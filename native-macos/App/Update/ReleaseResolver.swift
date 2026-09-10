import Foundation
import os

/// Resolves the newest installable dsh version.
///
/// The precedence mirrors `native-macos/Scripts/build-release.sh`: GitHub
/// releases are authoritative because npm can lag behind a tagged release, a
/// tag is accepted only when the matching npm version actually exists, and the
/// npm registry's `latest` dist-tag is the fallback.
///
/// Every repository Release is currently a GitHub pre-release, so the list
/// endpoint is used instead of `/releases/latest`, which would report nothing.
struct ReleaseResolver: Sendable {
    /// Which rule produced a resolved version.
    enum Source: Equatable, Sendable {
        case githubReleaseTag(String)
        case npmLatest
    }

    /// A version together with the rule that produced it.
    struct Resolution: Equatable, Sendable {
        let version: RuntimeVersion
        let source: Source
    }

    /// Why resolution could not produce a version.
    enum Failure: Error, CustomStringConvertible {
        case http(status: Int, url: String)
        case malformed(String)
        case transport(String)

        var description: String {
            switch self {
            case .http(let status, let url):
                return "HTTP \(status) @ \(url)"
            case .malformed(let detail):
                return "响应格式异常: \(detail)"
            case .transport(let detail):
                return "网络错误: \(detail)"
            }
        }
    }

    static let defaultRepository = "deepseek-ai/deepseek-harness"
    static let defaultPackage = "@deepseek-ai/dsh"
    static let defaultRegistry = URL(string: "https://registry.npmjs.org")!

    let repository: String
    let packageName: String
    let registry: URL

    /// Creates a resolver.
    /// - Parameters:
    ///   - repository: GitHub `owner/name` holding the release tags.
    ///   - packageName: npm package published for each release tag.
    ///   - registry: npm registry base URL.
    init(
        repository: String = ReleaseResolver.defaultRepository,
        packageName: String = ReleaseResolver.defaultPackage,
        registry: URL = ReleaseResolver.defaultRegistry
    ) {
        self.repository = repository
        self.packageName = packageName
        self.registry = registry
    }

    /// Returns the newest version available for installation.
    /// - Returns: the version and the rule that produced it.
    /// - Throws: ``Failure`` when neither GitHub nor the registry yields one.
    func latest() async throws -> Resolution {
        do {
            let tag = try await latestReleaseTag()
            if let version = RuntimeVersion.parseTag(tag) {
                if await isPublished(version) {
                    return Resolution(version: version, source: .githubReleaseTag(tag))
                }
                logger.info("GitHub tag \(tag, privacy: .public) 尚未发布到 npm，回退 registry")
            } else {
                logger.error("GitHub release tag 无法解析为版本: \(tag, privacy: .public)")
            }
        } catch {
            logger.info("GitHub release 查询失败，回退 registry: \(String(describing: error), privacy: .public)")
        }
        let version = try await npmLatestVersion()
        return Resolution(version: version, source: .npmLatest)
    }

    /// Reads the newest release tag (by creation time, matching `gh release list`).
    /// - Returns: the raw tag name, e.g. `dsh-v0.1.5-rc.1`.
    func latestReleaseTag() async throws -> String {
        let url = URL(string: "https://api.github.com/repos/\(repository)/releases?per_page=1")!
        let response = try await get(url, accept: "application/vnd.github+json")
        guard (200..<300).contains(response.status) else {
            throw Failure.http(status: response.status, url: url.absoluteString)
        }
        guard let releases = try? JSONSerialization.jsonObject(with: response.data) as? [[String: Any]] else {
            throw Failure.malformed("GitHub releases 不是数组")
        }
        guard let tag = releases.first?["tag_name"] as? String else {
            throw Failure.malformed("GitHub releases 为空或缺少 tag_name")
        }
        return tag
    }

    /// Reports whether a version exists on the registry, the equivalent of
    /// `npm view <package>@<version> version`.
    /// - Parameter version: the version to look up.
    /// - Returns: true on HTTP 200.
    func isPublished(_ version: RuntimeVersion) async -> Bool {
        guard let url = URL(string: "\(registry.absoluteString)/\(encodedPackage)/\(version.raw)") else {
            return false
        }
        do {
            let response = try await get(url, accept: "application/json")
            return response.status == 200
        } catch {
            logger.info("版本校验失败 \(version.raw, privacy: .public): \(String(describing: error), privacy: .public)")
            return false
        }
    }

    /// Reads the registry's `latest` dist-tag, the equivalent of
    /// `npm view <package> version`.
    /// - Returns: the parsed version.
    func npmLatestVersion() async throws -> RuntimeVersion {
        guard let url = URL(string: "\(registry.absoluteString)/\(encodedPackage)") else {
            throw Failure.malformed("registry URL 非法: \(registry.absoluteString)")
        }
        let response = try await get(url, accept: "application/json")
        guard response.status == 200 else {
            throw Failure.http(status: response.status, url: url.absoluteString)
        }
        guard let manifest = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
              let tags = manifest["dist-tags"] as? [String: Any],
              let latest = tags["latest"] as? String,
              let version = RuntimeVersion(latest)
        else {
            throw Failure.malformed("registry 响应缺少 dist-tags.latest")
        }
        return version
    }

    private var encodedPackage: String {
        packageName.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? packageName
    }

    private func get(_ url: URL, accept: String) async throws -> (status: Int, data: Data) {
        var request = URLRequest(url: url)
        request.setValue("DeepSeekHarness", forHTTPHeaderField: "User-Agent")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        request.timeoutInterval = 20

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 60
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw Failure.malformed("非 HTTP 响应 @ \(url.absoluteString)")
            }
            return (http.statusCode, data)
        } catch let failure as Failure {
            throw failure
        } catch {
            throw Failure.transport(error.localizedDescription)
        }
    }
}

private let logger = os.Logger(subsystem: "com.deepseek.harness", category: "updater")
