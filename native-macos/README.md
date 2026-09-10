# DeepSeek Harness — macOS Desktop App

English | [中文](README.zh.md)

Native macOS 14+ desktop application built with **Swift + SwiftUI + WKWebView**.

No Electron. No WebView wrapper libraries. Just a thin Swift shell that hosts the existing Harness web UI in a `WKWebView`, with a JS↔Swift bridge for native macOS capabilities.

## Architecture

```
DeepSeekHarness.app/
├── Contents/MacOS/DeepSeekHarness          # Compiled Swift binary
├── Contents/Info.plist
└── Contents/Resources/
    ├── dsh-root/                           # Seed runtime: npm production closure
    ├── node/                               # Embedded Node.js + npm
    └── updater/                            # assemble-runtime.mjs, prune-node-modules.mjs
```

**Runtime flow:**
1. App launches → `DshServer` starts `dsh --profile web --port 6080` as a child process
2. Waits for HTTP `/` to return 200
3. `ContentView` loads `http://127.0.0.1:6080` in a `WKWebView`
4. JS bridge (`nativeBridge`) maps `window.nativeBridge.request()` → macOS APIs
5. `RuntimeUpdater` checks for a newer dsh runtime in the background and, once the
   user accepts, installs it under `<DSH_HOME>/runtime` and restarts dsh

Before starting dsh, the app terminates any stale dsh still listening on the
chosen port. A force-quit or crash can orphan the dsh child of an earlier run;
without this recovery the fresh dsh exits with `EADDRINUSE` and the app reports
only "dsh 进程意外退出 (code=1)". A foreign process owning the port fails loud
with an actionable message instead. On normal quit (Cmd+Q / Apple menu Quit)
the app terminates its dsh child first, so orphans only appear after a hard
kill and are cleaned up on the next launch.

## Project Root Resolution

The app finds the dsh tree in this order:
1. `DSH_PROJECT_ROOT` environment variable
2. The newer of `<DSH_HOME>/runtime/dsh-root` (a downloaded update) and
   `Contents/Resources/dsh-root/` (the seed shipped in the bundle); a tie resolves
   to the downloaded runtime, so a stale one cannot shadow a fresh `.app`
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
  the log tail in the app's status instead of a bare exit code, and runtime
  updates write their npm output to `update-*.log` here
- `runtime/` — the updatable dsh runtime (`dsh-root`), the one it replaced
  (`dsh-root.previous`), the shared npm cache (`.npm-cache`), and the update lock

Profiles and sessions are **no longer** written to a per-launch
`/tmp/dsh-<pid>` directory: they survive app restarts.

## Quick Start

```bash
# 1. Build the app bundle (npm production closure + Swift shell + embedded Node/npm)
./native-macos/Scripts/build-release.sh

# 2. Run
open native-macos/dist/DeepSeekHarness.app
```

On a cold start the app launches dsh as a child process and loads the UI in the
`WKWebView` once the server answers; the web UI is also reachable in a browser
at `http://127.0.0.1:6080`.

## Release Build

For a distributable `.app`. The default path resolves the newest release and
assembles its production npm closure; `--from-source` opts into the legacy pnpm
tree (much larger; for debugging locally unreleased code only):

```bash
./native-macos/Scripts/build-release.sh              # resolve latest + full build
./native-macos/Scripts/build-release.sh --skip-dsh   # reuse the existing npm closure
./native-macos/Scripts/build-release.sh --dmg        # also create a .dmg installer
./native-macos/Scripts/build-release.sh --sign "Developer ID"  # codesign
./native-macos/Scripts/build-release.sh --oneclick   # clone upstream and build it
```

The version comes from the newest GitHub release tag, verified against the npm
registry and falling back to the registry's `latest` — the same precedence the
app's own updater uses at runtime. The closure persists at
`dist/.dsh-npm-closure/` (relative to `native-macos/`): `--skip-dsh` reuses it
and `--clean` wipes and reinstalls it. All flags are listed under Script Options
below.

**Output:** `native-macos/dist/DeepSeekHarness.app` (230M, measured 2026-08-16;
npm production closure with pruned `node_modules`; down from ~1.5GB measured
2026-08-15, 6.67x smaller)

The bundle is self-contained: it embeds Node.js together with npm under
`Contents/Resources/node`, so a clean macOS needs no system Node. `DSH_NODE_PATH`
and a system Node remain as fallbacks (`--no-node` skips the embedded runtime).
The script includes a smoke test: it launches the built app and verifies HTTP 200
on port 6080.

## Runtime Updates

The app updates its own dsh runtime; users never rebuild or reinstall it.

On launch, after dsh has settled, the app asks GitHub for the newest release tag,
verifies that version exists on the npm registry (falling back to the registry's
`latest`), and compares it with the runtime it is running. Nothing is downloaded
and no prompt appears unless the published version is newer; a network or
registry failure is logged and the launch continues.

The same check is available on demand from the app menu: **检查更新…** always
reports an outcome — `发现新版本` with the current and target version, `正在更新`
while the runtime is replaced, or `当前已是最新版本`. A manual check that cannot
reach GitHub or the registry reports the failure instead of logging it silently.

When the user accepts, the app:

1. installs `@deepseek-ai/dsh@<version>` with the embedded npm into
   `<DSH_HOME>/runtime/.staging-<uuid>`, reusing `<DSH_HOME>/runtime/.npm-cache`
   so unchanged packages are not downloaded again;
2. prunes the closure with the same two scripts the release build uses
   (`assemble-runtime.mjs`, `prune-node-modules.mjs`);
3. creates the `apps/cli` and `apps/web/dist` bridge symlinks;
4. verifies the staged runtime — `node apps/cli/lib/bin.js --version` must load
   the module graph and print the requested version;
5. switches with a directory rename, keeping the previous runtime as
   `dsh-root.previous`, and restarts dsh.

If the new runtime fails to boot, the app moves `dsh-root.previous` back,
restarts dsh, and reports the failure together with the log directory. The app
process never exits and the `.app` bundle is never modified, so its code
signature and Gatekeeper status stay intact. Runtime state lives under
`<DSH_HOME>/runtime` (default `~/.dsh/runtime`), and update logs land in
`<DSH_HOME>/logs/update-*.log`.

The About panel reports the runtime version in effect rather than the shell's
build-time version, so it stays correct after an update.

### Rebuilding the shell

Only Swift shell changes need a rebuild:

```bash
./native-macos/Scripts/build-release.sh --skip-dsh
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

Flags for `./native-macos/Scripts/build-release.sh`:

| Flag | Description |
|------|-------------|
| (none) | Full release build: newest npm production closure + Swift shell + embedded Node/npm |
| `--oneclick` | Clone upstream, build it with pnpm, then assemble (mode A) |
| `--from-source` | Assemble from a local/external pnpm dev tree (mode B; much larger) |
| `--ref <branch\|tag>` | With `--oneclick`: upstream ref to build (default `master`) |
| `--url <repo>` | With `--oneclick`: upstream git URL |
| `--src <dir>` | With `--from-source`: source tree to assemble (default local checkout) |
| `--skip-dsh` | Skip installing/building dsh and reuse the existing closure at `dist/.dsh-npm-closure`; fails with a readable error if it is missing |
| `--clean` | Wipe `dist/.dsh-npm-closure` and reinstall (with `--oneclick`: re-clone the source tree) |
| `--no-prune` | Ignored in npm mode (prints a warning; the production closure has no dev dependencies to strip) |
| `--no-node` | Skip the embedded Node download; runtime falls back to `DSH_NODE_PATH` / system node |
| `--node-from <path>` | Copy the embedded Node (and npm) from a local install instead of downloading |
| `--strip` / `--no-strip` | Strip debug symbols from the binary (default: on) |
| `--dmg` | Create `.dmg` disk image installer |
| `--sign <id>` | Codesign with identity (default: ad-hoc) |
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
- Node.js 22+ (embedded in the built app; a system install is only a fallback)
- pnpm (only for `--from-source` and `--oneclick` builds; the npm closure path needs only npm)

## Development Notes

- The Swift source lives in `native-macos/App/`
- `App/DeepSeekHarnessApp.swift` — App entry point; starts dsh and the update check
- `App/ContentView.swift` — SwiftUI view with WKWebView container and update overlay
- `App/AboutPanel.swift` — About panel reporting the runtime version in effect
- `Server/DshServer.swift` — Node.js subprocess management and runtime root resolution
- `Server/NodeRuntime.swift` — Node and npm location
- `Update/RuntimeVersion.swift` — release-tag and semver parsing
- `Update/RuntimeLayout.swift` — runtime paths, lock, and installed-version read
- `Update/ReleaseResolver.swift` — GitHub release tag → npm registry resolution
- `Update/RuntimeInstaller.swift` — closure install, prune, verify, swap, rollback
- `Update/RuntimeUpdater.swift` — launch check, prompt, progress, restart
- `NativeBridge/BridgeManager.swift` — WKWebView ↔ Swift message bridge
- `bash native-macos/Scripts/test-updater-logic.sh` — offline assertions for version logic
