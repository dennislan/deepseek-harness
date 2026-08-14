#!/bin/bash
# =============================================================================
# DeepSeek Harness macOS App — Build Script
#
# Quick upgrade flow (after git pull):
#   cd /path/to/deepseek-harness
#   pnpm run build                    # rebuild Node.js side
#   ./native-macos/Scripts/build.sh   # recompile Swift + assemble .app
#
# Usage:
#   ./native-macos/Scripts/build.sh              # build debug (default)
#
# Note: The app sets DSH_HOME=/tmp/dsh-<pid> at runtime so dsh can manage
# its profile symlinks without hitting the sandbox-blocked ~/.dsh directory.
#   ./native-macos/Scripts/build.sh release      # build release
#   ./native-macos/Scripts/build.sh --clean      # clean before build
#   ./native-macos/Scripts/build.sh --skip-dsh   # skip pnpm build
#   ./native-macos/Scripts/build.sh --bundle     # full bundle (no symlink)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BINARY_NAME="DeepSeekHarness"

BUILD_CONFIG="${1:-debug}"
case "$BUILD_CONFIG" in
    release) BUILD_OPT="-O"; APP_NAME="${BINARY_NAME}.app" ;;
    *)       BUILD_OPT="";   APP_NAME="${BINARY_NAME}-debug.app" ;;
esac

CLEAN=false; SKIP_DSH=false; FULL_BUNDLE=false
for arg in "$@"; do
    case "$arg" in
        --clean)    CLEAN=true ;;
        --skip-dsh) SKIP_DSH=true ;;
        --bundle)   FULL_BUNDLE=true ;;
    esac
done

TMP_BINARY="/tmp/dsh-native-build/$BINARY_NAME"
APP_DIR="$PROJECT_ROOT/native-macos/dist/$APP_NAME"
MODULE_CACHE="/tmp/swift-module-cache-dsh"
SRC_DIR="$PROJECT_ROOT/native-macos/App"
SDK_PATH=$(xcrun --sdk macosx --show-sdk-path 2>/dev/null \
    || echo "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.5.sdk")

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
step()  { echo -e "${CYAN}▶${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ---------------------------------------------------------------------------
# Step 1: Build dsh (CLI + frontend)
# ---------------------------------------------------------------------------
if [ "$SKIP_DSH" = true ]; then
    info "Skipping pnpm build (--skip-dsh)"
else
    step "Building dsh CLI + frontend (pnpm run build)..."
    cd "$PROJECT_ROOT"
    [ "$CLEAN" = true ] && pnpm run clean
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
    pnpm run build || error "pnpm build failed"
    info "✓ dsh built"
fi

# ---------------------------------------------------------------------------
# Step 2: Compile Swift binary (to temp location first)
# ---------------------------------------------------------------------------
step "Compiling Swift binary ($BUILD_CONFIG)..."
mkdir -p "$(dirname "$TMP_BINARY")" "$MODULE_CACHE"

SWIFT_CMD=(
    xcrun swiftc
    -target arm64-apple-macosx14.0
    "-sdk" "$SDK_PATH"
    -I"$SDK_PATH/System/Library/Frameworks/SwiftUI.framework/Headers"
    -module-cache-path "$MODULE_CACHE"
    -framework SwiftUI
    -framework AppKit
    -framework WebKit
    -framework Foundation
    -framework Security
    -framework UniformTypeIdentifiers
    -framework UserNotifications
    -o "$TMP_BINARY"
    "$SRC_DIR/App/DeepSeekHarnessApp.swift"
    "$SRC_DIR/App/ContentView.swift"
    "$SRC_DIR/Server/DshServer.swift"
    "$SRC_DIR/NativeBridge/BridgeManager.swift"
)

[ -n "$BUILD_OPT" ] && SWIFT_CMD+=("$BUILD_OPT")

"${SWIFT_CMD[@]}" || error "Swift compilation failed"
chmod +x "$TMP_BINARY"
info "✓ Swift binary: $(ls -lh "$TMP_BINARY" | awk '{print $5}')"

# ---------------------------------------------------------------------------
# Step 3: Assemble .app bundle
# ---------------------------------------------------------------------------
step "Assembling $APP_NAME..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

# Copy binary into bundle
cp "$TMP_BINARY" "$APP_DIR/Contents/MacOS/$BINARY_NAME"
chmod +x "$APP_DIR/Contents/MacOS/$BINARY_NAME"

if [ "$FULL_BUNDLE" = true ]; then
    # Full bundle: copy only essential dsh artifacts (no node_modules)
    DSH_ROOT="$APP_DIR/Contents/Resources/dsh-root"
    mkdir -p "$DSH_ROOT"
    SRC="$PROJECT_ROOT"

    # Copy essential dirs
    for dir in apps packages native; do
        [ -d "$SRC/$dir" ] && cp -R "$SRC/$dir/." "$DSH_ROOT/$dir/" 2>/dev/null &
    done
    for f in package.json pnpm-workspace.yaml tsconfig.host.json tsconfig.client.json \
             tsconfig.base.json tsconfig.base.client.json .npmrc; do
        [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DSH_ROOT/$f" 2>/dev/null &
    done
    wait

    # Strip noise
    find "$DSH_ROOT" -name "node_modules" -type d -exec rm -rf {} + 2>/dev/null || true
    rm -rf "$DSH_ROOT/.git" "$DSH_ROOT/.agents" 2>/dev/null || true
    info "✓ Full bundle: $(du -sh "$DSH_ROOT" | cut -f1)"
else
    # Lightweight: symlink to project root (fastest upgrade path)
    ln -sfn "$PROJECT_ROOT" "$APP_DIR/Contents/Resources/dsh-root"
    info "✓ Lightweight mode (symlink → project root)"
fi

# Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>zh_CN</string>
    <key>CFBundleExecutable</key>
    <string>DeepSeekHarness</string>
    <key>CFBundleIdentifier</key>
    <string>com.deepseek.harness</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>DeepSeek Harness</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.developer-tools</string>
    <key>NSHighResolutionCapable</key>
    <string>true</string>
</dict>
</plist>
PLIST

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------
step "Verifying build..."
[ -x "$APP_DIR/Contents/MacOS/$BINARY_NAME" ] || error "Binary missing or not executable"
[ -f "$APP_DIR/Contents/Info.plist" ]         || error "Info.plist missing"

if [ "$FULL_BUNDLE" = true ]; then
    [ -f "$APP_DIR/Contents/Resources/dsh-root/apps/cli/lib/bin.js" ]    || error "dsh CLI missing"
    [ -f "$APP_DIR/Contents/Resources/dsh-root/apps/web/dist/index.html" ] || error "Frontend dist missing"
else
    [ -e "$APP_DIR/Contents/Resources/dsh-root/apps/cli/lib/bin.js" ] || \
        warn "dsh CLI not found at project root (run pnpm run build first)"
fi

BUNDLE_SIZE=$(du -sh "$APP_DIR" | cut -f1)
info "  Binary: $(file "$APP_DIR/Contents/MacOS/$BINARY_NAME" | sed 's/.*://')"
info "  Bundle: $BUNDLE_SIZE"

echo ""
echo -e "${GREEN}✅ Build complete:${NC} $APP_DIR"
echo ""
echo -e "  ${CYAN}Run:${NC}        open \"$APP_DIR\""
echo -e "  ${CYAN}Inspect:${NC}    open \"$APP_DIR/Contents/Resources/dsh-root\""
echo -e "  ${CYAN}Full bundle:${NC} ./native-macos/Scripts/build.sh --bundle"
echo ""
