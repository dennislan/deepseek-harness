# dsh-oauth (English) | [中文](README.zh.md)

OAuth / login plugin for DeepSeek Harness. Supports username/password login and WeChat Website App (微信网站应用) QR-code login; sessions are isolated per user.

## Features

- **Username/password login** — validated against a remote auth API; on success the user enters the main UI.
- **WeChat Website App QR-code login** — follows the official WeChat OAuth 2.0 flow: the official `wxLogin.js` renders the QR code, and WeChat's callback completes login after the user confirms.
- **Sessions and workspaces isolated per user** — server-side exact-route overrides filter workspaces and sessions; client-side `window.fetch` interception mirrors the filter in the sidebar.
- **High-quality login UI** — full-screen split layout: an animated gradient brand panel on the left, a clean form card on the right.
- **Sidebar user badge** — the username appears in the bottom-left "Settings" row after login; clicking it opens a small user menu.

## Installation

```bash
# From a local checkout (development)
dsh plugin --profile web add /path/to/dsh-oauth-plugin

# From npm (after publishing)
dsh plugin --profile web add dsh-oauth
```

## Configuration

Enable it in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: dsh-oauth-host
  disabled: false
  config:
    apiUrl: 'http://localhost:3000/api/auth'
    wechatEnabled: true
    wechatAppId: 'wx...'
    wechatAppSecret: '...'
    wechatRedirectUri: 'http://127.0.0.1:3080/api/auth/wechat/callback'
    wechatStateTtlMs: 600000
    wechatFastLogin: true
```

See [Configuration keys](#configuration-keys) for all options.

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
| `wechatAppSecret` | `''` | WeChat Open Platform AppSecret (server-side only) |
| `wechatRedirectUri` | `''` | WeChat OAuth callback URL; must be a registered authorized callback domain |
| `wechatStateTtlMs` | `600000` | TTL of the one-time `state` (milliseconds) |
| `wechatFastLogin` | `true` | Whether to enable WeChat fast login |
| `mockEnabled` | `false` | Bypass the remote API; admin/admin logs in with a fixed user |

## Remote API contract

### Password login — `POST {apiUrl}{loginPath}`

```json
// Request
{ "username": "alice", "password": "secret" }
// Success 200
{ "user": { "id": "usr_abc123", "displayName": "Alice", "token": "…" }, "expiresIn": 3600 }
// Error 401
{ "code": "INVALID_CREDENTIALS", "message": "Invalid username or password" }
```

### Current user — `GET {apiUrl}{mePath}`

```json
{ "id": "usr_abc123", "displayName": "Alice" }
```

### Logout — `POST {apiUrl}{logoutPath}`

```json
{ "ok": true }
```

## WeChat Website App login

Follows the official WeChat OAuth 2.0 `authorization_code` flow using `wxLogin.js`.

Prerequisites:

1. Register a **Website App** on the [WeChat Open Platform](https://open.weixin.qq.com/) and obtain `AppID` / `AppSecret`.
2. Add the `wechatRedirectUri` domain to the app's **authorized callback domains** (授权回调域).
3. For **fast login**: the user's WeChat desktop client must be v3.9.11+ (Windows) or v4.0.0+ (macOS), signed in and unlocked.

## Session and workspace isolation

- **Server-side**: the host registers exact routes for `/api/workspace.list`, `/api/workspace.create`, `/api/session.list`, and `/api/session.history` that override the built-in handlers, returning only the current user's data.
- **Client-side**: the client overrides `window.fetch` to mirror the same filter for `/api/session.list` responses, so the sidebar never renders other users' sessions.

State files (all under `$DSH_HOME/`):
- `.oauth-sessions.json` — `sessionId → userId`
- `.oauth-workspaces.json` — `workspaceId → userId`
- `oauth-user.json` — current user identity

## Development

```bash
# Install dependencies
npm install

# Build all artifacts (tsc + tsdown)
./scripts/build.sh

# Build and deploy to the web profile
./scripts/deploy.sh
```

The `tsconfig.standalone.json` is used for builds outside the main repo; `tsconfig.json` is used inside the repo checkout (with `paths` to workspace packages).

## License

MIT
