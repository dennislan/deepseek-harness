import Foundation

/// Offline behavior assertions for applying a staged runtime.
///
/// Compiled and run by `native-macos/Scripts/test-updater-logic.sh`, which links
/// this file with `RuntimeVersion.swift`, `RuntimeLayout.swift`,
/// `NodeRuntime.swift`, and `RuntimeInstaller.swift`. Activation is directory
/// renames plus a manifest read, so no network, no Node, and no app bundle are
/// involved.
@main
struct RuntimeActivationTests {
    static func main() {
        var failures: [String] = []

        func expect(_ condition: Bool, _ message: String) {
            if !condition { failures.append(message) }
        }

        let manager = FileManager.default
        let home = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("dsh-activation-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? manager.removeItem(at: home) }
        let layout = RuntimeLayout(home: home)

        /// Writes a runtime tree shaped like `dsh-root`: activation accepts it
        /// when the CLI entry exists and the manifest reports `version`.
        func makeRuntimeTree(at root: URL, version: String, withCLI: Bool = true) throws {
            if withCLI {
                let cli = root.appendingPathComponent(RuntimeInstaller.cliPath)
                try manager.createDirectory(at: cli.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Data("// dsh CLI".utf8).write(to: cli)
            }
            let manifest = root.appendingPathComponent(RuntimeLayout.dshPackagePath)
            try manager.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("{\"version\":\"\(version)\"}".utf8).write(to: manifest)
        }

        func versionInService() -> String? {
            layout.installedVersion(at: layout.dshRoot)?.raw
        }

        do {
            try layout.prepare()

            // MARK: Nothing staged

            expect(RuntimeInstaller.activatePending(layout: layout) == nil, "无待生效运行时时不激活")
            expect(!manager.fileExists(atPath: layout.dshRoot.path), "无待生效运行时不创建 dsh-root")

            // MARK: First activation

            try makeRuntimeTree(at: layout.pendingRoot, version: "0.1.5")
            let first = RuntimeInstaller.activatePending(layout: layout)
            expect(first?.version.raw == "0.1.5", "首次激活的版本为 0.1.5，实际 \(first?.version.raw ?? "nil")")
            expect(first?.hasPrevious == false, "首次激活没有上一版本")
            expect(versionInService() == "0.1.5", "首次激活后 dsh-root 为 0.1.5，实际 \(versionInService() ?? "nil")")
            expect(!manager.fileExists(atPath: layout.pendingRoot.path), "首次激活后 pending 目录被消费")

            // MARK: Replacing a runtime in service

            try makeRuntimeTree(at: layout.pendingRoot, version: "0.1.6")
            let second = RuntimeInstaller.activatePending(layout: layout)
            expect(second?.version.raw == "0.1.6", "再次激活的版本为 0.1.6，实际 \(second?.version.raw ?? "nil")")
            expect(second?.hasPrevious == true, "再次激活保留上一版本")
            expect(versionInService() == "0.1.6", "再次激活后 dsh-root 为 0.1.6，实际 \(versionInService() ?? "nil")")
            expect(
                layout.installedVersion(at: layout.previousRoot)?.raw == "0.1.5",
                "previous 保留被替换的 0.1.5"
            )

            // MARK: Rollback

            _ = try? RuntimeInstaller.rollback(layout: layout)
            expect(versionInService() == "0.1.5", "回滚后 dsh-root 为 0.1.5，实际 \(versionInService() ?? "nil")")
            expect(!manager.fileExists(atPath: layout.previousRoot.path), "回滚后 previous 目录被消费")

            // MARK: Nothing newer

            try makeRuntimeTree(at: layout.pendingRoot, version: "0.1.5")
            expect(RuntimeInstaller.activatePending(layout: layout) == nil, "同版本不激活")
            expect(!manager.fileExists(atPath: layout.pendingRoot.path), "同版本 pending 被丢弃")
            expect(versionInService() == "0.1.5", "同版本不改变 dsh-root")

            try makeRuntimeTree(at: layout.pendingRoot, version: "0.1.4")
            expect(RuntimeInstaller.activatePending(layout: layout) == nil, "旧版本不激活")
            expect(!manager.fileExists(atPath: layout.pendingRoot.path), "旧版本 pending 被丢弃")
            expect(versionInService() == "0.1.5", "旧版本不改变 dsh-root")

            // MARK: Incomplete staging tree

            try makeRuntimeTree(at: layout.pendingRoot, version: "0.1.7", withCLI: false)
            expect(RuntimeInstaller.activatePending(layout: layout) == nil, "缺 CLI 入口的运行时不被激活")
            expect(!manager.fileExists(atPath: layout.pendingRoot.path), "缺 CLI 入口的 pending 被丢弃")
            expect(versionInService() == "0.1.5", "缺 CLI 入口的待生效运行时不改变 dsh-root")

            // MARK: Rollback without a previous runtime

            expect((try? RuntimeInstaller.rollback(layout: layout)) == nil, "无可回滚版本时回滚报错")
        } catch {
            failures.append("用例执行失败: \(error)")
        }

        if failures.isEmpty {
            print("RuntimeActivationTests: 全部通过")
            return
        }
        for failure in failures {
            print("RuntimeActivationTests 失败 — \(failure)")
        }
        exit(1)
    }
}
