import Foundation

/// A semantic version parsed from an npm version string or from a
/// deepseek-harness release tag.
///
/// Comparison follows semver 2.0 §11: numeric prerelease identifiers compare
/// numerically, alphanumeric identifiers compare in ASCII order, a numeric
/// identifier sorts below an alphanumeric one, and any prerelease sorts below
/// the same release without one. Build metadata never participates.
struct RuntimeVersion: Comparable, CustomStringConvertible, Sendable {
    /// Canonical `major.minor.patch[-prerelease]` text, in the form npm accepts
    /// as a package specifier.
    let raw: String

    private let major: Int
    private let minor: Int
    private let patch: Int
    private let prerelease: [String]

    /// Parses a version, padding missing components and dropping build metadata.
    ///
    /// A single leading `v` is accepted because release tags carry one; the
    /// canonical `raw` never does, so it is safe to pass to `npm install`.
    /// - Parameter text: an npm version such as `0.1.5-rc.1`, `1.2`, or `v2.0.0`.
    /// - Returns: nil when `text` is not a version this app can install.
    init?(_ text: String) {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("v") || value.hasPrefix("V") {
            value.removeFirst()
        }
        if let build = value.firstIndex(of: "+") {
            value = String(value[value.startIndex..<build])
        }

        let halves = value.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard let core = halves.first, !core.isEmpty else { return nil }

        var components: [Int] = []
        for number in core.split(separator: ".", omittingEmptySubsequences: false) {
            guard !number.isEmpty, number.allSatisfy(\.isNumber), let parsed = Int(number) else {
                return nil
            }
            components.append(parsed)
        }
        guard (1...3).contains(components.count) else { return nil }
        while components.count < 3 { components.append(0) }

        var identifiers: [String] = []
        if halves.count == 2 {
            identifiers = halves[1].split(separator: ".", omittingEmptySubsequences: false)
                .map(String.init)
            for identifier in identifiers {
                let valid = !identifier.isEmpty && identifier.allSatisfy {
                    $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-")
                }
                guard valid else { return nil }
            }
        }

        self.major = components[0]
        self.minor = components[1]
        self.patch = components[2]
        self.prerelease = identifiers

        let base = "\(components[0]).\(components[1]).\(components[2])"
        self.raw = identifiers.isEmpty ? base : "\(base)-\(identifiers.joined(separator: "."))"
    }

    /// Normalizes a deepseek-harness release tag into an installable version.
    ///
    /// Mirrors `build-release.sh`, which strips the `dsh-` prefix and then the
    /// `v` prefix of tags such as `dsh-v0.1.5-rc.1`.
    /// - Parameter tagName: a GitHub release tag name.
    /// - Returns: nil when the remainder is not a parseable version.
    static func parseTag(_ tagName: String) -> RuntimeVersion? {
        var value = tagName.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("dsh-") { value.removeFirst(4) }
        return RuntimeVersion(value)
    }

    var description: String { raw }

    static func == (lhs: RuntimeVersion, rhs: RuntimeVersion) -> Bool {
        lhs.major == rhs.major
            && lhs.minor == rhs.minor
            && lhs.patch == rhs.patch
            && lhs.prerelease == rhs.prerelease
    }

    static func < (lhs: RuntimeVersion, rhs: RuntimeVersion) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        if lhs.patch != rhs.patch { return lhs.patch < rhs.patch }
        return comparePrerelease(lhs.prerelease, rhs.prerelease) < 0
    }

    /// Orders two prerelease identifier lists; an empty list is the release
    /// itself and therefore sorts above any prerelease of the same version.
    private static func comparePrerelease(_ lhs: [String], _ rhs: [String]) -> Int {
        if lhs.isEmpty || rhs.isEmpty {
            if lhs.isEmpty && rhs.isEmpty { return 0 }
            return lhs.isEmpty ? 1 : -1
        }
        for index in 0..<min(lhs.count, rhs.count) {
            let left = lhs[index]
            let right = rhs[index]
            let leftNumber = Int(left)
            let rightNumber = Int(right)
            switch (leftNumber, rightNumber) {
            case let (left?, right?):
                if left != right { return left < right ? -1 : 1 }
            case (nil, nil):
                if left != right { return left < right ? -1 : 1 }
            case (nil, _):
                return 1
            case (_, nil):
                return -1
            }
        }
        if lhs.count == rhs.count { return 0 }
        return lhs.count < rhs.count ? -1 : 1
    }
}
