# Cookbook：开发一个请假工具对接 OA 系统

[English](../user/develop/plugin-dev-tutorial.md) | 中文

本教程以"请假工具对接 OA 系统"为完整示例，从零开始，逐步覆盖插件开发的全部关键模式：工具定义、配置校验、HTTP 调用、UI 卡片渲染、事件监听、后台任务、打包与安装。每一步的代码均可直接复制运行；完成全部步骤后，你将拥有一个可以在 DeepSeek Harness Web UI 上正常工作的请假工具插件。

> **前置知识**：阅读本教程前请先完成 [第一个插件](../user/develop/basic/index.zh.md)。本教程在此基础上扩展，不重复介绍插件基础。
>
> **参考实现**：`packages/shell/tool-bash` 是一个生产级的三包示例（定义/提供方/消费方），本教程的单包形态与之对比阅读效果更佳。

---

## 项目目标

构建一个名为 `dsh-oa-leave` 的插件，提供以下三个工具：

| 工具名 | 功能 | OA 接口 |
|--------|------|---------|
| `submit_leave` | 提交请假申请 | `POST /api/leave/submit` |
| `query_leave_status` | 查询请假单审批状态 | `GET /api/leave/{id}/status` |
| `list_leave_types` | 获取可请的假期类型列表 | `GET /api/leave/types` |

配置项：

- `oaBaseUrl` — OA 系统地址（必填）
- `oaToken` — 认证 Token（通过配置传入，不硬编码）
- `timeoutMs` — 请求超时（默认 10000 ms）

---

## Step 1：创建项目目录

在仓库根目录或任意位置创建项目：

```sh
mkdir -p oa-leave-plugin/src
```

最终结构：

```
oa-leave-plugin/
├── package.json
├── cordis.patch.yml   # 开发阶段：本地 patch（Step 1~6 用）
├── dist/              # 打包产出（Step 7 生成）
└── src/
    └── index.ts       # 插件主入口
```

---

## Step 2：编写最小可用的插件

**目标**：注册一个最简单的 `list_leave_types` 工具，不接真实 OA，先用模拟数据验证流程。

`src/index.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'oa-leave'

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'list_leave_types',
    description:
      'List available leave types from the OA system. Use this before submitting a leave request.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          types: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                maxDays: { type: 'number' },
              },
              required: ['code', 'name', 'maxDays'],
              additionalProperties: false,
            },
          },
        },
        required: ['types'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Available leave types:\n${(value as { types: { code: string; name: string; maxDays: number }[] }).types
            .map(t => `  - ${t.code}: ${t.name} (max ${t.maxDays} days)`)
            .join('\n')}`,
        },
      ],
    },
    async execute() {
      // 模拟响应：Step 4 会替换为真实 OA 调用
      return {
        types: [
          { code: 'annual', name: '年假', maxDays: 15 },
          { code: 'sick', name: '病假', maxDays: 30 },
          { code: 'personal', name: '事假', maxDays: 5 },
        ],
      }
    },
  }))
}
```

创建开发阶段使用的 patch 文件 `cordis.patch.yml`：

```yaml
- insert:
    - id: oa-leave
      name: './src/index.ts'
```

启动 Web UI：

```sh
pnpm dsh web --patch ./oa-leave-plugin/cordis.patch.yml
```

打开浏览器，发送：

> 有哪些请假类型？

模型会调用 `list_leave_types`，收到模拟数据并回复。

---

## Step 3：添加配置校验

真实场景需要接入外部 OA 系统，地址和认证信息必须由用户配置，不能硬编码。

更新 `src/index.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'oa-leave'

export interface Config {
  oaBaseUrl: string
  oaToken: string
  timeoutMs: number
}

export const Config = Schema.object({
  oaBaseUrl: Schema.string().required(),
  oaToken: Schema.string().required(),
  timeoutMs: Schema.number().default(10000),
})

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'list_leave_types',
    description:
      'List available leave types from the OA system. Use this before submitting a leave request.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          types: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                maxDays: { type: 'number' },
              },
              required: ['code', 'name', 'maxDays'],
              additionalProperties: false,
            },
          },
        },
        required: ['types'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Available leave types:\n${(value as { types: { code: string; name: string; maxDays: number }[] }).types
            .map(t => `  - ${t.code}: ${t.name} (max ${t.maxDays} days)`)
            .join('\n')}`,
        },
      ],
    },
    async execute() {
      return fetchLeaveTypes(config.oaBaseUrl, config.oaToken, config.timeoutMs)
    },
  }))
}

// 真实 OA 调用在 Step 4 实现
async function fetchLeaveTypes(
  baseUrl: string,
  token: string,
  timeoutMs: number,
): Promise<{ types: { code: string; name: string; maxDays: number }[] }> {
  throw new Error('not yet implemented — see Step 4')
}
```

更新 `cordis.patch.yml`，传入配置：

```yaml
- insert:
    - id: oa-leave
      name: './src/index.ts'
      config:
        oaBaseUrl: 'https://oa.example.com'
        oaToken: 'test-token-123'
```

重启后观察终端报错（`not yet implemented`）。下一步实现真正的 HTTP 调用。

---

## Step 4：对接 OA HTTP API

使用 Node 内置 `fetch`（Node 18+ 原生支持），实现三个工具的完整 OA 调用。

完整的 `src/index.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'oa-leave'

export interface Config {
  oaBaseUrl: string
  oaToken: string
  timeoutMs: number
}

export const Config = Schema.object({
  oaBaseUrl: Schema.string().required(),
  oaToken: Schema.string().required(),
  timeoutMs: Schema.number().default(10000),
})

export function apply(ctx: Context, config: Config) {
  // ── list_leave_types ──────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'list_leave_types',
    description:
      'List available leave types from the OA system. Call this first when the user wants to apply for leave.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          types: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                maxDays: { type: 'number' },
              },
              required: ['code', 'name', 'maxDays'],
              additionalProperties: false,
            },
          },
        },
        required: ['types'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: buildLeaveTypesText(value),
        },
      ],
    },
    async execute(_args, exec) {
      return oafetch(config.oaBaseUrl, `/api/leave/types`, {
        token: config.oaToken,
        timeoutMs: config.timeoutMs,
        signal: exec.signal,
      })
    },
  }))

  // ── submit_leave ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'submit_leave',
    description:
      'Submit a leave request to the OA system. Requires leaveType (from list_leave_types), startDate, endDate, and reason.',
    parameters: {
      leaveType: {
        type: 'string',
        required: true,
        description: 'Leave type code, e.g. "annual", "sick", "personal"',
      },
      startDate: {
        type: 'string',
        required: true,
        description: 'Start date in YYYY-MM-DD format',
      },
      endDate: {
        type: 'string',
        required: true,
        description: 'End date in YYYY-MM-DD format',
      },
      reason: {
        type: 'string',
        required: false,
        description: 'Optional reason for the leave',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          status: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['requestId', 'status'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: buildSubmitResultText(value),
        },
      ],
    },
    async execute(args, exec) {
      return oafetch(config.oaBaseUrl, '/api/leave/submit', {
        method: 'POST',
        token: config.oaToken,
        body: {
          leaveType: args.leaveType,
          startDate: args.startDate,
          endDate: args.endDate,
          reason: args.reason ?? '',
        },
        timeoutMs: config.timeoutMs,
        signal: exec.signal,
      })
    },
  }))

  // ── query_leave_status ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'query_leave_status',
    description:
      'Query the approval status of a leave request by its request ID.',
    parameters: {
      requestId: {
        type: 'string',
        required: true,
        description: 'The request ID returned by submit_leave',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'approved', 'rejected', 'cancelled'],
          },
          approver: { type: 'string' },
          updatedAt: { type: 'string' },
        },
        required: ['requestId', 'status'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: buildStatusText(value),
        },
      ],
    },
    async execute(args, exec) {
      return oafetch(config.oaBaseUrl, `/api/leave/${args.requestId}/status`, {
        token: config.oaToken,
        timeoutMs: config.timeoutMs,
        signal: exec.signal,
      })
    },
  }))
}

// ─── OA HTTP 客户端 ─────────────────────────────────────────────────────────

interface OafetchOptions {
  token: string
  timeoutMs: number
  signal?: AbortSignal
  method?: 'GET' | 'POST'
  body?: unknown
}

async function oafetch(
  baseUrl: string,
  path: string,
  opts: OafetchOptions,
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs)
  const signal = opts.signal
    ? mergeSignals(opts.signal, controller.signal)
    : controller.signal

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`OA API error ${res.status}: ${text}`)
    }

    return res.json() as Promise<unknown>
  } finally {
    clearTimeout(timeout)
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortController {
  const c = new AbortController()
  if (a.aborted) c.abort()
  if (b.aborted) c.abort()
  a.addEventListener('abort', () => c.abort(), { once: true })
  b.addEventListener('abort', () => c.abort(), { once: true })
  return c
}

// ─── render 辅助函数 ────────────────────────────────────────────────────────

function buildLeaveTypesText(
  value: { types: { code: string; name: string; maxDays: number }[] },
): string {
  return `Available leave types:\n${value.types
    .map(t => `  - ${t.code}: ${t.name} (max ${t.maxDays} days)`)
    .join('\n')}`
}

function buildSubmitResultText(
  value: { requestId: string; status: string; message?: string },
): string {
  const lines = [`Leave request submitted.`, `  Request ID: ${value.requestId}`, `  Status: ${value.status}`]
  if (value.message) lines.push(`  Note: ${value.message}`)
  return lines.join('\n')
}

function buildStatusText(
  value: { requestId: string; status: string; approver?: string; updatedAt?: string },
): string {
  const lines = [`Request ${value.requestId}: ${value.status}`]
  if (value.approver) lines.push(`  Approver: ${value.approver}`)
  if (value.updatedAt) lines.push(`  Updated: ${value.updatedAt}`)
  return lines.join('\n')
}
```

> **注意**：真实 OA 接口路径和字段以你的系统为准，本教程使用占位路径。把 `oaBaseUrl` 替换为实际地址即可测试。

---

## Step 5：添加 UI 卡片渲染

工具的 `output.render` 控制模型看到的内容；**UI 卡片**是另一个独立关注点，通过 `presentCall` / `presentResult` 声明。

对于请假工具，`submit_leave` 和 `query_leave_status` 适合使用 `generic` 卡片（带标题），`list_leave_types` 保持默认回退即可。

在 `defineTool` 中增加 `output` 的展示方法：

```ts
// submit_leave 的 output 改为：
output: {
  schema: { /* ... */ },
  render: (_args, value) => [{ type: 'text', text: buildSubmitResultText(value) }],
  presentCall(args) {
    return {
      card: 'generic',
      title: 'Submit Leave Request',
      kind: 'write',
      rawInput: args,
    }
  },
  presentResult(_args, { content }) {
    const text = content[0]?.type === 'text' ? content[0].text : ''
    return {
      card: 'generic',
      title: 'Leave Request Submitted',
      content: text,
    }
  },
}
```

`list_leave_types` 的 `presentCall` 可以简化为：

```ts
presentCall() {
  return { card: 'generic', title: 'List Leave Types', kind: 'read' }
},
presentResult(_args, { content }) {
  return { card: 'generic', content: content[0]?.type === 'text' ? content[0].text : '' }
},
```

卡片渲染规则（来自 [adding-a-tool.md](./adding-a-tool.zh.md)）：

- `presentCall` / `presentResult` 必须是**纯函数**，不做 I/O，不读会话状态
- 格式错误时 `defineTool` 会返回 `undefined`（通用回退），不会抛异常
- 面向模型的文本在 `render` 中；卡片在展示器中；二者不要混用

---

## Step 6：监听事件 — 记录每次 OA 调用

创建一个独立的 logger 插件，观察所有 `oa-leave` 工具的执行：

`src/logger.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-tools'   // 引入类型声明，使 'tools/result' 有类型

export const name = 'oa-leave-logger'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.on('tools/result', (exec, result) => {
    if (!exec.name.startsWith('oa-leave')) return
    const text = result.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    console.log(`[oa-leave] ${exec.name}(${JSON.stringify(exec.arguments)}) => ${text.slice(0, 200)}`)
  })
}
```

更新 `cordis.patch.yml`：

```yaml
- insert:
    - id: oa-leave
      name: './src/index.ts'
      config:
        oaBaseUrl: 'https://oa.example.com'
        oaToken: 'test-token-123'
        timeoutMs: 10000
    - id: oa-leave-logger
      name: './src/logger.ts'
```

重启后每次调用工具都会看到日志输出。

---

## Step 7：打包为组合包

开发阶段用 `--patch` 加载源码；正式分发需要打包为组合包。

### 目录结构

```
oa-leave-plugin/
├── package.json
├── cordis.patch.yml       # bundle 入口：告诉 harness 加载哪个模块
└── index.js               # 插件代码（构建产物或手写 JS）
```

`package.json`：

```json
{
  "name": "dsh-oa-leave",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-tools": "*"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "*"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

> **重要**：`peerDependencies` 中必须包含 `@deepseek-ai/cordis`；`schemastery` 是运行时校验器，放 `dependencies`。

`index.js`（从 `src/index.ts` 编译后的产物；开发期也可以直接写 `.js`，见下方完整内容）：

`cordis.patch.yml`（注意 `name` 用包名，不是相对路径）：

```yaml
- insert:
    - id: oa-leave
      name: dsh-oa-leave
      config:
        oaBaseUrl: 'https://oa.example.com'
        oaToken: '${DSH_OA_TOKEN}'
        timeoutMs: 10000
```

`{${DSH_OA_TOKEN}}` 是 Loader 的环境变量插值语法（`!!js` 表达式），部署时由环境变量注入，不写入配置文件。

---

## Step 8：安装并运行

```sh
# 初始化 demo profile（首次）并安装包
dsh plugin --profile demo add ./oa-leave-plugin

# 验证层已安装
dsh --profile demo --dump-config | grep -A5 'oa-leave'

# 启动
dsh --profile demo
```

打开浏览器，发送以下消息验证：

```
我想请3天年假，从2025-09-01到2025-09-03，理由是回老家办事。
```

模型会依次调用 `list_leave_types` → `submit_leave`，你将看到工具卡片和执行结果。

---

## 完整代码清单

### `src/index.ts`（开发阶段）

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'oa-leave'

export interface Config {
  oaBaseUrl: string
  oaToken: string
  timeoutMs: number
}

export const Config = Schema.object({
  oaBaseUrl: Schema.string().required(),
  oaToken: Schema.string().required(),
  timeoutMs: Schema.number().default(10000),
})

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'list_leave_types',
    description:
      'List available leave types from the OA system. Call this first when the user wants to apply for leave.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          types: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                maxDays: { type: 'number' },
              },
              required: ['code', 'name', 'maxDays'],
              additionalProperties: false,
            },
          },
        },
        required: ['types'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: buildLeaveTypesText(value) },
      ],
      presentCall() {
        return { card: 'generic', title: 'List Leave Types', kind: 'read' }
      },
      presentResult(_args, { content }) {
        return {
          card: 'generic',
          content: content[0]?.type === 'text' ? content[0].text : '',
        }
      },
    },
    async execute(_args, exec) {
      return oafetch(config.oaBaseUrl, '/api/leave/types', {
        token: config.oaToken,
        timeoutMs: config.timeoutMs,
        signal: exec.signal,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'submit_leave',
    description:
      'Submit a leave request to the OA system. Requires leaveType (from list_leave_types), startDate, endDate, and optional reason.',
    parameters: {
      leaveType: { type: 'string', required: true, description: 'Leave type code, e.g. "annual"' },
      startDate: { type: 'string', required: true, description: 'Start date YYYY-MM-DD' },
      endDate: { type: 'string', required: true, description: 'End date YYYY-MM-DD' },
      reason: { type: 'string', required: false, description: 'Optional reason' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          status: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['requestId', 'status'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: buildSubmitResultText(value) },
      ],
      presentCall(args) {
        return {
          card: 'generic',
          title: 'Submit Leave Request',
          kind: 'write',
          rawInput: args,
        }
      },
      presentResult(_args, { content }) {
        return {
          card: 'generic',
          title: 'Leave Request Submitted',
          content: content[0]?.type === 'text' ? content[0].text : '',
        }
      },
    },
    async execute(args, exec) {
      return oafetch(config.oaBaseUrl, '/api/leave/submit', {
        method: 'POST',
        token: config.oaToken,
        body: {
          leaveType: args.leaveType,
          startDate: args.startDate,
          endDate: args.endDate,
          reason: args.reason ?? '',
        },
        timeoutMs: config.timeoutMs,
        signal: exec.signal,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'query_leave_status',
    description: 'Query the approval status of a leave request by its request ID.',
    parameters: {
      requestId: { type: 'string', required: true, description: 'Request ID from submit_leave' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'cancelled'] },
          approver: { type: 'string' },
          updatedAt: { type: 'string' },
        },
        required: ['requestId', 'status'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: buildStatusText(value) },
      ],
      presentCall(args) {
        return {
          card: 'generic',
          title: 'Query Leave Status',
          kind: 'read',
          rawInput: args,
        }
      },
      presentResult(_args, { content }) {
        return {
          card: 'generic',
          title: 'Leave Status',
          content: content[0]?.type === 'text' ? content[0].text : '',
        }
      },
    },
    async execute(args, exec) {
      return oafetch(config.oaBaseUrl, `/api/leave/${args.requestId}/status`, {
        token: config.oaToken,
        timeoutMs: config.timeoutMs,
        signal: exec.signal,
      })
    },
  }))
}

// ─── HTTP 客户端 ────────────────────────────────────────────────────────────

interface OafetchOptions {
  token: string
  timeoutMs: number
  signal?: AbortSignal
  method?: 'GET' | 'POST'
  body?: unknown
}

async function oafetch(
  baseUrl: string,
  path: string,
  opts: OafetchOptions,
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs)

  const signal = opts.signal
    ? mergeSignals(opts.signal, controller.signal)
    : controller.signal

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`OA API error ${res.status}: ${text}`)
    }

    return res.json() as Promise<unknown>
  } finally {
    clearTimeout(timeout)
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortController {
  const c = new AbortController()
  if (a.aborted) c.abort()
  if (b.aborted) c.abort()
  a.addEventListener('abort', () => c.abort(), { once: true })
  b.addEventListener('abort', () => c.abort(), { once: true })
  return c
}

// ─── render 辅助 ────────────────────────────────────────────────────────────

function buildLeaveTypesText(
  value: { types: { code: string; name: string; maxDays: number }[] },
): string {
  return `Available leave types:\n${value.types
    .map(t => `  - ${t.code}: ${t.name} (max ${t.maxDays} days)`)
    .join('\n')}`
}

function buildSubmitResultText(
  value: { requestId: string; status: string; message?: string },
): string {
  const lines = [
    `Leave request submitted.`,
    `  Request ID: ${value.requestId}`,
    `  Status: ${value.status}`,
  ]
  if (value.message) lines.push(`  Note: ${value.message}`)
  return lines.join('\n')
}

function buildStatusText(
  value: { requestId: string; status: string; approver?: string; updatedAt?: string },
): string {
  const lines = [`Request ${value.requestId}: ${value.status}`]
  if (value.approver) lines.push(`  Approver: ${value.approver}`)
  if (value.updatedAt) lines.push(`  Updated: ${value.updatedAt}`)
  return lines.join('\n')
}
```

### `src/logger.ts`

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-tools'

export const name = 'oa-leave-logger'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.on('tools/result', (exec, result) => {
    if (!exec.name.startsWith('oa-leave')) return
    const text = result.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    console.log(`[oa-leave] ${exec.name}(${JSON.stringify(exec.arguments)}) => ${text.slice(0, 200)}`)
  })
}
```

### `cordis.patch.yml`（开发阶段）

```yaml
- insert:
    - id: oa-leave
      name: './src/index.ts'
      config:
        oaBaseUrl: 'https://oa.example.com'
        oaToken: 'test-token-123'
        timeoutMs: 10000
    - id: oa-leave-logger
      name: './src/logger.ts'
```

### `package.json`（打包阶段）

```json
{
  "name": "dsh-oa-leave",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-tools": "*"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "*"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

### `cordis.patch.yml`（打包阶段）

```yaml
- insert:
    - id: oa-leave
      name: dsh-oa-leave
      config:
        oaBaseUrl: 'https://oa.example.com'
        oaToken: '${DSH_OA_TOKEN}'
        timeoutMs: 10000
    - id: oa-leave-logger
      name: dsh-oa-leave/logger
```

---

## 关键模式速查

| 模式 | 机制 | 本教程中的位置 |
|------|------|---------------|
| 注册工具 | `ctx.tools.register(defineTool({...}))` | Step 2 |
| 配置校验 | 导出 `Config: Schema<...>`，`apply(ctx, config)` | Step 3 |
| HTTP 调用 | 内置 `fetch` + `AbortController` 超时 | Step 4 |
| UI 卡片 | `output.presentCall` / `output.presentResult` | Step 5 |
| 事件监听 | `ctx.on('tools/result', handler)` | Step 6 |
| 热重载 | 修改 `cordis.patch.yml` 的 `config` 自动生效 | Step 3 |
| 打包分发 | `dsh.bundle.patch` + `dsh plugin add` | Step 7~8 |

---

## 常见陷阱

1. **`additionalProperties` 未声明**：显式对象节点必须在 schema 中声明 `additionalProperties: true | false`，否则 `defineTool` 参数校验不通过。

2. **render 与卡片混用**：`output.render` 的输出进入模型上下文；`presentCall`/`presentResult` 只影响 UI 卡片。不要把 diff 格式或控制台围栏放入 `render`。

3. **配置字段硬编码**：凡是不同部署可能需要改变的值，必须放在 `Config` schema 中，允许从 `cordis.yml` 覆盖。

4. **插件路径用包名而非源码路径**：打包后的 `cordis.patch.yml` 中 `name` 必须是 npm 包名；相对路径只在 `--patch` 开发阶段有效。

---

## 下一步

- [添加工具参考](./adding-a-tool.zh.md) — 后台任务、`run_in_background`、`presentationMeta`
- [扩展插件形态参考](./extension-cookbook.zh.md) — 钩子、UI 组件、外部协议驱动
- [打包与安装](../user/develop/basic/publish.zh.md) — profile、bundle 层顺序、GitHub 安装
- [能力分层](../user/develop/practice/index.zh.md) — Service Definition / Provider / Consumer 三角色拆分

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
