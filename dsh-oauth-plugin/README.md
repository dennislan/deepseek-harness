# dsh-oauth

OAuth / login plugin for DeepSeek Harness. 支持用户名密码登录和企业微信（WeCom）扫码登录，会话按用户隔离。

## 特性

- **用户名密码登录** — 调用远程 auth API 验证，通过后进入主界面。
- **企业微信扫码登录** — 生成 QR 码，轮询扫码状态，确认后完成登录。
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
# 启用密码登录 + 可选的企业微信 QR 登录
- id: dsh-oauth-host
  disabled: false
  config:
    apiUrl: 'http://localhost:3000/api/auth'
    wechatEnabled: true
    wechatApiUrl: 'https://open.weixin.qq.com/connect'
```

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

1. 客户端生成随机 `flowId`（UUID v4）。
2. `POST /api/auth/wechat-qr` 返回 QR 图片 URL。
3. QR 渲染在圆角边框容器中。
4. 每 2 秒客户端轮询 `GET /api/auth/wechat-status?flowId=…`。
5. 状态变为 `confirmed` 时客户端调用 `POST /api/auth/wechat-login` 完成登录。
6. QR 过期时自动刷新新 flow。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `apiUrl` | *必填* | 远程 auth API 的基址，如 `http://localhost:3000/api/auth` |
| `loginPath` | `/login` | 密码登录路径（拼接到 apiUrl） |
| `mePath` | `/me` | 验证当前用户路径 |
| `logoutPath` | `/logout` | 登出路径 |
| `sessionMapFile` | `.oauth-sessions.json` | 会话↔用户映射的持久化文件名（位于 `$DSH_HOME/`） |
| `wechatEnabled` | `false` | 是否启用企业微信 QR 登录 |
| `wechatApiUrl` | `''` | 企业微信 auth API 基址（启用时需要） |
| `wechatQrPath` | `/wechat/qr` | QR 生成 POST 路径 |
| `wechatStatusPath` | `/wechat/status` | 状态轮询 GET 路径 |
| `wechatLoginPath` | `/wechat/login` | code 交换 POST 路径 |

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

### 企业微信 QR

**`POST {wechatApiUrl}{wechatQrPath}`**

请求：
```json
{ "flowId": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx" }
```

成功（200）：
```json
{
  "ok": true,
  "qr": {
    "flowId": "…",
    "qrUrl": "https://example.com/qr.png",
    "qrContent": "wxquota://…",
    "ttlSeconds": 300
  }
}
```

**`GET {wechatApiUrl}{wechatStatusPath}?flowId=…`**

响应：
```json
{
  "status": "waiting",
  "user": { "id": "…", "displayName": "…", "token": "…" },
  "message": "…"
}
```

`status` 枚举：`waiting` | `scanned` | `confirmed` | `expired` | `error`

**`POST {wechatApiUrl}{wechatLoginPath}`**

请求：
```json
{ "flowId": "…", "code": "…" }
```

成功（200）：
```json
{ "ok": true, "user": { "id": "…", "displayName": "…", "token": "…" } }
```

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
