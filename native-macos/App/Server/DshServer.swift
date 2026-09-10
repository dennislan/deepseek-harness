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
    /// The dsh tree in effect; re-resolved by ``restart()`` after an update.
    private var projectRoot: URL
    /// Locations of the updatable runtime, derived from `DSH_HOME`.
    private let layout: RuntimeLayout
    private let defaultPort: Int = 6080

    var status: Status = .stopped
    var url: URL?

    var statusText: String {
        switch status {
        case .stopped:    return "Loading..."
        case .starting:   return "starting..."
        case .running:    return "Running"
        case .failed(let msg): return "启动失败: \(msg)"
        }
    }

    // MARK: - Init

    init() {
        let layout = RuntimeLayout(home: RuntimeLayout.resolveHome())
        let projectRoot = Self.resolveProjectRoot(layout: layout)
        self.layout = layout
        self.projectRoot = projectRoot
        logger.info("projectRoot = \(projectRoot.path)")
    }

    // MARK: - Lifecycle

    func start() async {
        guard case .stopped = status else { return }
        status = .starting
        postStatusChanged()

        // Runtime resolution order: embedded bundle node → DSH_NODE_PATH →
        // well-known install locations → PATH. The embedded runtime makes the
        // app self-contained on a clean macOS; the rest stay as explicit or
        // debugging fallbacks.
        guard let node = NodeRuntime.resolve() else {
            status = .failed(
                "找不到可用的 Node.js 运行时。\n\n" +
                "• 内嵌运行时缺失：Contents/Resources/node/bin/node 不存在（重新打包应先运行 build-release.sh 内嵌 Node）。\n" +
                "• 且未设置环境变量 DSH_NODE_PATH。\n" +
                "• 且系统未安装 Node 22+。\n\n" +
                "请安装 Node.js 22+（https://nodejs.org），或设置 DSH_NODE_PATH 指向 node 可执行文件。"
            )
            postStatusChanged()
            return
        }
        let resolvedNode = node.executable.path

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
        let configuredHome = ProcessInfo.processInfo.environment["DSH_HOME"]?
            .trimmingCharacters(in: .whitespaces) ?? ""
        let homePath: String
        if configuredHome.isEmpty {
            do {
                try FileManager.default.createDirectory(at: layout.home, withIntermediateDirectories: true)
            } catch {
                status = .failed("无法创建 DSH_HOME 目录 (\(layout.home.path)): \(error.localizedDescription)")
                postStatusChanged()
                return
            }
            homePath = layout.home.path
        } else {
            homePath = configuredHome
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
        process.arguments = [binPath.path, "--profile", "web", "--port", "\(port)", "--no-open"]

        // Persist user data under ~/.dsh; an explicit DSH_HOME wins (matches
        // dsh-home-paths precedence: configured > $DSH_HOME > ~/.dsh).
        var env = process.environment ?? [:]
        env["DSH_HOME"] = homePath
        // The dsh child (and the plugin market it hosts) needs a PATH that
        // finds the user's pnpm. A GUI launch inherits only launchd's minimal
        // PATH (/usr/bin:/bin:…) with no Node or pnpm, so the market's own
        // pnpm auto-provisioner pulls a *second* pnpm whose content-addressable
        // store diverges from the one that built the profile — every later
        // `pnpm add`/`update` then fails with ERR_PNPM_UNEXPECTED_STORE. Expand
        // PATH with the resolved Node bin, the user's nvm Node bins, and the
        // common macOS Node/pnpm locations, preserving any inherited PATH.
        env["PATH"] = Self.augmentedChildPath(inheriting: env["PATH"], resolvedNodeBin: (resolvedNode as NSString).deletingLastPathComponent)
        // Same story for PNPM_HOME: pnpm's global store defaults to it, so a
        // GUI launch that drops it can land on a different store than the one
        // the profile was built against.
        if env["PNPM_HOME"]?.isEmpty ?? true {
            env["PNPM_HOME"] = (NSHomeDirectory() as NSString).appendingPathComponent("Library/pnpm")
        }
        // The plugin market is a user-driven sandbox where installing a
        // just-published plugin is the point; pnpm ≥11's default fresh-release
        // hold would otherwise block every change to a profile that contains a
        // young package (ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION). The market
        // already retries once with a one-shot bypass, but a GUI launch has no
        // shell to set it in, so export the equivalent npm-style config so the
        // market's pnpm spawn inherits the relaxed policy.
        if env["npm_config_minimumReleaseAge"]?.isEmpty ?? true {
            env["npm_config_minimumReleaseAge"] = "0"
        }
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
                    var newURL = URL(string: "http://127.0.0.1:\(port)")!
                    if let token = await Self.extractTokenWithRetry(from: logURL) {
                        newURL = newURL.appending(queryItems: [URLQueryItem(name: "token", value: token)])
                        logger.info("✅ dsh ready with token: \(newURL.absoluteString)")
                    } else {
                        logger.info("✅ dsh ready (no token found): \(newURL.absoluteString)")
                    }
                    self.url = newURL
                    self.status = .running
                    logger.info("📤 Posting notifications, url=\(self.url?.absoluteString ?? "nil")")
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

    /// Stops dsh, re-resolves the runtime after an update, and starts it again.
    ///
    /// The app process stays alive; the web view reloads through the usual
    /// `urlChanged` notification once the new child answers.
    func restart() async {
        stop()
        projectRoot = Self.resolveProjectRoot(layout: layout)
        logger.info("restarted with runtime root \(self.projectRoot.path)")
        await start()
    }

    /// The dsh tree currently in effect.
    /// - Returns: the directory dsh is launched from.
    func runtimeRoot() -> URL { projectRoot }

    /// Version of the runtime the app runs, read from the dsh manifest.
    /// - Returns: nil when the manifest is missing or unreadable.
    func runtimeVersion() -> RuntimeVersion? { layout.installedVersion(at: projectRoot) }

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

    /// Extracts the authentication token from the dsh boot log.
    /// The log contains a line like: `dsh web: http://127.0.0.1:6080/?token=abc123`
    private static func extractToken(from logURL: URL) -> String? {
        guard let data = try? Data(contentsOf: logURL),
              let text = String(data: data, encoding: .utf8) else {
            return nil
        }
        let pattern = #"dsh web: .*\?token=([^&\s]+)"#
        let regex = try? NSRegularExpression(pattern: pattern)
        let range = NSRange(location: 0, length: text.utf16.count)
        if let match = regex?.firstMatch(in: text, options: [], range: range),
           let range = Range(match.range(at: 1), in: text) {
            return String(text[range])
        }
        return nil
    }

    /// Extracts token with retries to handle log file buffering delay.
    private static func extractTokenWithRetry(from logURL: URL) async -> String? {
        for _ in 1...10 {
            if let token = extractToken(from: logURL) {
                return token
            }
            try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
        }
        return nil
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
            // Accept any HTTP response (200, 303, 401, etc.) as long as the server responds.
            // The dsh web server returns 401 for / without token, 303 with token.
            // Any response means the server is up and running.
            if let httpResponse = response as? HTTPURLResponse {
                return httpResponse.statusCode > 0 && httpResponse.statusCode < 600
            }
            return false
        } catch { return false }
    }

    private func chosenPort() -> Int {
        if let envPort = ProcessInfo.processInfo.environment["DSH_PORT"],
           let port = Int(envPort), port > 0 && port <= 65535 { return port }
        return defaultPort
    }

    /// Builds the `PATH` for the dsh child so it can locate Node and pnpm.
    /// A GUI launch inherits only launchd's minimal PATH (no Node, no pnpm),
    /// which forces the plugin market to auto-provision a second pnpm whose
    /// store diverges from the profile's — the `ERR_PNPM_UNEXPECTED_STORE`
    /// install failure. The resolved Node bin and the user's nvm Node bins
    /// lead, followed by the common macOS locations; any PATH already present
    /// (e.g. a terminal-launched app) is preserved and de-duplicated.
    /// - Parameters:
    ///   - inherited: the parent process PATH, or nil.
    ///   - resolvedNodeBin: the bin directory of the Node chosen to run dsh.
    /// - Returns: a de-duplicated, order-preserving PATH string.
    private static func augmentedChildPath(inheriting inherited: String?, resolvedNodeBin: String) -> String {
        var candidates: [String] = []
        candidates.append(resolvedNodeBin)
        if let home = NSHomeDirectory().isEmpty ? nil : NSHomeDirectory() as String? {
            let nvmRoot = (home as NSString).appendingPathComponent(".nvm/versions/node")
            if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmRoot) {
                for version in versions where !version.hasPrefix(".") {
                    candidates.append((nvmRoot as NSString).appendingPathComponent("\(version)/bin"))
                }
            }
        }
        candidates.append(contentsOf: [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ])
        if let inherited {
            candidates.append(contentsOf: inherited.split(separator: ":").map(String.init))
        }
        var seen = Set<String>()
        var result: [String] = []
        for candidate in candidates {
            guard !candidate.isEmpty, !seen.contains(candidate) else { continue }
            seen.insert(candidate)
            result.append(candidate)
        }
        return result.joined(separator: ":")
    }

    // MARK: - Project Root Resolution

    /// Resolves the dsh tree the app runs, in this order:
    /// 1. `DSH_PROJECT_ROOT`, the development escape hatch;
    /// 2. the newer of the updatable runtime and the runtime shipped in the
    ///    bundle, so a stale downloaded runtime cannot shadow a fresh `.app`;
    /// 3. walking up from the executable, for `swiftc` development builds.
    /// - Parameter layout: the user runtime layout consulted for an update.
    /// - Returns: the directory holding `apps/cli/lib/bin.js`.
    static func resolveProjectRoot(layout: RuntimeLayout) -> URL {
        if let envRoot = ProcessInfo.processInfo.environment["DSH_PROJECT_ROOT"] {
            return URL(fileURLWithPath: envRoot)
        }
        let bundled = Bundle.main.resourceURL?
            .appendingPathComponent(RuntimeLayout.runtimeDirectoryName, isDirectory: true)
        if let root = preferredRuntime(installed: layout.dshRoot, bundled: bundled, layout: layout) {
            logger.info("using runtime root: \(root.path)")
            return root
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
            "无法定位 dsh 项目根目录：已检查用户运行时(\(layout.dshRoot.path))、应用包内 dsh-root，" +
            "并从可执行文件所在目录向上逐级探测 apps/cli/lib/bin.js 直至文件系统根目录。" +
            "请设置 DSH_PROJECT_ROOT 环境变量，或确保二进制位于 deepseek-harness 仓库内。"
        )
    }

    /// Picks the runtime to run: the higher installed version wins, and an
    /// unreadable or incomplete tree loses to a usable one.
    /// - Parameters:
    ///   - installed: the user runtime root.
    ///   - bundled: the runtime inside the app bundle, when the bundle has one.
    ///   - layout: used to read each tree's dsh manifest.
    /// - Returns: the preferred usable runtime, or nil when neither is usable.
    private static func preferredRuntime(installed: URL, bundled: URL?, layout: RuntimeLayout) -> URL? {
        let manager = FileManager.default
        let cli = "apps/cli/lib/bin.js"
        let installedUsable = manager.fileExists(atPath: installed.appendingPathComponent(cli).path)
        let bundledUsable = bundled.map {
            $0.path != installed.path && manager.fileExists(atPath: $0.appendingPathComponent(cli).path)
        } ?? false

        guard installedUsable, bundledUsable, let bundled else {
            return installedUsable ? installed : (bundledUsable ? bundled : nil)
        }
        let installedVersion = layout.installedVersion(at: installed)
        let bundledVersion = layout.installedVersion(at: bundled)
        if let bundledVersion, let installedVersion, bundledVersion > installedVersion {
            return bundled
        }
        return installed
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
