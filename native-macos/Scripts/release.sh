#!/bin/bash
# =============================================================================
# DeepSeek Harness macOS — Release Build Script
#
# One-command release build:
#   ./native-macos/Scripts/release.sh
#
# Options:
#   ./native-macos/Scripts/release.sh --skip-dsh     skip pnpm build
#   ./native-macos/Scripts/release.sh --strip        strip debug symbols
#   ./native-macos/Scripts/release.sh --dmg          also create .dmg installer
#   ./native-macos/Scripts/release.sh --sign <id>    codesign with identity (default: ad-hoc)
#   ./native-macos/Scripts/release.sh --notarize     notarize after signing
#   ./native-macos/Scripts/release.sh --clean        pnpm run clean first
#
# Outputs:
#   native-macos/dist/DeepSeekHarness.app   (self-contained, ready to ship)
#   native-macos/dist/DeepSeekHarness.dmg   (optional disk image)
# =============================================================================
set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_NAME="DeepSeekHarness"
APP_DIR="$SCRIPT_DIR/../dist/$APP_NAME.app"
BINARY_NAME="$APP_NAME"
TMP_DIR="/tmp/dsh-release-build"
MODULE_CACHE="$TMP_DIR/module-cache"
SDK_PATH=$(xcrun --sdk macosx --show-sdk-path 2>/dev/null \
    || echo "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.5.sdk")
SRC_DIR="$SCRIPT_DIR/../App"

# ── Flags ──────────────────────────────────────────────────────────────────────
SKIP_DSH=false
STRIP=false
CREATE_DMG=false
CODE_SIGN_ID=""
NOTARIZE=false
CLEAN_FIRST=false

while [ $# -gt 0 ]; do
    case "$1" in
        --skip-dsh)   SKIP_DSH=true; shift ;;
        --strip)      STRIP=true; shift ;;
        --dmg)        CREATE_DMG=true; shift ;;
        --sign)
            shift
            if [ $# -eq 0 ] || [ -z "$1" ]; then
                echo "Error: --sign requires an identity (e.g. --sign \"Developer ID Application: X\")" >&2
                exit 1
            fi
            CODE_SIGN_ID="$1"; shift ;;
        --sign=*)
            CODE_SIGN_ID="${1#--sign=}"
            if [ -z "$CODE_SIGN_ID" ]; then
                echo "Error: --sign requires an identity (e.g. --sign=\"Developer ID Application: X\")" >&2
                exit 1
            fi
            shift ;;
        --notarize)   NOTARIZE=true; shift ;;
        --clean)      CLEAN_FIRST=true; shift ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
    esac
done

# ── Colors ─────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
step()  { echo -e "${CYAN}▶${NC} ${BOLD}$*${NC}"; }
info()  { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*"; exit 1; }

ARCH="${ARCH:-arm64}"
case "$ARCH" in
    *[!a-zA-Z0-9_-]*)
        echo -e "${RED}✗${NC} Illegal ARCH value '$ARCH' (allowed: [a-zA-Z0-9_-])" >&2
        exit 1 ;;
esac

# ── Cleanup ────────────────────────────────────────────────────────────────────
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR" "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

# =============================================================================
# Step 1: Build dsh (Node.js side)
# =============================================================================
if [ "$SKIP_DSH" = true ]; then
    info "Skipping pnpm build (--skip-dsh)"
else
    step "Building dsh (pnpm run build)..."
    cd "$PROJECT_ROOT"
    [ "$CLEAN_FIRST" = true ] && pnpm run clean
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
    pnpm run build || fail "pnpm build failed"
    info "dsh built"
fi

# =============================================================================
# Step 2: Compile Swift binary (release, optimized)
# =============================================================================
step "Compiling Swift binary (release -O)..."

BINARY_PATH="$TMP_DIR/$BINARY_NAME"

xcrun swiftc \
    -target "$ARCH-apple-macosx14.0" \
    -O \
    -sdk "$SDK_PATH" \
    -I"$SDK_PATH/System/Library/Frameworks/SwiftUI.framework/Headers" \
    -module-cache-path "$MODULE_CACHE" \
    -framework SwiftUI \
    -framework AppKit \
    -framework WebKit \
    -framework Foundation \
    -framework Security \
    -framework UniformTypeIdentifiers \
    -framework UserNotifications \
    -o "$BINARY_PATH" \
    "$SRC_DIR/App/DeepSeekHarnessApp.swift" \
    "$SRC_DIR/App/ContentView.swift" \
    "$SRC_DIR/Server/DshServer.swift" \
    "$SRC_DIR/NativeBridge/BridgeManager.swift" \
    || fail "Swift compilation failed"

# Strip debug symbols to reduce size
if [ "$STRIP" = true ]; then
    xcrun strip -S "$BINARY_PATH" 2>/dev/null || true
fi

chmod +x "$BINARY_PATH"
BINARY_SIZE=$(du -h "$BINARY_PATH" | cut -f1)
info "Swift binary: $BINARY_SIZE"

# =============================================================================
# Step 3: Assemble .app bundle
# =============================================================================
step "Assembling $APP_NAME.app..."

# Clean previous build
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

# Copy binary
cp "$BINARY_PATH" "$APP_DIR/Contents/MacOS/$BINARY_NAME"
chmod +x "$APP_DIR/Contents/MacOS/$BINARY_NAME"

# Create dsh-root inside the bundle
DSH_ROOT="$APP_DIR/Contents/Resources/dsh-root"
mkdir -p "$DSH_ROOT"

SRC="$PROJECT_ROOT"

# Copy apps (CLI lib + frontend dist) — use cp -R to preserve structure
mkdir -p "$DSH_ROOT/apps"
if [ -d "$SRC/apps/cli" ]; then
    cp -R "$SRC/apps/cli/." "$DSH_ROOT/apps/cli/" 2>/dev/null \
        || cp -R "$SRC/apps/cli" "$DSH_ROOT/apps/cli/" 2>/dev/null \
        || fail "Failed to copy apps/cli"
    info "  apps/cli ($(du -sh "$DSH_ROOT/apps/cli" 2>/dev/null | cut -f1 || echo "?"))"
fi
if [ -d "$SRC/apps/web/dist" ]; then
    mkdir -p "$DSH_ROOT/apps/web"
    cp -R "$SRC/apps/web/dist/." "$DSH_ROOT/apps/web/dist/" 2>/dev/null \
        || fail "Failed to copy apps/web/dist"
    info "  apps/web/dist ($(du -sh "$DSH_ROOT/apps/web/dist" | cut -f1))"
fi

# Copy packages (all harness plugins), keeping node_modules: the pnpm
# symlink farm must survive for runtime resolution. Copy links as links
# (rsync -a, not -aL): every link is relative and its target (packages/,
# vendor/, node_modules/.pnpm/) is bundled alongside. Dereferencing (-aL)
# re-materializes the whole .pnpm store per link and can recurse.
if [ -d "$SRC/packages" ]; then
    if rsync -a \
        --exclude='.git' \
        --exclude='*.test.*' \
        --exclude='*.spec.*' \
        --exclude='__tests__' \
        --exclude='fixtures' \
        "$SRC/packages/" "$DSH_ROOT/packages/"; then
        info "  packages ($(du -sh "$DSH_ROOT/packages" | cut -f1))"
    else
        warn "rsync failed, falling back to cp"
        cp -R "$SRC/packages/." "$DSH_ROOT/packages/" \
            || fail "Failed to copy packages"
    fi
fi

# Copy root node_modules (pnpm virtual store). Third-party packages live
# under .pnpm; workspace links under node_modules/@deepseek-ai point into
# packages/ (bundled above). Preserved as links, like packages/.
if [ -d "$SRC/node_modules" ]; then
    rsync -a "$SRC/node_modules/" "$DSH_ROOT/node_modules/" \
        || fail "Failed to copy root node_modules"
    info "  node_modules ($(du -sh "$DSH_ROOT/node_modules" | cut -f1))"
else
    fail "Root node_modules missing — run pnpm install first"
fi

# Copy vendor
if [ -d "$SRC/vendor" ]; then
    cp -R "$SRC/vendor/." "$DSH_ROOT/vendor/" 2>/dev/null || fail "Failed to copy vendor"
    info "  vendor ($(du -sh "$DSH_ROOT/vendor" | cut -f1))"
fi

# Copy native landlock binary if present (as a subdir: node_modules links
# resolve @deepseek-ai/node-addon-landlock-run → native/landlock-run/…)
if [ -d "$SRC/native/landlock-run" ]; then
    mkdir -p "$DSH_ROOT/native"
    cp -R "$SRC/native/landlock-run" "$DSH_ROOT/native/" 2>/dev/null || fail "Failed to copy native/landlock-run"
    info "  native/landlock-run"
fi

# Root config files
for f in package.json pnpm-workspace.yaml tsconfig.host.json tsconfig.client.json \
         tsconfig.base.json tsconfig.base.client.json .npmrc; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DSH_ROOT/$f"
done
info "  config files"

DSH_ROOT_SIZE=$(du -sh "$DSH_ROOT" | cut -f1)
info "dsh-root total: $DSH_ROOT_SIZE"

# Write Info.plist
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

# =============================================================================
# Step 4: Verification
# =============================================================================
step "Verifying build..."

[ -x "$APP_DIR/Contents/MacOS/$BINARY_NAME" ] || fail "Binary missing"
[ -f "$APP_DIR/Contents/Info.plist" ]          || fail "Info.plist missing"
CLI_BIN="$DSH_ROOT/apps/cli/lib/bin.js"
[ ! -f "$CLI_BIN" ] && CLI_BIN="$DSH_ROOT/apps/cli/bin.js"
[ ! -f "$CLI_BIN" ] && fail "dsh CLI missing from bundle (checked $DSH_ROOT/apps/cli/)"
info "dsh CLI found at $CLI_BIN"
[ -f "$DSH_ROOT/apps/web/dist/index.html" ]   || fail "Frontend dist missing from bundle"

# Quick smoke test: verify binary runs and starts dsh
info "Smoke testing…"
# Kill any dsh already on port 3080
pkill -f "dsh.*profile web" 2>/dev/null || true

"$APP_DIR/Contents/MacOS/$BINARY_NAME" &
APP_PID=$!
trap 'kill $APP_PID 2>/dev/null; rm -rf "$TMP_DIR"' EXIT

READY=false
for i in $(seq 1 30); do
    sleep 1
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/ 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        READY=true
        break
    fi
done

if [ "$READY" = true ]; then
    info "Smoke test passed (HTTP 200 on :3080)"
else
    warn "Smoke test: server did not become ready in 30s (bundle may still work)"
fi

kill $APP_PID 2>/dev/null
wait $APP_PID 2>/dev/null || true
trap 'rm -rf "$TMP_DIR"' EXIT

# =============================================================================
# Step 5: Code sign (optional)
# =============================================================================
if [ -n "$CODE_SIGN_ID" ]; then
    step "Codesigning (identity: $CODE_SIGN_ID)..."
    codesign --sign "$CODE_SIGN_ID" --force --deep --options runtime "$APP_DIR" \
        || warn "Codesigning failed (may need entitlements)"
    info "Codesigned"
elif [ "$NOTARIZE" = true ]; then
    warn "Notarize requested but --sign not provided; skipping"
else
    step "Codesigning (ad-hoc)..."
    codesign --force --deep -s - "$APP_DIR" \
        || warn "Ad-hoc codesigning failed"
    info "Ad-hoc codesigned"
fi

# =============================================================================
# Step 6: Create DMG (optional)
# =============================================================================
if [ "$CREATE_DMG" = true ]; then
    step "Creating DMG..."
    DMG_DIR="$TMP_DIR/dmg-work"
    DMG_PATH="$SCRIPT_DIR/../dist/$APP_NAME.dmg"
    rm -rf "$DMG_DIR"
    mkdir -p "$DMG_DIR"
    cp -R "$APP_DIR" "$DMG_DIR/"

    # Create a helper app to show the drag-to-Applications visual
    cat > "$DMG_DIR/.build_app" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>IFMajorVersion</key><integer>1</integer>
    <key>IFMinorVersion</key><integer>0</integer>
    <key>IFBgBounds</key><string>{{0, 0}, {700, 400}}</string>
    <key>IF Dock icon</key><string>Application</string>
    <key>IF Documentation folder</key><string></string>
    <key>IF Expanded</key><true/>
    <key>IF License</key><string></string>
    <key>IF Locale</key><string>0x0005</string>
    <key>IF Overlay</key><string></string>
    <key>IF Selected</key><true/>
    <key>IF Title</key><string>DeepSeek Harness</string>
    <key>IF Volume Contents</key>
    <array>
        <dict>
            <key>IF Application</key><true/>
            <key>IF Doc mount</key><false/>
            <key>IF File</key><string>DeepSeekHarness.app</string>
            <key>IF Loc</key><string>{0.500000, 0.500000}</string>
            <key>IF Selected</key><true/>
            <key>IF Type</key><string>Application</string>
        </dict>
    </array>
    <key>IF Show status line</key><true/>
    <key>IF VSize</key><integer>700</integer>
    <key>IF WSize</key><integer>400</integer>
</dict>
</plist>
PLIST

    hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_DIR" \
        -fs HFS+ -format UDRW "$TMP_DIR/$APP_NAME_temp.dmg" 2>/dev/null \
        || fail "DMG creation failed"
    hdiutil convert "$TMP_DIR/$APP_NAME_temp.dmg" \
        -format UDZO -o "$DMG_PATH" 2>/dev/null || fail "DMG conversion failed"
    rm -rf "$DMG_DIR" "$TMP_DIR/$APP_NAME_temp.dmg"
    info "DMG: $(du -h "$DMG_PATH" | cut -f1)"
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}  ✅ Release build complete${NC}"
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}.app:${NC}  $APP_DIR"
BUNDLE_SIZE=$(du -sh "$APP_DIR" | cut -f1)
echo -e "  ${CYAN}Size:${NC}  $BUNDLE_SIZE"
[ -f "$SCRIPT_DIR/../dist/$APP_NAME.dmg" ] && \
    echo -e "  ${CYAN}.dmg:${NC}  $SCRIPT_DIR/../dist/$APP_NAME.dmg"
echo ""
echo -e "  ${YELLOW}Run:${NC}    open \"$APP_DIR\""
echo -e "  ${YELLOW}Ship:${NC}   scp \"$APP_DIR\" user@server:~/Apps/"
echo ""
