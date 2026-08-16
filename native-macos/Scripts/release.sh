#!/bin/bash
# =============================================================================
# DeepSeek Harness macOS — Release Build Script
#
# One-command release build. The default assembles dsh-root from the published
# npm production closure (@deepseek-ai/dsh@0.1.0-rc.6, --omit=dev), installed
# once into native-macos/dist/.dsh-npm-closure and reused across runs:
#   ./native-macos/Scripts/release.sh
#
# Options:
#   ./native-macos/Scripts/release.sh --skip-dsh     skip dsh install (reuse npm closure)
#   ./native-macos/Scripts/release.sh --strip        strip debug symbols
#   ./native-macos/Scripts/release.sh --dmg          also create .dmg installer
#   ./native-macos/Scripts/release.sh --sign <id>    codesign with identity (default: ad-hoc)
#   ./native-macos/Scripts/release.sh --notarize     notarize after signing
#   ./native-macos/Scripts/release.sh --clean        npm mode: reinstall the closure fresh
#   ./native-macos/Scripts/release.sh --no-prune     ignored in npm mode (no dev deps to retain)
#   ./native-macos/Scripts/release.sh --from-source  assemble from the local pnpm dev tree (original path)
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
NPM_DSH_VERSION="0.1.0-rc.6"
NPM_CLOSURE_DIR="$SCRIPT_DIR/../dist/.dsh-npm-closure"

# ── Flags ──────────────────────────────────────────────────────────────────────
SKIP_DSH=false
STRIP=false
CREATE_DMG=false
CODE_SIGN_ID=""
NOTARIZE=false
CLEAN_FIRST=false
PRUNE=true
FROM_SOURCE=false

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
        --no-prune)   PRUNE=false; shift ;;
        --from-source) FROM_SOURCE=true; shift ;;
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
if [ "$FROM_SOURCE" = true ]; then
    # from-source (original path): build from the local pnpm dev tree
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
else
    # npm mode (default): install the published production closure
    if [ "$PRUNE" = false ]; then
        warn "--no-prune is ignored in npm mode: the production closure has no dev dependencies to retain"
    fi
    if [ "$SKIP_DSH" = true ]; then
        if [ ! -d "$NPM_CLOSURE_DIR/node_modules" ]; then
            fail "npm closure missing at $NPM_CLOSURE_DIR — run without --skip-dsh to install it"
        fi
        info "Reusing npm closure at $NPM_CLOSURE_DIR (--skip-dsh)"
    else
        [ "$CLEAN_FIRST" = true ] && rm -rf "$NPM_CLOSURE_DIR"
        step "Installing npm production closure (@deepseek-ai/dsh@$NPM_DSH_VERSION)..."
        npm install "@deepseek-ai/dsh@$NPM_DSH_VERSION" --omit=dev --no-audit --no-fund --prefix "$NPM_CLOSURE_DIR" \
            || fail "npm install of @deepseek-ai/dsh@$NPM_DSH_VERSION failed (registry unreachable?)"
        info "npm closure installed"
    fi
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

# Create dsh-root inside the bundle. The path must be normalized (no
# "Scripts/.."): the app spawns dsh with Bundle.resourceURL-derived paths, so
# the smoke test's pkill/listener patterns only match a canonical path.
mkdir -p "$APP_DIR/Contents/Resources/dsh-root"
DSH_ROOT="$(cd "$APP_DIR/Contents/Resources/dsh-root" && pwd)"

if [ "$FROM_SOURCE" = true ]; then
# ── from-source (original path): assemble the full pnpm dev tree ──
SRC="$PROJECT_ROOT"

# ── Prune excludes ────────────────────────────────────────────────────────────
# When PRUNE=true (default), strip dev-only packages from node_modules/.pnpm and
# build artifacts from packages/ that are dead weight at runtime. The entries are
# safe to remove: dev toolchain (typescript, oxlint, vitest, …), disabled-by-
# default subagent SDK binaries (@openai/codex, @anthropic-ai/claude-agent-sdk-
# darwin-arm64 — both `disabled: true` in every shipped agent preset), and
# non-runtime file types (*.map, *.d.ts, *.ts source, *.tsbuildinfo, .DS_Store).
# Broken symlinks under node_modules/<pkg> are harmless — they only resolve on
# require(), which the runtime never issues for these packages.
PNPM_DEV_EXCLUDES=(
    --exclude='.pnpm/typescript@*'
    --exclude='.pnpm/tsdown@*'
    --exclude='.pnpm/tsx@*'
    --exclude='.pnpm/vite-tsconfig-paths@*'
    --exclude='.pnpm/vitest@*'
    --exclude='.pnpm/@vitest+*@*'
    --exclude='.pnpm/oxlint@*'
    --exclude='.pnpm/oxlint-tsgolint@*'
    --exclude='.pnpm/@oxlint-tsgolint+*@*'
    --exclude='.pnpm/knip@*'
    --exclude='.pnpm/publint@*'
    --exclude='.pnpm/lefthook@*'
    --exclude='.pnpm/lefthook-darwin-arm64@*'
    --exclude='.pnpm/@stylistic+*@*'
    --exclude='.pnpm/eslint-plugin-sonarjs@*'
    --exclude='.pnpm/@testing-library+*@*'
    --exclude='.pnpm/fast-check@*'
    --exclude='.pnpm/jsdom@*'
    --exclude='.pnpm/jscpd@*'
    --exclude='.pnpm/lightningcss@*'
    --exclude='.pnpm/mermaid@*'
    --exclude='.pnpm/@mermaid-js+*@*'
    --exclude='.pnpm/mdast-util-*@*'
    --exclude='.pnpm/micromark-*@*'
    --exclude='.pnpm/istanbul-lib-report@*'
    --exclude='.pnpm/smol-toml@*'
    --exclude='.pnpm/spdx-expression-parse@*'
    --exclude='.pnpm/@agentclientprotocol+sdk@*'
    --exclude='.pnpm/@yarnpkg+*@*'
    --exclude='.pnpm/@types+*@*'
    --exclude='.pnpm/@rolldown+*@*'
    --exclude='.pnpm/@oxlint+binding*@*'
    --exclude='.pnpm/esbuild@*'
    --exclude='.pnpm/@esbuild+*@*'
    --exclude='.pnpm/vite@*'
    --exclude='.pnpm/playwright@*'
    --exclude='.pnpm/playwright-core@*'
    --exclude='.pnpm/@openai+codex@*'
    --exclude='.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@*'
)

PACKAGES_ARTIFACT_EXCLUDES=(
    --exclude='*.map'
    --exclude='*.d.ts'
    --exclude='*.d.ts.map'
    --exclude='*.ts'
    --exclude='*.tsbuildinfo'
    --exclude='.DS_Store'
    --exclude='README*'
    --exclude='tsconfig*.json'
    --exclude='tsdown.config.*'
)

APPS_CLI_EXCLUDES=(
    --exclude='src/'
    --exclude='tests/'
    --exclude='reference/'
    --exclude='composition.md'
    --exclude='README*'
    --exclude='README.i18n.yaml'
    --exclude='tsconfig.json'
    --exclude='tsdown.config.ts'
    --exclude='.DS_Store'
)

if [ "$PRUNE" = false ]; then
    PNPM_DEV_EXCLUDES=()
    PACKAGES_ARTIFACT_EXCLUDES=()
    APPS_CLI_EXCLUDES=()
    info "Pruning disabled (--no-prune); bundle will include dev deps and artifacts"
fi

# ── apps/ ─────────────────────────────────────────────────────────────────────
# CLI: only lib/ + config/ + package.json are needed at runtime (per the
# package.json `files` field). Web: only the built dist/.
mkdir -p "$DSH_ROOT/apps"
if [ -d "$SRC/apps/cli" ]; then
    rsync -a "${APPS_CLI_EXCLUDES[@]}" \
        "$SRC/apps/cli/" "$DSH_ROOT/apps/cli/" \
        || fail "Failed to copy apps/cli"
    info "  apps/cli ($(du -sh "$DSH_ROOT/apps/cli" 2>/dev/null | cut -f1 || echo "?"))"
fi
if [ -d "$SRC/apps/web/dist" ]; then
    mkdir -p "$DSH_ROOT/apps/web"
    rsync -a \
        --exclude='.DS_Store' \
        "$SRC/apps/web/dist/" "$DSH_ROOT/apps/web/dist/" \
        || fail "Failed to copy apps/web/dist"
    info "  apps/web/dist ($(du -sh "$DSH_ROOT/apps/web/dist" | cut -f1))"
fi

# ── packages/ ─────────────────────────────────────────────────────────────────
# Copy packages (all harness plugins). rsync -a preserves symlinks; any
# workspace symlinks are resolved to real files in the post-assembly step.
if [ -d "$SRC/packages" ]; then
    if rsync -a \
        --exclude='.git' \
        --exclude='*.test.*' \
        --exclude='*.spec.*' \
        --exclude='__tests__' \
        --exclude='fixtures' \
        "${PACKAGES_ARTIFACT_EXCLUDES[@]}" \
        "$SRC/packages/" "$DSH_ROOT/packages/"; then
        info "  packages ($(du -sh "$DSH_ROOT/packages" | cut -f1))"
    else
        warn "rsync failed, falling back to cp"
        cp -R "$SRC/packages/." "$DSH_ROOT/packages/" \
            || fail "Failed to copy packages"
    fi
fi

# ── node_modules/ ────────────────────────────────────────────────────────────
# Root node_modules (pnpm virtual store). rsync -a preserves the pnpm
# symlink farm so circular workspace dependencies do not cause infinite
# recursion. The post-assembly step then dereferences top-level symlinks
# (node_modules/<pkg>, node_modules/@scope/<pkg>) into real files, while
# keeping .pnpm/ internal symlinks (relative paths that resolve correctly
# at any install path).
if [ -d "$SRC/node_modules" ]; then
    rsync -a "${PNPM_DEV_EXCLUDES[@]}" \
        "$SRC/node_modules/" "$DSH_ROOT/node_modules/" \
        || fail "Failed to copy root node_modules"
    info "  node_modules ($(du -sh "$DSH_ROOT/node_modules" | cut -f1))"
else
    fail "Root node_modules missing — run pnpm install first"
fi

# ── vendor/ ──────────────────────────────────────────────────────────────────
if [ -d "$SRC/vendor" ]; then
    rsync -a \
        --exclude='.DS_Store' \
        --exclude='*.tsbuildinfo' \
        --exclude='*.map' \
        --exclude='*.d.ts' \
        --exclude='*.d.ts.map' \
        "$SRC/vendor/." "$DSH_ROOT/vendor/" 2>/dev/null \
        || cp -R "$SRC/vendor/." "$DSH_ROOT/vendor/" 2>/dev/null \
        || fail "Failed to copy vendor"
    info "  vendor ($(du -sh "$DSH_ROOT/vendor" | cut -f1))"
fi

# Copy native landlock binary if present (as a subdir: node_modules links
# resolve @deepseek-ai/node-addon-landlock-run → native/landlock-run/…)
if [ -d "$SRC/native/landlock-run" ]; then
    mkdir -p "$DSH_ROOT/native"
    rsync -a --exclude='.DS_Store' --exclude='*.tsbuildinfo' \
        "$SRC/native/landlock-run/" "$DSH_ROOT/native/landlock-run/" 2>/dev/null \
        || cp -R "$SRC/native/landlock-run" "$DSH_ROOT/native/" 2>/dev/null \
        || fail "Failed to copy native/landlock-run"
    info "  native/landlock-run"
fi

# Root config files
for f in package.json pnpm-workspace.yaml tsconfig.host.json tsconfig.client.json \
         tsconfig.base.json tsconfig.base.client.json .npmrc; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DSH_ROOT/$f"
done
info "  config files"

# ── Post-assembly: dereference top-level symlinks ────────────────────────────
# Replace top-level symlinks under node_modules/ (e.g. node_modules/<pkg> →
# .pnpm/<pkg>@<ver>/node_modules/<pkg>, or node_modules/@scope/<pkg> →
# ../../packages/<pkg>) with real file copies so the bundle is self-contained
# and works at any install path (/Applications, ~/Apps, …).
#
# Symlinks inside node_modules/.pnpm/ are PRESERVED: they use relative paths
# that resolve correctly wherever the .pnpm/ tree lives, and dereferencing
# them would trigger infinite recursion on circular workspace dependencies.
#
# Dangling symlinks (from pruned dev-only .pnpm entries) are deleted.
info "  dereferencing top-level symlinks..."
DEREF_COUNT=0
DANGLING_COUNT=0
TMP_LINKS="$TMP_DIR/top-level-links.txt"
find "$DSH_ROOT/node_modules" -maxdepth 3 -type l \
    ! -path '*/.pnpm/*' -print0 2>/dev/null > "$TMP_LINKS"
while IFS= read -r -d '' link; do
    target="$(readlink -f "$link" 2>/dev/null || true)"
    if [ -n "$target" ] && [ -e "$target" ]; then
        rm "$link"
        cp -R "$target" "$link"
        DEREF_COUNT=$((DEREF_COUNT + 1))
    else
        rm -f "$link"
        DANGLING_COUNT=$((DANGLING_COUNT + 1))
    fi
done < "$TMP_LINKS"
rm -f "$TMP_LINKS"
info "  dereferenced $DEREF_COUNT symlinks, removed $DANGLING_COUNT dangling"

# ── Post-assembly cleanup ─────────────────────────────────────────────────────
# Sweep any .DS_Store and *.tsbuildinfo that slipped through (e.g. in
# node_modules third-party packages or apps/web/dist). Also delete all
# dangling symlinks (pointing to pruned dev-only packages) across the entire
# bundle so Node.js module resolution never hits a broken link.
if [ "$PRUNE" = true ]; then
    find "$DSH_ROOT" -name '.DS_Store' -delete 2>/dev/null || true
    find "$DSH_ROOT/packages" -name '*.tsbuildinfo' -delete 2>/dev/null || true
fi
# Delete dangling symlinks regardless of PRUNE mode — broken links cause
# EPERM or ENOENT errors in Node.js module resolution at runtime.
find "$DSH_ROOT" -type l ! -exec test -e {} \; -delete 2>/dev/null || true

DSH_ROOT_SIZE=$(du -sh "$DSH_ROOT" | cut -f1)
info "dsh-root total: $DSH_ROOT_SIZE"
else
# ── npm mode (default): assemble from the published production closure ──
# npm layout is flat (no .pnpm store, no symlink farm): one rsync of
# node_modules/ is self-contained; apps/cli and apps/web/dist are relative
# symlinks into the closure so the bundle stays offline-safe and signable.
if [ ! -d "$NPM_CLOSURE_DIR/node_modules" ]; then
    fail "npm closure node_modules missing at $NPM_CLOSURE_DIR — run release.sh without --skip-dsh"
fi
rsync -a "$NPM_CLOSURE_DIR/node_modules/" "$DSH_ROOT/node_modules/" \
    || fail "Failed to copy npm closure node_modules"
info "  node_modules ($(du -sh "$DSH_ROOT/node_modules" | cut -f1))"

# apps/cli -> ../node_modules/@deepseek-ai/dsh: mkdir creates the parent;
# rm -rf clears a leftover real directory from an earlier from-source run
# before the symlink replaces it.
mkdir -p "$DSH_ROOT/apps/cli"
rm -rf "$DSH_ROOT/apps/cli"
ln -sfn "../node_modules/@deepseek-ai/dsh" "$DSH_ROOT/apps/cli"
info "  apps/cli -> ../node_modules/@deepseek-ai/dsh"

# apps/web/dist is two levels below dsh-root, so its closure target needs
# ../../node_modules (apps/web/dist -> dsh-root/node_modules/...).
mkdir -p "$DSH_ROOT/apps/web"
ln -sfn "../../node_modules/@deepseek-ai/dsh-web-frontend/dist" "$DSH_ROOT/apps/web/dist"
info "  apps/web/dist -> ../../node_modules/@deepseek-ai/dsh-web-frontend/dist"

DSH_ROOT_SIZE=$(du -sh "$DSH_ROOT" | cut -f1)
info "dsh-root total: $DSH_ROOT_SIZE"
fi

# Compile asset catalog: AppIcon.icns + Assets.car (LogoLight/LogoDark for splash)
ICON_FILE=""
ASSETS_CATALOG="$SRC_DIR/Assets.xcassets"
if [ -d "$ASSETS_CATALOG" ]; then
    xcrun actool "$ASSETS_CATALOG" \
        --platform macosx \
        --minimum-deployment-target 14.0 \
        --app-icon AppIcon \
        --compile "$APP_DIR/Contents/Resources" \
        --output-partial-info-plist "$TMP_DIR/actool.plist" \
        || fail "Asset catalog compilation failed"
    ICON_FILE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$TMP_DIR/actool.plist" 2>/dev/null || true)"
    [ -n "$ICON_FILE" ] && info "App icon: $ICON_FILE.icns + Assets.car"
fi

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

# Attach the icon name produced by actool (quoted heredoc does not expand vars)
if [ -n "$ICON_FILE" ]; then
    /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string $ICON_FILE" "$APP_DIR/Contents/Info.plist"
fi

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
# Terminate dsh instances from this bundle: a force-quit or crash leaves the
# child of an earlier run holding :6080, and a fresh dsh then exits with
# EADDRINUSE (reported by the app as "code=1").
pkill -f "$DSH_ROOT/apps/cli/lib/bin.js --profile web" 2>/dev/null || true

"$APP_DIR/Contents/MacOS/$BINARY_NAME" &
APP_PID=$!
trap 'kill $APP_PID 2>/dev/null || true; rm -rf "$TMP_DIR"' EXIT

READY=false
for i in $(seq 1 30); do
    sleep 1
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6080/ 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        # Confirm the responder is this bundle's own dsh, not a leftover from
        # another copy of the app or an unrelated service on :6080.
        LISTENER_PID=$(lsof -nP -iTCP:6080 -sTCP:LISTEN -t 2>/dev/null | head -1)
        if [ -n "$LISTENER_PID" ]; then
            LISTENER_CMD=$(ps -p "$LISTENER_PID" -o command= 2>/dev/null || true)
            case "$LISTENER_CMD" in
                *"$DSH_ROOT/apps/cli/lib/bin.js --profile web"*)
                    READY=true
                    break
                    ;;
            esac
        fi
    fi
done

if [ "$READY" = true ]; then
    info "Smoke test passed (HTTP 200 on :6080)"
else
    warn "Smoke test: server did not become ready in 30s (bundle may still work)"
fi

kill $APP_PID 2>/dev/null || true
wait $APP_PID 2>/dev/null || true
# The dsh child outlives a SIGTERM'd app; terminate it so the smoke test never
# leaves an orphan holding :6080.
pkill -f "$DSH_ROOT/apps/cli/lib/bin.js --profile web" 2>/dev/null || true
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
        -fs HFS+ -format UDRW "$TMP_DIR/${APP_NAME}_temp.dmg" 2>/dev/null \
        || fail "DMG creation failed"
    hdiutil convert "$TMP_DIR/${APP_NAME}_temp.dmg" \
        -format UDZO -o "$DMG_PATH" 2>/dev/null || fail "DMG conversion failed"
    rm -rf "$DMG_DIR" "$TMP_DIR/${APP_NAME}_temp.dmg"
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
