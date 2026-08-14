import Foundation
import os

/// Manages the dsh Node.js HTTP server process as a child of the Swift app.
/// The server serves the Harness web UI on 127.0.0.1:<port>.
///
/// Project root resolution (in order):
///   1. DSH_PROJECT_ROOT env var (for CI / custom layouts)
///   2. dsh-root/ inside the .app bundle (for packaged app)
///   3. Three levels up from the running binary (swiftc dev builds)
///   4. Fall back to the repo default
actor DshServer {
    enum Status: Equatable {
        case stopped, starting, running, failed(String)
    }

    // MARK: - Properties

    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?

    private let projectRoot: URL
    private let defaultPort: Int = 3080

    var status: Status = .stopped {
        didSet { NotificationCenter.default.post(name: Self.statusChanged, object: self) }
    }

    var url: URL?
    var statusText: String {
        switch status {
        case .stopped:    return "未启动"
        case .starting:   return "正在启动 dsh 服务…"
        case .running:    return "已就绪"
        case .failed(let msg): return "启动失败: \(msg)"
        }
    }

    // MARK: - Notification Center

    static let statusChanged = Notification.Name("DeepSeekHarness.DshServer.statusChanged")

    // MARK: - Init

    init() {
        self.projectRoot = Self.resolveProjectRoot()
        logger.info("projectRoot = \(self.projectRoot.path)")
    }

    // MARK: - Lifecycle

    func start() async {
        guard case .stopped = status else { return }
        status = .starting

        let nodePath: String
        if let envNode = ProcessInfo.processInfo.environment["DSH_NODE_PATH"] {
            nodePath = envNode
        } else {
            nodePath = locateNode() ?? findNodeInEnv() ?? "/usr/local/bin/node"
        }

        guard FileManager.default.fileExists(atPath: nodePath) else {
            status = .failed(
                "找不到 Node.js: \(nodePath)\n\n" +
                "请确保 Node 22+ 已安装，或通过 DSH_NODE_PATH 环境变量指定路径。"
            )
            return
        }

        let binPath = projectRoot.appendingPathComponent("apps/cli/lib/bin.js")
        guard FileManager.default.fileExists(atPath: binPath.path) else {
            status = .failed(
                "dsh CLI 未编译。\n\n请在项目根目录运行：\n  pnpm run build\n\n" +
                "projectRoot: \(projectRoot.path)"
            )
            return
        }

        let frontendDist = projectRoot.appendingPathComponent("apps/web/dist")
        guard FileManager.default.fileExists(atPath: frontendDist.path) else {
            status = .failed(
                "前端 dist 不存在。\n\n请在项目根目录运行：\n  pnpm run build\n\n" +
                "frontendDist: \(frontendDist.path)"
            )
            return
        }

        let port = chosenPort()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [
            binPath.path,
            "--profile", "web",
            "--port", "\(port)"
        ]

        // Inherit all environment variables (DEEPSEEK_API_KEY etc.)
        var env = ProcessInfo.processInfo.environment
        // Use a writable DSH_HOME so healProfilesModuleFallback can manage symlinks
        // without hitting the sandbox-blocked ~/.dsh directory.
        env["DSH_HOME"] = URL(fileURLWithPath: "/tmp").appendingPathComponent("dsh-\(ProcessInfo.processInfo.processIdentifier)").path
        process.environment = env

        // Redirect stdio to pipes
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        self.stdoutPipe = stdout
        self.stderrPipe = stderr

        // Read stdout/stderr
        let logQueue = DispatchQueue(label: "com.deepseek.harness.dsh-server")
        stdout.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            if let line = String(data: data, encoding: .utf8) {
                logQueue.async {
                    for piece in line.split(separator: "\n") where !piece.trimmingCharacters(in: .whitespaces).isEmpty {
                        logger.info("◉ dsh: \(piece)")
                    }
                }
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            if let line = String(data: data, encoding: .utf8) {
                logQueue.async {
                    for piece in line.split(separator: "\n") where !piece.trimmingCharacters(in: .whitespaces).isEmpty {
                        logger.error("✗ dsh: \(piece)")
                    }
                }
            }
        }

        do {
            try process.run()
            self.process = process
            logger.info("dsh 进程已启动 PID=\(process.processIdentifier) port=\(port)")

            // Poll until server is ready (max 60 s)
            for attempt in 1...120 {
                try await Task.sleep(nanoseconds: 500_000_000)

                if !process.isRunning {
                    if process.terminationStatus != 0 {
                        status = .failed("dsh 进程意外退出 (code=\(process.terminationStatus))")
                    }
                    return
                }

                if await self.checkReady(port: port) {
                    self.url = URL(string: "http://127.0.0.1:\(port)")
                    self.status = .running
                    logger.info("✅ dsh 服务就绪 http://127.0.0.1:\(port)")
                    return
                }

                if attempt % 20 == 0 {
                    logger.info("等待 dsh 就绪... \(attempt)/120")
                }
            }

            status = .failed("服务器启动超时 (60s)")

        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    func stop() {
        process?.terminate()
        process?.waitUntilExit()
        process = nil
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        url = nil
        status = .stopped
        logger.info("dsh 服务已停止")
    }

    // MARK: - Helpers

    private func checkReady(port: Int) async -> Bool {
        guard let checkURL = URL(string: "http://127.0.0.1:\(port)/") else { return false }
        do {
            let (_, response) = try await URLSession.shared.data(from: checkURL)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private func chosenPort() -> Int {
        if let envPort = ProcessInfo.processInfo.environment["DSH_PORT"],
           let port = Int(envPort), port > 0 && port <= 65535 {
            return port
        }
        return defaultPort
    }

    private func locateNode() -> String? {
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        for candidate in candidates {
            if FileManager.default.fileExists(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    private func findNodeInEnv() -> String? {
        guard let path = ProcessInfo.processInfo.environment["PATH"] else { return nil }
        for dir in path.split(separator: ":") {
            let nodePath = URL(fileURLWithPath: "\(dir)/node")
            if FileManager.default.fileExists(atPath: nodePath.path) {
                return nodePath.path
            }
        }
        return nil
    }

    // MARK: - Project Root Resolution

    /// Resolve the dsh project root directory. Resolution order:
    ///   1. DSH_PROJECT_ROOT env var
    ///   2. dsh-root/ resource bundle (packaged .app)
    ///   3. Three levels up from executable (swiftc dev build)
    ///   4. Fall back to the repo default
    static func resolveProjectRoot() -> URL {
        // 1. Explicit override
        if let envRoot = ProcessInfo.processInfo.environment["DSH_PROJECT_ROOT"] {
            return URL(fileURLWithPath: envRoot)
        }

        // 2. Bundled app: dsh-root/ sits alongside the binary in Contents/Resources/
        if let bundleURL = Bundle.main.resourceURL?
            .appendingPathComponent("dsh-root", isDirectory: true),
           FileManager.default.fileExists(atPath: bundleURL.appendingPathComponent("apps/cli/lib").path) {
            logger.info("using bundled dsh-root: \(bundleURL.path)")
            return bundleURL
        }

        // 3. Dev build: binary is at .../native-macos/build/Debug/DeepSeekHarness
        //    project root is 3 levels up
        let exeURL = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0])
        let devRoot = exeURL.deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("deepseek-harness")
        if FileManager.default.fileExists(atPath: devRoot.appendingPathComponent("apps/cli/lib").path) {
            logger.info("using dev project root: \(devRoot.path)")
            return devRoot
        }

        // 4. Default
        let fallback = URL(fileURLWithPath: "/Users/dennis/AIProjects/deepseek-harness")
        logger.warning("using fallback project root: \(fallback.path)")
        return fallback
    }
}

// MARK: - Logger

private let logger = os.Logger(subsystem: "com.deepseek.harness", category: "dsh-server")
