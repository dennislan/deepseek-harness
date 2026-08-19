# dsh-oauth

OAuth / login plugin for DeepSeek Harness. 支持用户名密码登录和企业微信（WeCom）扫码登录，会话按用户隔离。

## 特性

- **用户名密码登录** — 调用远程 auth API 验证，通过后进入主界面。
- **企业微信扫码登录** — 生成 QR 码，轮询扫码状态，确认后完成登录。
- **模式切换** — 表单右上角 WeChat / 账号图标可切换两种登录方式。
- **会话按用户隔离** — 认证后新建的会话自动关联当前 userId，持久化到 `$DSH_HOME/.oauth-sessions.json`。
- **高品质登录 UI** — 全屏分割布局：左侧动态渐变品牌面板，右侧简洁表单卡片。

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

# 启用登录 UI 覆盖层
- id: dsh-oauth-client
  disabled: false
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

## 会话隔离

用户认证后新建会话时，host 插件自动将 `sessionId → userId` 写入持久化映射文件（默认 `$DSH_HOME/.oauth-sessions.json`）。通过 `auth.getSessionsForUser(userId)` 可按用户过滤会话。

## 不修改 deepseek-harness 源码

本插件完全独立于 harness 仓库。通过标准 Cordis bundle 机制加载——只需在 profile 中启用即可，无需改动任何 harness 代码。

## License

MIT
