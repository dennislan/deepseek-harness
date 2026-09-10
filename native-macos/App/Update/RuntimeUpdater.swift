import AppKit
import Foundation
import os

/// Drives runtime updates: resolve the newest published version, ask the user,
/// install it into the user runtime root, and restart dsh on it.
///
/// The launch check runs after dsh has settled, so a slow or unreachable network
/// never delays the app. All published state is main-actor isolated because it
/// feeds the UI and the About panel.
@MainActor
final class RuntimeUpdater: ObservableObject {
    /// What the updater is doing, as surfaced to the UI.
    enum Phase: Equatable {
        case idle
        case checking
        case upToDate
        case available(current: String, latest: String)
        case installing(InstallStep)
        case failed(String)

        /// Overlay text for the current phase, or nil when no overlay is due.
        var progressMessage: String? {
            guard case .installing(let step) = self else { return nil }
            return step.label
        }

        /// True while a check or an installation is in flight.
        var isBusy: Bool {
            switch self {
            case .checking, .installing: return true
            case .idle, .upToDate, .available, .failed: return false
            }
        }
    }

    @Published private(set) var phase: Phase = .idle
    /// Version of the runtime in effect; nil when its manifest is unreadable.
    @Published private(set) var runtimeVersion: String?
    /// Directory the runtime in effect was loaded from.
    @Published private(set) var runtimePath: String = ""

    private let layout: RuntimeLayout
    private let resolver: ReleaseResolver
    private var available: RuntimeVersion?

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
    /// Unlike the launch check this always reports an outcome, so an explicit
    /// action never ends in silence.
    /// - Parameter server: the server an update would restart.
    func checkForUpdates(server: DshServer) async {
        await performCheck(server: server, userInitiated: true)
    }

    /// Checks for a newer runtime once dsh has settled, then offers to install it.
    /// - Parameter server: the server an update would restart.
    func checkOnLaunch(server: DshServer) async {
        await waitForBoot(server: server)
        guard phase == .idle else { return }
        await performCheck(server: server, userInitiated: false)
    }

    /// Resolves the newest version and reacts to the comparison.
    /// - Parameters:
    ///   - server: the server an update would restart.
    ///   - userInitiated: whether the choice came from the menu, which decides
    ///     whether an up-to-date or failed check is reported.
    private func performCheck(server: DshServer, userInitiated: Bool) async {
        guard !phase.isBusy else {
            logger.info("已有更新流程在运行，忽略本次检查")
            return
        }
        await refreshRuntimeIdentity(server: server)
        phase = .checking

        guard let current = await server.runtimeVersion() else {
            logger.error("当前运行时版本不可读: \(self.runtimePath, privacy: .public)")
            guard userInitiated else {
                phase = .idle
                return
            }
            phase = .failed("无法读取当前 dsh 运行时版本")
            present(
                title: "检查更新失败",
                message: "无法读取当前 dsh 运行时版本。\n\n运行时目录：\(runtimePath)",
                style: .warning
            )
            return
        }

        do {
            let resolution = try await resolver.latest()
            guard resolution.version > current else {
                logger.info("运行时已是最新 \(current.raw, privacy: .public)")
                phase = .upToDate
                if userInitiated {
                    present(title: "当前已是最新版本", message: "Version: \(current.raw)")
                }
                return
            }
            available = resolution.version
            phase = .available(current: current.raw, latest: resolution.version.raw)
            logger.info("发现新运行时 \(resolution.version.raw, privacy: .public)，当前 \(current.raw, privacy: .public)")
            guard confirmUpdate(current: current, latest: resolution.version) else {
                logger.info("用户选择稍后更新")
                phase = .idle
                return
            }
            await install(server: server)
        } catch {
            logger.info("更新检查失败: \(String(describing: error), privacy: .public)")
            guard userInitiated else {
                phase = .idle
                return
            }
            let detail = (error as? ReleaseResolver.Failure)?.description ?? error.localizedDescription
            phase = .failed(detail)
            present(title: "检查更新失败", message: detail, style: .warning)
        }
    }

    // MARK: - Steps

    /// Waits for dsh to reach a terminal state so the prompt never covers a
    /// startup that is still running.
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

    private func confirmUpdate(current: RuntimeVersion, latest: RuntimeVersion) -> Bool {
        let alert = NSAlert()
        alert.messageText = "发现新版本"
        alert.informativeText = """
            当前版本：\(current.raw)
            最新版本：\(latest.raw)

            更新完成后本地服务会自动重启。
            """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "立即更新")
        alert.addButton(withTitle: "稍后")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func install(server: DshServer) async {
        guard let target = available else { return }
        guard let node = NodeRuntime.resolve() else {
            fail("找不到 Node.js 运行时，无法安装更新。")
            return
        }
        guard let tools = RuntimeInstaller.resolveToolsDirectory() else {
            fail("应用包内缺少更新器脚本 (Contents/Resources/updater)，无法安装更新。")
            return
        }

        let installer = RuntimeInstaller(layout: layout, node: node, toolsDirectory: tools)
        phase = .installing(.preparing)
        do {
            _ = try await installer.install(version: target) { step in
                Task { @MainActor [weak self] in self?.phase = .installing(step) }
            }
            phase = .installing(.restarting)
            await server.restart()
            await refreshRuntimeIdentity(server: server)

            let status = await server.status
            if case .failed(let reason) = status {
                await restore(installer: installer, server: server, reason: reason)
                return
            }
            available = nil
            phase = .upToDate
            logger.info("运行时更新完成 \(target.raw, privacy: .public)")
        } catch {
            let detail = (error as? RuntimeInstaller.Failure)?.description ?? error.localizedDescription
            logger.error("运行时更新失败: \(detail, privacy: .public)")
            fail(detail)
        }
    }

    /// Puts the previous runtime back after the new one failed to boot.
    private func restore(installer: RuntimeInstaller, server: DshServer, reason: String) async {
        do {
            _ = try installer.rollback()
            await server.restart()
            await refreshRuntimeIdentity(server: server)
            fail("新运行时启动失败，已回滚到上一版本。\n\n原因：\(reason)")
        } catch {
            logger.error("回滚失败: \(String(describing: error), privacy: .public)")
            fail("新运行时启动失败，且回滚失败。\n\n原因：\(reason)\n回滚错误：\(error.localizedDescription)")
        }
    }

    /// Records a failure and reports it, including where the logs are.
    private func fail(_ message: String) {
        phase = .failed(message)
        present(
            title: "运行时更新失败",
            message: "\(message)\n\n日志目录：\(layout.logsDirectory.path)",
            style: .warning
        )
    }

    /// Shows a modal alert.
    private func present(title: String, message: String, style: NSAlert.Style = .informational) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = style
        alert.addButton(withTitle: "好")
        alert.runModal()
    }
}

private let logger = os.Logger(subsystem: "com.deepseek.harness", category: "updater")
