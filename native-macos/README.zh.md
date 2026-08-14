# DeepSeek Harness — macOS 桌面应用

原生 macOS 14+ 桌面应用，使用 **Swift + SwiftUI + WKWebView** 构建。

无需 Electron，无需 WebView 封装库。一个轻量 Swift 外壳启动 dsh 子进程，用 `WKWebView` 承载现有 Harness Web UI，并通过 JS↔Swift Bridge 暴露 macOS 原生能力。

## 架构

```
DeepSeekHarness.app/
├── Contents/MacOS/DeepSeekHarness          # 编译后的 Swift 二进制
├── Contents/Resources/dsh-root/            # 符号链接 → 项目根目录（开发模式）
│                                              或 dsh 文件副本（发布模式）
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
3. 可执行文件向上三级（swiftc 开发构建）
4. 默认回退：`/Users/dennis/AIProjects/deepseek-harness`

## 快速开始

```bash
# 1. 构建 dsh（CLI + 前端）
pnpm run build

# 2. 构建 macOS 应用（轻量符号链接模式）
./native-macos/Scripts/build.sh

# 3. 运行
open native-macos/dist/DeepSeekHarness-debug.app
```

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
# 产出：native-macos/dist/DeepSeekHarness.app（约 500MB，自包含）
```

## 脚本选项

| 参数 | 说明 |
|------|------|
| （无） | Debug 构建，轻量符号链接模式 |
| `release` | Release 构建（`-O`），生成 `DeepSeekHarness.app` |
| `--skip-dsh` | 跳过 `pnpm run build`（dsh 已最新） |
| `--bundle` | 完整打包模式（将 dsh 内嵌到 .app，约 500MB） |
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
