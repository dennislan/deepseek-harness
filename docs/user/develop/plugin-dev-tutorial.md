# DeepSeek Harness Plugin Development Tutorial

English | [中文](plugin-dev-tutorial.zh.md)

This tutorial takes you from zero to a fully installed plugin in DeepSeek Harness. Each step is runnable as-is; by the end you will have a plugin with tools, configuration, hot reload, and formal bundle installation.

## Prerequisites

- Node.js 22.19+ or 24+
- pnpm
- A cloned deepseek-harness repository: `git clone https://github.com/deepseek-ai/deepseek-harness.git && cd deepseek-harness`
- Dependencies installed: `pnpm install`

No `DEEPSEEK_API_KEY` is required.

---

## Step 1: Understand Plugins

Everything in Harness is a plugin. LLM adapters, file systems, Bash execution, the UI — all injected through the same mechanism.

A plugin is a TypeScript module that exports an `apply` function:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // Register your capabilities here
}
```

The framework calls `apply` when loading the plugin, passing the context `ctx`; you use `ctx` to tell the framework what you contribute.

---

## Step 2: Create Your First Plugin

Create a temporary project in the repository root:

```sh
mkdir -p scratch-plugin/src
```

Create `scratch-plugin/src/my-plugin.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  console.log('[hello-plugin] loaded!')
}
```

Create `scratch-plugin/cordis.yml` (this file acts as a patch layer, telling Harness where to find your plugin):

```yaml
- insert:
    - id: hello
      name: './src/my-plugin.ts'
```

> **Note**: The relative path in `cordis.yml` is for local development. When packaging for distribution (see Step 7), use the package name instead.

Start the Web UI with your patch:

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

Open the URL shown in the terminal (default: `http://127.0.0.1:3080`). The terminal should print:

```
[hello-plugin] loaded!
```

The plugin loaded successfully. Press `Ctrl+C` to stop the server.

---

## Step 3: Declare Service Dependencies

If your plugin needs an existing Harness service (e.g., the tool registry `tools`, or the LLM service `llm`), declare it with `inject`. The framework guarantees all declared services are ready before calling your `apply`:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-tool-plugin'
export const inject = ['tools']   // declare dependency

export function apply(ctx: Context) {
  // ctx.tools is now available
  console.log('[my-tool-plugin] tools ready:', typeof ctx.tools)
}
```

Update `scratch-plugin/src/my-plugin.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'
export const inject = ['tools']   // depends on the tools service

export function apply(ctx: Context) {
  console.log('[hello-plugin] tools service ready:', typeof ctx.tools)
}
```

Restart:

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

Verify in the terminal that `tools` is available.

> Optional dependencies do not need declaration; call `ctx.get('serviceName')` directly, which returns `undefined` when the service is absent.

---

## Step 4: Add a Tool

Tools are capabilities the model can invoke. Define a tool with `defineTool` and register it via `ctx.tools.register()`.

Replace `scratch-plugin/src/my-plugin.ts` with:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
  console.log('[greet-tool] registered greet tool')
}
```

Restart the Web UI:

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

Open `http://127.0.0.1:3080` and send:

> Use the greet tool to greet Ada.

The model will call the `greet` tool and receive `Hello, Ada!`.

### Understanding the Tool Structure

| Field | Purpose |
|-------|---------|
| `name` | Tool name as seen by the model |
| `description` | Description the model uses to decide whether to call the tool |
| `parameters` | JSON Schema; `defineTool` derives `args` types and validates input before execution |
| `output.schema` | Type of the normative return value; `execute` must return a value matching this schema |
| `output.render` | Converts the normative value to model-visible content (array of text blocks) |
| `execute` | Actual execution logic; receives typed `args` |

---

## Step 5: Add Configuration

Some behaviors should be user-configurable. Define a `Config` type with Schemastery so `apply`'s second parameter receives validated configuration.

Update `scratch-plugin/src/my-plugin.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export interface Config {
  greetingPrefix: string
  maxRetries: number
}

export const Config = Schema.object({
  greetingPrefix: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
})

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `${config.greetingPrefix}, ${args.name}!`
    },
  }))
}
```

Update `scratch-plugin/cordis.yml` to pass configuration:

```yaml
- insert:
    - id: hello
      name: './src/my-plugin.ts'
      config:
        greetingPrefix: 'Hi there'
```

After restarting, the greet tool will say `Hi there, Ada!`. Changing `cordis.yml` triggers hot reload (HMR); no manual restart needed.

---

## Step 6: Listen to Events

Plugins communicate via events. Listening to the `tools/result` event lets you log every tool invocation:

Create `scratch-plugin/src/logger.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-tools'   // import type declarations so 'tools/result' is typed

export const name = 'tool-logger'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.on('tools/result', (exec, result) => {
    const text = result.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    console.log(`[tool-logger] ${exec.name} -> ${text}`)
  })
}
```

Update `scratch-plugin/cordis.yml`:

```yaml
- insert:
    - id: hello
      name: './src/my-plugin.ts'
      config:
        greetingPrefix: 'Hi there'
    - id: logger
      name: './src/logger.ts'
```

After restarting, every `greet` call prints in the terminal:

```
[tool-logger] greet -> Hi there, Ada!
```

---

## Step 7: Package as an Installable Bundle

The `--patch` approach is for local development. To distribute your plugin, package it as a **bundle**.

### Create the package directory

```sh
mkdir -p hello-plugin
```

```
hello-plugin/
├── package.json
├── cordis.patch.yml
└── index.js
```

Create `hello-plugin/package.json`:

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Create `hello-plugin/index.js`:

```js
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'hello-plugin'

export const Config = Schema.object({
  greetingPrefix: Schema.string().default('Hello'),
})

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `${config.greetingPrefix}, ${args.name}!`
    },
  }))
}
```

> For production, write the plugin in TypeScript and build it to `index.js`. This tutorial uses plain JS for simplicity.

Create `hello-plugin/cordis.patch.yml`:

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
      config:
        greetingPrefix: 'Hello'
```

The `name` here uses the package name `dsh-hello-plugin`, not a relative path; Node module resolution finds `index.js` through the installed package.

---

## Step 8: Install the Bundle into a Profile

The `dsh plugin` command installs a bundle into a profile. A profile is a named configuration template loaded by `dsh --profile <name>`.

### Initialize a profile and install the package

```sh
dsh plugin --profile demo add ./hello-plugin
```

On first run, this initializes the profile and automatically adds `@deepseek-ai/dsh-base` as the first layer.

Verify the installed layer:

```sh
dsh --profile demo --dump-config | grep -A5 'hello-plugin'
```

You should see output containing `# == dsh-hello-plugin`.

### Start and verify

```sh
dsh --profile demo
```

Open the Web UI. The `greet` tool should be available. Send:

> Use the greet tool to greet World.

Receive: `Hello, World!`

### Installing from GitHub

```sh
dsh plugin --profile demo add github:yourname/hello-plugin
```

Git installs source code, not built artifacts. If your bundle uses TypeScript, the author must provide a `prepare` script so pnpm builds automatically after installation.

---

## Load Order

Harness layers are stacked in this order at startup:

1. Each bundle listed in the profile's `dsh.profile.bundles`, in list order
2. The profile's own `cordis.patch.yml`
3. The user-level `$DSH_HOME/cordis.patch.yml`
4. Each `--patch <path>` overlay, in argument order

Later layers win on duplicate `id` entries; patches replace the entire `config` of the target row (no field-level merge).

---

## Three Plugin Shapes

| Shape | When to use |
|-------|-------------|
| Function (`export function apply(ctx) {}`) | Most plugins: registering tools, listening to events, using effects |
| Object (`export default { name, inject, apply }`) | Equivalent to function; explicit style |
| Class (`class MyService extends Service`) | When your plugin needs to expose methods to other plugins |

---

## Lifecycle Quick Reference

```
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

- Plugins with `inject` wait for dependencies to become ready (PENDING → LOADING)
- If `apply` throws → FAILED
- On unload, all effects registered via `ctx.on()`, `ctx.tools.register()`, and `ctx.effect()` are automatically cleaned up

---

## Next Steps

- [Services and Dependencies](./framework/service.md) — Expose capabilities from your plugin
- [Event System](./framework/events.md) — Loose-coupling communication between plugins
- [Capability Layers](./practice/index.md) — Service Definition / Provider / Consumer three-role design
- [Adding a Tool Reference](../../cookbook/adding-a-tool.md) — Background jobs, UI cards, policy hooks, and advanced patterns
- [Extension Cookbook](../../cookbook/extension-cookbook.md) — Hooks, UI, and external-protocol-driven patterns

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
