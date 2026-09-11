import Foundation
import os

/// Drives runtime updates: resolve the newest published version, stage it in the
/// background, and let the next launch run it.
///
/// Nothing here interrupts the user. The launch check opens no window at all, and
/// an update never restarts dsh under a session in use: it is assembled and
/// verified in the staging directory, published as `dsh-root.pending`, and moved
/// into place by ``DshServer/applyStagedRuntime()`` at the next launch — the same
/// way a browser applies an update it downloaded in the background. A check the
/// user asked for reports through ``report``, which the window renders as a
/// banner that takes no clicks, so even an explicit check cannot block work.
/// All published state is main-actor isolated because it feeds the UI and the
/// About panel.
@MainActor
final class RuntimeUpdater: ObservableObject {
    /// What the updater is doing, as surfaced to the UI.
    enum Phase: Equatable {
        case idle
        case checking
        case upToDate(current: String)
        /// A run of ``InstallStep``s assembling a newer runtime in the background.
        case staging(InstallStep)
        /// A newer runtime is on disk and takes effect at the next launch.
        case staged(current: String, latest: String)
        case failed(String)

        /// True while a check or a staging run is in flight.
        var isBusy: Bool {
            switch self {
            case .checking, .staging: return true
            case .idle, .upToDate, .staged, .failed: return false
            }
        }
    }

    /// Why an update could not start. Both are environment problems rather than
    /// installer failures.
    private enum Precondition: Error, CustomStringConvertible {
        case nodeMissing
        case toolsMissing

        var description: String {
            switch self {
            case .nodeMissing:
                return "找不到 Node.js 运行时，无法安装更新"
            case .toolsMissing:
                return "应用包内缺少更新器脚本 (Contents/Resources/updater)，无法安装更新"
            }
        }
    }

    @Published private(set) var phase: Phase = .idle
    /// Seconds a final banner message stays on screen before it dismisses itself.
    private static let reportLifetime: UInt64 = 8_000_000_000
    /// Banner text for a check the user asked for; nil when nothing is shown.
    ///
    /// The launch check never reports here: an update the user did not ask for
    /// stays in the log.
    @Published private(set) var report: String?
    /// Version of the runtime in effect; nil when its manifest is unreadable.
    @Published private(set) var runtimeVersion: String?
    /// Directory the runtime in effect was loaded from.
    @Published private(set) var runtimePath: String = ""

    private let layout: RuntimeLayout
    private let resolver: ReleaseResolver
    private var reportDismissal: Task<Void, Never>?

    /// Creates an updater.
    /// - Parameters:
    ///   - layout: runtime locations; defaults to the same `DSH_HOME` the server uses.
    ///   - resolver: version source; injectable for tests.
    init(
        layout: RuntimeLayout = RuntimeLayout(home: RuntimeLayout.resolveHome()),
        resolver: ReleaseResolver = ReleaseResolver()
    ) {
        self.layout = layout
        self.resolver = resolver
    }

    /// Refreshes the identity the About panel reports.
    /// - Parameter server: the server whose runtime is in effect.
    func refreshRuntimeIdentity(server: DshServer) async {
        runtimeVersion = await server.runtimeVersion()?.raw
        runtimePath = await server.runtimeRoot().path
    }

    /// Checks for a newer runtime when the user asks for it.
    ///
    /// Unlike the launch check this reports progress and outcome in the banner,
    /// so an explicit action never ends in silence.
    /// - Parameter server: the server whose runtime decides whether an update is due.
    func checkForUpdates(server: DshServer) async {
        await performCheck(server: server, reportsToUser: true)
    }

    /// Checks for a newer runtime once dsh has settled, then stages it silently.
    /// - Parameter server: the server whose boot outcome decides a rollback.
    func checkOnLaunch(server: DshServer) async {
        await waitForBoot(server: server)
        // A runtime applied at launch is the only thing that changed since the
        // last run, so a failed boot is attributed to it and the runtime it
        // replaced goes back. No update check follows a rollback: the staged
        // release is the one that just failed, so checking would re-stage it.
        if await restoreLaunchActivation(server: server) { return }
        guard phase == .idle else {
            logger.notice("启动检查跳过：已有更新流程在运行（\(self.progressLabel, privacy: .public)）")
            return
        }
        await performCheck(server: server, reportsToUser: false)
    }

    // MARK: - Steps

    /// Resolves the newest version and stages it when it is newer.
    /// - Parameters:
    ///   - server: the server whose runtime is compared with the published one.
    ///   - reportsToUser: whether the check came from the menu, which decides
    ///     whether the banner shows progress and the outcome.
    private func performCheck(server: DshServer, reportsToUser: Bool) async {
        guard !phase.isBusy else {
            // A click that lands while a run is already in flight must not end in
            // silence: it reports the step that run is on instead of being dropped.
            logger.notice("已有更新流程在运行（\(self.progressLabel, privacy: .public)），本次检查汇报当前进度")
            if reportsToUser { announce("更新正在进行：\(progressLabel)") }
            return
        }
        logger.notice("检查更新开始（\(reportsToUser ? "用户请求" : "启动检查", privacy: .public)）")
        phase = .checking
        if reportsToUser { setReport("正在检查更新…") }
        await refreshRuntimeIdentity(server: server)

        guard let current = await server.runtimeVersion() else {
            logger.error("当前运行时版本不可读: \(self.runtimePath, privacy: .public)")
            settle(
                .failed("无法读取当前 dsh 运行时版本"),
                announcement: "检查更新失败：无法读取当前 dsh 运行时版本（\(runtimePath)）",
                reportsToUser: reportsToUser
            )
            return
        }

        do {
            let resolution = try await resolver.latest()
            guard resolution.version > current else {
                logger.info("运行时已是最新 \(current.raw, privacy: .public)")
                settle(
                    .upToDate(current: current.raw),
                    announcement: "当前已是最新版本（\(current.raw)）",
                    reportsToUser: reportsToUser
                )
                return
            }
            logger.info("发现新运行时 \(resolution.version.raw, privacy: .public)，当前 \(current.raw, privacy: .public)")
            if layout.installedVersion(at: layout.pendingRoot) == resolution.version {
                // A previous run already staged this version; the check reports
                // that outcome instead of reinstalling what is already on disk.
                logger.notice("\(resolution.version.raw, privacy: .public) 已在待生效目录，跳过重复安装")
                settle(
                    .staged(current: current.raw, latest: resolution.version.raw),
                    announcement: "\(resolution.version.raw) 已下载完成，下次启动应用时生效",
                    reportsToUser: reportsToUser
                )
                return
            }
            try await stage(version: resolution.version, current: current, reportsToUser: reportsToUser)
        } catch {
            let detail = describe(error)
            logger.error("运行时更新失败: \(detail, privacy: .public)")
            settle(
                .failed(detail),
                announcement: "更新未完成：\(detail)（日志：\(layout.logsDirectory.path)）",
                reportsToUser: reportsToUser
            )
        }
    }

    /// Builds `version` in the background and publishes it for the next launch.
    private func stage(version: RuntimeVersion, current: RuntimeVersion, reportsToUser: Bool) async throws {
        guard let node = NodeRuntime.resolve() else { throw Precondition.nodeMissing }
        guard let tools = RuntimeInstaller.resolveToolsDirectory() else { throw Precondition.toolsMissing }

        let installer = RuntimeInstaller(layout: layout, node: node, toolsDirectory: tools)
        phase = .staging(.preparing)
        if reportsToUser { setReport(InstallStep.preparing.label) }
        _ = try await installer.stage(version: version) { step in
            Task { @MainActor [weak self] in
                // A step reported after the run settled must not put the updater
                // back into a busy phase, which would drop every later check.
                guard let self, self.phase.isBusy else { return }
                self.phase = .staging(step)
                if reportsToUser { self.setReport(step.label) }
            }
        }
        settle(
            .staged(current: current.raw, latest: version.raw),
            announcement: "\(version.raw) 已下载完成，下次启动应用时生效",
            reportsToUser: reportsToUser
        )
    }

    /// Puts the runtime back that the new one replaced at launch, when the new
    /// one failed to boot.
    /// - Parameter server: the server whose boot outcome decides the rollback.
    /// - Returns: true when a rollback ran, so the caller skips the update check.
    private func restoreLaunchActivation(server: DshServer) async -> Bool {
        guard let activation = await server.launchActivation else { return false }
        await server.clearLaunchActivation()
        guard case .failed(let reason) = await server.status else { return false }
        guard activation.hasPrevious else {
            logger.error("运行时 \(activation.version.raw, privacy: .public) 启动失败且无可回滚版本：\(reason, privacy: .public)")
            return true
        }

        do {
            _ = try RuntimeInstaller.rollback(layout: layout)
            await server.restart()
            await refreshRuntimeIdentity(server: server)
            logger.error("运行时 \(activation.version.raw, privacy: .public) 启动失败，已回滚：\(reason, privacy: .public)")
        } catch {
            logger.error(
                "运行时 \(activation.version.raw, privacy: .public) 启动失败且回滚失败：\(String(describing: error), privacy: .public)"
            )
        }
        return true
    }

    /// Waits for dsh to reach a terminal state, because a rollback decision needs
    /// the boot outcome and a launch check must not race the first launch.
    private func waitForBoot(server: DshServer) async {
        for _ in 0..<120 {
            let status = await server.status
            switch status {
            case .running, .failed: return
            case .stopped, .starting: break
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
    }

    /// Records a terminal phase and, for a user-initiated check, shows its
    /// outcome in the banner until it dismisses itself.
    private func settle(_ outcome: Phase, announcement: String, reportsToUser: Bool) {
        phase = outcome
        guard reportsToUser else { return }
        announce(announcement)
    }

    /// Shows a final banner message and schedules its dismissal.
    /// - Parameter message: the text the banner carries.
    private func announce(_ message: String) {
        setReport(message)
        reportDismissal = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.reportLifetime)
            guard !Task.isCancelled else { return }
            self?.report = nil
        }
    }

    /// Sets the banner text, discarding any dismissal still pending from an
    /// earlier message. Every message is logged as well, so what the user was
    /// told stays traceable after the banner has dismissed itself.
    private func setReport(_ message: String?) {
        reportDismissal?.cancel()
        reportDismissal = nil
        report = message
        guard let message else { return }
        logger.notice("提示条：\(message, privacy: .public)")
    }

    /// Label for the step the updater is on, as the banner shows it.
    private var progressLabel: String {
        switch phase {
        case .checking: return "正在检查更新…"
        case .staging(let step): return step.label
        case .idle, .upToDate, .staged, .failed: return "更新流程运行中"
        }
    }

    /// Renders a thrown error as the text the user reads.
    private func describe(_ error: Error) -> String {
        if let failure = error as? ReleaseResolver.Failure { return failure.description }
        if let failure = error as? RuntimeInstaller.Failure { return failure.description }
        if let precondition = error as? Precondition { return precondition.description }
        return error.localizedDescription
    }
}

private let logger = os.Logger(subsystem: "com.deepseek.harness", category: "updater")
