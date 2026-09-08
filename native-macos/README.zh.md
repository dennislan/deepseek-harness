# DeepSeek Harness — macOS 桌面应用

[English](README.md) | 中文

原生 macOS 14+ 桌面应用，使用 **Swift + SwiftUI + WKWebView** 构建。

无需 Electron，无需 WebView 封装库。一个轻量 Swift 外壳启动 dsh 子进程，用 `WKWebView` 承载现有 Harness Web UI，并通过 JS↔Swift Bridge 暴露 macOS 原生能力。

## 架构

```
DeepSeekHarness.app/
├── Contents/MacOS/DeepSeekHarness          # Compiled Swift binary
├── Contents/Resources/dsh-root/            # Symlink → project root (debug)
│                                              or npm production closure (release)
└── Contents/Info.plist
```

**运行流程：**
1. 应用启动 → `DshServer` 以子进程方式运行 `dsh --profile web --port 6080`
2. 轮询 HTTP `/` 返回 200
3. `ContentView` 在 `WKWebView` 中加载 `http://127.0.0.1:6080`
4. JS Bridge (`nativeBridge`) 将 `window.nativeBridge.request()` 映射到 macOS API

启动 dsh 前，应用会先终止仍占用所选端口的残留 dsh 进程。强制退出或崩溃可能
让上一次运行的 dsh 子进程成为孤儿；若不回收，新启动的 dsh 会以 `EADDRINUSE`
失败，应用只显示「dsh 进程意外退出 (code=1)」。端口被其他程序占用时会给出
可操作的明确提示而不是裸的退出码。正常退出（Cmd+Q / 应用菜单退出）时应用会
先终止 dsh 子进程，因此孤儿只会在硬杀进程后出现，并由下一次启动自动清理。

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
- `logs/` — 最近一次 dsh 启动输出（`dsh-<port>.log`）；启动失败时状态栏会
  显示日志尾部，而不是一个裸的退出码

profiles 与会话**不再**写入每次启动的临时目录 `/tmp/dsh-<pid>`：它们跨重启持久保留。

## 快速开始

```bash
# 1. Build dsh (CLI + frontend)
pnpm run build

# 2. Build macOS app (lightweight symlink mode)
./native-macos/Scripts/build.sh

# 3. Run
open native-macos/dist/DeepSeekHarness-debug.app
```

冷启动后，应用将 dsh 作为子进程拉起，服务就绪后由 `WKWebView` 加载 UI；
Web UI 也可在浏览器中通过 `http://127.0.0.1:6080` 访问。

## 发布构建（Release Build）

生成自包含可分发 `.app`（无符号链接依赖）。默认路径组装 npm 生产闭包；
`--from-source` 显式选择旧 pnpm 路径（体积大得多，仅供本地未发布代码调试）：

```bash
./native-macos/Scripts/release.sh           # full build (npm closure + Swift)
./native-macos/Scripts/release.sh --skip-dsh   # reuse existing npm closure
./native-macos/Scripts/release.sh --dmg      # also create .dmg installer
./native-macos/Scripts/release.sh --sign "Developer ID"  # codesign
```

闭包由 `NPM_DSH_VERSION` 锁定（当前 `0.1.0-rc.6`），持久存放在
`dist/.dsh-npm-closure/`（相对 `native-macos/`）：`--skip-dsh` 复用它，
`--clean` 清空并重装。全部参数见下文「脚本选项」。

**产出：** `native-macos/dist/DeepSeekHarness.app`（230M，2026-08-16 实测；
npm 生产闭包 + 清理后的 `node_modules`；对比 2026-08-15 实测约 1.5GB，
缩小 6.67 倍）

bundle 相对 dsh 目录树是自包含的（无需源码检出），但运行时仍需系统
**Node.js ≥ 22**。脚本自带 smoke test：启动应用并校验 6080 端口 HTTP 200。

## 升级流程

当 deepseek-harness 有更新时：

```bash
# Step 1: Pull latest code and rebuild the Node.js side
git pull
pnpm run build

# Step 2: Recompile Swift binary and refresh the app bundle
./native-macos/Scripts/build.sh --skip-dsh
```

一键完成（轻量模式，无文件复制）：

```bash
git pull && pnpm run build && ./native-macos/Scripts/build.sh --skip-dsh
```

### Bundle 内容与离线运行

release 构建将完整 dsh 运行时内嵌到 `.app`：

- `Contents/Resources/dsh-root/node_modules/` — 扁平 npm 布局（无 `.pnpm`
  虚拟商店、无符号链接农场），含编译后的 `@deepseek-ai/*` 包，已清理
  `*.map`、`*.d.ts`、README/CHANGELOG 与测试/文档夹具
- `apps/cli` — 符号链接到 `../node_modules/@deepseek-ai/dsh`
- `apps/web/dist` — 符号链接到 `../node_modules/@deepseek-ai/dsh-web-frontend/dist`

两个桥接符号链接可通过 `codesign --verify --deep --strict`（2026-08-16 构建
已验证），并让应用的 bundle 根目录探测在闭包内解析出 `apps/cli/lib/bin.js`
与前端 dist。整个目录树可离线运行；运行时仅要求系统 **Node.js ≥ 22**。

## 脚本选项

`./native-macos/Scripts/release.sh` 的参数：

| 参数 | 说明 |
|------|------|
| （无） | 完整 release 构建：npm 生产闭包 + Swift，生成 `DeepSeekHarness.app` |
| `--skip-dsh` | 跳过 npm install，复用 `dist/.dsh-npm-closure` 现有闭包；闭包缺失时以可读错误失败 |
| `--clean` | 清空 `dist/.dsh-npm-closure` 并重新安装 |
| `--no-prune` | npm 模式下忽略（打印警告；生产闭包没有可剥离的 dev 依赖） |
| `--from-source` | 选择旧 pnpm 路径，从本地源码检出组装（体积大得多，仅供调试未发布代码） |
| `--strip` | 去除二进制调试符号 |
| `--dmg` | 生成 `.dmg` 磁盘镜像安装包 |
| `--sign <id>` | 使用指定身份签名 |
| `--notarize` | 签名后公证 |

## 原生 Bridge API

从 JavaScript（Web UI 内部）调用：

```javascript
// Async request with response
const path = await nativeBridge.request('directoryPicker')
const files = await nativeBridge.request('filePicker', { multiple: true })
const url = await nativeBridge.request('savePanel', { defaultName: 'report.md' })

// Fire-and-forget
nativeBridge.callSync('showNotification', { title: 'Done', body: 'Task complete' })

// Environment
const key = await nativeBridge.request('getEnvironment', { key: 'DEEPSEEK_API_KEY' })

// Alerts
await nativeBridge.request('alert', { title: 'Info', message: 'Something happened' })
const yes = await nativeBridge.request('confirm', { title: 'Confirm', message: 'Are you sure?' })
```

## 环境要求

- macOS 14.0+ (Sonoma)
- Xcode 16+（提供 `xcrun swiftc`）
- Node.js 22+（dsh 运行时）
- pnpm（仅 `--from-source` 构建需要；npm 闭包路径只需 npm）

## 开发笔记

- Swift 源码位于 `native-macos/App/`
- `DshServer.swift` — Node.js 子进程管理
- `BridgeManager.swift` — WKWebView ↔ Swift 消息桥
- `ContentView.swift` — 带 WKWebView 容器的 SwiftUI 视图
- `DeepSeekHarnessApp.swift` — 应用入口
