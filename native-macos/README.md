# DeepSeek Harness — macOS Desktop App

Native macOS 14+ desktop application built with **Swift + SwiftUI + WKWebView**.

No Electron. No WebView wrapper libraries. Just a thin Swift shell that hosts the existing Harness web UI in a `WKWebView`, with a JS↔Swift bridge for native macOS capabilities.

## Architecture

```
DeepSeekHarness.app/
├── Contents/MacOS/DeepSeekHarness          # Compiled Swift binary
├── Contents/Resources/dsh-root/            # Symlink → project root (dev)
│                                              or copy of apps/packages (release)
└── Contents/Info.plist
```

**Runtime flow:**
1. App launches → `DshServer` starts `dsh --profile web --port 3080` as a child process
2. Waits for HTTP `/` to return 200
3. `ContentView` loads `http://127.0.0.1:3080` in a `WKWebView`
4. JS bridge (`nativeBridge`) maps `window.nativeBridge.request()` → macOS APIs

## Project Root Resolution

The app finds the dsh project in this order:
1. `DSH_PROJECT_ROOT` environment variable
2. `Contents/Resources/dsh-root/` inside the `.app` bundle (full-bundle mode)
3. Three levels up from the running binary (swiftc dev build)
4. Fallback: `/Users/dennis/AIProjects/deepseek-harness`

## Quick Start

```bash
# 1. Build dsh (CLI + frontend)
pnpm run build

# 2. Build macOS app (lightweight symlink mode)
./native-macos/Scripts/build.sh

# 3. Run
open native-macos/dist/DeepSeekHarness-debug.app
```

## Upgrade Workflow

When deepseek-harness is updated, the upgrade is a two-step process:

```bash
# Step 1: Pull latest code and rebuild the Node.js side
git pull
pnpm run build

# Step 2: Recompile Swift binary and refresh the app bundle
./native-macos/Scripts/build.sh --skip-dsh
```

Or in one line (lightweight mode — no file copy):

```bash
git pull && pnpm run build && ./native-macos/Scripts/build.sh --skip-dsh
```

### Full Bundle Mode

For distribution (no symlink dependency):

```bash
./native-macos/Scripts/build.sh --bundle
# Produces: native-macos/dist/DeepSeekHarness.app (~500MB, self-contained)
```

## Script Options

| Flag | Description |
|------|-------------|
| (none) | Debug build, lightweight symlink mode |
| `release` | Release build (`-O`), `DeepSeekHarness.app` |
| `--skip-dsh` | Skip `pnpm run build` (dsh already up-to-date) |
| `--bundle` | Full bundle mode (copies dsh into .app, ~500MB) |
| `--clean` | Run `pnpm run clean` before building |

## Native Bridge API

From JavaScript (inside the web UI):

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

## Requirements

- macOS 14.0+ (Sonoma)
- Xcode 16+ (for `xcrun swiftc`)
- Node.js 22+ (for dsh runtime)
- pnpm (for dsh build)

## Development Notes

- The Swift source lives in `native-macos/App/`
- `DshServer.swift` — Node.js subprocess management
- `BridgeManager.swift` — WKWebView ↔ Swift message bridge
- `ContentView.swift` — SwiftUI view with WKWebView container
- `DeepSeekHarnessApp.swift` — App entry point
