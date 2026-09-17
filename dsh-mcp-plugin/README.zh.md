# dsh-mcp-plugin

[English](README.md) | 中文

为 DeepSeek Harness 管理 MCP server，并保持它们**可实时调用**。插件提供 `mcp_list` /
`mcp_add` / `mcp_modify` / `mcp_remove` 工具，可在运行中的 harness 里注册、重连、删除 MCP
server。每个 server 由一个真实的 `@deepseek-ai/dsh-mcp-client` fiber 支撑，因此新增
server 的工具会立即以 `mcp__<serverName>__<tool>` 形式出现在 `ctx.tools` 上——删除该
server 时这些工具也同时被卸载。

## 工作原理

- **存储** — server 定义持久化到 `~/.dsh/mcp-servers.json`（或按 profile 的 `storePath`）。
  定义即 mcp-client 的 `Config`，可直接用于实时挂载，无 schema 漂移。手工按 Claude-Code
  `mcpServers` 风格写入的文件（例如 `{ "mcpServers": { "postgres": { "command": …, "args": […] } } }`）
  在加载时会被识别并就地迁移：按条目字段推断 transport，并以键名作为 server 名；下次保存
  会把文件归一化为原生 `{ version, servers }` 信封。
- **实时挂载** — 在 `add`/`modify`/加载时，插件在自身上下文中挂载一个子 mcp-client fiber
  （`ctx.plugin`）。`remove`/`modify` 时销毁该 fiber，插件销毁时随之卸载。加载时重新挂载
  所有已存 server，使配置在重启后依然有效。挂载失败的已存 server 会被隔离：它只被标记为
  离线并带上 `lastError`，不会让加载失败。
- **传输** — `stdio`（派生子进程：`command`/`args`/`env`/`cwd`）与
  `streamable-http`（远端端点：`url`/`headers`），与 mcp-client 对齐。
- **按会话选择 server** — 客户端还会在 `conversation.composer.dock`（聊天输入框下方的环境行）
  注册一个紧凑的选择器：列出所有受管 server（带实时状态点与工具数）外加一个「自动」选项。
  点击某个 server 即为**当前会话**偏好该 server，再点一次（或点「自动」）取消。选择保存在
  宿主侧（按会话 id 区分、仅内存），并在该会话每次提示词装配时贡献一条
  `mcp-server-preference` 上下文，使发出的请求在需要时优先调用所选 server 的
  `mcp__<serverName>__*` 工具。选择器与管理面板都走同源 `/api/mcp/*` 路由（standalone
  plugin 的 webserver 桥）。

新增时若 server 暂不可用，调用不会失败（沿用 mcp-client 默认的 `failOnStartupError:
false`）；其重连循环会持续尝试，连接成功即出现工具。`mcp_list` 会把每个 server 标记为
`connected` 或 `connecting`。

启动同样不会被单个 server 卡住：已存 server 若挂载失败（例如 `npx` 缓存路径已被清理、
数据库未启动、命令写错），失败被隔离在该 server 内——记录日志，并通过 `mcp_list` 与
`/api/mcp/list` 以该 server 的 `lastError` 暴露（含 cause 链，例如
`spawn /…/mcp-server-postgres ENOENT`）。profile 照常启动，该 server 显示为离线，
直到用 `mcp_modify` 修好它。

## 启用

该 bundle 默认禁用。在 profile 的 `cordis.patch.yml` 中：

```yaml
- id: dsh-mcp-plugin-host
  disabled: false
  config:
    storePath: '~/.dsh/mcp-servers.json'   # optional; defaults to $DSH_HOME/mcp-servers.json
```

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `mcp_list` | 列出已注册 server，含传输方式、连接状态与工具数量。 |
| `mcp_add` | 注册并实时挂载新 server（`serverName`、`transport` 及对应字段）。 |
| `mcp_modify` | 修改已存 server 并重连；`serverName` 不可改名。 |
| `mcp_remove` | 断开并删除 server（其工具随即不可用）。 |

## 按会话选择 server

一个紧凑的选择器位于 `conversation.composer.dock`——即聊天输入框正下方的环境行。它列出所有
受管 server（带状态点与工具数），外加「自动」选项。点击某个 server 即为**当前会话**偏好它；
再点一次或点「自动」即取消。选择按会话 id 保存在宿主内存中，并在该会话每次提示词装配时
贡献一条 `mcp-server-preference` 上下文，使发出的请求在需要时优先调用所选 server 的
`mcp__<serverName>__*` 工具。

- 没有受管 server 时，选择器不渲染任何东西。
- 偏好按会话、仅内存保存：重启不保留，也不影响其他会话。
- `mcp_remove` 删除某 server 时，指向它的所有会话偏好一并清除。

底层实现：选择器通过同源 `/api/mcp/pref` 路由读写偏好（`GET ?sessionId=` 读取，
`POST {sessionId, serverName}` 设置；`serverName` 为 `null` 即清除），与 `/api/mcp/*` 同属
standalone-plugin 的 webserver 桥。

## 开发 / 测试

```sh
# 在插件目录内，基于仓库已构建的包与 node_modules：
npm run typecheck     # host + client 类型检查
npm run build         # 产出 lib/（host tsc + client tsdown 打包）
npm test              # 实时挂载 + 按会话偏好的集成测试
```

## 兼容性

本插件针对 **0.1.6-alpha.1** 版本的 DeepSeek Harness：其 `peerDependencies` 已锁定到
该版本 —— `@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-tools`、
`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-llm` 为 `^0.1.6-alpha.1`，
`@deepseek-ai/cordis` 为 `^4.0.2`，`@deepseek-ai/schemastery` 为 `^3.18.2`。
npm registry 的 `latest` dist-tag 指向更早的版本，因此在基于 0.1.6-alpha.1 工具链构建
本插件时，请勿用 `latest` 安装这些 harness 包。

## 已知限制与待办

- 状态由已注册的 `mcp__<name>__*` 工具数推断，而非 mcp-client 内部连接状态；因此重连中的
  server 报 `connecting`，而非具体错误；只有挂载被拒绝的 server 才带 `lastError`。
- 不可用的 server 会保留其重连循环；`mcp_remove` 会清掉 fiber，不留后台任务。
- 按会话的 server 偏好仅存内存：不写入 store，重启后需重新选择。选择仍处于 `connecting`
  的 server 只会影响提示词偏好，其工具要等重连成功后才真正可调用。
