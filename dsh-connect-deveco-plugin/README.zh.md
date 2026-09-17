# dsh-connect-deveco

把本机已安装并登录的 **DevEco Code** CLI（`deveco`）所提供的模型接入
**DeepSeek Harness**，让 harness 会话可以直接调用 `GLM-5.3`、`GLM-5.1`、
`Qwen3_VL_235B_A22B_Instruct`。

插件由三部分组成，都在同一个包里：

| 组成 | 文件 | 作用 |
| --- | --- | --- |
| Provider | `lib/host.js` | 在 `ctx.llm` 上注册 `deveco` 路由：一个负责列举模型、流式补全的 `LlmAdapter`。 |
| 诊断 CLI | `lib/cli.js` | `dsh-connect-deveco` 检查凭据与模型目录是否可用。 |
| Bundle 补丁 | `cordis.patch.yml` | 把该 provider 挂载进 harness 组合的那一行。 |

## 设计

DevEco Code 是一个本地 agent CLI，后端是华为托管的网关。它既不是
OpenAI 兼容端点，也没有暴露这样的端点，因此插件就是双向的转换层：

```
 agent loop ──▶ ctx.llm ──▶ DevecoAdapter ──▶ gateway ──▶ model
 (DSH)          registry     (本插件)          cn.devecostudio.huawei.com
```

有两个决定性的取舍。

**直接读取 CLI 的凭据存储，而不是驱动 CLI。** `deveco serve` 和 `deveco run`
都能用，但每个请求都起子进程会额外引入一个进程、一次解析，并且每一轮都要
维护第二份会话状态。磁盘上的凭据就是 `deveco` 自己在用的那一份，因此直接读取
可以让插件走一等公民的 HTTP 通路，链路里不再有 CLI。

**适配器只支持流式。** 网关会直接拒绝非流式请求（`400 ... "argument stream is
false"`），所以不存在可回退的非流式路径，也没有实现。

### 凭据发现

CLI 用两层 AES-256-GCM 信封存放凭据。每一层都是一个 JSON 文档，内含 base64 的
`ciphertext`、`iv`、`authTag`：

```
~/.config/deveco/keys/kek-v1.bin   32 字节原始 KEK（直接是文件字节，非编码）
        │  解包
        ▼
~/.config/deveco/token.dek         包裹 32 字节 DEK（字段名：encryptedDek）
        │  解包
        ▼
~/.local/share/deveco/auth.json    包裹 access token（deveco.access）
  或 ~/.config/deveco/token.enc    包裹 access token
```

有两个细节很容易出错，需要特别注意：

- DEK 层把密文字段命名为 `encryptedDek`，而不是 `ciphertext`。两种写法都兼容。
- **两个 token 存储可能互相矛盾。** 在本插件开发所用的机器上，`token.enc`
  里的 token 被网关以 `4016 invalid accessToken` 拒绝，而 `auth.json` 里的
  是可用的。因此读取逻辑会解密所有候选文件，并按 `timeStamp` 取**最新**的一个，
  而不是盲目相信先找到的那个文件。

Node 的 `createDecipheriv` 类型是基类 `Decipher`，没有 `setAuthTag`；GCM 必须
调用它，所以代码只在那一处收窄为 `DecipherGCM`，而不是整体放宽类型。

### 模型目录

`GET /codeGenie/modelConfig` 返回按组组织的模型配置。目录携带的信息远不止
一个 id：上下文窗口、输出上限、模态列表、工具调用模式，以及推理强度声明：

- `reasoning_effort` 是**以 JSON 字符串**下发的，不是嵌套对象，需要解码。
- `thinking_mode` 取值 `on`、`off`、`configurable`；`configurable` 视作支持推理。
- `reasoning_effort` 格式异常时只丢掉推理档位、保留模型，因为一个可选字段损坏
  不应让一个可用模型消失。

缓存是进程级、带 TTL 的。刷新失败会**继续提供上一次已知的模型**并告警，这样
瞬时网络故障不会把会话中的模型选择器清空；而冷缓存下的失败会直接上抛，因为
没有任何可回退的内容。并发调用共享同一次进行中的请求。

### 流式转换

网关使用 OpenAI 形状的 SSE，适配器把它转换为 harness 的 `StreamChunk` 协议。
需要特别注意的映射：

- **推理与正文是独立的块。** `reasoning_content` 开启 `reasoning` 块，并在正文块
  开启前关闭，使 harness 能分别渲染。历史推理不会回灌进后续请求。
- **部分模型把思考内联在 `content` 里。** 本网关的 GLM 模型完全不用
  `reasoning_content`：它把思维链当作普通正文流式输出，以**没有开标签的**裸
  `</think>` 结尾，之后才输出答案。适配器在该终止符处切分，使推理以
  `reasoning` 块进入 harness，而不是被当作答案显示给用户。切分跨帧缓冲，
  因此被拆到两帧的终止符仍能被识别、不会露出半截；流结束时仍被扣留的文本
  会被释放而不是丢弃。
- **工具调用是组装出来的，不是转发的。** 参数以字符串片段跨帧到达；适配器按
  index 累积，在 `block-end` 发出完整的 `tool-call` 块。无参数调用变成 `{}`，
  而不是空字符串。
- **工具调用轮次以 `tool-calls` 结束，而非 `stop`**，这正是让 agent loop 去执行
  工具、而不是把该轮当作已完成回答的原因。
- **失败是带内传递的。** 网关在 HTTP 200 内部报告错误——既可能是
  `{"errorCode":...}` 响应体，也可能是 SSE 的 `event: error` 帧。两者都会被识别
  并抛出；仅检查 `response.ok` 会静默地把它们当成空目录或空回复。

## 与 DeepSeek Harness 的集成

源码按职责拆成若干小模块：

| 模块 | 职责 |
| --- | --- |
| `src/credentials.ts` | 定位并解密磁盘上的凭据信封。 |
| `src/api.ts` | 与网关通信：模型目录与 SSE 流式对话。 |
| `src/catalog.ts` | 缓存目录，并合并并发的刷新请求。 |
| `src/reasoning.ts` | 从正文流中切出内联的 `</think>` 推理。 |
| `src/adapter.ts` | 在 harness 的 `StreamChunk` 协议与网关协议之间翻译。 |
| `src/host.ts` | Cordis 插件本体：配置 schema、注册、释放。 |
| `src/cli.ts` | `dsh-connect-deveco` 诊断命令。 |

`src/host.ts` 中的 `apply(ctx, config)` 向 `llm` 服务贡献三项注册，每一项都由
插件的 effect 作用域持有：

| 注册 | 用途 |
| --- | --- |
| `ctx.llm.registerConfigurableProviders` | 在 provider 选择器中暴露 `deveco`，设置命名空间为 `dsh-connect-deveco`。 |
| `ctx.llm.registerAdapter([PROVIDER], adapter)` | 把适配器绑定到 `deveco` 路由。 |
| `ctx.llm.registerModelDiscovery` | 让设置界面可以按需刷新模型列表。 |

模型目录是**惰性**获取的，在首次 `listModels` 或 `resolveModel` 调用时拉取。
从不路由到该 provider 的 harness 在启动时不付出任何代价，网关不可达时插件
依然能加载。卸载时通过 `ctx.effect` 释放两项注册与进程级目录缓存。

## 与 DevEco CLI 的集成

唯一的硬耦合是磁盘上的凭据布局，以及 CLI 所指向的网关。插件从不调用 `deveco`
可执行文件：不启动任何进程，请求时也不需要 `deveco` 在 `PATH` 上——只需要它的
凭据文件存在，也就是至少登录过一次（`deveco providers login`）。

请求头包含 `authorization: Bearer <access>`、`content-type: application/json`、
`lang: en`，以及每次请求一个 `Chat-Id`。`accept` 按调用分别设置——目录用
`application/json`，对话用 `text/event-stream`——因为任一路由上发错都会被拒绝
（目录路由返回 `406`）。

## 配置

所有选项都写在 `cordis.yml` 的插件行上。每个字段都可选，并在加载时校验；
非法值会让插件加载失败，而不是静默取默认值。

```yaml
- id: dsh-connect-deveco
  name: 'dsh-connect-deveco'
  config:
    displayName: DevEco Code      # provider 选择器展示的名称
    baseUrl: https://cn.devecostudio.huawei.com
    authFile: null                # 固定一个凭据文件，而不是取最新
    dataDir: null                 # 覆盖存放 auth.json 的目录
    configDir: null               # 覆盖存放 token.enc 与 keys/ 的目录
    catalogTtlSeconds: 900        # 已获取目录的保鲜时长
    requestTimeoutSeconds: 300    # 目录与对话的单次超时
    models: []                    # 直接宣告模型列表，跳过发现
```

`models` 用于目录路由不可达但已知模型 id 的环境；默认空数组表示走发现流程。
宣告的 id 仅用于展示——网关才是所提供模型的权威，宣告某个 id 并不会让对它的请求
成功，其容量元数据也会退回保守下限。

负数 `catalogTtlSeconds` 或小于 1 的 `requestTimeoutSeconds` 会在加载时被 schema
拒绝。

## 诊断

```sh
dsh-connect-deveco            # 状态：凭据、指纹、模型数量
dsh-connect-deveco doctor     # 平台、网关、凭据路径
dsh-connect-deveco --json     # 机器可读状态
```

状态取值：`READY`、`NOT_LOGGED_IN`、`NO_CREDENTIAL`、`AUTH_REJECTED`。
CLI 从不打印 token——只打印 12 位十六进制的 SHA-256 指纹，足以在问题反馈中
区分两份凭据。

## 环境要求与已知限制

- **需要 DevEco Code 账号，且必须是国内站点账号。** 其他账号会被网关以
  "only China site accounts are currently supported" 拒绝。CLI 仅支持国内站点。
- **macOS 路径已验证。** Linux 与 Windows 路径由平台约定推导，未在真实硬件上
  验证；CLI 也没有 Linux 版本。
- **凭据布局未有文档**，是通过检查 CLI 自身文件得出的。未来 CLI 版本可能改变它；
  届时 `dsh-connect-deveco doctor` 会报 `NO_CREDENTIAL`，而 `deveco` 本身仍可用
  ——这个组合就是需要重新推导布局的信号。
- **模型 id 与配额属于 DevEco Code 账号**，而非本插件。目录只是建议性的：未列出
  的模型 id 依然会被路由，网关才是所提供模型的权威。
- 并非目录中的每个模型都支持工具调用（`Qwen3_VL_235B_A22B_Instruct` 声明
  `tool_call_mode: none`），因此需要用工具的会话应选择支持工具调用的模型。

## 开发

```sh
npm install
npm run build       # tsc 产出声明 + tsdown 打包
npm run typecheck
npm test            # 82 个测试
```

测试覆盖：凭据信封往返（含篡改、错误密钥、过期与最新存储的选择）、网关响应解析、
跨读取边界的 SSE 帧重组、HTTP 200 错误路径、目录缓存与失败回退，以及适配器双向的
分块输出。

## 许可证

MIT，见 [LICENSE](LICENSE)。
