# dsh-oauth

OAuth / login plugin for DeepSeek Harness. 支持用户名密码登录和微信网站应用（WeChat Website App）扫码登录，会话按用户隔离。

## 特性

- **用户名密码登录** — 调用远程 auth API 验证，通过后进入主界面。
- **微信网站应用扫码登录** — 按微信官方 OAuth2.0 流程：加载官方 `wxLogin.js` 渲染二维码，扫码确认后由微信回调完成登录。
- **模式切换** — 表单右上角 WeChat / 账号图标可切换两种登录方式。
- **会话与工作区按用户隔离** — 认证后新建的会话与所选工作区自动关联当前 userId 并持久化；服务端与客户端双层过滤，未登录用户看不到任何会话或工作区。
- **高品质登录 UI** — 全屏分割布局：左侧动态渐变品牌面板，右侧简洁表单卡片。
- **侧边栏用户徽章** — 登录后用户名显示在左侧导航「设定」栏位置（用户名居左、齿轮图标居右），点击用户名可直接退出登录；侧边栏折叠为窄轨时徽章自动隐藏。

## 安装

```bash
# 从本地路径安装（开发中）
dsh plugin --profile web add /path/to/dsh-oauth-plugin

# 或发布到 npm 后
dsh plugin --profile web add dsh-oauth
```

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 中启用：

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

微信扫码登录要求：

1. 在[微信开放平台](https://open.weixin.qq.com/)注册**网站应用**，获取 `AppID` / `AppSecret`。
2. 将 `wechatRedirectUri` 的域名加入该应用的**授权回调域**（开发时可填 `127.0.0.1`）。
3. 填入上述配置后重启 harness；登录 UI 的微信模式会加载官方 `wxLogin.js` 渲染二维码。

## 登录 UI

插件激活后，首次打开 harness 会看到全屏登录遮罩：

**左半屏**（深色，约 44%）：
- 蓝→紫→绿三色调渐变 mesh 动画（缓慢漂移）
- 点阵网格叠加径向遮罩
- 浮动 Logo 标记（带勾选符号）
- 品牌标题与标语

**右半屏**（浅色，约 56%）：
- 标题 + 副标题
- 错误提示横幅（红色带图标）
- 登录表单（密码模式）或 QR 码（微信模式）
- 底部版权文字

**切换按钮**（表单面板右上角）：
- WeChat 气泡图标 → 切换到微信扫码模式
- 账号轮廓图标 → 切回密码模式

### 密码模式

| 字段 | 类型 |
|------|------|
| 用户名 | `text` 输入框，`autocomplete="username"` |
| 密码 | `password` 输入框，`autocomplete="current-password"` |

提交后调用 `POST /api/auth/login`。

### 微信 QR 模式

按微信官方网站应用 OAuth2.0 `authorization_code` 流程：

1. 客户端请求 `GET /api/auth/wechat/config`，服务端生成一次性 `state` 并返回 `appId`、`redirectUri`、`scope`。
2. 客户端动态加载官方 `wxLogin.js`，以 `new WxLogin(...)` 在容器中渲染微信官方二维码 iframe。
3. 用户扫码确认后，微信将 `code` + `state` 重定向到 `redirectUri`（即 `/api/auth/wechat/callback`）。
4. 服务端校验 `state`（一次性、防 CSRF、到期作废），用 `code` 向微信换取 `access_token` 与用户信息。
5. 回调页通过 `postMessage` 把登录结果告知登录遮罩，页面随即刷新进入主界面。

失败或过期时回调页同样通过 `postMessage` 回报错误，遮罩展示错误并允许重新扫码。

**微信快速登录**（wechatFastLogin）：
- 默认启用（`wechatFastLogin: true`）。当用户的微信桌面客户端满足以下条件时，QR 码内会显示快速登录按钮，用户可直接登录而无需扫码：
  - Windows：微信 3.9.11+
  - macOS：微信 4.0.0+
  - 客户端已登录且未锁定
- 如需禁用，设置 `wechatFastLogin: false`，客户端会向 wxLogin.js 传入 `fast_login: 0` 参数，强制显示完整 QR 码。
- 快速登录的显示时机由微信官方 iframe 控制，插件仅负责传递开关状态。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `apiUrl` | *必填* | 远程 auth API 的基址，如 `http://localhost:3000/api/auth` |
| `loginPath` | `/login` | 密码登录路径（拼接到 apiUrl） |
| `mePath` | `/me` | 验证当前用户路径 |
| `logoutPath` | `/logout` | 登出路径 |
| `sessionMapFile` | `.oauth-sessions.json` | 会话↔用户映射的持久化文件名（位于 `$DSH_HOME/`） |
| `wechatEnabled` | `false` | 是否启用微信网站应用扫码登录 |
| `wechatAppId` | `''` | 微信开放平台网站应用 AppID（启用时需要） |
| `wechatAppSecret` | `''` | 微信开放平台 AppSecret（仅服务端使用，绝不出现在前端） |
| `wechatRedirectUri` | `''` | 微信 OAuth 回调地址，需在开放平台配置为授权回调域 |
| `wechatStateTtlMs` | `600000` | 一次性 `state` 有效期（毫秒） |
| `wechatFastLogin` | `true` | 是否启用微信快速登录（默认 true）；要求微信 3.9.11+（Windows）/ 4.0.0+（macOS）桌面客户端已登录且非锁定 |

## 远程 API 契约

### 密码登录

**`POST {apiUrl}{loginPath}`**

请求：
```json
{ "username": "alice", "password": "secret" }
```

成功（200）：
```json
{ "user": { "id": "usr_abc123", "displayName": "Alice", "token": "…" }, "expiresIn": 3600 }
```

错误（401）：
```json
{ "code": "INVALID_CREDENTIALS", "message": "Invalid username or password" }
```

### 当前用户

**`GET {apiUrl}{mePath}`**

成功（200）：`{ "id": "usr_abc123", "displayName": "Alice" }`
未认证（401）：`{ "error": "unauthorized" }`

### 登出

**`POST {apiUrl}{logoutPath}`** → `{ "ok": true }`

### 微信 OAuth 引导

**`GET {origin}/api/auth/wechat/config`**

无参。服务端生成一次性 `state`（有效期 `wechatStateTtlMs`，默认 10 分钟）并返回：

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

`enabled: false` 表示未配置微信登录，客户端应隐藏微信模式。

### 微信 OAuth 回调

**`GET {origin}/api/auth/wechat/callback?code=…&state=…`**

微信扫码确认后重定向至此。服务端校验 `state`（不存在/已用/过期均拒绝）后用 `code` 向微信换取 `access_token` 与用户信息，并写入本地会话。回调返回一个 HTML 页面，通过 `postMessage({ type: 'dsh-wechat-login', user })` 把结果告知登录遮罩窗口；失败时 `postMessage({ type: 'dsh-wechat-login', error })`。

## 会话与工作区隔离

登录后新建的会话自动将 `sessionId → userId` 写入 `$DSH_HOME/.oauth-sessions.json`，所选工作区（通过 `workspace.create` 建立或复用）自动将 `workspaceId → userId` 写入 `$DSH_HOME/.oauth-workspaces.json`；当前用户身份持久化到 `$DSH_HOME/oauth-user.json`，重启后免登录。三个文件均为普通覆盖写，切换用户后新身份覆盖旧身份。

隔离在两层强制：

- **服务端** — 插件以 exact route 覆盖 `/api/workspace.list`、`/api/workspace.create`、`/api/session.list` 与 `/api/session.history`：工作区列表按「用户拥有该工作区，或其中至少一个会话属于该用户」保留，共享工作区只返回用户自己的会话 id；会话列表只返回该用户的会话；历史读取非本人会话时按 `session-not-found` 应答（存在性不泄露）；未认证调用者一律返回空列表。`session.search` 基于 `session.list` 的可见性集合授权，随列表过滤自动隔离。
- **客户端** — 覆盖全局 `fetch` 镜像服务端过滤，避免侧边栏渲染其他用户的会话与工作区。

## 不修改 deepseek-harness 源码

本插件完全独立于 harness 仓库。通过标准 Cordis bundle 机制加载——只需在 profile 中启用即可，无需改动任何 harness 代码。

## 非官方扩展点

插件依赖以下 harness 未公开承诺的扩展点，升级 harness 后需验证兼容性：

- **exact route 覆盖** — host 以 exact route 注册 `/api/workspace.list`、`/api/workspace.create`、`/api/session.list` 与 `/api/session.history`，覆盖内置 handler 实现隔离。harness 未提供按用户过滤的官方接口，这是当前唯一的服务端隔离手段。
- **`window.fetch` 拦截** — 客户端覆盖全局 `fetch`，镜像服务端过滤 `/api/session.list` 与 `/api/workspace.list` 的响应，避免侧边栏渲染未授权内容。
- **`document.body` 注入** — 登录遮罩直接追加到 `document.body`，未经官方 UI 插槽协议注册。
- **侧边栏「设定」按钮结构** — 用户名徽章依赖侧边栏设置触发按钮的 DOM 结构（`button[aria-haspopup="dialog"]` 且无 `aria-label`）：徽章作为首个子节点注入，通过 MutationObserver 在 harness 重渲染后自愈，并在窄轨（rail）模式下隐藏。harness 若调整该按钮的标记或布局，徽章注入可能失效。

若 harness 后续提供官方按用户过滤 API 或 UI 扩展点，本插件将优先迁移，不再依赖上述非官方机制。

## 已知限制

- 状态文件由单进程独占（`$DSH_HOME/` 下三个 JSON），多个 harness 进程共享同一 `$DSH_HOME` 时写入互相覆盖，未做进程间协调。
- 除 `session.history` 外，其余直接指定 `sessionId` 的深层会话接口未做服务端守卫；客户端侧边栏已过滤，绕过 UI 的手工调用仍可读取这些接口。

## License

MIT
