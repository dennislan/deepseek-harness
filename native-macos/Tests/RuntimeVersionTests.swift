import Foundation

/// Offline behavior assertions for `RuntimeVersion`.
///
/// Compiled and run by `native-macos/Scripts/test-updater-logic.sh`, which
/// links this file with `App/Update/RuntimeVersion.swift`.
@main
struct RuntimeVersionTests {
    static func main() {
        var failures: [String] = []

        func expect(_ condition: Bool, _ message: String) {
            if !condition { failures.append(message) }
        }

        func expectEqual(_ actual: String?, _ expected: String, _ message: String) {
            expect(actual == expected, "\(message): 期望 \(expected)，实际 \(actual ?? "nil")")
        }

        // MARK: Normalization

        expectEqual(RuntimeVersion("0.1.5-rc.1")?.raw, "0.1.5-rc.1", "保留预发布标识")
        expectEqual(RuntimeVersion("1.2")?.raw, "1.2.0", "补齐缺失的补丁号")
        expectEqual(RuntimeVersion("1")?.raw, "1.0.0", "补齐缺失的次版本与补丁号")
        expectEqual(RuntimeVersion("v2.0.0")?.raw, "2.0.0", "去掉 v 前缀")
        expectEqual(RuntimeVersion(" 0.1.5 ")?.raw, "0.1.5", "去掉首尾空白")
        expectEqual(RuntimeVersion("1.2.3+build.7")?.raw, "1.2.3", "丢弃构建元数据")

        expect(RuntimeVersion("") == nil, "空串不是版本")
        expect(RuntimeVersion("abc") == nil, "非数字不是版本")
        expect(RuntimeVersion("1.2.3.4") == nil, "四段版本被拒绝")
        expect(RuntimeVersion("1.2.3-") == nil, "空的预发布段被拒绝")
        expect(RuntimeVersion("1.2.3-rc..1") == nil, "空标识符被拒绝")
        expect(RuntimeVersion("1.2.3-rc_1") == nil, "非法字符被拒绝")
        expect(RuntimeVersion("1.2.x") == nil, "非数字段被拒绝")

        // MARK: Release tag normalization

        expectEqual(RuntimeVersion.parseTag("dsh-v0.1.5-rc.1")?.raw, "0.1.5-rc.1", "去掉 dsh- 与 v 前缀")
        expectEqual(RuntimeVersion.parseTag("dsh-0.1.5")?.raw, "0.1.5", "只有 dsh- 前缀")
        expectEqual(RuntimeVersion.parseTag("v0.1.5")?.raw, "0.1.5", "只有 v 前缀")
        expectEqual(RuntimeVersion.parseTag("0.1.5-rc.1")?.raw, "0.1.5-rc.1", "无前缀 tag")
        expect(RuntimeVersion.parseTag("release-notes") == nil, "非版本 tag 被拒绝")

        // MARK: Precedence

        func expectOrder(_ higher: String, _ lower: String) {
            guard let high = RuntimeVersion(higher), let low = RuntimeVersion(lower) else {
                failures.append("排序断言无法解析: \(higher) / \(lower)")
                return
            }
            expect(low < high, "\(higher) 应高于 \(lower)")
            expect(high != low, "\(higher) 与 \(lower) 不应相等")
        }

        expectOrder("0.1.5-rc.1", "0.1.5-alpha.2")
        expectOrder("0.1.5-rc.2", "0.1.5-rc.1")
        expectOrder("0.1.5", "0.1.5-rc.1")
        expectOrder("0.1.6", "0.1.5")
        expectOrder("0.2.0", "0.1.9")
        expectOrder("1.0.0", "0.9.9")
        expectOrder("0.1.5-alpha.10", "0.1.5-alpha.9")
        expectOrder("0.1.5-alpha.1", "0.1.5-alpha")
        expectOrder("0.1.5-alpha", "0.1.5-1")
        expectOrder("0.1.5-rc.1", "0.1.5-rc")

        expect(RuntimeVersion("1.2.3") == RuntimeVersion("v1.2.3"), "规范化后相等")
        expect(RuntimeVersion("1.2.3") == RuntimeVersion("1.2.3+build.9"), "构建元数据不影响相等")

        // MARK: Sorting

        let unordered = ["0.1.5-alpha.2", "0.1.5", "0.1.5-rc.1", "0.1.3", "0.1.5-alpha.10"]
        let sorted = unordered.compactMap { RuntimeVersion($0) }.sorted().map(\.raw)
        expect(
            sorted == ["0.1.3", "0.1.5-alpha.2", "0.1.5-alpha.10", "0.1.5-rc.1", "0.1.5"],
            "升序排列: \(sorted)"
        )

        if failures.isEmpty {
            print("RuntimeVersionTests: 全部通过")
            return
        }
        for failure in failures {
            print("RuntimeVersionTests 失败 — \(failure)")
        }
        exit(1)
    }
}
