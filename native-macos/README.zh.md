# DeepSeek Harness — macOS 桌面应用

[English](README.md) | 中文

原生 macOS 14+ 桌面应用，使用 **Swift + SwiftUI + WKWebView** 构建。

无需 Electron，无需 WebView 封装库。一个轻量 Swift 外壳启动 dsh 子进程，用 `WKWebView` 承载现有 Harness Web UI，并通过 JS↔Swift Bridge 暴露 macOS 原生能力。

## 架构

```
DeepSeekHarness.app/
├── Contents/MacOS/DeepSeekHarness          # Compiled Swift binary
├── Contents/Info.plist
└── Contents/Resources/
    ├── dsh-root/                           # Seed runtime: npm production closure
    ├── node/                               # Embedded Node.js + npm
    └── updater/                            # assemble-runtime.mjs, prune-node-modules.mjs
```

**运行流程：**
1. 应用启动 → `DshServer` 以子进程方式运行 `dsh --profile web --port 6080`
2. 轮询 HTTP `/` 返回 200
3. `ContentView` 在 `WKWebView` 中加载 `http://127.0.0.1:6080`
4. JS Bridge (`nativeBridge`) 将 `window.nativeBridge.request()` 映射到 macOS API
5. `RuntimeUpdater` 在后台检查是否有更新的 dsh 运行时，用户确认后安装到
   `<DSH_HOME>/runtime` 并重启 dsh

启动 dsh 前，应用会先终止仍占用所选端口的残留 dsh 进程。强制退出或崩溃可能
让上一次运行的 dsh 子进程成为孤儿；若不回收，新启动的 dsh 会以 `EADDRINUSE`
失败，应用只显示「dsh 进程意外退出 (code=1)」。端口被其他程序占用时会给出
可操作的明确提示而不是裸的退出码。正常退出（Cmd+Q / 应用菜单退出）时应用会
先终止 dsh 子进程，因此孤儿只会在硬杀进程后出现，并由下一次启动自动清理。

## 项目根目录解析顺序

1. `DSH_PROJECT_ROOT` 环境变量
2. `<DSH_HOME>/runtime/dsh-root`（已下载的更新）与 `.app` 包内
   `Contents/Resources/dsh-root/`（随包分发的种子）中版本更高的一方；
   版本相同时取已下载的运行时，避免陈旧运行时遮蔽新版 `.app`
3. 从可执行文件所在目录逐级向上探测 `apps/cli/lib/bin.js`（swiftc 开发构建）
4. 均未命中则报错退出（可读错误），可设 `DSH_PROJECT_ROOT` 显式指定项目根目录

## 持久化状态（`~/.dsh`）

用户数据持久化在 `~/.dsh`：`DshServer` 在启动 dsh 前创建该目录，显式设置的
`DSH_HOME` 环境变量优先于默认值（优先级与 `dsh-home-paths` 一致）：

- `profiles/` — `web` profile，首次启动时创建，之后复用
- `sessions/` — 会话日志，跨应用重启保留
- `storages/` — 设置、凭证引用与匿名身份
- `logs/` — 最近一次 dsh 启动输出（`dsh-<port>.log`）；启动失败时状态栏会
  显示日志尾部，而不是一个裸的退出码；运行时更新的 npm 输出写入
  `update-*.log`
- `runtime/` — 可更新的 dsh 运行时（`dsh-root`）、被它替换的上一份
  （`dsh-root.previous`）、共享的 npm 缓存（`.npm-cache`）与更新锁

profiles 与会话**不再**写入每次启动的临时目录 `/tmp/dsh-<pid>`：它们跨重启持久保留。

## 快速开始

```bash
# 1. Build the app bundle (npm production closure + Swift shell + embedded Node/npm)
./native-macos/Scripts/build-release.sh

# 2. Run
open native-macos/dist/DeepSeekHarness.app
```

冷启动后，应用将 dsh 作为子进程拉起，服务就绪后由 `WKWebView` 加载 UI；
Web UI 也可在浏览器中通过 `http://127.0.0.1:6080` 访问。

## 发布构建（Release Build）

生成可分发 `.app`。默认路径先解析最新 release，再组装它的 npm 生产闭包；
`--from-source` 显式选择旧 pnpm 路径（体积大得多，仅供本地未发布代码调试）：

```bash
./native-macos/Scripts/build-release.sh              # resolve latest + full build
./native-macos/Scripts/build-release.sh --skip-dsh   # reuse the existing npm closure
./native-macos/Scripts/build-release.sh --dmg        # also create a .dmg installer
./native-macos/Scripts/build-release.sh --sign "Developer ID"  # codesign
./native-macos/Scripts/build-release.sh --oneclick   # clone upstream and build it
```

版本取自最新的 GitHub release tag，并在 npm registry 上校验，失败时回退到
registry 的 `latest`——与应用自身运行期更新用的是同一套优先级。闭包持久存放在
`dist/.dsh-npm-closure/`（相对 `native-macos/`）：`--skip-dsh` 复用它，
`--clean` 清空并重装。全部参数见下文「脚本选项」。

**产出：** `native-macos/dist/DeepSeekHarness.app`（230M，2026-08-16 实测；
npm 生产闭包 + 清理后的 `node_modules`；对比 2026-08-15 实测约 1.5GB，
缩小 6.67 倍）

bundle 是自包含的：它在 `Contents/Resources/node` 下内嵌 Node.js 与 npm，
因此干净 macOS 无需系统 Node；`DSH_NODE_PATH` 与系统 Node 仍作为回退
（`--no-node` 可跳过内嵌运行时）。脚本自带 smoke test：启动应用并校验
6080 端口 HTTP 200。

## 运行时更新

应用自行更新 dsh 运行时，用户无需重新打包或重新安装。

每次启动后、dsh 就绪时，应用会向 GitHub 询问最新 release tag，到 npm registry
核验该版本确实存在（失败则回退 registry 的 `latest`），再与正在运行的运行时比较。
只有发布版本更新时才会下载并弹出提示；网络或 registry 失败只记日志，本次启动照常。

同一次检查也可在应用菜单中手动触发：**检查更新…** 总会给出结果——`发现新版本`
（附当前与目标版本）、替换运行时的 `正在更新`，或 `当前已是最新版本`。手动检查
若无法访问 GitHub 或 registry，会明确报错而不是只写日志。

用户确认后，应用会：

1. 用内嵌 npm 把 `@deepseek-ai/dsh@<version>` 安装到
   `<DSH_HOME>/runtime/.staging-<uuid>`，并复用 `<DSH_HOME>/runtime/.npm-cache`，
   未变更的包不会重复下载；
2. 用与发布构建相同的两个脚本剪枝（`assemble-runtime.mjs`、
   `prune-node-modules.mjs`）；
3. 建立 `apps/cli` 与 `apps/web/dist` 桥接符号链接；
4. 校验暂存运行时——`node apps/cli/lib/bin.js --version` 必须能加载模块图并
   打印出目标版本；
5. 以目录重命名完成切换，把上一份运行时保留为 `dsh-root.previous`，然后重启 dsh。

若新运行时启动失败，应用会把 `dsh-root.previous` 移回、重启 dsh，并连同日志目录
一起报告失败原因。应用进程全程不退出，`.app` 包也不会被修改，因此代码签名与
Gatekeeper 状态保持不变。运行时状态位于 `<DSH_HOME>/runtime`（默认
`~/.dsh/runtime`），更新日志写入 `<DSH_HOME>/logs/update-*.log`。

「关于」面板报告的是当前生效的运行时版本，而不是外壳的编译期版本，因此更新后
依然正确。

### 重建外壳

只有 Swift 外壳改动才需要重新构建：

```bash
./native-macos/Scripts/build-release.sh --skip-dsh
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

`./native-macos/Scripts/build-release.sh` 的参数：

| 参数 | 说明 |
|------|------|
| （无） | 完整 release 构建：最新 npm 生产闭包 + Swift 外壳 + 内嵌 Node/npm |
| `--oneclick` | 拉取上游源码并用 pnpm 构建后组装（模式 A） |
| `--from-source` | 从本地/外部 pnpm dev 树组装（模式 B，体积大得多） |
| `--ref <branch\|tag>` | 配合 `--oneclick`：指定上游 ref（默认 `master`） |
| `--url <repo>` | 配合 `--oneclick`：指定上游 git URL |
| `--src <dir>` | 配合 `--from-source`：指定源码树（默认本地检出） |
| `--skip-dsh` | 跳过 dsh 安装/构建，复用 `dist/.dsh-npm-closure` 现有闭包；闭包缺失时以可读错误失败 |
| `--clean` | 清空 `dist/.dsh-npm-closure` 并重新安装（配合 `--oneclick`：重新克隆源码树） |
| `--no-prune` | npm 模式下忽略（打印警告；生产闭包没有可剥离的 dev 依赖） |
| `--no-node` | 跳过内嵌 Node 下载；运行时回退 `DSH_NODE_PATH` / 系统 node |
| `--node-from <path>` | 从本地已安装目录复制内嵌 Node（含 npm），跳过下载 |
| `--strip` / `--no-strip` | 去除二进制调试符号（默认开启） |
| `--dmg` | 生成 `.dmg` 磁盘镜像安装包 |
| `--sign <id>` | 使用指定身份签名（默认 ad-hoc） |
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
- Node.js 22+（已内嵌进构建产物；系统安装仅作回退）
- pnpm（仅 `--from-source` 与 `--oneclick` 构建需要；npm 闭包路径只需 npm）

## 开发笔记

- Swift 源码位于 `native-macos/App/`
- `App/DeepSeekHarnessApp.swift` — 应用入口；启动 dsh 并触发更新检查
- `App/ContentView.swift` — 带 WKWebView 容器与更新遮罩的 SwiftUI 视图
- `App/AboutPanel.swift` — 报告当前运行时版本的「关于」面板
- `Server/DshServer.swift` — Node.js 子进程管理与运行时根解析
- `Server/NodeRuntime.swift` — Node 与 npm 定位
- `Update/RuntimeVersion.swift` — release tag 与语义化版本解析
- `Update/RuntimeLayout.swift` — 运行时路径、锁与已安装版本读取
- `Update/ReleaseResolver.swift` — GitHub release tag → npm registry 解析
- `Update/RuntimeInstaller.swift` — 闭包安装、剪枝、校验、切换与回滚
- `Update/RuntimeUpdater.swift` — 启动检查、确认框、进度与重启
- `NativeBridge/BridgeManager.swift` — WKWebView ↔ Swift 消息桥
- `bash native-macos/Scripts/test-updater-logic.sh` — 版本逻辑离线断言
