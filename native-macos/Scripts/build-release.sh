#!/usr/bin/bash
# =============================================================================
# DeepSeek Harness macOS — Unified Build & Release Script
#
# 单一入口脚本，合并原 oneclick.sh（一键拉取官方源码）与 release.sh（发布构建）的
# 全部能力。官方源码会被原封不动地拉取/使用，打包逻辑（native-macos/）与源码树
# 完全隔离；除内嵌 Node 等打包层产物外，不修改任何 harness 源码。
#
# 主要模式：
#   A. 一键拉取官方最新源码并构建（原 oneclick.sh 行为）
#        ./build-release.sh --oneclick
#        ./build-release.sh --oneclick --ref <branch|tag> --url <repo> --clean
#   B. 从本地 pnpm dev tree 组装（原 release.sh --from-source 默认行为）
#        ./build-release.sh --from-source
#        ./build-release.sh --from-source --src <外部源码树>
#   C. 从已发布 npm 生产闭包组装（原 release.sh 默认行为，零参数）
#        ./build-release.sh
#
# 通用选项：
#   --oneclick           一键模式：拉取官方源码 → pnpm build → 组装（模式 A）
#   --from-source        从本地/外部源码树组装（模式 B）
#   --ref <branch|tag>   一键模式：指定上游 ref（默认 master）
#   --url <repo>         一键模式：指定上游 git URL
#   --clean              一键模式：全量重拉源码树；或 npm 模式：重装闭包
#   --skip-dsh           跳过 dsh 安装/构建，复用已有产物
#   --src <dir>          from-source 模式：使用外部源码树（默认本地 checkout）
#   --no-node            跳过内嵌 Node 下载（运行时回退 DSH_NODE_PATH / 系统 node）
#   --node-from <path>   从本地已安装的 Node 目录复制内嵌 Node，跳过下载
#   --strip / --no-strip 二进制 strip（默认开启）
#   --dmg                额外生成 .dmg
#   --sign <id>          用指定身份 codesign（默认 ad-hoc）
#   --notarize           签名后公证
#   --no-prune           保留 dev 依赖与构建产物（默认剪枝）
#   -h | --help          显示帮助
#
# 内嵌 Node：默认下载 Node v24 arm64 到 Contents/Resources/node，使干净 macOS
#   无需系统 Node 即可运行；DSH_NODE_PATH 与系统 node 仍作为 fallback。
#   可用环境变量 NODE_VERSION 覆盖版本（须满足引擎约束 ^22.19 || >=24）。
#   如本机已安装 Node，可用 --node-from <path> 或 NODE_LOCAL_PATH 直接复制，跳过下载。
#
# 输出：
#   native-macos/dist/DeepSeekHarness.app
#   native-macos/dist/DeepSeekHarness.dmg   （--dmg 时）
# =============================================================================
set -euo pipefail

# =============================================================================
# 模块 0：路径与常量配置
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

APP_NAME="DeepSeekHarness"
BINARY_NAME="$APP_NAME"
APP_DIR="$NATIVE_MACOS_DIR/dist/$APP_NAME.app"

TMP_DIR="/tmp/dsh-build-release"
MODULE_CACHE="$TMP_DIR/module-cache"
SRC_DIR="$NATIVE_MACOS_DIR/App"
PRUNE_SCRIPT="$SCRIPT_DIR/prune-node-modules.mjs"

# npm 生产闭包（默认发布模式）：@deepseek-ai/dsh 的生产依赖，安装一次复用
# =============================================================================
# 模块 0.5：日志颜色常量（必须在模块 3 之前定义，供 early echo 使用）
# =============================================================================
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# 从 GitHub release 获取最新版本（以 GitHub 为准，npm 可能滞后）
# GitHub tag 格式为 dsh-v0.1.0-rc.N，需去掉前缀 dsh- 得到 npm 版本
NPM_DSH_VERSION="$(gh release list --repo deepseek-ai/deepseek-harness --limit 1 --json tagName --jq '.[0].tagName' | sed 's/^dsh-//' 2>/dev/null || npm view @deepseek-ai/dsh version --registry https://registry.npmjs.org 2>/dev/null || echo '0.1.0-rc.6')"
# printf '%b\n' "  ${CYAN}使用 npm 最新版本: ${NPM_DSH_VERSION}${NC}"
NPM_CLOSURE_DIR="$NATIVE_MACOS_DIR/dist/.dsh-npm-closure"

# 一键模式：独立拉取的官方源码树（构建缓存，不入库）
SRC_LATEST="$NATIVE_MACOS_DIR/dist/src-latest"
SRC_BUILD_CACHE="$SRC_LATEST/.oneclick-build-ok"

# macOS SDK 路径（Swift 编译用）
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null \
    || echo "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.5.sdk")"

# 内嵌 Node.js 运行时（固定版本，可被 NODE_VERSION 覆盖）
NODE_VERSION="${NODE_VERSION:-v24.12.0}"
# 本地已安装的 Node 目录（含 bin/node）；设置后优先复制，跳过下载。
# 使用 $HOME 而非 ~，避免全角 ～（U+FF5E）被误写时无法展开。
if [ -z "${NODE_LOCAL_PATH:-}" ] || [ "$NODE_LOCAL_PATH" = "～/.nvm/versions/node/v24.12.0" ]; then
    NODE_LOCAL_PATH="$HOME/.nvm/versions/node/v24.12.0"
fi
NODE_DIST_BASE="https://nodejs.org/dist"
NODE_TARBALL="node-${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_URL="${NODE_DIST_BASE}/${NODE_VERSION}/${NODE_TARBALL}"
NODE_SHA_URL="${NODE_DIST_BASE}/${NODE_VERSION}/SHASUMS256.txt"

ARCH="${ARCH:-arm64}"
case "$ARCH" in
    *[!a-zA-Z0-9_-]*) printf '%b\n' "${RED}✗${NC} 非法 ARCH 值 '$ARCH' (允许 [a-zA-Z0-9_-])" >&2; exit 1 ;;
esac

# =============================================================================
# 模块 1：日志与错误处理
# =============================================================================

# printf '%b' 跨 shell 可靠解释 ANSI 转义；echo -e 在 sh/POSIX 下会把 '-e' 原样输出
step() { printf '%b\n' "\n${CYAN}▶${NC} ${BOLD}[$(date +%H:%M:%S)] $*${NC}"; }
info() { printf '%b\n' "  ${GREEN}✓${NC} $*"; }
warn() { printf '%b\n' "  ${YELLOW}⚠${NC} $*"; }
fail() { printf '%b\n' "${RED}✗${NC} $*\n${RED}构建中止。${NC}" >&2; exit 1; }

# 清理函数：确保临时目录与可能残留的 APP 子进程被回收
cleanup() {
    rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# 帮助信息（从脚本头部注释提取）
show_help() {
    sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

# =============================================================================
# 模块 2：参数解析
# =============================================================================
# 主模式（互斥，最多一个）
MODE=""                 # oneclick | from-source | npm(默认)
UPSTREAM_URL="https://github.com/deepseek-ai/deepseek-harness.git"
UPSTREAM_REF="master"
CLEAN_FIRST=false
SKIP_DSH=false
SRC=""
EMBED_NODE=true
STRIP=true
CREATE_DMG=false
CODE_SIGN_ID=""
NOTARIZE=false
PRUNE=true

# 透传给组装阶段（oneclick 模式复用）
RELEASE_ARGS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --oneclick)  MODE="oneclick"; shift ;;
        --from-source) MODE="from-source"; shift ;;
        --ref)       shift; [ $# -eq 0 ] && fail "--ref 需要参数"; UPSTREAM_REF="$1"; shift ;;
        --ref=*)     UPSTREAM_REF="${1#--ref=}"; shift ;;
        --url)       shift; [ $# -eq 0 ] && fail "--url 需要参数"; UPSTREAM_URL="$1"; shift ;;
        --url=*)     UPSTREAM_URL="${1#--url=}"; shift ;;
        --clean)     CLEAN_FIRST=true; shift ;;
        --skip-dsh)  SKIP_DSH=true; shift ;;
        --src)       shift; [ $# -eq 0 ] && fail "--src 需要参数"; SRC="$1"; shift ;;
        --src=*)     SRC="${1#--src=}"; shift ;;
        --no-node)   EMBED_NODE=false; shift ;;
        --node-from) shift; [ $# -eq 0 ] && fail "--node-from 需要参数"; NODE_LOCAL_PATH="$1"; shift ;;
        --node-from=*) NODE_LOCAL_PATH="${1#--node-from=}"; shift ;;
        --strip)     STRIP=true; shift ;;
        --no-strip)  STRIP=false; shift ;;
        --dmg)       CREATE_DMG=true; shift ;;
        --sign)
            shift
            [ $# -eq 0 ] && fail "--sign 需要一个身份标识，例如 --sign \"Developer ID Application: X\""
            CODE_SIGN_ID="$1"; shift ;;
        --sign=*)
            CODE_SIGN_ID="${1#--sign=}"
            [ -z "$CODE_SIGN_ID" ] && fail "--sign 需要一个身份标识" ;;
        --notarize)  NOTARIZE=true; shift ;;
        --no-prune)  PRUNE=false; shift ;;
        -h|--help)   show_help ;;
        *)           fail "未知参数: $1" ;;
    esac
done

# 默认模式：npm 生产闭包组装
[ -z "$MODE" ] && MODE="npm"

# =============================================================================
# 模块 3：一键模式 — 拉取官方源码（原封不动）并构建
# =============================================================================
pull_upstream_source() {
    step "一键模式：拉取官方源码 ($UPSTREAM_URL @ $UPSTREAM_REF)"

    if [ "$CLEAN_FIRST" = true ]; then
        rm -rf "$SRC_LATEST"
    fi

    if [ ! -d "$SRC_LATEST/.git" ]; then
        mkdir -p "$NATIVE_MACOS_DIR/dist"
        git clone --depth 1 --no-checkout "$UPSTREAM_URL" "$SRC_LATEST" \
            || fail "git clone $UPSTREAM_URL 失败（网络/鉴权？）"
        info "已浅克隆"
    else
        step "增量获取更新..."
        git -C "$SRC_LATEST" fetch --depth 1 origin "$UPSTREAM_REF" \
            || git -C "$SRC_LATEST" fetch origin "$UPSTREAM_REF" \
            || fail "git fetch 失败"
        info "已获取"
    fi

    # 检出到请求的 ref（官方源码，原封不动）
    git -C "$SRC_LATEST" checkout --detach "FETCH_HEAD" 2>/dev/null \
        || git -C "$SRC_LATEST" checkout --detach "origin/$UPSTREAM_REF" 2>/dev/null \
        || git -C "$SRC_LATEST" checkout "$UPSTREAM_REF" \
        || fail "checkout $UPSTREAM_REF 失败"

    # 健全性检查：树结构看起来像 deepseek-harness
    [ -f "$SRC_LATEST/package.json" ] && [ -d "$SRC_LATEST/packages" ] \
        || fail "检出的源码不像 deepseek-harness（缺少 package.json/packages）"
    info "源码位于 $UPSTREAM_REF ($(git -C "$SRC_LATEST" rev-parse --short HEAD 2>/dev/null || echo unknown))"
}

build_oneclick_source() {
    step "构建 dsh (pnpm install + pnpm run build) @ $SRC_LATEST"
    cd "$SRC_LATEST"
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install \
        || fail "pnpm install 失败 @ $SRC_LATEST"
    pnpm run build || fail "pnpm run build 失败 @ $SRC_LATEST"
    : > "$SRC_BUILD_CACHE"      # 标记构建成功，使 --skip-dsh 可安全复用
    info "dsh 构建完成"
}

# =============================================================================
# 模块 4：内嵌 Node.js 运行时（自包含，可选）
# =============================================================================
embed_node_runtime() {
    local NODE_DEST="$APP_DIR/Contents/Resources/node"
    if [ "$EMBED_NODE" != true ]; then
        info "已跳过内嵌 Node（--no-node）；运行时将回退 DSH_NODE_PATH / 系统 node"
        return
    fi
    if [ -x "$NODE_DEST/bin/node" ]; then
        info "复用已存在的内嵌 Node @ $NODE_DEST ($(du -sh "$NODE_DEST" | awk '{print $1}'))"
        return
    fi

    # 优先从本地已安装的 Node 目录复制，跳过下载（--node-from / NODE_LOCAL_PATH）
    if [ -n "${NODE_LOCAL_PATH:-}" ] && [ -x "$NODE_LOCAL_PATH/bin/node" ]; then
        step "从本地复制内嵌 Node @ $NODE_LOCAL_PATH"
        mkdir -p "$NODE_DEST/bin"
        cp "$NODE_LOCAL_PATH/bin/node" "$NODE_DEST/bin/node" \
            || fail "复制本地 node 失败：$NODE_LOCAL_PATH/bin/node"
        [ -f "$NODE_LOCAL_PATH/LICENSE" ] && cp "$NODE_LOCAL_PATH/LICENSE" "$NODE_DEST/LICENSE"
        chmod +x "$NODE_DEST/bin/node"
        info "内嵌 Node 已复制 ($(du -sh "$NODE_DEST" | awk '{print $1}'))"
        return
    fi

    step "下载内嵌 Node $NODE_VERSION (darwin-arm64)..."
    local NODE_DL="$TMP_DIR/$NODE_TARBALL"
    rm -f "$NODE_DL"
    curl -fSL "$NODE_URL" -o "$NODE_DL" \
        || fail "下载 Node 失败：$NODE_URL（网络/鉴权？）"

    # 官方 SHA256 校验
    local EXPECTED
    EXPECTED="$(curl -fSL "$NODE_SHA_URL" 2>/dev/null | awk -v f="$NODE_TARBALL" '$2==f {print $1}')"
    if [ -n "$EXPECTED" ]; then
        local ACTUAL
        ACTUAL="$(shasum -a 256 "$NODE_DL" | awk '{print $1}')"
        [ "$EXPECTED" = "$ACTUAL" ] \
            || fail "Node 校验和不匹配：期望 $EXPECTED，实际 $ACTUAL"
        info "校验和已验证"
    else
        warn "无法获取 SHASUMS256.txt，跳过 Node 校验和验证"
    fi

    mkdir -p "$NODE_DEST"
    tar -xzf "$NODE_DL" -C "$TMP_DIR" || fail "解压 Node tarball 失败"
    local NODE_EXTRACT="$TMP_DIR/node-${NODE_VERSION}-darwin-arm64"
    [ -d "$NODE_EXTRACT" ] || fail "Node 解压目录缺失：$NODE_EXTRACT"

    # 仅保留 bin/node 与 LICENSE（最小体积）
    mkdir -p "$NODE_DEST/bin"
    cp "$NODE_EXTRACT/bin/node" "$NODE_DEST/bin/node" || fail "复制内嵌 node 失败"
    [ -f "$NODE_EXTRACT/LICENSE" ] && cp "$NODE_EXTRACT/LICENSE" "$NODE_DEST/LICENSE"
    chmod +x "$NODE_DEST/bin/node"
    rm -f "$NODE_DL"
    info "内嵌 Node 已安装 ($(du -sh "$NODE_DEST" | awk '{print $1}'))"
}

# =============================================================================
# 模块 5：Swift 二进制编译（release -O + 可选 strip）
# =============================================================================
compile_swift() {
    step "编译 Swift 二进制 (release -O)..."
    local BINARY_PATH="$TMP_DIR/$BINARY_NAME"

    xcrun swiftc \
        -target "$ARCH-apple-macosx14.0" \
        -O \
        -sdk "$SDK_PATH" \
        -I"$SDK_PATH/System/Library/Frameworks/SwiftUI.framework/Headers" \
        -module-cache-path "$MODULE_CACHE" \
        -framework SwiftUI -framework AppKit -framework WebKit \
        -framework Foundation -framework Security \
        -framework UniformTypeIdentifiers -framework UserNotifications \
        -o "$BINARY_PATH" \
        "$SRC_DIR/App/DeepSeekHarnessApp.swift" \
        "$SRC_DIR/App/ContentView.swift" \
        "$SRC_DIR/Server/DshServer.swift" \
        "$SRC_DIR/NativeBridge/BridgeManager.swift" \
        || fail "Swift 编译失败"

    if [ "${STRIP:-true}" = true ]; then
        xcrun strip -S "$BINARY_PATH" 2>/dev/null || true
    fi
    chmod +x "$BINARY_PATH"

    BINARY_PATH_FINAL="$BINARY_PATH"
    info "Swift 二进制：$(du -sh "$BINARY_PATH" | awk '{print $1}')（strip=${STRIP:-true}）"
}

# =============================================================================
# 模块 6：组装 dsh-root（两种来源：from-source / npm 闭包）
# =============================================================================

# 6a. from-source 模式：复制本地/外部 pnpm dev tree
assemble_from_source() {
    local SRC_TREE="${SRC:-$PROJECT_ROOT}"
    [ -d "$SRC_TREE" ] || fail "from-source 源码树缺失：$SRC_TREE"
    info "from-source 源树 = $SRC_TREE"

    # ── 剪枝排除规则 ───────────────────────────────────────────────
    # PRUNE=true（默认）时移除 dev-only 包与构建产物；这些是安全删除项：
    # 开发工具链（typescript/oxlint/vitest…）、默认禁用的 subagent SDK 二进制、
    # 以及非运行时文件类型（*.map/*.d.ts/*.ts/*.tsbuildinfo）。
    local PNPM_DEV_EXCLUDES=(
        --exclude='.pnpm/typescript@*'        --exclude='.pnpm/tsdown@*'
        --exclude='.pnpm/tsx@*'               --exclude='.pnpm/vite-tsconfig-paths@*'
        --exclude='.pnpm/vitest@*'            --exclude='.pnpm/@vitest+*@*'
        --exclude='.pnpm/oxlint@*'            --exclude='.pnpm/oxlint-tsgolint@*'
        --exclude='.pnpm/@oxlint-tsgolint+*@*' --exclude='.pnpm/knip@*'
        --exclude='.pnpm/publint@*'           --exclude='.pnpm/lefthook@*'
        --exclude='.pnpm/lefthook-darwin-arm64@*' --exclude='.pnpm/@stylistic+*@*'
        --exclude='.pnpm/eslint-plugin-sonarjs@*' --exclude='.pnpm/@testing-library+*@*'
        --exclude='.pnpm/fast-check@*'        --exclude='.pnpm/jsdom@*'
        --exclude='.pnpm/jscpd@*'             --exclude='.pnpm/lightningcss@*'
        --exclude='.pnpm/mermaid@*'           --exclude='.pnpm/@mermaid-js+*@*'
        --exclude='.pnpm/mdast-util-*@*'      --exclude='.pnpm/micromark-*@*'
        --exclude='.pnpm/istanbul-lib-report@*' --exclude='.pnpm/smol-toml@*'
        --exclude='.pnpm/spdx-expression-parse@*' --exclude='.pnpm/@agentclientprotocol+sdk@*'
        --exclude='.pnpm/@yarnpkg+*@*'        --exclude='.pnpm/@types+*@*'
        --exclude='.pnpm/@rolldown+*@*'       --exclude='.pnpm/@oxlint+binding*@*'
        --exclude='.pnpm/esbuild@*'           --exclude='.pnpm/@esbuild+*@*'
        --exclude='.pnpm/vite@*'              --exclude='.pnpm/playwright@*'
        --exclude='.pnpm/playwright-core@*'   --exclude='.pnpm/@openai+codex@*'
        --exclude='.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@*'
    )
    local PACKAGES_ARTIFACT_EXCLUDES=(
        --exclude='*.map' --exclude='*.d.ts' --exclude='*.d.ts.map'
        --exclude='*.ts' --exclude='*.tsbuildinfo' --exclude='.DS_Store'
        --exclude='README*' --exclude='tsconfig*.json' --exclude='tsdown.config.*'
    )
    local APPS_CLI_EXCLUDES=(
        --exclude='src/' --exclude='tests/' --exclude='reference/'
        --exclude='composition.md' --exclude='README*' --exclude='README.i18n.yaml'
        --exclude='tsconfig.json' --exclude='tsdown.config.ts' --exclude='.DS_Store'
    )
    if [ "$PRUNE" = false ]; then
        PNPM_DEV_EXCLUDES=(); PACKAGES_ARTIFACT_EXCLUDES=(); APPS_CLI_EXCLUDES=()
        info "已禁用剪枝（--no-prune）；将包含 dev 依赖与产物"
    fi

    # apps/cli：仅 lib/ + config + package.json 运行时必需
    mkdir -p "$DSH_ROOT/apps"
    [ -d "$SRC_TREE/apps/cli" ] && {
        rsync -a "${APPS_CLI_EXCLUDES[@]}" "$SRC_TREE/apps/cli/" "$DSH_ROOT/apps/cli/" \
            || fail "复制 apps/cli 失败"
        info "  apps/cli ($(du -sh "$DSH_ROOT/apps/cli" 2>/dev/null | cut -f1 || echo ?))"
    }
    # apps/web/dist：仅构建产物
    [ -d "$SRC_TREE/apps/web/dist" ] && {
        mkdir -p "$DSH_ROOT/apps/web"
        rsync -a --exclude='.DS_Store' "$SRC_TREE/apps/web/dist/" "$DSH_ROOT/apps/web/dist/" \
            || fail "复制 apps/web/dist 失败"
        info "  apps/web/dist ($(du -sh "$DSH_ROOT/apps/web/dist" | cut -f1))"
    }

    # packages/：所有 harness 插件
    [ -d "$SRC_TREE/packages" ] && {
        if rsync -a --exclude='.git' --exclude='*.test.*' --exclude='*.spec.*' \
            --exclude='__tests__' --exclude='fixtures' "${PACKAGES_ARTIFACT_EXCLUDES[@]}" \
            "$SRC_TREE/packages/" "$DSH_ROOT/packages/"; then
            info "  packages ($(du -sh "$DSH_ROOT/packages" | cut -f1))"
        else
            warn "rsync 失败，回退 cp"
            cp -R "$SRC_TREE/packages/." "$DSH_ROOT/packages/" \
                || fail "复制 packages 失败"
        fi
    }

    # node_modules/：pnpm 虚拟存储 + 符号链接农场
    [ -d "$SRC_TREE/node_modules" ] && {
        rsync -a "${PNPM_DEV_EXCLUDES[@]}" "$SRC_TREE/node_modules/" "$DSH_ROOT/node_modules/" \
            || fail "复制 root node_modules 失败"
        info "  node_modules ($(du -sh "$DSH_ROOT/node_modules" | cut -f1))"
    } || fail "root node_modules 缺失——请先 pnpm install"

    # vendor/ 与 native/landlock-run
    [ -d "$SRC_TREE/vendor" ] && {
        rsync -a --exclude='.DS_Store' --exclude='*.tsbuildinfo' --exclude='*.map' \
            --exclude='*.d.ts' --exclude='*.d.ts.map' "$SRC_TREE/vendor/." "$DSH_ROOT/vendor/" 2>/dev/null \
            || cp -R "$SRC_TREE/vendor/." "$DSH_ROOT/vendor/" 2>/dev/null \
            || fail "复制 vendor 失败"
        info "  vendor ($(du -sh "$DSH_ROOT/vendor" | cut -f1))"
    }
    [ -d "$SRC_TREE/native/landlock-run" ] && {
        mkdir -p "$DSH_ROOT/native"
        rsync -a --exclude='.DS_Store' --exclude='*.tsbuildinfo' \
            "$SRC_TREE/native/landlock-run/" "$DSH_ROOT/native/landlock-run/" 2>/dev/null \
            || cp -R "$SRC_TREE/native/landlock-run" "$DSH_ROOT/native/" 2>/dev/null \
            || fail "复制 native/landlock-run 失败"
        info "  native/landlock-run"
    }

    # 根配置文件
    for f in package.json pnpm-workspace.yaml tsconfig.host.json tsconfig.client.json \
             tsconfig.base.json tsconfig.base.client.json .npmrc; do
        [ -f "$SRC_TREE/$f" ] && cp "$SRC_TREE/$f" "$DSH_ROOT/$f"
    done
    info "  配置文件"

    # 反引用顶层符号链接：使 bundle 自包含，可在任意安装路径运行
    info "  反引用顶层符号链接..."
    local DEREF_COUNT=0 DANGLING_COUNT=0 TMP_LINKS="$TMP_DIR/top-level-links.txt"
    find "$DSH_ROOT/node_modules" -maxdepth 3 -type l ! -path '*/.pnpm/*' -print0 2>/dev/null > "$TMP_LINKS"
    while IFS= read -r -d '' link; do
        local target; target="$(readlink -f "$link" 2>/dev/null || true)"
        if [ -n "$target" ] && [ -e "$target" ]; then
            rm "$link"; cp -R "$target" "$link"; DEREF_COUNT=$((DEREF_COUNT+1))
        else
            rm -f "$link"; DANGLING_COUNT=$((DANGLING_COUNT+1))
        fi
    done < "$TMP_LINKS"
    rm -f "$TMP_LINKS"
    info "  已反引用 $DEREF_COUNT 个链接，移除 $DANGLING_COUNT 个悬空链接"

    # 删除全部悬空符号链接，避免 Node 解析时报错
    find "$DSH_ROOT" -type l ! -exec test -e {} \; -delete 2>/dev/null || true

    DSH_ROOT_SIZE="$(du -sh "$DSH_ROOT" | cut -f1)"
    info "dsh-root 总计：$DSH_ROOT_SIZE"
}

# 6b. npm 模式：从已发布生产闭包组装（扁平 node_modules）
assemble_from_npm() {
    [ -d "$NPM_CLOSURE_DIR/node_modules" ] \
        || fail "npm 闭包缺失 @ $NPM_CLOSURE_DIR —— 请不带 --skip-dsh 运行以安装"
    rsync -a "$NPM_CLOSURE_DIR/node_modules/" "$DSH_ROOT/node_modules/" \
        || fail "复制 npm 闭包 node_modules 失败"
    info "  node_modules 剪枝前 ($(du -sh "$DSH_ROOT/node_modules" | cut -f1))"

    # 删除非运行时文件（*.map/*.d.ts/test/docs/README 等）
    local before after
    before="$(du -sh "$DSH_ROOT/node_modules" | cut -f1)"
    find "$DSH_ROOT/node_modules" \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \
        -o -name '*.tsbuildinfo' -o -name 'README*' -o -name 'CHANGELOG*' \) -type f -delete 2>/dev/null || true
    find "$DSH_ROOT/node_modules" -type d \( -name test -o -name tests -o -name __tests__ \
        -o -name docs -o -name fixtures \) -prune -exec rm -rf {} + 2>/dev/null || true
    find "$DSH_ROOT/node_modules" -name '.DS_Store' -delete 2>/dev/null || true
    after="$(du -sh "$DSH_ROOT/node_modules" | cut -f1)"
    info "  node_modules 剪枝后 ($before → $after)"

    # apps/cli 与 apps/web/dist 以相对符号链接指向闭包内对应包
    mkdir -p "$DSH_ROOT/apps/cli"; rm -rf "$DSH_ROOT/apps/cli"
    ln -sfn "../node_modules/@deepseek-ai/dsh" "$DSH_ROOT/apps/cli"
    info "  apps/cli -> ../node_modules/@deepseek-ai/dsh"
    mkdir -p "$DSH_ROOT/apps/web"
    ln -sfn "../../node_modules/@deepseek-ai/dsh-web-frontend/dist" "$DSH_ROOT/apps/web/dist"
    info "  apps/web/dist -> ../../node_modules/@deepseek-ai/dsh-web-frontend/dist"

    DSH_ROOT_SIZE="$(du -sh "$DSH_ROOT" | cut -f1)"
    info "dsh-root 总计：$DSH_ROOT_SIZE"
}

# 6c. 两种模式通用：按 exports 可达性进一步剪枝
prune_exports_reachability() {
    if [ "$PRUNE" = true ] && [ -f "$PRUNE_SCRIPT" ]; then
        step "按 exports 可达性剪枝 node_modules..."
        if node "$PRUNE_SCRIPT" "$DSH_ROOT/node_modules" 2>&1; then
            info "精简代码"
        else
            warn "prune-node-modules.mjs 报告问题；继续使用剪枝前树"
        fi
    fi
}

# =============================================================================
# 模块 7：.app 包组装（二进制 + dsh-root + 资源 + Info.plist）
# =============================================================================
assemble_app_bundle() {
    step "组装 $APP_NAME.app..."
    rm -rf "$APP_DIR"
    mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

    cp "$BINARY_PATH_FINAL" "$APP_DIR/Contents/MacOS/$BINARY_NAME"
    chmod +x "$APP_DIR/Contents/MacOS/$BINARY_NAME"

    mkdir -p "$APP_DIR/Contents/Resources/dsh-root"
    DSH_ROOT="$(cd "$APP_DIR/Contents/Resources/dsh-root" && pwd)"

    # 依据模式选择组装来源
    if [ "$MODE" = "from-source" ] || [ "$MODE" = "oneclick" ]; then
        assemble_from_source
    else
        assemble_from_npm
    fi
    prune_exports_reachability

    # 资源目录（内嵌 Node 已由 embed_node_runtime 放入，无需额外复制）
    # 编译资源目录：AppIcon.icns + Assets.car
    local ASSETS_CATALOG="$SRC_DIR/Assets.xcassets"
    if [ -d "$ASSETS_CATALOG" ]; then
        xcrun actool "$ASSETS_CATALOG" \
            --platform macosx --minimum-deployment-target 14.0 \
            --app-icon AppIcon --compile "$APP_DIR/Contents/Resources" \
            --output-partial-info-plist "$TMP_DIR/actool.plist" \
            || fail "资源目录编译失败"
        ICON_FILE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$TMP_DIR/actool.plist" 2>/dev/null || true)"
        [ -n "$ICON_FILE" ] && info "App 图标：$ICON_FILE.icns + Assets.car"
    fi

    # 写入 Info.plist
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
    if [ -n "$ICON_FILE" ]; then
        /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string $ICON_FILE" "$APP_DIR/Contents/Info.plist"
    fi
}

# =============================================================================
# 模块 8：验证与冒烟测试
# =============================================================================
verify_and_smoke_test() {
    step "验证构建产物..."
    [ -x "$APP_DIR/Contents/MacOS/$BINARY_NAME" ] || fail "二进制缺失"
    [ -f "$APP_DIR/Contents/Info.plist" ]         || fail "Info.plist 缺失"
    local CLI_BIN="$DSH_ROOT/apps/cli/lib/bin.js"
    [ ! -f "$CLI_BIN" ] && CLI_BIN="$DSH_ROOT/apps/cli/bin.js"
    [ ! -f "$CLI_BIN" ] && fail "dsh CLI 缺失（检查 $DSH_ROOT/apps/cli/）"
    info "dsh CLI 位于 $CLI_BIN"
    [ -f "$DSH_ROOT/apps/web/dist/index.html" ]   || fail "前端 dist 缺失"

    # 冒烟测试：启动 app，等待 :6080 返回 HTTP 200，并确认监听进程为本 bundle 的 dsh
    info "冒烟测试：启动 app 并探测 :6080 ..."
    pkill -f "$DSH_ROOT/apps/cli/lib/bin.js --profile web" 2>/dev/null || true
    "$APP_DIR/Contents/MacOS/$BINARY_NAME" &
    local APP_PID=$!
    trap "kill $APP_PID 2>/dev/null || true; cleanup" EXIT

    local READY=false
    for i in $(seq 1 30); do
        sleep 1
        local CODE
        CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6080/ 2>/dev/null || echo 000)"
        if [ "$CODE" = "200" ]; then
            local LPID LCMD
            LPID="$(lsof -nP -iTCP:6080 -sTCP:LISTEN -t 2>/dev/null | head -1)"
            if [ -n "$LPID" ]; then
                LCMD="$(ps -p "$LPID" -o command= 2>/dev/null || true)"
                case "$LCMD" in
                    *"$DSH_ROOT/apps/cli/lib/bin.js --profile web"*) READY=true; break ;;
                esac
            fi
        fi
    done

    kill $APP_PID 2>/dev/null || true
    wait $APP_PID 2>/dev/null || true
    pkill -f "$DSH_ROOT/apps/cli/lib/bin.js --profile web" 2>/dev/null || true
    trap cleanup EXIT

    if [ "$READY" = true ]; then
        info "冒烟测试通过（:6080 HTTP 200）"
    else
        warn "冒烟测试：30s 内服务未就绪（bundle 仍可能正常工作）"
    fi
}

# =============================================================================
# 模块 9：代码签名（可选）与 DMG（可选）
# =============================================================================
codesign_app() {
    if [ -n "$CODE_SIGN_ID" ]; then
        step "代码签名（身份：$CODE_SIGN_ID）..."
        codesign --sign "$CODE_SIGN_ID" --force --deep --options runtime "$APP_DIR" \
            || warn "代码签名失败（可能需要 entitlements）"
        info "已签名"
    elif [ "$NOTARIZE" = true ]; then
        warn "请求了公证但未提供 --sign；跳过"
    else
        step "代码签名（ad-hoc）..."
        codesign --force --deep -s - "$APP_DIR" || warn "ad-hoc 签名失败"
        info "已 ad-hoc 签名"
    fi
}

create_dmg() {
    [ "$CREATE_DMG" != true ] && return
    step "生成 DMG..."
    local DMG_DIR="$TMP_DIR/dmg-work"
    local DMG_MOUNT="$TMP_DIR/dmg-mount"
    local DMG_RW="$TMP_DIR/${APP_NAME}_temp.dmg"
    local DMG_PATH="$NATIVE_MACOS_DIR/dist/$APP_NAME.dmg"
    rm -rf "$DMG_DIR" "$DMG_MOUNT" "$DMG_RW"; mkdir -p "$DMG_DIR"

    # 仅复制 app：Applications 软链接必须在镜像挂载后再创建，
    # 否则 hdiutil -srcfolder 会跟随该链接、把整个 /Applications 拷入镜像导致转换失败。
    cp -R "$APP_DIR" "$DMG_DIR/"

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
            <key>IF Loc</key><string>{0.280000, 0.500000}</string>
            <key>IF Selected</key><true/>
            <key>IF Type</key><string>Application</string>
        </dict>
        <dict>
            <key>IF Application</key><false/>
            <key>IF Doc mount</key><false/>
            <key>IF File</key><string>Applications</string>
            <key>IF Loc</key><string>{0.720000, 0.500000}</string>
            <key>IF Selected</key><false/>
            <key>IF Type</key><string>Folder</string>
        </dict>
    </array>
    <key>IF Show status line</key><true/>
    <key>IF VSize</key><integer>700</integer>
    <key>IF WSize</key><integer>400</integer>
</dict>
</plist>
PLIST

    # 1) 生成可读写镜像（不含 Applications 链接）
    hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_DIR" \
        -fs HFS+ -format UDRW "$DMG_RW" \
        || fail "DMG 创建失败"

    # 2) 挂载并在镜像内部创建 /Applications 软链接（不跟随到宿主系统）
    local DEV
    DEV="$(hdiutil attach -nobrowse -noautoopen -mountpoint "$DMG_MOUNT" "$DMG_RW" \
        | awk '/Apple_HFS/ {print $1; exit}')"
    [ -n "$DEV" ] || fail "DMG 挂载失败"
    ln -sfn "/Applications" "$DMG_MOUNT/Applications" \
        || { hdiutil detach "$DEV" 2>/dev/null || true; fail "创建 Applications 软链接失败"; }
    # 避免 .build_app 等隐藏文件出现在最终镜像
    rm -f "$DMG_MOUNT/.build_app" 2>/dev/null || true
    hdiutil detach "$DEV" \
        || fail "DMG 卸载失败"

    # 3) 转换为压缩镜像（UDZO）
    rm -f "$DMG_PATH"   # convert 不覆盖已存在文件，需先清理上次残留
    hdiutil convert "$DMG_RW" -format UDZO -o "$DMG_PATH" \
        || fail "DMG 转换失败"
    rm -rf "$DMG_DIR" "$DMG_MOUNT" "$DMG_RW"
    info "DMG：$(du -sh "$DMG_PATH" | awk '{print $1}')"
}

# =============================================================================
# 主流程
# =============================================================================
main() {
    printf '%b\n'
    printf '%b\n' "${BOLD}${CYAN}════════════════════════════════════════════════════════════${NC}"
    printf '%b\n' "${BOLD}${CYAN}          Build DeepSeek Harness Desktop for macOS"
    printf '%b\n' "${BOLD}${CYAN}            Dev by Dennis | dennis.lan@gmail.com "
    printf '%b\n' "${BOLD}${CYAN}════════════════════════════════════════════════════════════${NC}"
    mkdir -p "$TMP_DIR" "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

    # 阶段 1：准备 dsh 源码/产物（按模式分支）
    case "$MODE" in
        oneclick)
            if [ "$SKIP_DSH" = true ]; then
                info "跳过拉取+构建（--skip-dsh），复用 $SRC_LATEST"
                [ -d "$SRC_LATEST" ] || fail "无源码树 @ $SRC_LATEST —— 请先不带 --skip-dsh 运行"
            else
                pull_upstream_source
                build_oneclick_source
            fi
            SRC="$SRC_LATEST"   # 组装阶段使用拉取的源码树
            ;;
        from-source)
            if [ "$SKIP_DSH" = true ]; then
                info "跳过 pnpm build（--skip-dsh）"
            else
                step "构建 dsh (pnpm run build) @ ${SRC:-$PROJECT_ROOT}"
                cd "${SRC:-$PROJECT_ROOT}"
                [ "$CLEAN_FIRST" = true ] && pnpm run clean
                pnpm install --frozen-lockfile 2>/dev/null || pnpm install
                pnpm run build || fail "pnpm build 失败"
                info "dsh 构建完成"
            fi
            ;;
        npm)
            if [ "$PRUNE" = false ]; then
                warn "--no-prune 在 npm 模式被忽略：生产闭包无 dev 依赖可保留"
            fi
            if [ "$SKIP_DSH" = true ]; then
                [ -d "$NPM_CLOSURE_DIR/node_modules" ] \
                    || fail "npm 闭包缺失 @ $NPM_CLOSURE_DIR —— 请不带 --skip-dsh 运行"
                info "复用 npm 闭包 @ $NPM_CLOSURE_DIR（--skip-dsh）"
            else
                [ "$CLEAN_FIRST" = true ] && rm -rf "$NPM_CLOSURE_DIR"
                step "安装 npm 生产闭包 (@deepseek-ai/dsh@$NPM_DSH_VERSION)..."
                npm install "@deepseek-ai/dsh@$NPM_DSH_VERSION" --omit=dev --no-audit --no-fund \
                    --prefix "$NPM_CLOSURE_DIR" \
                    || fail "npm install @deepseek-ai/dsh@$NPM_DSH_VERSION 失败（registry 不可达？）"
                info "npm 闭包已安装"
            fi
            ;;
    esac

    # 阶段 2：内嵌 Node
    embed_node_runtime

    # 阶段 3：Swift 编译
    compile_swift

    # 阶段 4：组装 .app（含 dsh-root + 剪枝 + 资源）
    assemble_app_bundle

    # 阶段 5：验证 + 冒烟测试
    verify_and_smoke_test

    # 阶段 6：签名（可选）
    codesign_app

    # 阶段 7：DMG（可选）
    create_dmg

    # 完成报告
    echo ""
    printf '%b\n' "${BOLD}${GREEN}══════════════════════════════════════════════════${NC}"
    printf '%b\n' "${BOLD}${GREEN}  ✅ 构建完成${NC}"
    printf '%b\n' "${BOLD}${GREEN}══════════════════════════════════════════════════${NC}"
    echo ""
    printf '%b\n' "  ${CYAN}.app:${NC}  $APP_DIR"
    printf '%b\n' "  ${CYAN}体积:${NC}  $(du -sh "$APP_DIR" | cut -f1)"
    [ -f "$NATIVE_MACOS_DIR/dist/$APP_NAME.dmg" ] \
        && printf '%b\n' "  ${CYAN}.dmg:${NC}  $NATIVE_MACOS_DIR/dist/$APP_NAME.dmg"
    echo ""
    printf '%b\n' "  ${YELLOW}运行:${NC}    open \"$APP_DIR\""
    printf '%b\n' "  ${YELLOW}分发:${NC}   scp \"$APP_DIR\" user@server:~/Apps/"
    echo ""
}

main "$@"
