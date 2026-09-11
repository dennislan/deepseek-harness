import Foundation
import os

/// Stage of an in-flight runtime installation, surfaced to the UI.
enum InstallStep: String, Sendable, Equatable {
    case preparing, installing, pruning, publishing

    /// Localized label shown while this stage runs.
    var label: String {
        switch self {
        case .preparing:   return "准备更新"
        case .installing:  return "下载并安装运行时"
        case .pruning:     return "精简运行时文件"
        case .publishing:  return "写入新运行时"
        }
    }
}

/// Installs a published `@deepseek-ai/dsh` closure into the user runtime root.
///
/// Mirrors the npm path of `native-macos/Scripts/build-release.sh`: install the
/// production closure, prune it, create the two bridge symlinks dsh resolves
/// through, verify it, and publish it as the runtime the next launch runs.
/// Assembling happens in a staging directory and switching is a directory
/// rename, so a failed attempt never damages the runtime in service.
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

    /// A runtime published by an update and applied at a later launch.
    struct Activation: Equatable, Sendable {
        /// The version now in effect.
        let version: RuntimeVersion
        /// Whether the replaced runtime is kept as `dsh-root.previous`.
        let hasPrevious: Bool
    }

    /// Package installed for every runtime update.
    static let packageName = "@deepseek-ai/dsh"
    /// Entry point that must exist in a runtime root before it can be activated.
    static let cliPath = "apps/cli/lib/bin.js"
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

    // MARK: - Stage

    /// Builds `version` and publishes it as the runtime the next launch runs.
    ///
    /// The runtime in service is untouched throughout: the closure is assembled
    /// in a staging directory and only a verified tree is moved into place.
    /// - Parameters:
    ///   - version: the version to install.
    ///   - progress: called with each stage from a background context.
    /// - Returns: the runtime root now waiting to be activated.
    /// - Throws: ``Failure`` describing the failed stage.
    func stage(
        version: RuntimeVersion,
        progress: @escaping @Sendable (InstallStep) -> Void
    ) async throws -> URL {
        try layout.prepare()
        progress(.preparing)

        // The log opens before the first fallible step, so an attempt that dies
        // in the lock, the free-space check, or npm resolution leaves a file
        // saying why instead of only an os_log line.
        let log = layout.updateLogURL()
        append(to: log, "== 更新 @deepseek-ai/dsh 到 \(version.raw) ==")
        logger.info("更新运行时到 \(version.raw, privacy: .public)，日志 \(log.path, privacy: .public)")

        do {
            try await assemble(version: version, log: log, progress: progress)
        } catch {
            append(to: log, "== 更新未完成：\(error) ==")
            logger.error("更新 \(version.raw, privacy: .public) 未完成：\(String(describing: error), privacy: .public)")
            throw error
        }
        append(to: log, "== 更新完成：\(version.raw) 已就绪，下次启动生效 ==")
        logger.info("运行时 \(version.raw, privacy: .public) 已就绪，下次启动生效")
        return layout.pendingRoot
    }

    /// Takes the update lock and runs the staged install through to the tree the
    /// next launch activates: npm closure, prune, bridge symlinks, precheck, publish.
    /// - Parameters:
    ///   - version: the version to install.
    ///   - log: the update log that receives every command and its output.
    ///   - progress: called with each stage from a background context.
    /// - Throws: ``Failure`` describing the failed stage.
    private func assemble(
        version: RuntimeVersion,
        log: URL,
        progress: @escaping @Sendable (InstallStep) -> Void
    ) async throws {
        let lock = try layout.acquireLock()
        defer { lock.release() }
        layout.cleanStaleStaging()

        try requireSpace()
        let npm = try requireNpm()
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
        let npmStatus = await Self.run(
            node.executable, installArguments,
            loggingTo: log,
            environment: node.childEnvironment()
        )
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

        progress(.publishing)
        try publish(stagedRoot)
    }

    /// Applies the runtime a previous session published.
    ///
    /// Renames only: no Node and no npm run here, so activation costs no startup
    /// delay. A pending tree that is unreadable, incomplete, or not newer than
    /// the runtime in service is discarded instead of applied.
    /// - Parameter layout: runtime locations.
    /// - Returns: the activated runtime, or nil when there was nothing to apply.
    static func activatePending(layout: RuntimeLayout) -> Activation? {
        let manager = FileManager.default
        let pending = layout.pendingRoot
        guard manager.fileExists(atPath: pending.path) else { return nil }

        let current = layout.installedVersion(at: layout.dshRoot)
        guard let version = layout.installedVersion(at: pending),
              manager.fileExists(atPath: pending.appendingPathComponent(cliPath).path) else {
            logger.error("待生效运行时不可用，已丢弃 \(pending.path, privacy: .public)")
            try? manager.removeItem(at: pending)
            return nil
        }
        guard current.map({ version > $0 }) ?? true else {
            logger.error(
                "待生效运行时 \(version.raw, privacy: .public) 不高于当前 \(current?.raw ?? "无", privacy: .public)，已丢弃"
            )
            try? manager.removeItem(at: pending)
            return nil
        }

        try? manager.removeItem(at: layout.previousRoot)
        var keptPrevious = false
        if manager.fileExists(atPath: layout.dshRoot.path) {
            do {
                try manager.moveItem(at: layout.dshRoot, to: layout.previousRoot)
                keptPrevious = true
            } catch {
                logger.error("备份当前运行时失败: \(error.localizedDescription, privacy: .public)")
                return nil
            }
        }
        do {
            try manager.moveItem(at: pending, to: layout.dshRoot)
        } catch {
            logger.error("应用待生效运行时失败: \(error.localizedDescription, privacy: .public)")
            if keptPrevious { try? manager.moveItem(at: layout.previousRoot, to: layout.dshRoot) }
            return nil
        }
        logger.info("运行时 \(version.raw, privacy: .public) 已生效")
        return Activation(version: version, hasPrevious: keptPrevious)
    }

    /// Restores the runtime replaced by the most recent activation.
    /// - Returns: the runtime root now in effect.
    /// - Throws: ``Failure`` when no previous runtime was kept.
    func rollback() throws -> URL {
        try Self.rollback(layout: layout)
    }

    /// Restores the runtime replaced by the most recent activation.
    ///
    /// Layout only: neither Node nor npm is needed to move a directory back.
    /// - Parameter layout: runtime locations.
    /// - Returns: the runtime root now in effect.
    /// - Throws: ``Failure`` when no previous runtime was kept.
    static func rollback(layout: RuntimeLayout) throws -> URL {
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
        logger.info("运行时已回滚到 \(layout.dshRoot.path, privacy: .public)")
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
            Self.cliPath,
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

        let cli = root.appendingPathComponent(Self.cliPath)
        let log = layout.logsDirectory.appendingPathComponent("verify-\(version.raw).log")
        append(to: log, "$ node \(cli.path) --version")
        let status = await Self.run(
            node.executable,
            [cli.path, "--version"],
            loggingTo: log,
            environment: node.childEnvironment(),
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
            let status = await Self.run(
                node.executable, [tool.path, modules],
                loggingTo: log,
                environment: node.childEnvironment()
            )
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

    /// Moves the verified tree to the runtime root the next launch activates.
    private func publish(_ root: URL) throws {
        let manager = FileManager.default
        try? manager.removeItem(at: layout.pendingRoot)
        do {
            try manager.moveItem(at: root, to: layout.pendingRoot)
        } catch {
            throw Failure.fileSystem("写入待生效运行时失败：\(error.localizedDescription)")
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
    ///
    /// The caller supplies the environment because a child that only inherits
    /// the app's must still find Node on `PATH`: npm runs a dependency's install
    /// script through `sh -c`, which resolves `node` from `PATH` and fails with
    /// exit 127 when a GUI launch left it at launchd's minimal value.
    /// - Parameters:
    ///   - executable: the program to run.
    ///   - arguments: its arguments.
    ///   - logURL: receives combined stdout and stderr.
    ///   - environment: the child environment, typically ``NodeRuntime/childEnvironment(inheriting:)``.
    ///   - timeout: seconds before the process is terminated; nil waits forever.
    /// - Returns: the exit status, or -1 when the process could not be started.
    static func run(
        _ executable: URL,
        _ arguments: [String],
        loggingTo logURL: URL,
        environment: [String: String],
        timeout: TimeInterval? = nil
    ) async -> Int32 {
        guard let handle = openForAppend(logURL) else { return -1 }
        defer { try? handle.close() }

        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
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
