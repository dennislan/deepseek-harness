# DeepSeek Harness — macOS Desktop App

Native macOS 14+ desktop application built with **Swift + SwiftUI + WKWebView**.

No Electron. No WebView wrapper libraries. Just a thin Swift shell that hosts the existing Harness web UI in a `WKWebView`, with a JS↔Swift bridge for native macOS capabilities.

## Architecture

```
DeepSeekHarness.app/
├── Contents/MacOS/DeepSeekHarness          # Compiled Swift binary
├── Contents/Resources/dsh-root/            # Symlink → project root (debug)
│                                              or npm production closure (release)
└── Contents/Info.plist
```

**Runtime flow:**
1. App launches → `DshServer` starts `dsh --profile web --port 6080` as a child process
2. Waits for HTTP `/` to return 200
3. `ContentView` loads `http://127.0.0.1:6080` in a `WKWebView`
4. JS bridge (`nativeBridge`) maps `window.nativeBridge.request()` → macOS APIs

Before starting dsh, the app terminates any stale dsh still listening on the
chosen port. A force-quit or crash can orphan the dsh child of an earlier run;
without this recovery the fresh dsh exits with `EADDRINUSE` and the app reports
only "dsh 进程意外退出 (code=1)". A foreign process owning the port fails loud
with an actionable message instead. On normal quit (Cmd+Q / Apple menu Quit)
the app terminates its dsh child first, so orphans only appear after a hard
kill and are cleaned up on the next launch.

## Project Root Resolution

The app finds the dsh project in this order:
1. `DSH_PROJECT_ROOT` environment variable
2. `Contents/Resources/dsh-root/` inside the `.app` bundle (full-bundle mode)
3. Walking up from the running binary until `apps/cli/lib/bin.js` is found (swiftc dev build)
4. Otherwise it fails with a readable error; set `DSH_PROJECT_ROOT` to point at the repository

## Persistent State (`~/.dsh`)

User data persists under `~/.dsh`; `DshServer` creates the directory before
launching dsh, and an explicit `DSH_HOME` environment variable overrides the
default (same precedence as `dsh-home-paths`):

- `profiles/` — the `web` profile, created on first launch and reused afterwards
- `sessions/` — session logs, kept across app restarts
- `storages/` — settings, credential references, and anonymous identity
- `logs/` — the latest dsh boot output (`dsh-<port>.log`); a failed start shows
  the log tail in the app's status instead of a bare exit code

Profiles and sessions are **no longer** written to a per-launch
`/tmp/dsh-<pid>` directory: they survive app restarts.

## Quick Start

```bash
# 1. Build dsh (CLI + frontend)
pnpm run build

# 2. Build macOS app (lightweight symlink mode)
./native-macos/Scripts/build.sh

# 3. Run
open native-macos/dist/DeepSeekHarness-debug.app
```

On a cold start the app launches dsh as a child process and loads the UI in the
`WKWebView` once the server answers; the web UI is also reachable in a browser
at `http://127.0.0.1:6080`.

## Release Build

For a self-contained distributable `.app` (no symlink dependency). The default
path assembles a production npm closure; `--from-source` opts into the legacy
pnpm tree (much larger; for debugging locally unreleased code only):

```bash
./native-macos/Scripts/release.sh           # full build (npm closure + Swift)
./native-macos/Scripts/release.sh --skip-dsh   # reuse existing npm closure
./native-macos/Scripts/release.sh --dmg      # also create .dmg installer
./native-macos/Scripts/release.sh --sign "Developer ID"  # codesign
```

The closure is pinned by `NPM_DSH_VERSION` (currently `0.1.0-rc.6`) and persists
at `dist/.dsh-npm-closure/` (relative to `native-macos/`): `--skip-dsh` reuses
it and `--clean` wipes and reinstalls it. All flags are listed under Script
Options below.

**Output:** `native-macos/dist/DeepSeekHarness.app` (230M, measured 2026-08-16;
npm production closure with pruned `node_modules`; down from ~1.5GB measured
2026-08-15, 6.67x smaller)

The bundle is self-contained for the dsh tree (no source checkout needed), but a
system **Node.js ≥ 22** is still required at runtime. The script includes a smoke
test: launches the built app and verifies HTTP 200 on port 6080.

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

### Bundle Contents & Offline Operation

The release build ships the complete dsh runtime inside the `.app`:

- `Contents/Resources/dsh-root/node_modules/` — flat npm layout (no `.pnpm`
  store, no symlink farm) with the compiled `@deepseek-ai/*` packages, pruned
  of `*.map`, `*.d.ts`, README/CHANGELOG, and test/docs fixtures
- `apps/cli` — symlink to `../node_modules/@deepseek-ai/dsh`
- `apps/web/dist` — symlink to `../node_modules/@deepseek-ai/dsh-web-frontend/dist`

The bridge symlinks survive `codesign --verify --deep --strict` (verified on the
2026-08-16 build) and let the app's bundle-root probe resolve `apps/cli/lib/bin.js`
and the frontend dist inside the closure. Everything runs offline; only a system
**Node.js ≥ 22** is required at runtime.

## Script Options

Flags for `./native-macos/Scripts/release.sh`:

| Flag | Description |
|------|-------------|
| (none) | Full release build: npm production closure + Swift, `DeepSeekHarness.app` |
| `--skip-dsh` | Skip npm install and reuse the existing closure at `dist/.dsh-npm-closure`; fails with a readable error if the closure is missing |
| `--clean` | Wipe `dist/.dsh-npm-closure` and reinstall |
| `--no-prune` | Ignored in npm mode (prints a warning; the production closure has no dev dependencies to strip) |
| `--from-source` | Opt into the legacy pnpm path, assembling from the local source checkout (much larger; for debugging unreleased code only) |
| `--strip` | Strip debug symbols from binary |
| `--dmg` | Create `.dmg` disk image installer |
| `--sign <id>` | Codesign with identity |
| `--notarize` | Notarize after signing |

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
- pnpm (only for `--from-source` builds; the npm closure path needs only npm)

## Development Notes

- The Swift source lives in `native-macos/App/`
- `DshServer.swift` — Node.js subprocess management
- `BridgeManager.swift` — WKWebView ↔ Swift message bridge
- `ContentView.swift` — SwiftUI view with WKWebView container
- `DeepSeekHarnessApp.swift` — App entry point
