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
/// user asked for reports through ``report`` and ``bannerStyle``, which the
/// window renders as a banner that takes no clicks, so even an explicit check
/// cannot block work. The banner stays empty while the check runs: it carries
/// the release the user is being offered, and then the outcome, so nothing is
/// shown that only says work is happening. All published state is main-actor
/// isolated because it feeds the UI and the About panel.
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
    /// Which icon the banner draws while `report` is on screen.
    @Published private(set) var bannerStyle: BannerStyle = .checking
    /// Version of the runtime in effect; nil when its manifest is unreadable.
    @Published private(set) var runtimeVersion: String?
    /// Directory the runtime in effect was loaded from.
    @Published private(set) var runtimePath: String = ""

    /// Icon the banner draws next to its text.
    enum BannerStyle: Equatable, CustomStringConvertible {
        /// A download the user was not offered is in flight: the spinner says
        /// work is happening.
        case checking
        /// A newer release is published: the download symbol marks the release
        /// the banner offers.
        case available
        /// A check ended the way the user would want: nothing new to do, or a
        /// newer runtime is on disk for the next launch. Always the green check,
        /// so both outcomes read the same at a glance.
        case success
        /// A check could not finish: the refresh symbol, uncolored.
        case failure

        /// Names the icon for the log, which traces what the user was told.
        var description: String {
            switch self {
            case .checking: return "checking"
            case .available: return "available"
            case .success: return "success"
            case .failure: return "failure"
            }
        }
    }

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
    /// Unlike the launch check this answers in the banner: a newer release is
    /// announced with its version and the offer to update, and every outcome is
    /// reported. The check itself is never announced — the click is answered by
    /// the offering or by the outcome, so a user who is already up to date reads
    /// one message instead of two.
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
    ///     whether the banner carries the offer and the outcome.
    private func performCheck(server: DshServer, reportsToUser: Bool) async {
        guard !phase.isBusy else {
            // A click that lands while a run is already in flight must not end in
            // silence: it reports the step that run is on instead of being dropped.
            logger.notice("已有更新流程在运行（\(self.progressLabel, privacy: .public)），本次检查汇报当前进度")
            if reportsToUser {
                let busy = phase.isBusy
                announce("更新正在进行：\(progressLabel)", style: busy ? .checking : .success)
            }
            return
        }
        logger.notice("检查更新开始（\(reportsToUser ? "用户请求" : "启动检查", privacy: .public)）")
        phase = .checking
        // The click is answered by what the check finds, never by a message that
        // only says a check is running: nothing is shown until there is
        // something to report.
        await refreshRuntimeIdentity(server: server)

        guard let current = await server.runtimeVersion() else {
            logger.error("当前运行时版本不可读: \(self.runtimePath, privacy: .public)")
            settle(
                .failed("无法读取当前 dsh 运行时版本"),
                announcement: "检查更新失败：无法读取当前 dsh 运行时版本（\(runtimePath)）",
                style: .failure,
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
                    style: .success,
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
                    style: .success,
                    reportsToUser: reportsToUser
                )
                return
            }
            if reportsToUser {
                // Banner shows the version being installed and the current step
                // as it progresses, without a dismissal timer: a long install
                // must not leave the banner empty.
                setReport("正在更新到 \(resolution.version.raw)…", style: .checking)
            }
            try await stage(version: resolution.version, showProgress: reportsToUser)
            settle(
                .staged(current: current.raw, latest: resolution.version.raw),
                announcement: "\(resolution.version.raw) 已更新成功，下次启动生效",
                style: .success,
                reportsToUser: reportsToUser
            )
        } catch {
            let detail = describe(error)
            logger.error("运行时更新失败: \(detail, privacy: .public)")
            settle(
                .failed(detail),
                announcement: "更新未完成：\(detail)（日志：\(layout.logsDirectory.path)）",
                style: .failure,
                reportsToUser: reportsToUser
            )
        }
    }

    /// Builds `version` in the background and publishes it for the next launch.
    ///
    /// When `showProgress` is true each step updates the banner with the version
    /// and step label so the user can see what is happening; otherwise steps
    /// are only logged.
    private func stage(version: RuntimeVersion, showProgress: Bool) async throws {
        guard let node = NodeRuntime.resolve() else { throw Precondition.nodeMissing }
        guard let tools = RuntimeInstaller.resolveToolsDirectory() else { throw Precondition.toolsMissing }

        let installer = RuntimeInstaller(layout: layout, node: node, toolsDirectory: tools)
        phase = .staging(.preparing)
        if showProgress {
            setReport("正在更新到 \(version.raw)：\(InstallStep.preparing.label)", style: .checking)
        }
        _ = try await installer.stage(version: version) { [weak self] step in
            Task { @MainActor in
                // A step reported after the run settled must not put the updater
                // back into a busy phase, which would drop every later check.
                guard let self, self.phase.isBusy else { return }
                self.phase = .staging(step)
                logger.notice("安装步骤：\(step.label, privacy: .public)")
                if showProgress {
                    self.setReport("正在更新到 \(version.raw)：\(step.label)", style: .checking)
                }
            }
        }
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
    /// - Parameters:
    ///   - outcome: the phase the check ends in.
    ///   - announcement: the banner text.
    ///   - style: the banner icon for that text.
    ///   - reportsToUser: whether the check came from the menu.
    private func settle(_ outcome: Phase, announcement: String, style: BannerStyle, reportsToUser: Bool) {
        phase = outcome
        guard reportsToUser else { return }
        announce(announcement, style: style)
    }

    /// Shows a final banner message and schedules its dismissal.
    /// - Parameters:
    ///   - message: the text the banner carries.
    ///   - style: the icon the banner draws next to it.
    private func announce(_ message: String, style: BannerStyle) {
        setReport(message, style: style)
        reportDismissal = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.reportLifetime)
            guard !Task.isCancelled else { return }
            self?.report = nil
        }
    }

    /// Sets the banner text and icon, discarding any dismissal still pending from
    /// an earlier message. Every message is logged as well, so what the user was
    /// told stays traceable after the banner has dismissed itself.
    private func setReport(_ message: String?, style: BannerStyle) {
        reportDismissal?.cancel()
        reportDismissal = nil
        report = message
        bannerStyle = style
        guard let message else { return }
        logger.notice("提示条（\(style, privacy: .public)）：\(message, privacy: .public)")
    }

    /// Label for the step the updater is on, as the banner shows it.
    ///
    /// There is no wording for "a check is running" on its own: the menu click is
    /// answered by the offer or the outcome, and only a click that lands on a run
    /// already in flight reads this label.
    private var progressLabel: String {
        switch phase {
        case .checking: return "检查新版本"
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
