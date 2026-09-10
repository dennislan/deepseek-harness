#!/bin/bash
# =============================================================================
# Offline assertions for the macOS app's runtime update logic.
#
# Compiles App/Update/RuntimeVersion.swift together with Tests/RuntimeVersionTests.swift
# and runs the result. No network, no dsh runtime, no app bundle required.
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
TEST_SOURCE="$NATIVE_MACOS_DIR/Tests/RuntimeVersionTests.swift"
[ -f "$VERSION_SOURCE" ] || fail "缺少 $VERSION_SOURCE"
[ -f "$TEST_SOURCE" ] || fail "缺少 $TEST_SOURCE"

step "编译 RuntimeVersion 断言..."
xcrun swiftc -O -parse-as-library \
    "$VERSION_SOURCE" \
    "$TEST_SOURCE" \
    -o "$TMP_DIR/runtime-version-tests" \
    || fail "Swift 编译失败"

step "运行断言..."
"$TMP_DIR/runtime-version-tests" || fail "版本逻辑断言未通过"

info "更新逻辑离线断言通过"
