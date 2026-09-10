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

    // MARK: - Resolution helpers

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
