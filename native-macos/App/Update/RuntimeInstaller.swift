import Foundation
import os

/// Stage of an in-flight runtime installation, surfaced to the UI.
enum InstallStep: String, Sendable, Equatable {
    case preparing, installing, pruning, swapping, restarting

    /// Localized label shown while this stage runs.
    var label: String {
        switch self {
        case .preparing:  return "准备更新"
        case .installing: return "下载并安装运行时"
        case .pruning:    return "精简运行时文件"
        case .swapping:   return "切换到新运行时"
        case .restarting: return "重启本地服务"
        }
    }
}

/// Installs a published `@deepseek-ai/dsh` closure into the user runtime root.
///
/// Mirrors the npm path of `native-macos/Scripts/build-release.sh`: install the
/// production closure, prune it, create the two bridge symlinks dsh resolves
/// through, verify it, then replace the live runtime in a single directory
/// rename while keeping the previous one for rollback.
struct RuntimeInstaller: Sendable {
    /// Why an installation could not complete.
    enum Failure: Error, CustomStringConvertible {
        case npmUnavailable(String)
        case npmFailed(status: Int32, log: URL)
        case toolFailed(tool: String, status: Int32, log: URL)
        case missingArtifact(String)
        case insufficientSpace(required: Int64, available: Int64)
        case fileSystem(String)

        var description: String {
            switch self {
            case .npmUnavailable(let detail):
                return detail
            case .npmFailed(let status, let log):
                return "npm install 失败 (退出码 \(status))，日志：\(log.path)"
            case .toolFailed(let tool, let status, let log):
                return "\(tool) 失败 (退出码 \(status))，日志：\(log.path)"
            case .missingArtifact(let detail):
                return detail
            case .insufficientSpace(let required, let available):
                let formatter = ByteCountFormatter()
                return "磁盘空间不足：需要 \(formatter.string(fromByteCount: required))，可用 \(formatter.string(fromByteCount: available))"
            case .fileSystem(let detail):
                return detail
            }
        }
    }

    /// Package installed for every runtime update.
    static let packageName = "@deepseek-ai/dsh"
    /// Web frontend package whose `dist` the `apps/web/dist` bridge points at.
    static let frontendPackage = "@deepseek-ai/dsh-web-frontend"
    /// Registry the build script also pins, so installs stay deterministic.
    static let registry = "https://registry.npmjs.org"
    /// Scripts applied to every freshly installed closure.
    static let assembleScript = "assemble-runtime.mjs"
    static let pruneScript = "prune-node-modules.mjs"
    /// Free space an update needs: the unpruned closure, the shared npm cache,
    /// and the previous runtime kept for rollback.
    static let requiredFreeSpace: Int64 = 1_500_000_000
    /// Seconds allowed for the staged runtime to answer `--version`.
    static let verificationTimeout: TimeInterval = 60

    let layout: RuntimeLayout
    let node: NodeRuntime
    /// Directory holding the two pruning scripts.
    let toolsDirectory: URL

    /// Resolves the directory that ships the pruning scripts.
    /// - Returns: the bundle's `Resources/updater`, a source checkout's
    ///   `native-macos/Scripts`, or nil when neither exists.
    static func resolveToolsDirectory() -> URL? {
        let manager = FileManager.default
        if let resources = Bundle.main.resourceURL {
            let bundled = resources.appendingPathComponent("updater", isDirectory: true)
            if manager.fileExists(atPath: bundled.appendingPathComponent(assembleScript).path) {
                return bundled
            }
        }
        // Development builds run from a source checkout rather than a shipped bundle.
        var directory = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0])
            .deletingLastPathComponent()
        while true {
            let candidate = directory.appendingPathComponent("native-macos/Scripts", isDirectory: true)
            if manager.fileExists(atPath: candidate.appendingPathComponent(assembleScript).path) {
                return candidate
            }
            let parent = directory.deletingLastPathComponent()
            if parent == directory { return nil }
            directory = parent
        }
    }

    // MARK: - Install

    /// Installs `version` and switches the runtime over to it.
    ///
    /// The live runtime is untouched until the staged closure passes
    /// ``verify(_:expecting:)``; after that the switch is a directory rename.
    /// - Parameters:
    ///   - version: the version to install.
    ///   - progress: called with each stage from a background context.
    /// - Returns: the runtime root now in effect.
    /// - Throws: ``Failure`` describing the failed stage.
    func install(
        version: RuntimeVersion,
        progress: @escaping @Sendable (InstallStep) -> Void
    ) async throws -> URL {
        try layout.prepare()
        progress(.preparing)

        let lock = try layout.acquireLock()
        defer { lock.release() }
        layout.cleanStaleStaging()

        try requireSpace()
        let npm = try requireNpm()
        let log = layout.updateLogURL()
        append(to: log, "== 更新 @deepseek-ai/dsh 到 \(version.raw) ==")
        logger.info("更新运行时到 \(version.raw, privacy: .public)，日志 \(log.path, privacy: .public)")

        let staging = try layout.makeStagingRoot()
        defer { try? FileManager.default.removeItem(at: staging) }

        progress(.installing)
        let installArguments = [
            npm.path, "install", "\(Self.packageName)@\(version.raw)",
            "--omit=dev", "--no-audit", "--no-fund",
            "--registry", Self.registry,
            "--prefix", staging.path,
            "--cache", layout.npmCache.path,
        ]
        append(to: log, "$ node \(installArguments.joined(separator: " "))")
        let npmStatus = await Self.run(node.executable, installArguments, loggingTo: log)
        guard npmStatus == 0 else { throw Failure.npmFailed(status: npmStatus, log: log) }

        let stagedRoot = staging.appendingPathComponent(RuntimeLayout.runtimeDirectoryName, isDirectory: true)
        try FileManager.default.createDirectory(at: stagedRoot, withIntermediateDirectories: true)
        try moveInstalledModules(from: staging, into: stagedRoot)

        progress(.pruning)
        try await prune(stagedRoot, log: log)
        try linkBridges(in: stagedRoot)

        if let problem = await verify(stagedRoot, expecting: version) {
            throw Failure.missingArtifact("新运行时预检失败：\(problem)（日志：\(log.path)）")
        }

        progress(.swapping)
        try swap(stagedRoot)
        logger.info("运行时已切换到 \(version.raw, privacy: .public)")
        return layout.dshRoot
    }

    /// Restores the runtime replaced by the most recent successful update.
    /// - Returns: the runtime root now in effect.
    /// - Throws: ``Failure`` when no previous runtime was kept.
    func rollback() throws -> URL {
        let manager = FileManager.default
        guard manager.fileExists(atPath: layout.previousRoot.path) else {
            throw Failure.missingArtifact("没有可回滚的上一版本：\(layout.previousRoot.path)")
        }
        try? manager.removeItem(at: layout.dshRoot)
        do {
            try manager.moveItem(at: layout.previousRoot, to: layout.dshRoot)
        } catch {
            throw Failure.fileSystem("回滚失败：\(error.localizedDescription)")
        }
        logger.info("运行时已回滚到 \(self.layout.dshRoot.path, privacy: .public)")
        return layout.dshRoot
    }

    // MARK: - Verification

    /// Checks a staged runtime before it replaces the live one.
    ///
    /// Runs the staged CLI (`--version`) so a published closure that cannot load
    /// is rejected here instead of after the switch; the printed version also
    /// proves the closure really is the requested release.
    /// - Parameters:
    ///   - root: the assembled `dsh-root`.
    ///   - version: the version the closure must report.
    /// - Returns: nil when the runtime is usable, otherwise what failed.
    func verify(_ root: URL, expecting version: RuntimeVersion) async -> String? {
        let manager = FileManager.default
        let required = [
            "apps/cli/lib/bin.js",
            "apps/web/dist/index.html",
            RuntimeLayout.dshPackagePath,
        ]
        for relative in required where !manager.fileExists(atPath: root.appendingPathComponent(relative).path) {
            return "缺少 \(relative)"
        }
        let installed = layout.installedVersion(at: root)
        guard installed == version else {
            return "版本不匹配：期望 \(version.raw)，实际 \(installed?.raw ?? "未知")"
        }

        let cli = root.appendingPathComponent("apps/cli/lib/bin.js")
        let log = layout.logsDirectory.appendingPathComponent("verify-\(version.raw).log")
        append(to: log, "$ node \(cli.path) --version")
        let status = await Self.run(
            node.executable,
            [cli.path, "--version"],
            loggingTo: log,
            timeout: Self.verificationTimeout
        )
        let output = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
        for marker in ["ERR_MODULE_NOT_FOUND", "does not provide an export named", "Cannot find module", "ERR_UNSUPPORTED_DIR_IMPORT"] {
            guard !output.contains(marker) else { return "运行时模块加载失败：\(marker)" }
        }
        guard output.contains(version.raw) else {
            return "运行时未报告目标版本 \(version.raw)（退出码 \(status)）"
        }
        return nil
    }

    // MARK: - Steps

    /// Moves the npm-installed closure into the runtime layout.
    private func moveInstalledModules(from staging: URL, into root: URL) throws {
        let manager = FileManager.default
        let installed = staging.appendingPathComponent("node_modules", isDirectory: true)
        guard manager.fileExists(atPath: installed.path) else {
            throw Failure.missingArtifact("npm 未生成 node_modules @ \(staging.path)")
        }
        let destination = root.appendingPathComponent("node_modules", isDirectory: true)
        try? manager.removeItem(at: destination)
        do {
            try manager.moveItem(at: installed, to: destination)
        } catch {
            throw Failure.fileSystem("移动 node_modules 失败：\(error.localizedDescription)")
        }
        // npm also writes these at the prefix root; the runtime layout has no use for them.
        for leftover in ["package.json", "package-lock.json"] {
            try? manager.removeItem(at: staging.appendingPathComponent(leftover))
        }
    }

    /// Applies the two pruning scripts the build script also runs.
    private func prune(_ root: URL, log: URL) async throws {
        let modules = root.appendingPathComponent("node_modules").path
        for script in [Self.assembleScript, Self.pruneScript] {
            let tool = toolsDirectory.appendingPathComponent(script)
            guard FileManager.default.fileExists(atPath: tool.path) else {
                throw Failure.missingArtifact("缺少更新器脚本 \(script) @ \(toolsDirectory.path)")
            }
            append(to: log, "$ node \(tool.path) \(modules)")
            let status = await Self.run(node.executable, [tool.path, modules], loggingTo: log)
            guard status == 0 else { throw Failure.toolFailed(tool: script, status: status, log: log) }
        }
    }

    /// Creates the two relative symlinks dsh resolves through, exactly as the
    /// packaged bundle does.
    private func linkBridges(in root: URL) throws {
        let manager = FileManager.default
        let apps = root.appendingPathComponent("apps", isDirectory: true)
        let web = apps.appendingPathComponent("web", isDirectory: true)
        try manager.createDirectory(at: web, withIntermediateDirectories: true)

        let cliTarget = root.appendingPathComponent("node_modules/\(Self.packageName)", isDirectory: true)
        guard manager.fileExists(atPath: cliTarget.path) else {
            throw Failure.missingArtifact("闭包缺少 \(Self.packageName)")
        }
        let frontendTarget = root.appendingPathComponent("node_modules/\(Self.frontendPackage)/dist", isDirectory: true)
        guard manager.fileExists(atPath: frontendTarget.path) else {
            throw Failure.missingArtifact("闭包缺少 \(Self.frontendPackage)/dist")
        }

        let cliLink = apps.appendingPathComponent("cli")
        let frontendLink = web.appendingPathComponent("dist")
        try? manager.removeItem(at: cliLink)
        try? manager.removeItem(at: frontendLink)
        try manager.createSymbolicLink(
            atPath: cliLink.path,
            withDestinationPath: "../node_modules/\(Self.packageName)"
        )
        try manager.createSymbolicLink(
            atPath: frontendLink.path,
            withDestinationPath: "../../node_modules/\(Self.frontendPackage)/dist"
        )
    }

    /// Replaces the live runtime, keeping the previous one for rollback.
    private func swap(_ root: URL) throws {
        let manager = FileManager.default
        try? manager.removeItem(at: layout.previousRoot)
        if manager.fileExists(atPath: layout.dshRoot.path) {
            do {
                try manager.moveItem(at: layout.dshRoot, to: layout.previousRoot)
            } catch {
                throw Failure.fileSystem("备份当前运行时失败：\(error.localizedDescription)")
            }
        }
        do {
            try manager.moveItem(at: root, to: layout.dshRoot)
        } catch {
            if manager.fileExists(atPath: layout.previousRoot.path) {
                try? manager.moveItem(at: layout.previousRoot, to: layout.dshRoot)
            }
            throw Failure.fileSystem("切换运行时失败：\(error.localizedDescription)")
        }
    }

    // MARK: - Preconditions

    private func requireSpace() throws {
        guard let available = layout.availableCapacity() else { return }
        guard available >= Self.requiredFreeSpace else {
            throw Failure.insufficientSpace(required: Self.requiredFreeSpace, available: available)
        }
    }

    private func requireNpm() throws -> URL {
        guard let npm = node.resolvedNpmCLI() else {
            throw Failure.npmUnavailable(
                "未找到 npm，无法安装运行时。请安装 Node.js 22+（自带 npm），" +
                "或用 native-macos/Scripts/build-release.sh 重新打包以内嵌 npm。"
            )
        }
        return npm
    }

    // MARK: - Child processes

    /// Runs a child process with its output appended to `logURL`.
    /// - Parameters:
    ///   - executable: the program to run.
    ///   - arguments: its arguments.
    ///   - logURL: receives combined stdout and stderr.
    ///   - timeout: seconds before the process is terminated; nil waits forever.
    /// - Returns: the exit status, or 0 when the process could not be started.
    static func run(
        _ executable: URL,
        _ arguments: [String],
        loggingTo logURL: URL,
        timeout: TimeInterval? = nil
    ) async -> Int32 {
        guard let handle = openForAppend(logURL) else { return -1 }
        defer { try? handle.close() }

        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = handle
        process.standardError = handle

        let watchdog = Task {
            guard let timeout else { return }
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            if !Task.isCancelled, process.isRunning { process.terminate() }
        }
        defer { watchdog.cancel() }

        return await withCheckedContinuation { (continuation: CheckedContinuation<Int32, Never>) in
            process.terminationHandler = { finished in continuation.resume(returning: finished.terminationStatus) }
            do {
                try process.run()
            } catch {
                process.terminationHandler = nil
                logger.error("无法启动 \(executable.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
                continuation.resume(returning: -1)
            }
        }
    }

    // MARK: - Update log

    private static func openForAppend(_ url: URL) -> FileHandle? {
        let manager = FileManager.default
        if !manager.fileExists(atPath: url.path) {
            manager.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: url.path) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }

    private func append(to url: URL, _ line: String) {
        guard let handle = Self.openForAppend(url) else { return }
        handle.write(Data("\(line)\n".utf8))
        try? handle.close()
    }
}

private let logger = os.Logger(subsystem: "com.deepseek.harness", category: "updater")
