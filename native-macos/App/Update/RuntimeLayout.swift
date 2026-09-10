import Darwin
import Foundation

/// On-disk locations of the updatable dsh runtime.
///
/// The runtime lives under `<DSH_HOME>/runtime` so an update never writes into
/// the application bundle: the bundle stays read-only, keeps its code
/// signature, and the app also works when installed under `/Applications`.
struct RuntimeLayout: Sendable {
    /// Directory name of the assembled runtime inside ``runtimeRoot``.
    static let runtimeDirectoryName = "dsh-root"
    /// Package manifest whose `version` field identifies the installed runtime.
    static let dshPackagePath = "node_modules/@deepseek-ai/dsh/package.json"

    let home: URL
    let runtimeRoot: URL
    let logsDirectory: URL

    /// The assembled runtime the app runs dsh from.
    var dshRoot: URL {
        runtimeRoot.appendingPathComponent(Self.runtimeDirectoryName, isDirectory: true)
    }

    /// The runtime replaced by the most recent successful update.
    var previousRoot: URL {
        runtimeRoot.appendingPathComponent("\(Self.runtimeDirectoryName).previous", isDirectory: true)
    }

    /// npm content-addressed cache shared by every update, so unchanged
    /// dependency tarballs are never downloaded twice.
    var npmCache: URL {
        runtimeRoot.appendingPathComponent(".npm-cache", isDirectory: true)
    }

    /// Exclusive lock that keeps two app instances from updating concurrently.
    var lockFile: URL {
        runtimeRoot.appendingPathComponent(".update.lock")
    }

    /// Resolves the dsh home directory, honouring `DSH_HOME` and otherwise
    /// falling back to `~/.dsh`, matching the dsh child's own precedence.
    /// - Returns: the resolved home directory.
    static func resolveHome() -> URL {
        let configured = ProcessInfo.processInfo.environment["DSH_HOME"]?
            .trimmingCharacters(in: .whitespaces) ?? ""
        guard configured.isEmpty else { return URL(fileURLWithPath: configured) }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dsh", isDirectory: true)
    }

    /// Creates a layout rooted at an explicit home directory.
    /// - Parameter home: the dsh home directory.
    init(home: URL) {
        self.home = home
        self.runtimeRoot = home.appendingPathComponent("runtime", isDirectory: true)
        self.logsDirectory = home.appendingPathComponent("logs", isDirectory: true)
    }

    /// Creates the runtime root and log directory when they do not exist yet.
    func prepare() throws {
        let manager = FileManager.default
        try manager.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)
        try manager.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    }

    /// Reads the dsh version installed in a runtime tree.
    /// - Parameter root: a directory shaped like ``dshRoot``.
    /// - Returns: nil when the manifest is missing or unreadable.
    func installedVersion(at root: URL) -> RuntimeVersion? {
        guard let data = try? Data(contentsOf: root.appendingPathComponent(Self.dshPackagePath)),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = manifest["version"] as? String
        else { return nil }
        return RuntimeVersion(version)
    }

    /// Creates an empty, uniquely named staging directory.
    /// - Returns: the staging root that will contain `dsh-root`.
    func makeStagingRoot() throws -> URL {
        let url = runtimeRoot.appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Removes staging directories left behind by an interrupted update.
    func cleanStaleStaging() {
        let manager = FileManager.default
        let entries = (try? manager.contentsOfDirectory(at: runtimeRoot, includingPropertiesForKeys: nil)) ?? []
        for entry in entries where entry.lastPathComponent.hasPrefix(".staging-") {
            try? manager.removeItem(at: entry)
        }
    }

    /// Free space on the volume that holds the runtime, in bytes.
    /// - Returns: nil when the volume cannot be queried.
    func availableCapacity() -> Int64? {
        let values = try? runtimeRoot.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }

    /// Log file dedicated to one update attempt.
    /// - Parameter timestamp: the attempt time; defaults to now.
    /// - Returns: a path under ``logsDirectory``.
    func updateLogURL(timestamp: Date = Date()) -> URL {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return logsDirectory.appendingPathComponent("update-\(formatter.string(from: timestamp)).log")
    }

    /// Takes the exclusive update lock.
    /// - Returns: the held lock; the caller must release it.
    func acquireLock() throws -> UpdateLock {
        try UpdateLock(url: lockFile)
    }
}

/// Exclusive lock file that makes runtime updates single-writer.
///
/// The lock records the owning process id, so a lock left behind by a crashed
/// update is reclaimed instead of blocking every later launch.
final class UpdateLock {
    /// Why the lock could not be taken.
    enum Failure: Error, CustomStringConvertible {
        case heldByProcess(Int)
        case unavailable(String)

        var description: String {
            switch self {
            case .heldByProcess(let pid):
                return "另一个更新进程正在运行 (PID \(pid))"
            case .unavailable(let reason):
                return "无法创建更新锁: \(reason)"
            }
        }
    }

    private let url: URL
    private var descriptor: Int32 = -1

    /// Creates the lock file exclusively.
    /// - Parameter url: the lock file path; its parent must exist.
    init(url: URL) throws {
        self.url = url
        for attempt in 0..<2 {
            let descriptor = open(url.path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
            if descriptor >= 0 {
                let owner = "\(getpid())"
                _ = owner.withCString { write(descriptor, $0, strlen($0)) }
                self.descriptor = descriptor
                return
            }
            guard errno == EEXIST else {
                throw Failure.unavailable(String(cString: strerror(errno)))
            }
            if attempt == 0, let holder = Self.owner(of: url), !Self.isAlive(holder) {
                unlink(url.path)
                continue
            }
            throw Failure.heldByProcess(Self.owner(of: url) ?? 0)
        }
        throw Failure.unavailable("锁文件存在且无法回收: \(url.path)")
    }

    /// Releases the lock and deletes its file.
    func release() {
        guard descriptor >= 0 else { return }
        close(descriptor)
        descriptor = -1
        unlink(url.path)
    }

    deinit { release() }

    private static func owner(of url: URL) -> Int? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return Int(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func isAlive(_ pid: Int) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid_t(pid), 0) == 0 || errno == EPERM
    }
}
