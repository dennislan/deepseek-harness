# DeepSeek Harness — macOS 桌面应用

原生 macOS 14+ 桌面应用，使用 **Swift + SwiftUI + WKWebView** 构建。

无需 Electron，无需 WebView 封装库。一个轻量 Swift 外壳启动 dsh 子进程，用 `WKWebView` 承载现有 Harness Web UI，并通过 JS↔Swift Bridge 暴露 macOS 原生能力。

## 架构

```
DeepSeekHarness.app/
├── Contents/MacOS/DeepSeekHarness          # 编译后的 Swift 二进制
├── Contents/Resources/dsh-root/            # 符号链接 → 项目根目录（debug）
│                                              或完整 dsh 目录树（含 pnpm
│                                              node_modules 符号链接农场，release）
└── Contents/Info.plist
```

**运行流程：**
1. 应用启动 → `DshServer` 以子进程方式运行 `dsh --profile web --port 3080`
2. 轮询 HTTP `/` 返回 200
3. `ContentView` 在 `WKWebView` 中加载 `http://127.0.0.1:3080`
4. JS Bridge (`nativeBridge`) 将 `window.nativeBridge.request()` 映射到 macOS API

## 项目根目录解析顺序

1. `DSH_PROJECT_ROOT` 环境变量
2. `.app` 包内的 `Contents/Resources/dsh-root/`（完整打包模式）
3. 从可执行文件所在目录逐级向上探测 `apps/cli/lib/bin.js`（swiftc 开发构建）
4. 均未命中则报错退出（可读错误），可设 `DSH_PROJECT_ROOT` 显式指定项目根目录

## 持久化状态（`~/.dsh`）

用户数据持久化在 `~/.dsh`：`DshServer` 在启动 dsh 前创建该目录，显式设置的
`DSH_HOME` 环境变量优先于默认值（优先级与 `dsh-home-paths` 一致）：

- `profiles/` — `web` profile，首次启动时创建，之后复用
- `sessions/` — 会话日志，跨应用重启保留
- `storages/` — 设置、凭证引用与匿名身份

profiles 与会话**不再**写入每次启动的临时目录 `/tmp/dsh-<pid>`：它们跨重启持久保留。

## 快速开始

```bash
# 1. 构建 dsh（CLI + 前端）
pnpm run build

# 2. 构建 macOS 应用（轻量符号链接模式）
./native-macos/Scripts/build.sh

# 3. 运行
open native-macos/dist/DeepSeekHarness-debug.app
```

冷启动后，应用将 dsh 作为子进程拉起，服务就绪后由 `WKWebView` 加载 UI；
Web UI 也可在浏览器中通过 `http://127.0.0.1:3080` 访问。

## 发布构建（Release Build）

生成自包含可分发 `.app`（无符号链接依赖）：

```bash
./native-macos/Scripts/release.sh           # 完整构建（dsh + Swift）
./native-macos/Scripts/release.sh --skip-dsh   # 跳过 pnpm build
./native-macos/Scripts/release.sh --dmg      # 同时生成 .dmg 安装包
./native-macos/Scripts/release.sh --sign "Developer ID"  # 代码签名
```

选项：

| 参数 | 说明 |
|------|------|
| `--skip-dsh` | 跳过 `pnpm run build`（dsh 已最新） |
| `--strip` | 去除二进制调试符号 |
| `--dmg` | 生成 `.dmg` 磁盘镜像安装包 |
| `--sign <id>` | 使用指定身份签名 |
| `--notarize` | 签名后公证 |
| `--clean` | 先运行 `pnpm run clean` |

**产出：** `native-macos/dist/DeepSeekHarness.app`（约 1.5GB，2026-08-15 实测；
包含完整 dsh 目录树，含 pnpm `node_modules` 符号链接农场）

bundle 相对 dsh 目录树是自包含的（无需源码检出），但运行时仍需系统
**Node.js ≥ 22**。脚本自带 smoke test：启动应用并校验 3080 端口 HTTP 200。

## 升级流程

当 deepseek-harness 有更新时：

```bash
# 第一步：拉取最新代码并重新构建 Node.js 侧
git pull
pnpm run build

# 第二步：重新编译 Swift 二进制并刷新 .app 包
./native-macos/Scripts/build.sh --skip-dsh
```

一键完成（轻量模式，无文件复制）：

```bash
git pull && pnpm run build && ./native-macos/Scripts/build.sh --skip-dsh
```

### 完整打包模式

用于分发（无符号链接依赖）：

```bash
./native-macos/Scripts/build.sh --bundle
# 产出：native-macos/dist/DeepSeekHarness.app（与 release 相同的 dsh 目录树，约 1.5GB）
```

### Bundle 内容与离线运行

release 与 `--bundle` 构建会将完整 dsh 运行时内嵌到 `.app`：

- `apps/cli` 与 `apps/web/dist` — dsh CLI 与 Web UI
- `packages/`、`vendor/`、`native/landlock-run` — harness 插件与原生助手
- `node_modules/` — 完整 pnpm 依赖树，含 `.pnpm` 虚拟商店与
  `node_modules/@deepseek-ai` 下的 workspace 符号链接农场

符号链接以**链接形式**复制（`rsync -a`，而非 `-aL`）：每条链接都是相对路径，
其目标（`.pnpm/`、`packages/`、`vendor/`）已一并打包，因此整个目录树在 bundle
内可解析并可离线运行。若反序列化链接（`-aL`），`.pnpm` 商店会按链接逐份复制，
并可能因 peer 环递归失控。

轻量 debug 构建（`build.sh` 不加 `--bundle`）**不携带** dsh 目录树：
`Contents/Resources/dsh-root` 是指向项目根目录的符号链接，依赖源码检出。
所有模式下运行时都要求 Node.js ≥ 22。

## 脚本选项

| 参数 | 说明 |
|------|------|
| （无） | Debug 构建，轻量符号链接模式 |
| `release` | Release 构建（`-O`），生成 `DeepSeekHarness.app` |
| `--skip-dsh` | 跳过 `pnpm run build`（dsh 已最新） |
| `--bundle` | 完整打包模式（将 dsh 目录树连同 node_modules 符号链接农场内嵌到 .app，约 1.5GB） |
| `--clean` | 构建前运行 `pnpm run clean` |

## 原生 Bridge API

从 JavaScript（Web UI 内部）调用：

```javascript
// 异步请求并等待响应
const path = await nativeBridge.request('directoryPicker')
const files = await nativeBridge.request('filePicker', { multiple: true })
const url = await nativeBridge.request('savePanel', { defaultName: 'report.md' })

//  fire-and-forget
nativeBridge.callSync('showNotification', { title: '完成', body: '任务已完成' })

// 环境变量
const key = await nativeBridge.request('getEnvironment', { key: 'DEEPSEEK_API_KEY' })

// 弹窗
await nativeBridge.request('alert', { title: '提示', message: '发生了某事' })
const yes = await nativeBridge.request('confirm', { title: '确认', message: '确定吗？' })
```

## 环境要求

- macOS 14.0+ (Sonoma)
- Xcode 16+（提供 `xcrun swiftc`）
- Node.js 22+（dsh 运行时）
- pnpm（dsh 构建）
