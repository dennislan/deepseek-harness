# DeepSeek Harness 插件开发教程

[English](./plugin-dev-tutorial.md) | 中文

本教程从零开始，带你一步步编写一个 DeepSeek Harness 插件，并最终把它安装到 Harness 的 Web UI 上。教程包含可以实际运行的代码；完成全部步骤后，你会拥有一个带工具、配置、热重载和正式安装的完整插件。

## 前置条件

- Node.js 22.19+ 或 24+
- pnpm
- 已克隆 deepseek-harness 仓库：`git clone https://github.com/deepseek-ai/deepseek-harness.git && cd deepseek-harness`
- 已安装依赖：`pnpm install`

本教程不需要 `DEEPSEEK_API_KEY`。

---

## Step 1：认识插件

Harness 中的一切都是插件。LLM 适配器、文件系统、Bash 执行、UI——全部通过同一个机制注入。

一个插件就是一个导出 `apply` 函数的 TypeScript 模块：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // 在这里注册你贡献的能力
}
```

框架在加载时调用 `apply`，传入上下文 `ctx`；你通过 `ctx` 告诉框架你有什么。

---

## Step 2：创建第一个插件

在仓库根目录创建一个临时项目：

```sh
mkdir -p scratch-plugin/src
```

创建 `scratch-plugin/src/my-plugin.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  console.log('[hello-plugin] loaded!')
}
```

创建 `scratch-plugin/cordis.yml`（这个文件作为 patch 层，告诉 harness 去哪里找你的插件）：

```yaml
- insert:
    - id: hello
      name: './src/my-plugin.ts'
```

> **注意**：`cordis.yml` 里用相对路径指向源码，是为了在本教程的本地开发阶段方便；正式打包时（见 Step 7）改用包名引用。

启动 Web UI 并挂载你的插件：

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

打开终端输出的地址（默认 `http://127.0.0.1:3080`）。终端应该打印：

```
[hello-plugin] loaded!
```

插件已加载成功。按 `Ctrl+C` 停止服务器。

---

## Step 3：声明服务依赖

如果你的插件需要使用 harness 已有的服务（例如工具注册表 `tools`、LLM 服务 `llm`），需要声明 `inject`。框架保证在调用你的 `apply` 之前，所有声明的服务都已就绪：

```ts
export const name = 'my-tool-plugin'
export const inject = ['tools']   // 声明依赖

export function apply(ctx: Context) {
  // ctx.tools 现在可用
  console.log('[my-tool-plugin] tools ready:', typeof ctx.tools)
}
```

更新 `scratch-plugin/src/my-plugin.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'
export const inject = ['tools']   // 依赖 tools 服务

export function apply(ctx: Context) {
  console.log('[hello-plugin] tools service ready:', typeof ctx.tools)
}
```

重新启动：

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

观察终端输出确认 `tools` 已就绪。

> 可选依赖不需要声明；直接调用 `ctx.get('serviceName')` 即可，返回 `undefined` 时表示该服务不存在。

---

## Step 4：添加一个工具

工具是模型可以调用的能力。使用 `defineTool` 定义工具，并通过 `ctx.tools.register()` 注册。

将 `scratch-plugin/src/my-plugin.ts` 替换为：

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

重新启动 Web UI：

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

打开 `http://127.0.0.1:3080`，发送消息：

> Use the greet tool to greet Ada.

模型会调用 `greet` 工具，收到 `Hello, Ada!` 作为结果。

### 理解工具结构

| 字段 | 作用 |
|------|------|
| `name` | 模型看到的工具名 |
| `description` | 模型用来决定是否调用该工具的描述 |
| `parameters` | JSON Schema，`defineTool` 据此推导 `args` 的类型并在执行前校验 |
| `output.schema` | 规范返回值类型；`execute` 返回的值必须匹配此 schema |
| `output.render` | 将规范值转换为面向模型的内容（文本块数组） |
| `execute` | 实际执行逻辑；接收类型化的 `args` |

---

## Step 5：为插件添加配置

有些行为需要由用户配置。使用 Schemastery 定义 `Config` 类型，让 `apply` 的第二参数接收校验后的配置。

更新 `scratch-plugin/src/my-plugin.ts`：

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

更新 `scratch-plugin/cordis.yml`，传入配置：

```yaml
- insert:
    - id: hello
      name: './src/my-plugin.ts'
      config:
        greetingPrefix: 'Hi there'
```

重启后工具的问候语将变为 `Hi there, Ada!`。修改 `cordis.yml` 中的配置会触发热重载（HMR），无需手动重启。

---

## Step 6：监听事件

插件之间通过事件通信。监听 `tools/result` 事件可以记录每次工具调用的结果：

在 `scratch-plugin/src/` 下新建 `logger.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-tools'   // 引入类型声明合并，让 'tools/result' 有类型

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

更新 `scratch-plugin/cordis.yml`：

```yaml
- insert:
    - id: hello
      name: './src/my-plugin.ts'
      config:
        greetingPrefix: 'Hi there'
    - id: logger
      name: './src/logger.ts'
```

重启后，每次调用 `greet` 工具都会在终端看到类似：

```
[tool-logger] greet -> Hi there, Ada!
```

---

## Step 7：打包为可安装组合包

本地 `--patch` 方式适合开发阶段。要将插件分发给他人，需要打包成**组合包（bundle）**。

### 创建包目录

```sh
mkdir -p hello-plugin
```

```
hello-plugin/
├── package.json
├── cordis.patch.yml
└── index.js
```

创建 `hello-plugin/package.json`：

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

创建 `hello-plugin/index.js`：

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

> 生产环境建议把插件写成 TypeScript 并通过构建流程输出到 `index.js`。本教程使用 JS 以保持简单。

创建 `hello-plugin/cordis.patch.yml`：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
      config:
        greetingPrefix: 'Hello'
```

这里 `name` 使用包名 `dsh-hello-plugin`，而非相对路径；Node 模块解析会通过已安装的包找到 `index.js`。

---

## Step 8：安装组合包到 Profile

`dsh plugin` 命令把组合包安装进一个 profile（配置模板），profile 是 `dsh --profile <name>` 启动时读取的组合。

### 初始化 profile 并安装包

```sh
dsh plugin --profile demo add ./hello-plugin
```

首次执行会初始化 profile，并自动将 `@deepseek-ai/dsh-base` 作为第一层加入。

查看已安装的层：

```sh
dsh --profile demo --dump-config | grep -A5 'hello-plugin'
```

你应该看到 `# == dsh-hello-plugin` 的输出。

### 启动并验证

```sh
dsh --profile demo
```

打开 Web UI 后，`greet` 工具应已可用。发送消息：

> Use the greet tool to greet World.

收到：`Hello, World!`

### 安装来自 GitHub 的插件

```sh
dsh plugin --profile demo add github:yourname/hello-plugin
```

Git 安装拉取的是源码；若你的包使用 TypeScript，作者需提供 `prepare` 脚本让 pnpm 在安装后自动构建。

---

## 加载顺序

Harness 启动时，各层按如下顺序叠加：

1. profile 的 `dsh.profile.bundles` 列表中各组合包，按顺序
2. profile 自己的 `cordis.patch.yml`
3. 用户 home 目录下的 `$DSH_HOME/cordis.patch.yml`
4. 命令行上 `--patch <path>` 指定的 overlay，按顺序

后应用的层会覆盖先应用层中同名 `id` 的条目（整个 `config` 被替换，不逐字段合并）。

---

## 插件的三种形态

| 形态 | 适用场景 |
|------|----------|
| 函数（`export function apply(ctx) {}`） | 大多数插件：注册工具、监听事件、使用 effect |
| 对象（`export default { name, inject, apply }`） | 与函数等价，显式写法 |
| 类（`class MyService extends Service`） | 需要向其他插件公开服务方法时使用 |

---

## 生命周期速查

```
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

- 声明了 `inject` 的插件等待依赖就绪（PENDING → LOADING）
- `apply` 抛出异常 → FAILED
- 插件卸载时，所有通过 `ctx.on()`、`ctx.tools.register()`、`ctx.effect()` 注册的副作用都会自动清理

---

## 下一步

- [服务与依赖](./framework/service.md) — 让你的插件对外提供服务
- [事件系统](./framework/events.md) — 插件间松耦合通信
- [能力分层](./practice/index.md) — Service Definition / Provider / Consumer 三角色设计
- [添加工具参考](../../cookbook/adding-a-tool.md) — 后台任务、UI 卡片、策略钩子等高级用法
- [扩展插件形态参考](../../cookbook/extension-cookbook.md) — 钩子、UI、外部协议驱动等模式

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
