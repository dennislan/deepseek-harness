# Cookbook: Build an OA Leave Request Plugin

[中文](./oa-leave-plugin.zh.md) | English

This tutorial walks you through building a complete DeepSeek Harness plugin that integrates with an OA (Office Automation) system for leave request management. It covers tool definition, configuration validation, HTTP calls, UI cards, event logging, bundling, and installation — each step with copy-ready code.

> **Prerequisites**: Complete [Your first Harness plugin](../user/develop/basic/index.md) before starting. This tutorial builds on that foundation.
>
> **Reference implementation**: `packages/shell/tool-bash` is a production-grade three-package example (definition / provider / consumer); read it alongside this single-package tutorial for contrast.

---

## Project Goal

Build a plugin named `dsh-oa-leave` exposing three tools:

| Tool name | Purpose | OA endpoint |
|-----------|---------|-------------|
| `list_leave_types` | List available leave types | `GET /api/leave/types` |
| `submit_leave` | Submit a leave request | `POST /api/leave/submit` |
| `query_leave_status` | Query approval status | `GET /api/leave/{id}/status` |

Configuration:

- `oaBaseUrl` — OA system URL (required)
- `oaToken` — Authentication token (required)
- `timeoutMs` — Request timeout (default 10000 ms)

---

## Step 1: Create the project directory

```sh
mkdir -p oa-leave-plugin/src
```

Expected structure:

```
oa-leave-plugin/
├── package.json
├── cordis.patch.yml   # dev-stage patch (Steps 1–6)
├── dist/              # build output (Step 7)
└── src/
    └── index.ts       # main plugin entry
```

---

## Step 2: Write the minimal working plugin

**Goal**: Register a simple `list_leave_types` tool with simulated data to verify the flow.

`src/index.ts`:

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
      // Simulated response: Step 4 replaces this with a real OA call
      return {
        types: [
          { code: 'annual', name: 'Annual Leave', maxDays: 15 },
          { code: 'sick', name: 'Sick Leave', maxDays: 30 },
          { code: 'personal', name: 'Personal Leave', maxDays: 5 },
        ],
      }
    },
  }))
}
```

Create the dev-stage patch file `cordis.patch.yml`:

```yaml
- insert:
    - id: oa-leave
      name: './src/index.ts'
```

Start the Web UI:

```sh
pnpm dsh web --patch ./oa-leave-plugin/cordis.patch.yml
```

Open the browser and send:

> What leave types are available?

The model calls `list_leave_types` and receives the simulated data.

---

## Step 3: Add configuration validation

Real scenarios require connecting to an external OA system. URLs and credentials must come from user configuration, never hardcoded.

Update `src/index.ts`:

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

// Real OA call implemented in Step 4
async function fetchLeaveTypes(
  baseUrl: string,
  token: string,
  timeoutMs: number,
): Promise<{ types: { code: string; name: string; maxDays: number }[] }> {
  throw new Error('not yet implemented — see Step 4')
}
```

Update `cordis.patch.yml` to pass configuration:

```yaml
- insert:
    - id: oa-leave
      name: './src/index.ts'
      config:
        oaBaseUrl: 'https://oa.example.com'
        oaToken: 'test-token-123'
```

Restart. You'll see the `not yet implemented` error in the terminal. Step 4 implements the real HTTP call.

---

## Step 4: Connect to the OA HTTP API

Using Node's built-in `fetch` (native since Node 18), implement all three tools with real OA calls.

Complete `src/index.ts`:

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
  // ── list_leave_types ─────────────────────────────────────────────────────
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
    },
    async execute(_args, exec) {
      return oafetch(config.oaBaseUrl, '/api/leave/types', {
        token: config.oaToken,
        timeoutMs: config.timeoutMs,
        signal: exec.signal,
      })
    },
  }))

  // ── submit_leave ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'submit_leave',
    description:
      'Submit a leave request to the OA system. Requires leaveType (from list_leave_types), startDate, endDate, and reason.',
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

  // ── query_leave_status ───────────────────────────────────────────────────
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

// ─── OA HTTP client ────────────────────────────────────────────────────────

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

// ─── render helpers ────────────────────────────────────────────────────────

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

> **Note**: Actual OA endpoint paths and fields depend on your system. Replace them accordingly.

---

## Step 5: Add UI card rendering

`output.render` controls what the model sees; **UI cards** are a separate concern declared via `presentCall` / `presentResult`.

For `submit_leave` and `query_leave_status`, use `generic` cards with titles:

```ts
output: {
  // ... schema and render ...
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
    return { card: 'generic', title: 'Leave Request Submitted', content: text }
  },
}
```

For `list_leave_types`:

```ts
presentCall() {
  return { card: 'generic', title: 'List Leave Types', kind: 'read' }
},
presentResult(_args, { content }) {
  return { card: 'generic', content: content[0]?.type === 'text' ? content[0].text : '' }
},
```

Card rendering rules (from [adding-a-tool.md](./adding-a-tool.md)):

- `presentCall` / `presentResult` must be **pure functions** — no I/O, no session state reads
- On format errors `defineTool` returns `undefined` (generic fallback) rather than throwing
- Model-visible text goes in `render`; card layout goes in presenters; never mix them

---

## Step 6: Listen to events — log every OA call

Create a separate logger plugin that observes all `oa-leave` tool executions:

`src/logger.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-tools'   // import type declarations so 'tools/result' is typed

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

Update `cordis.patch.yml`:

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

After restarting, every tool call prints a log line to the terminal.

---

## Step 7: Package as a bundle

The `--patch` approach is for local development. For distribution, package as a **bundle**.

### Directory structure

```
oa-leave-plugin/
├── package.json
├── cordis.patch.yml       # bundle entry point
└── index.js               # plugin code (build artifact or handwritten JS)
```

`package.json`:

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

> **Important**: `@deepseek-ai/cordis` must be in `peerDependencies`; `schemastery` is a runtime validator, so it goes in `dependencies`.

`cordis.patch.yml` (note: `name` uses the package name, not a relative path):

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

`${DSH_OA_TOKEN}` uses the Loader's environment variable interpolation syntax (`!!js` expression). Set the environment variable at deploy time; never write secrets into the config file.

---

## Step 8: Install and run

```sh
# Initialize demo profile (first time) and install the bundle
dsh plugin --profile demo add ./oa-leave-plugin

# Verify the layer is installed
dsh --profile demo --dump-config | grep -A5 'oa-leave'

# Start
dsh --profile demo
```

Open the browser and send:

> I want to take 3 days of annual leave from 2025-09-01 to 2025-09-03, reason: visiting family.

The model calls `list_leave_types` then `submit_leave`, and you see tool cards and results in the UI.

---

## Complete code reference

### `src/index.ts` (development stage)

*(Same as the full Step 4 code shown above.)*

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

### `cordis.patch.yml` (development stage)

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

### `package.json` (bundled stage)

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

### `cordis.patch.yml` (bundled stage)

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

## Pattern quick reference

| Pattern | Mechanism | Tutorial step |
|---------|-----------|---------------|
| Register a tool | `ctx.tools.register(defineTool({...}))` | Step 2 |
| Config validation | Export `Config: Schema<...>`, receive in `apply(ctx, config)` | Step 3 |
| HTTP call | Native `fetch` + `AbortController` timeout | Step 4 |
| UI cards | `output.presentCall` / `output.presentResult` | Step 5 |
| Event listening | `ctx.on('tools/result', handler)` | Step 6 |
| Hot reload | Modifying `cordis.yml` config triggers automatic reload | Step 3 |
| Bundle distribution | `dsh.bundle.patch` + `dsh plugin add` | Step 7–8 |

---

## Common pitfalls

1. **Missing `additionalProperties`**: Explicit object nodes must declare `additionalProperties: true | false` in the schema; otherwise `defineTool` parameter validation fails.

2. **Mixing render with cards**: `output.render` output enters model context; `presentCall`/`presentResult` only affects UI cards. Never put diff formatting or console fences in `render`.

3. **Hardcoded config values**: Any value that may differ across deployments must be in the `Config` schema and overridable from `cordis.yml`.

4. **Wrong `name` in bundled patch**: After packaging, `cordis.patch.yml` must use the npm package name (e.g. `dsh-oa-leave`), not a relative source path. Relative paths only work with `--patch` during development.

---

## Next steps

- [Adding a Tool reference](./adding-a-tool.md) — background jobs, `run_in_background`, `presentationMeta`
- [Extension patterns](./extension-cookbook.md) — hooks, UI components, external protocol bridges
- [Package and install](../user/develop/basic/publish.md) — profiles, bundle layer ordering, GitHub installation
- [Capability layering](../user/develop/practice/index.md) — Service Definition / Provider / Consumer three-role split

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
