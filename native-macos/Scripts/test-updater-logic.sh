#!/bin/bash
# =============================================================================
# Offline assertions for the macOS app's runtime update logic.
#
# Compiles the update sources together with the assertions in Tests/ and runs
# the result. No network, no Node, no dsh runtime, and no app bundle required.
#
#   ./native-macos/Scripts/test-updater-logic.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
step() { printf '%b\n' "${CYAN}▶${NC} $*"; }
info() { printf '%b\n' "${GREEN}✓${NC} $*"; }
fail() { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-updater-tests.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

VERSION_SOURCE="$NATIVE_MACOS_DIR/App/Update/RuntimeVersion.swift"
VERSION_TEST="$NATIVE_MACOS_DIR/Tests/RuntimeVersionTests.swift"
ACTIVATION_TEST="$NATIVE_MACOS_DIR/Tests/RuntimeActivationTests.swift"
LAYOUT_SOURCE="$NATIVE_MACOS_DIR/App/Update/RuntimeLayout.swift"
INSTALLER_SOURCE="$NATIVE_MACOS_DIR/App/Update/RuntimeInstaller.swift"
NODE_SOURCE="$NATIVE_MACOS_DIR/App/Server/NodeRuntime.swift"

for source in "$VERSION_SOURCE" "$VERSION_TEST" "$ACTIVATION_TEST" \
              "$LAYOUT_SOURCE" "$INSTALLER_SOURCE" "$NODE_SOURCE"; do
    [ -f "$source" ] || fail "缺少 $source"
done

step "编译 RuntimeVersion 断言..."
xcrun swiftc -O -parse-as-library \
    "$VERSION_SOURCE" \
    "$VERSION_TEST" \
    -o "$TMP_DIR/runtime-version-tests" \
    || fail "Swift 编译失败"

step "运行版本断言..."
"$TMP_DIR/runtime-version-tests" || fail "版本逻辑断言未通过"

step "编译运行时激活断言..."
# 激活只做目录改名与清单读取，因此不需要 Node、npm 或应用包。
xcrun swiftc -O -parse-as-library \
    "$VERSION_SOURCE" \
    "$LAYOUT_SOURCE" \
    "$INSTALLER_SOURCE" \
    "$NODE_SOURCE" \
    "$ACTIVATION_TEST" \
    -o "$TMP_DIR/runtime-activation-tests" \
    || fail "Swift 编译失败"

step "运行激活断言..."
"$TMP_DIR/runtime-activation-tests" || fail "运行时激活断言未通过"

info "更新逻辑离线断言通过"
