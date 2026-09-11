#!/bin/bash
# =============================================================================
# End-to-end assertions for the macOS app's manual update path.
#
# Runs RuntimeUpdater against a scratch DSH_HOME seeded with an older runtime,
# so clicking 检查更新… installs the newest published runtime exactly as the app
# does. Asserts that a click during the run reports progress instead of being
# dropped silently, that the run ends with a definite outcome, and that a later
# click reuses what is already staged instead of reinstalling it.
#
# Needs network, Node.js 22+ with npm, and about a minute. The offline logic
# assertions are test-updater-logic.sh.
#
#   ./native-macos/Scripts/test-updater-manual-path.sh
#   KEEP_SCRATCH=1 ./native-macos/Scripts/test-updater-manual-path.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
step() { printf '%b\n' "${CYAN}▶${NC} $*"; }
info() { printf '%b\n' "${GREEN}✓${NC} $*"; }
fail() { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }

SOURCES=(
    "$NATIVE_MACOS_DIR/App/Update/RuntimeVersion.swift"
    "$NATIVE_MACOS_DIR/App/Update/RuntimeLayout.swift"
    "$NATIVE_MACOS_DIR/App/Update/ReleaseResolver.swift"
    "$NATIVE_MACOS_DIR/App/Update/RuntimeInstaller.swift"
    "$NATIVE_MACOS_DIR/App/Update/RuntimeUpdater.swift"
    "$NATIVE_MACOS_DIR/App/Server/NodeRuntime.swift"
    "$NATIVE_MACOS_DIR/App/Server/DshServer.swift"
    "$NATIVE_MACOS_DIR/Tests/RuntimeUpdaterManualPathTests.swift"
)
for source in "${SOURCES[@]}"; do
    [ -f "$source" ] || fail "缺少 $source"
done

command -v node >/dev/null 2>&1 || fail "需要 Node.js 22+（自带 npm）"
info "使用 $(node --version) ($(command -v node))"

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-manual-update.XXXXXX")"
if [ "${KEEP_SCRATCH:-0}" = "1" ]; then
    info "保留临时目录：$TEST_DIR"
else
    trap 'rm -rf "$TEST_DIR"' EXIT
fi

# 种子运行时：清单报告一个旧版本，激活与更新前的「在服务版本」因此可读，
# 且 apps/cli/lib/bin.js 存在，更新器才会把它当作在服务的运行时。
HOME_DIR="$TEST_DIR/home"
SEED_ROOT="$HOME_DIR/runtime/dsh-root"
mkdir -p "$SEED_ROOT/apps/cli/lib" "$SEED_ROOT/node_modules/@deepseek-ai/dsh" "$HOME_DIR/logs"
touch "$SEED_ROOT/apps/cli/lib/bin.js"
printf '{"name":"@deepseek-ai/dsh","version":"0.1.0"}' \
    > "$SEED_ROOT/node_modules/@deepseek-ai/dsh/package.json"

# 更新器在应用包外靠「从可执行文件向上找到 native-macos/Scripts」定位
# assemble-runtime.mjs 与 prune-node-modules.mjs，所以测试二进制必须留在仓库内。
step "编译手动更新断言..."
xcrun swiftc -O -parse-as-library "${SOURCES[@]}" \
    -o "$NATIVE_MACOS_DIR/.build/manual-path-tests" \
    || fail "Swift 编译失败"

step "运行手动更新断言（联网安装当前最新运行时，约 1 分钟）..."
DSH_HOME="$HOME_DIR" "$NATIVE_MACOS_DIR/.build/manual-path-tests" \
    || fail "手动更新路径断言未通过"

step "检查更新日志的结束标记..."
LOG_FILE="$(ls -t "$HOME_DIR"/logs/update-*.log | head -1)"
tail -1 "$LOG_FILE" | grep -q '^== 更新完成' \
    || fail "更新日志缺少完成标记：$LOG_FILE"

info "手动更新路径断言通过"
