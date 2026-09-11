import Foundation

/// Locates the Node.js executable the app runs dsh with, plus the npm CLI that
/// installs runtime closures.
///
/// Shared by ``DshServer`` (which launches dsh) and ``RuntimeInstaller`` (which
/// installs a new runtime), so both resolve the same interpreter.
struct NodeRuntime: Sendable {
    /// The Node executable handed to the dsh child process.
    let executable: URL

    /// Node runtime embedded in the app bundle.
    /// - Returns: `Contents/Resources/node/bin/node`, or nil when the bundle has
    ///   no embedded runtime.
    static func bundled() -> URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let node = resources.appendingPathComponent("node/bin/node")
        return FileManager.default.isExecutableFile(atPath: node.path) ? node : nil
    }

    /// Resolves the interpreter in the app's documented order: embedded runtime
    /// → `DSH_NODE_PATH` → well-known install locations → `PATH`.
    /// - Returns: nil when no usable Node.js executable exists.
    static func resolve() -> NodeRuntime? {
        let candidates = [bundled()?.path, configuredPath(), commonLocation(), pathLookup()]
        for candidate in candidates {
            guard let candidate else { continue }
            return NodeRuntime(executable: URL(fileURLWithPath: candidate))
        }
        return nil
    }

    /// npm CLI shipped alongside this Node runtime.
    /// - Returns: the `npm-cli.js` path, or nil when this runtime has no npm.
    func npmCLI() -> URL? {
        let prefix = executable.deletingLastPathComponent().deletingLastPathComponent()
        return Self.npmCLI(prefixedBy: prefix)
    }

    /// npm CLI usable for installing a runtime closure.
    ///
    /// The npm bundled with the interpreter running dsh wins, because it matches
    /// the runtime that will have to load the installed closure; npm found under
    /// the usual macOS prefixes and on `PATH` is the fallback.
    /// - Returns: the `npm-cli.js` path, or nil when npm is unavailable.
    func resolvedNpmCLI() -> URL? {
        if let own = npmCLI() { return own }
        for prefix in Self.prefixes() {
            if let found = Self.npmCLI(prefixedBy: prefix) { return found }
        }
        return nil
    }

    /// Environment for a child process that has to find this Node on `PATH`.
    ///
    /// npm runs a dependency's install script through `sh -c`, which resolves
    /// `node` from `PATH` rather than from the interpreter that started npm, and
    /// the plugin market looks for `pnpm` there too. A GUI launch inherits only
    /// launchd's minimal `PATH` (`/usr/bin:/bin:…`), so a native dependency's
    /// install script dies with `sh: node: command not found` (exit 127) and a
    /// runtime update never completes.
    /// - Parameter inherited: the parent environment, or nil for this process's.
    /// - Returns: the environment with `PATH` led by this Node's bin directory,
    ///   the user's nvm Node bins, and the common macOS locations.
    func childEnvironment(inheriting inherited: [String: String]? = nil) -> [String: String] {
        var environment = inherited ?? ProcessInfo.processInfo.environment
        environment["PATH"] = Self.childPath(
            leadingWith: executable.deletingLastPathComponent().path,
            inheriting: environment["PATH"]
        )
        return environment
    }

    // MARK: - Resolution helpers

    /// Builds the `PATH` handed to a child process.
    ///
    /// The resolved Node bin and the user's nvm Node bins lead, followed by the
    /// common macOS locations; any inherited `PATH` (e.g. a terminal-launched
    /// app) is preserved. De-duplicated and order-preserving.
    /// - Parameters:
    ///   - nodeBin: the bin directory of the Node the app runs.
    ///   - inherited: the parent process `PATH`, or nil.
    /// - Returns: the `PATH` string for the child.
    private static func childPath(leadingWith nodeBin: String, inheriting inherited: String?) -> String {
        var candidates = [nodeBin]
        let nvmRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".nvm/versions/node", isDirectory: true)
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmRoot.path) {
            candidates.append(contentsOf: versions
                .filter { !$0.hasPrefix(".") }
                .map { nvmRoot.appendingPathComponent("\($0)/bin").path })
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

    private static func npmCLI(prefixedBy prefix: URL) -> URL? {
        let candidate = prefix.appendingPathComponent("lib/node_modules/npm/bin/npm-cli.js")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }

    private static func configuredPath() -> String? {
        let value = ProcessInfo.processInfo.environment["DSH_NODE_PATH"]?
            .trimmingCharacters(in: .whitespaces) ?? ""
        return value.isEmpty ? nil : value
    }

    private static func commonLocation() -> String? {
        ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private static func pathLookup() -> String? {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        for entry in path.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(entry)).appendingPathComponent("node")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate.path }
        }
        return nil
    }

    /// Install prefixes worth probing for a standalone npm: the common macOS
    /// locations plus the parent of every `*/bin` directory on `PATH`.
    private static func prefixes() -> [URL] {
        var candidates = [URL(fileURLWithPath: "/opt/homebrew"), URL(fileURLWithPath: "/usr/local")]
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        for entry in path.split(separator: ":") {
            let directory = URL(fileURLWithPath: String(entry))
            candidates.append(directory)
            candidates.append(directory.deletingLastPathComponent())
        }
        var seen = Set<String>()
        return candidates.filter { seen.insert($0.path).inserted }
    }
}
