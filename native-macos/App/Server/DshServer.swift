import Foundation
import os
import Darwin

/// Manages the dsh Node.js HTTP server process as a child of the Swift app.
actor DshServer {
    enum Status: Equatable {
        case stopped, starting, running, failed(String)
    }

    // MARK: - Properties

    private var process: Process?
    private let projectRoot: URL
    private let defaultPort: Int = 6080

    var status: Status = .stopped
    var url: URL?

    var statusText: String {
        switch status {
        case .stopped:    return "Loading..."
        case .starting:   return "正在启动 dsh 服务…"
        case .running:    return "已就绪"
        case .failed(let msg): return "启动失败: \(msg)"
        }
    }

    // MARK: - Init

    init() {
        self.projectRoot = Self.resolveProjectRoot()
        logger.info("projectRoot = \(self.projectRoot.path)")
    }

    // MARK: - Lifecycle

    func start() async {
        guard case .stopped = status else { return }
        status = .starting
        postStatusChanged()

        // Runtime resolution order: embedded bundle node → DSH_NODE_PATH →
        // system node (locateNode/findNodeInEnv). The embedded runtime makes the
        // app self-contained on a clean macOS; DSH_NODE_PATH and system node
        // remain as explicit/debugging fallbacks.
        let nodePath: String? = bundledNode()
            ?? ProcessInfo.processInfo.environment["DSH_NODE_PATH"]
            ?? locateNode()
            ?? findNodeInEnv()

        guard let resolvedNode = nodePath, FileManager.default.fileExists(atPath: resolvedNode) else {
            status = .failed(
                "找不到可用的 Node.js 运行时。\n\n" +
                "• 内嵌运行时缺失：Contents/Resources/node/bin/node 不存在（重新打包应先运行 release.sh 内嵌 Node）。\n" +
                "• 且未设置环境变量 DSH_NODE_PATH。\n" +
                "• 且系统未安装 Node 22+。\n\n" +
                "请安装 Node.js 22+（https://nodejs.org），或设置 DSH_NODE_PATH 指向 node 可执行文件。"
            )
            postStatusChanged()
            return
        }

        let binPath = projectRoot.appendingPathComponent("apps/cli/lib/bin.js")
        guard FileManager.default.fileExists(atPath: binPath.path) else {
            status = .failed(
                "dsh CLI 未编译。\n请先在项目根目录运行：pnpm run build\n\n" +
                "projectRoot: \(projectRoot.path)"
            )
            postStatusChanged()
            return
        }

        let frontendDist = projectRoot.appendingPathComponent("apps/web/dist")
        guard FileManager.default.fileExists(atPath: frontendDist.path) else {
            status = .failed(
                "前端 dist 不存在。\n请先在项目根目录运行：pnpm run build\n\n" +
                "frontendDist: \(frontendDist.path)"
            )
            postStatusChanged()
            return
        }

        let port = chosenPort()

        // A force-quit or crash can orphan the dsh child of an earlier run,
        // leaving it listening on the chosen port; a fresh dsh then exits with
        // EADDRINUSE and the app shows only "code=1". Terminate stale dsh
        // processes on the port before launching; a foreign owner fails loud
        // with an actionable message instead of a bare exit code.
        let envHome = ProcessInfo.processInfo.environment["DSH_HOME"]?.trimmingCharacters(in: .whitespaces) ?? ""
        let homePath: String
        if envHome.isEmpty {
            let defaultHome = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".dsh")
            do {
                try FileManager.default.createDirectory(
                    at: defaultHome,
                    withIntermediateDirectories: true
                )
            } catch {
                status = .failed("无法创建 DSH_HOME 目录 (\(defaultHome.path)): \(error.localizedDescription)")
                postStatusChanged()
                return
            }
            homePath = defaultHome.path
        } else {
            homePath = envHome
        }
        let logURL = Self.prepareLog(homePath: homePath, port: port)

        if let conflict = clearStaleServer(on: port) {
            Self.appendToLog(logURL, "启动失败: \(conflict)")
            status = .failed(conflict)
            postStatusChanged()
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: resolvedNode)
        process.arguments = [binPath.path, "--profile", "web", "--port", "\(port)"]

        // Persist user data under ~/.dsh; an explicit DSH_HOME wins (matches
        // dsh-home-paths precedence: configured > $DSH_HOME > ~/.dsh).
        var env = process.environment ?? [:]
        env["DSH_HOME"] = homePath
        process.environment = env
        // Capture dsh boot output so a non-zero exit shows the real error in
        // the app's status instead of a bare code=1.
        if let logHandle = FileHandle(forWritingAtPath: logURL.path) {
            process.standardOutput = logHandle
            process.standardError = logHandle
        }

        do {
            try process.run()
            self.process = process
            Self.activeTerminator = { [weak process] in
                guard let process else { return }
                Self.terminate(process)
            }
            logger.info("dsh started PID=\(process.processIdentifier) port=\(port)")

            for attempt in 1...120 {
                try await Task.sleep(nanoseconds: 500_000_000)

                if !process.isRunning {
                    if process.terminationStatus != 0 {
                        let detail = Self.tail(of: logURL, lines: 15)
                        status = .failed(
                            "dsh 进程意外退出 (code=\(process.terminationStatus))" +
                                (detail.isEmpty ? "" : "\n\(detail)")
                        )
                    } else {
                        status = .failed("dsh 进程已退出 (code=0)")
                    }
                    postStatusChanged()
                    return
                }

                if await checkReady(port: port) {
                    let newURL = URL(string: "http://127.0.0.1:\(port)")
                    self.url = newURL
                    self.status = .running
                    logger.info("✅ dsh ready http://127.0.0.1:\(port)")
                    postStatusChanged()
                    postURLChanged()
                    return
                }

                if attempt % 20 == 0 {
                    logger.info("等待 dsh 就绪... \(attempt)/120")
                }
            }

            status = .failed("服务器启动超时 (60s)")
            postStatusChanged()

        } catch {
            status = .failed(error.localizedDescription)
            postStatusChanged()
        }
    }

    func stop() {
        Self.activeTerminator = nil
        if let process {
            Self.terminate(process)
        }
        process = nil
        url = nil
        status = .stopped
        logger.info("dsh stopped")
        postStatusChanged()
        postURLChanged()
    }

    // MARK: - Stale process recovery

    /// Terminates stale dsh processes listening on `port` (children of earlier
    /// app runs). Returns nil when the port is free or owned only by our dsh;
    /// returns an actionable message when a foreign process owns it.
    private func clearStaleServer(on port: Int) -> String? {
        var foreign: [Int] = []
        for pid in listeningPIDs(on: port) {
            let command = commandLine(of: pid) ?? ""
            if isDshCommand(command, port: port) {
                logger.info("terminating stale dsh (PID \(pid)) on port \(port)")
                Self.terminate(pid: pid)
            } else {
                foreign.append(pid)
            }
        }
        guard let pid = foreign.first else { return nil }
        return "端口 \(port) 已被其他程序占用 (PID \(pid))，无法启动 dsh。请退出占用该端口的程序，或设置 DSH_PORT 更换端口。"
    }

    private func isDshCommand(_ command: String, port: Int) -> Bool {
        let binPath = projectRoot.appendingPathComponent("apps/cli/lib/bin.js").path
        return command.contains(binPath) || (
            command.contains("bin.js")
                && command.contains("--profile")
                && command.contains("web")
                && command.contains("--port \(port)")
        )
    }

    private func listeningPIDs(on port: Int) -> [Int] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return []
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text.split(whereSeparator: \.isNewline).compactMap {
            Int($0.trimmingCharacters(in: .whitespaces))
        }
    }

    private func commandLine(of pid: Int) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-p", "\(pid)", "-o", "command="]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Termination

    private static func terminate(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning && Date() < deadline {
            usleep(100_000)
        }
        if process.isRunning {
            kill(pid_t(process.processIdentifier), SIGKILL)
        }
        process.waitUntilExit()
    }

    private static func terminate(pid: Int) {
        kill(pid_t(pid), SIGTERM)
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            usleep(100_000)
            if kill(pid_t(pid), 0) != 0 { return }
        }
        kill(pid_t(pid), SIGKILL)
    }

    // MARK: - Boot log

    private static func prepareLog(homePath: String, port: Int) -> URL {
        let logsDir = URL(fileURLWithPath: homePath)
            .appendingPathComponent("logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
        let url = logsDir.appendingPathComponent("dsh-\(port).log")
        if FileManager.default.createFile(atPath: url.path, contents: nil) {
            if let handle = FileHandle(forWritingAtPath: url.path) {
                handle.truncateFile(atOffset: 0)
                try? handle.close()
            }
        }
        return url
    }

    private static func appendToLog(_ url: URL, _ message: String) {
        guard let handle = FileHandle(forWritingAtPath: url.path) else { return }
        handle.seekToEndOfFile()
        handle.write(Data((message + "\n").utf8))
        try? handle.close()
    }

    private static func tail(of url: URL, lines: Int) -> String {
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else {
            return ""
        }
        return text.split(separator: "\n", omittingEmptySubsequences: false)
            .suffix(lines)
            .joined(separator: "\n")
    }

    // MARK: - Notifications (called from actor context, safe)

    func postStatusChanged() {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Self.statusChanged, object: self)
        }
    }

    func postURLChanged() {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Self.urlChanged, object: self)
        }
    }

    // MARK: - Helpers

    private func checkReady(port: Int) async -> Bool {
        guard let checkURL = URL(string: "http://127.0.0.1:\(port)/") else { return false }
        do {
            let (_, response) = try await URLSession.shared.data(from: checkURL)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch { return false }
    }

    private func chosenPort() -> Int {
        if let envPort = ProcessInfo.processInfo.environment["DSH_PORT"],
           let port = Int(envPort), port > 0 && port <= 65535 { return port }
        return defaultPort
    }

    /// Returns the path to the app-bundled Node runtime
    /// (Contents/Resources/node/bin/node), or nil when it is absent. This makes
    /// the app self-contained on a clean macOS with no system Node.
    private func bundledNode() -> String? {
        guard let resourceURL = Bundle.main.resourceURL else { return nil }
        let nodeURL = resourceURL.appendingPathComponent("node/bin/node")
        return FileManager.default.fileExists(atPath: nodeURL.path) ? nodeURL.path : nil
    }

    private func locateNode() -> String? {        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.fileExists(atPath: candidate) { return candidate }
        }
        return nil
    }

    private func findNodeInEnv() -> String? {
        guard let path = ProcessInfo.processInfo.environment["PATH"] else { return nil }
        for dir in path.split(separator: ":") {
            let nodePath = URL(fileURLWithPath: "\(dir)/node")
            if FileManager.default.fileExists(atPath: nodePath.path) { return nodePath.path }
        }
        return nil
    }

    // MARK: - Project Root Resolution

    static func resolveProjectRoot() -> URL {
        if let envRoot = ProcessInfo.processInfo.environment["DSH_PROJECT_ROOT"] {
            return URL(fileURLWithPath: envRoot)
        }
        // Bundled app: Contents/Resources/dsh-root/
        if let bundleURL = Bundle.main.resourceURL?
            .appendingPathComponent("dsh-root", isDirectory: true),
           FileManager.default.fileExists(atPath: bundleURL.appendingPathComponent("apps/cli/lib").path) {
            logger.info("using bundled dsh-root: \(bundleURL.path)")
            return bundleURL
        }
        // Dev build: walk up from the executable until the dsh CLI is found
        let exeURL = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0])
        var dir = exeURL.deletingLastPathComponent()
        while true {
            let marker = dir.appendingPathComponent("apps/cli/lib/bin.js")
            if FileManager.default.fileExists(atPath: marker.path) {
                logger.info("using dev project root: \(dir.path)")
                return dir
            }
            let parent = dir.deletingLastPathComponent()
            if parent == dir { break }
            dir = parent
        }
        fatalError(
            "无法定位 dsh 项目根目录：从可执行文件所在目录向上逐级探测 apps/cli/lib/bin.js " +
            "直至文件系统根目录均未命中。请设置 DSH_PROJECT_ROOT 环境变量，或确保二进制位于 deepseek-harness 仓库内。"
        )
    }
}

// MARK: - Notification Names

extension DshServer {
    static let statusChanged = Notification.Name("DeepSeekHarness.DshServer.statusChanged")
    static let urlChanged    = Notification.Name("DeepSeekHarness.DshServer.urlChanged")

    /// Synchronous terminator invoked from `applicationWillTerminate`, so a
    /// normal quit (Cmd+Q / Apple menu Quit) stops the dsh child before the
    /// process exits. Cleared on stop; a force-quit still orphans the child,
    /// which the next launch recovers from via `clearStaleServer`.
    nonisolated(unsafe) static var activeTerminator: (() -> Void)?
}

private let logger = os.Logger(subsystem: "com.deepseek.harness", category: "dsh-server")
