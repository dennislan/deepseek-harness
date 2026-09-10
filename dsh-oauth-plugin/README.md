# dsh-oauth

English | [中文](README.zh.md)

OAuth / login plugin for DeepSeek Harness. Supports username/password login and WeChat Website App (微信网站应用) QR-code login; sessions are isolated per user.

## Features

- **Username/password login** — validated against a remote auth API; on success the user enters the main UI.
- **WeChat Website App QR-code login** — follows the official WeChat OAuth 2.0 flow: the official `wxLogin.js` renders the QR code, and WeChat's callback completes login after the user confirms.
- **Mode switching** — the WeChat / account icon in the top-right corner of the form switches between the two login methods.
- **Sessions and workspaces isolated per user** — sessions and workspaces created after authentication are automatically associated with the current `userId` and persisted; two-layer filtering on the server and client means a logged-out user sees no sessions or workspaces at all.
- **High-quality login UI** — full-screen split layout: an animated gradient brand panel on the left, a clean form card on the right.
- **Sidebar user badge** — after login the username shows in the bottom-left "Settings" row of the left navigation (username left, gear icon right), in the current harness theme's label color (light/dark adaptive). Clicking the username opens a small user menu popping up above it (currently "退出登录"; extend the `USER_MENU_ITEMS` list for more user actions). The badge hides automatically when the sidebar collapses into the narrow rail.

## Installation

```bash
# 从本地路径安装（开发中）
dsh plugin --profile web add /path/to/dsh-oauth-plugin

# 或发布到 npm 后
dsh plugin --profile web add dsh-oauth
```

## Configuration

Enable it in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
# 启用密码登录 + 微信网站应用扫码登录
- id: dsh-oauth-host
  disabled: false
  config:
    apiUrl: 'http://localhost:3000/api/auth'
    wechatEnabled: true
    wechatAppId: 'wx...'           # 微信开放平台 网站应用 AppID
    wechatAppSecret: '...'         # 微信开放平台 AppSecret（仅服务端使用）
    wechatRedirectUri: 'http://127.0.0.1:3080/api/auth/wechat/callback'
    wechatStateTtlMs: 600000       # 一次性 state 有效期，默认 10 分钟
    wechatFastLogin: true          # 微信快速登录，默认 true
```

Requirements for WeChat QR login:

1. Register a **Website App** (网站应用) on the [WeChat Open Platform](https://open.weixin.qq.com/) and obtain the `AppID` / `AppSecret`.
2. Add the domain of `wechatRedirectUri` to the app's **authorized callback domains** (授权回调域) (in development you can use `127.0.0.1`).
3. After filling in the configuration above, restart the harness; the WeChat mode of the login UI loads the official `wxLogin.js` and renders the QR code.

## Login UI

Once the plugin is active, the first time you open the harness you see a full-screen login overlay:

**Left half** (dark, about 44%):
- Three-color blue→purple→green gradient mesh animation (slow drift)
- Dot-grid overlay with a radial mask
- Floating logo mark (with a check glyph)
- Brand title and tagline

**Right half** (light, about 56%):
- Title + subtitle
- Error banner (red, with icon)
- Login form (password mode) or QR code (WeChat mode)
- Copyright line at the bottom

**Switch buttons** (top-right corner of the form panel):
- WeChat bubble icon → switch to the WeChat QR mode
- Account outline icon → switch back to password mode

### Password mode

| Field | Type |
|------|------|
| Username | `text` input, `autocomplete="username"` |
| Password | `password` input, `autocomplete="current-password"` |

Submitting calls `POST /api/auth/login`.

### WeChat QR mode

Follows the official WeChat Website App OAuth 2.0 `authorization_code` flow:

1. The client requests `GET /api/auth/wechat/config`; the server generates a one-time `state` and returns `appId`, `redirectUri`, and `scope`.
2. The client dynamically loads the official `wxLogin.js` and renders the official WeChat QR-code iframe in its container via `new WxLogin(...)`.
3. After the user confirms by scanning, WeChat redirects the `code` + `state` to `redirectUri` (i.e. `/api/auth/wechat/callback`).
4. The server validates `state` (one-time, CSRF-proof, expired states are rejected), then exchanges the `code` with WeChat for an `access_token` and user info.
5. The callback page tells the login overlay the result via `postMessage`, and the page reloads into the main UI.

On failure or expiry the callback page likewise reports the error via `postMessage`; the overlay shows it and allows re-scanning.

**WeChat fast login** (`wechatFastLogin`):
- Enabled by default (`wechatFastLogin: true`). When the user's WeChat desktop client meets the conditions below, the QR code shows a fast-login button so the user can log in without scanning:
  - Windows: WeChat 3.9.11+
  - macOS: WeChat 4.0.0+
  - The client is signed in and not locked
- To disable it, set `wechatFastLogin: false`; the client then passes the `fast_login: 0` parameter to `wxLogin.js`, forcing the full QR code to be shown.
- When fast login appears is controlled by WeChat's official iframe; the plugin only forwards the flag.

## Configuration keys

| Key | Default | Description |
|---|---|---|
| `apiUrl` | *required* | Base URL of the remote auth API, e.g. `http://localhost:3000/api/auth` |
| `loginPath` | `/login` | Password login path (appended to `apiUrl`) |
| `mePath` | `/me` | Path for validating the current user |
| `logoutPath` | `/logout` | Logout path |
| `sessionMapFile` | `.oauth-sessions.json` | Persistence file name of the session↔user mapping (under `$DSH_HOME/`) |
| `wechatEnabled` | `false` | Whether to enable WeChat Website App QR login |
| `wechatAppId` | `''` | WeChat Open Platform Website App ID (required when enabled) |
| `wechatAppSecret` | `''` | WeChat Open Platform AppSecret (server-side only, never exposed to the frontend) |
| `wechatRedirectUri` | `''` | WeChat OAuth callback URL; must be registered as an authorized callback domain on the Open Platform |
| `wechatStateTtlMs` | `600000` | TTL of the one-time `state` (milliseconds) |
| `wechatFastLogin` | `true` | Whether to enable WeChat fast login (default true); requires the WeChat 3.9.11+ (Windows) / 4.0.0+ (macOS) desktop client to be signed in and unlocked |

## Remote API contract

### Password login

**`POST {apiUrl}{loginPath}`**

Request:
```json
{ "username": "alice", "password": "secret" }
```

Success (200):
```json
{ "user": { "id": "usr_abc123", "displayName": "Alice", "token": "…" }, "expiresIn": 3600 }
```

Error (401):
```json
{ "code": "INVALID_CREDENTIALS", "message": "Invalid username or password" }
```

### Current user

**`GET {apiUrl}{mePath}`**

Success (200): `{ "id": "usr_abc123", "displayName": "Alice" }`
Unauthenticated (401): `{ "error": "unauthorized" }`

### Logout

**`POST {apiUrl}{logoutPath}`** → `{ "ok": true }`

### WeChat OAuth bootstrapping

**`GET {origin}/api/auth/wechat/config`**

No parameters. The server generates a one-time `state` (valid for `wechatStateTtlMs`, default 10 minutes) and returns:

```json
{
  "enabled": true,
  "appId": "wx…",
  "redirectUri": "http://127.0.0.1:3080/api/auth/wechat/callback",
  "state": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
  "scope": "snsapi_login",
  "fastLogin": true
}
```

`enabled: false` means WeChat login is not configured; the client should hide the WeChat mode.

### WeChat OAuth callback

**`GET {origin}/api/auth/wechat/callback?code=…&state=…`**

After the WeChat QR scan is confirmed, the user is redirected here. The server validates the `state` (rejecting unknown/used/expired states), exchanges the `code` with WeChat for the `access_token` and user info, and writes the local session. The callback returns an HTML page that tells the login overlay window the result via `postMessage({ type: 'dsh-wechat-login', user })`; on failure it sends `postMessage({ type: 'dsh-wechat-login', error })`.

## Session and workspace isolation

After login, a newly created session automatically writes `sessionId → userId` to `$DSH_HOME/.oauth-sessions.json`, and the selected workspace (created or reused via `workspace.create`) automatically writes `workspaceId → userId` to `$DSH_HOME/.oauth-workspaces.json`; the current user's identity is persisted in `$DSH_HOME/oauth-user.json`, so a restart requires no login. All three files use plain overwrite writes; switching users overwrites the previous identity.

Isolation is enforced in two layers:

- **Server-side** — the plugin registers exact routes overriding `/api/workspace.list`, `/api/workspace.create`, `/api/session.list`, and `/api/session.history`: the workspace list keeps workspaces the user owns or that contain at least one session belonging to the user, and shared workspaces return only the user's own session ids; the session list returns only that user's sessions; history reads of another user's session answer `session-not-found` (existence is not leaked); unauthenticated callers get empty lists. `session.search` is authorized off the `session.list` visibility set and is isolated automatically by the same filter.
- **Client-side** — overriding the global `fetch` mirrors the server-side filter, so the sidebar never renders other users' sessions and workspaces.

## No changes to the deepseek-harness source

This plugin is fully independent of the harness repository. It is loaded through the standard Cordis bundle mechanism — enabling it in the profile is all that's needed; no harness code is modified.

## Unofficial extension points

The plugin relies on the following harness extension points that carry no public commitment; verify compatibility after upgrading the harness:

- **Exact-route overrides** — the host registers exact routes for `/api/workspace.list`, `/api/workspace.create`, `/api/session.list`, and `/api/session.history`, overriding the built-in handlers to implement isolation. The harness provides no official per-user filtering API; this is currently the only server-side isolation mechanism.
- **`window.fetch` interception** — the client overrides the global `fetch` and mirrors the server-side filtering of `/api/session.list` and `/api/workspace.list` responses so the sidebar never renders unauthorized content.
- **`document.body` injection** — the login overlay is appended directly to `document.body`, not registered through the official UI slot protocol.
- **Sidebar "Settings" button structure** — the user badge depends on the sidebar settings trigger being the leftmost (then bottommost) `button[aria-haspopup="dialog"]` in the viewport: the badge is injected as its first child, heals itself via a MutationObserver after the harness re-renders, hides in the narrow-rail mode, and its text color follows the harness theme tokens. If the harness moves the settings trigger out of the bottom-left sidebar, the badge injection may stop working.

If the harness later provides an official per-user filtering API or UI extension points, this plugin will migrate to them first and drop the unofficial mechanisms above.

## Known limitations

- The state files are owned by a single process (the three JSON files under `$DSH_HOME/`); multiple harness processes sharing one `$DSH_HOME` overwrite each other's writes — there is no inter-process coordination.
- Apart from `session.history`, the other deep session endpoints that take an explicit `sessionId` have no server-side guard; the client sidebar filters them, but a manual call bypassing the UI can still read them.

## License

MIT
