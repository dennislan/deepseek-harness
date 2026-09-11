import Foundation

/// End-to-end assertions for the path the menu's 检查更新… item runs.
///
/// Compiled and run by `native-macos/Scripts/test-updater-manual-path.sh`, which
/// links this file with the update sources and points `DSH_HOME` at a scratch
/// home seeded with an older runtime. Unlike `RuntimeActivationTests` this one
/// uses the registry, Node, and npm: the click installs the newest published
/// runtime exactly as the app does.
@main
struct RuntimeUpdaterManualPathTests {
    static func main() async {
        var failures: [String] = []

        func expect(_ condition: Bool, _ message: String) {
            if !condition { failures.append(message) }
        }

        let home = URL(fileURLWithPath: ProcessInfo.processInfo.environment["DSH_HOME"] ?? "")
        guard home.path.hasPrefix("/") else {
            print("RuntimeUpdaterManualPathTests 失败 — 需要 DSH_HOME 指向脚本准备的空目录")
            exit(1)
        }
        let layout = RuntimeLayout(home: home)
        let server = DshServer()
        let updater = await MainActor.run { RuntimeUpdater(layout: layout, resolver: ReleaseResolver()) }

        /// Update logs on disk, used to prove a check did not reinstall.
        func updateLogCount() -> Int {
            let entries = (try? FileManager.default.contentsOfDirectory(atPath: layout.logsDirectory.path)) ?? []
            return entries.filter { $0.hasPrefix("update-") && $0.hasSuffix(".log") }.count
        }

        let serving = await server.runtimeVersion()?.raw
        expect(serving != nil, "种子运行时版本可读，实际 \(serving ?? "nil")")

        // MARK: A click during a run in flight reports progress

        let inFlight = Task { @MainActor in
            await updater.checkForUpdates(server: server)
        }
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        let during = await MainActor.run { updater.report }
        expect(during != nil, "安装进行中应显示进度，实际 nil")

        await updater.checkForUpdates(server: server)
        let concurrent = await MainActor.run { updater.report }
        expect(
            concurrent?.contains("更新正在进行") == true,
            "运行中再次点击应汇报进度，实际 \(concurrent ?? "nil")"
        )

        await inFlight.value
        let installed = await MainActor.run { updater.report }
        expect(
            installed?.contains("已下载完成，下次启动应用时生效") == true,
            "安装结束后应给出明确结果，实际 \(installed ?? "nil")"
        )
        let settledPhase = await MainActor.run { updater.phase }
        expect(!settledPhase.isBusy, "安装结束后不再处于进行中，实际 \(settledPhase)")
        expect(
            layout.installedVersion(at: layout.pendingRoot) != nil,
            "安装结果发布为待生效运行时"
        )

        // MARK: A later click reuses the staged runtime instead of reinstalling

        let logsBefore = updateLogCount()
        await updater.checkForUpdates(server: server)
        let reused = await MainActor.run { updater.report }
        expect(
            reused?.contains("已下载完成，下次启动应用时生效") == true,
            "已暂存同版本时应立即汇报结果，实际 \(reused ?? "nil")"
        )
        expect(
            updateLogCount() == logsBefore,
            "已暂存同版本时不再安装（新增更新日志 \(updateLogCount() - logsBefore) 个）"
        )

        if failures.isEmpty {
            print("RuntimeUpdaterManualPathTests: 全部通过")
            return
        }
        for failure in failures {
            print("RuntimeUpdaterManualPathTests 失败 — \(failure)")
        }
        exit(1)
    }
}
