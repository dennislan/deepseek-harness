import Foundation
import os

/// Manages the dsh Node.js HTTP server process as a child of the Swift app.
actor DshServer {
    enum Status: Equatable {
        case stopped, starting, running, failed(String)
    }

    // MARK: - Properties

    private var process: Process?
    private let projectRoot: URL
    private let defaultPort: Int = 3080

    var status: Status = .stopped
    var url: URL?

    var statusText: String {
        switch status {
        case .stopped:    return "未启动"
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

        let nodePath: String
        if let envNode = ProcessInfo.processInfo.environment["DSH_NODE_PATH"] {
            nodePath = envNode
        } else {
            nodePath = locateNode() ?? findNodeInEnv() ?? "/usr/local/bin/node"
        }

        guard FileManager.default.fileExists(atPath: nodePath) else {
            status = .failed("找不到 Node.js: \(nodePath)\n请确保 Node 22+ 已安装。")
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

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = ["--profile", "web", "--port", "\(port)"]
        process.environment = ProcessInfo.processInfo.environment

        // Use a writable DSH_HOME
        var env = process.environment ?? [:]
        env["DSH_HOME"] = URL(fileURLWithPath: "/tmp").appendingPathComponent(
            "dsh-\(ProcessInfo.processInfo.processIdentifier)"
        ).path
        process.environment = env

        do {
            try process.run()
            self.process = process
            logger.info("dsh started PID=\(process.processIdentifier) port=\(port)")

            for attempt in 1...120 {
                try await Task.sleep(nanoseconds: 500_000_000)

                if !process.isRunning {
                    if process.terminationStatus != 0 {
                        status = .failed("dsh 进程意外退出 (code=\(process.terminationStatus))")
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
        process?.terminate()
        process?.waitUntilExit()
        process = nil
        url = nil
        status = .stopped
        logger.info("dsh stopped")
        postStatusChanged()
        postURLChanged()
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

    private func locateNode() -> String? {
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
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
        // Dev build: 3 levels up from executable
        let exeURL = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0])
        let devRoot = exeURL.deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("deepseek-harness")
        if FileManager.default.fileExists(atPath: devRoot.appendingPathComponent("apps/cli/lib").path) {
            logger.info("using dev project root: \(devRoot.path)")
            return devRoot
        }
        let fallback = URL(fileURLWithPath: "/Users/dennis/AIProjects/deepseek-harness")
        logger.warning("using fallback project root: \(fallback.path)")
        return fallback
    }
}

// MARK: - Notification Names

extension DshServer {
    static let statusChanged = Notification.Name("DeepSeekHarness.DshServer.statusChanged")
    static let urlChanged    = Notification.Name("DeepSeekHarness.DshServer.urlChanged")
}

private let logger = os.Logger(subsystem: "com.deepseek.harness", category: "dsh-server")
