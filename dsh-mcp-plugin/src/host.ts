/**
 * Host plugin: the MCP server manager. It owns a persistent store of mcp-client
 * definitions, live-mounts a real mcp-client fiber per server so its tools are
 * callable in the running harness, and exposes four model-facing tools —
 * `mcp_list` / `mcp_add` / `mcp_modify` / `mcp_remove` — that drive the store
 * and the live connections. Persisted servers are re-mounted on load so the
 * configuration survives a restart.
 *
 * Per session, a user may prefer one managed server through the composer-dock
 * picker (the `/api/mcp/pref` routes). The preference is kept in memory and
 * reaches the model as a dynamic `mcp-server-preference` context entry on every
 * prompt assembly for that session, so sent requests steer toward that
 * server's `mcp__<serverName>__*` tools when they are needed.
 *
 * @module dsh-mcp-plugin/host
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { defaultStorePath, loadStore, saveStore, STORE_VERSION } from './store.ts'
import { mountServer, unmountServer, toolsForServer, type LiveMount } from './mount.ts'
import {
  assembleSpec,
  applyPatch,
  type McpServerInput,
  type McpServerRecord,
  type McpServerSpec,
} from './types.ts'

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

/** Deployment config for the MCP manager. */
export interface Config {
  /**
   * Where the mcp-servers store file lives. Optional; defaults to
   * `~/.dsh/mcp-servers.json` (under `$DSH_HOME`). Set this for per-profile or
   * test isolation.
   */
  storePath?: string
}

/** Schemastery validation of {@link Config} for the loader. `storePath` is optional. */
export const Config = z.object({
  storePath: z.string(),
})

// ---------------------------------------------------------------------------
// Service: McpManager
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpManager: McpManager
  }
}

/**
 * The MCP server manager: a persistent store plus the live mcp-client fibers it
 * maintains. Every mutation is serialized per `serverName` so concurrent calls
 * for one server cannot race; different servers stay independent.
 */
export class McpManager extends Service {
  /** The plugin config schema, shared with the loader. */
  static readonly Config = Config

  /** Absolute path to the persisted store file. */
  private readonly storePath: string
  /** Authoritative in-memory store: serverName → mount-ready spec. */
  private store: Record<string, McpServerSpec> = {}
  /** Live mcp-client fibers currently mounted, keyed by serverName. */
  private readonly mounts = new Map<string, LiveMount>()
  /** In-flight mutation promise per serverName (serialization latch). */
  private readonly inFlight = new Map<string, Promise<unknown>>()
  /**
   * Per-session preferred server (the composer-dock picker): session id →
   * serverName. In-memory only; it does not survive a restart, and a removed
   * server's preference is dropped with the server.
   */
  private readonly preferences = new Map<string, string>()

  /**
   * @param ctx - the owning Cordis context (carries the tool registry); stored
   *   as `this.ctx` by the Service base and used for live mounts.
   * @param config - resolved plugin config; `storePath` defaults to `~/.dsh`.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mcpManager')
    this.storePath = config.storePath ?? defaultStorePath()
  }

  /** The store file path this instance reads and writes. */
  get storeFilePath(): string {
    return this.storePath
  }

  /** Load the persisted store into memory without mounting anything yet. */
  async load(): Promise<void> {
    this.store = (await loadStore(this.storePath)).servers
  }

  /**
   * Load the store and re-mount every stored server, so a persisted set survives
   * a restart. Each mount is awaited; with the default `failOnStartupError:
   * false` a downed server does not reject, its reconnect loop keeps running.
   */
  async restore(): Promise<void> {
    await this.load()
    for (const spec of Object.values(this.store)) {
      await this.mountOne(spec)
    }
  }

  // ---- Public operations --------------------------------------------------

  /**
   * Register and live-mount a new server.
   * @param input - the server definition to add.
   * @returns the persisted record with its live status.
   * @throws when the `serverName` is already registered, or the spec is invalid.
   */
  async add(input: McpServerInput): Promise<McpServerRecord> {
    return this.withLock(input.serverName, async () => {
      if (this.store[input.serverName] !== undefined) {
        throw new Error(`mcp_add: server "${input.serverName}" already exists — use mcp_modify or mcp_remove first`)
      }
      const spec = assembleSpec(input)
      this.store[input.serverName] = spec
      this.persist()
      await this.mountOne(spec)
      return this.record(input.serverName)
    })
  }

  /**
   * Change a stored server and reconnect it: the old fiber is disposed, the new
   * spec persisted, and a fresh fiber mounted.
   * @param input - the target `serverName` plus the fields to change.
   * @returns the updated record with its live status.
   * @throws when the `serverName` is not registered.
   */
  async modify(input: McpServerInput): Promise<McpServerRecord> {
    const serverName = input.serverName
    return this.withLock(serverName, async () => {
      const existing = this.store[serverName]
      if (existing === undefined) {
        throw new Error(`mcp_modify: server "${serverName}" is not registered — use mcp_add first`)
      }
      const spec = applyPatch(existing, input)
      this.store[serverName] = spec
      this.persist()
      const prior = this.mounts.get(serverName)
      if (prior !== undefined) {
        this.mounts.delete(serverName)
        await unmountServer(prior)
      }
      await this.mountOne(spec)
      return this.record(serverName)
    })
  }

  /**
   * Unmount and delete a stored server.
   * @param serverName - the registered server to remove.
   * @throws when the `serverName` is not registered.
   */
  async remove(serverName: string): Promise<void> {
    await this.withLock(serverName, async () => {
      if (this.store[serverName] === undefined && this.mounts.get(serverName) === undefined) {
        throw new Error(`mcp_remove: server "${serverName}" is not registered`)
      }
      const mount = this.mounts.get(serverName)
      if (mount !== undefined) {
        this.mounts.delete(serverName)
        await unmountServer(mount)
      }
      delete this.store[serverName]
      // A removed server must not keep steering sessions: drop its preferences.
      for (const [sessionId, preferred] of this.preferences) {
        if (preferred === serverName) this.preferences.delete(sessionId)
      }
      this.persist()
    })
  }

  /**
   * Every stored server with its live connection status.
   * @returns the records, one per stored server.
   */
  list(): McpServerRecord[] {
    return Object.keys(this.store).map(serverName => this.record(serverName))
  }

  // ---- Per-session preference ----------------------------------------------

  /**
   * The session's preferred MCP server (the composer-dock picker).
   * @param sessionId - the session whose preference to read.
   * @returns the preferred `serverName`, or undefined when the session set none.
   */
  preferenceFor(sessionId: string): string | undefined {
    return this.preferences.get(sessionId)
  }

  /**
   * Set or clear a session's preferred MCP server. Clearing passes null.
   * @param sessionId - the session to set the preference for.
   * @param serverName - a registered server to prefer, or null to clear.
   * @returns the resulting preference (undefined when cleared).
   * @throws when `serverName` names a server that is not registered.
   */
  setPreference(sessionId: string, serverName: string | null): string | undefined {
    if (serverName !== null && this.store[serverName] === undefined) {
      throw new Error(`mcp_pref: server "${serverName}" is not registered — use mcp_add first`)
    }
    if (serverName === null) {
      this.preferences.delete(sessionId)
      return undefined
    }
    this.preferences.set(sessionId, serverName)
    return serverName
  }

  // ---- Internals ----------------------------------------------------------

  /** Mount `spec` and remember its fiber under its `serverName`. */
  private async mountOne(spec: McpServerSpec): Promise<LiveMount> {
    const mount = await mountServer(this.ctx, spec)
    this.mounts.set(spec.serverName, mount)
    return mount
  }

  /** Best-effort persist; a failed write leaves memory authoritative. */
  private persist(): void {
    void saveStore(this.storePath, { version: STORE_VERSION, servers: this.store }).catch(() => {
      // In-memory store stays authoritative; the next mutation retries the write.
    })
  }

  /** One stored server plus its live status. */
  private record(serverName: string): McpServerRecord {
    const spec = this.store[serverName]
    const mount = this.mounts.get(serverName)
    const toolCount = mount !== undefined ? toolsForServer(this.ctx, serverName) : 0
    return {
      serverName,
      spec,
      connected: mount !== undefined && toolCount > 0,
      toolCount,
    }
  }

  /** Serialize one serverName's mutations without blocking other servers. */
  private withLock<T>(serverName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inFlight.get(serverName) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.inFlight.set(serverName, next)
    return next
  }
}

// ---------------------------------------------------------------------------
// Model-facing tools
// ---------------------------------------------------------------------------

/** JSON-safe view of one server for a tool result (no raw config). */
interface ServerResult {
  serverName: string
  connected: boolean
  toolCount: number
}

/** JSON-safe view of one server that also names its transport. */
interface ServerListEntry {
  serverName: string
  transport: string
  connected: boolean
  toolCount: number
}

function toResult(record: McpServerRecord): ServerResult {
  return { serverName: record.serverName, connected: record.connected, toolCount: record.toolCount }
}

function mcpListTool(manager: McpManager) {
  return defineTool({
    name: 'mcp_list',
    description:
      'List the MCP servers this harness manages, with each server\'s transport, '
      + 'whether it is connected, and how many of its tools are currently available.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          servers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                serverName: { type: 'string' },
                transport: { type: 'string' },
                connected: { type: 'boolean' },
                toolCount: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const entries = (value as { servers: ServerListEntry[] }).servers
        const lines = entries.length
          ? entries.map(e =>
              `${e.serverName} [${e.transport}] ${e.connected ? 'connected' : 'connecting'} (${e.toolCount} tool${e.toolCount === 1 ? '' : 's'})`)
          : '(no MCP servers registered)'
        return [{ type: 'text', text: `MCP servers:\n${lines}` }]
      },
    },
    execute: async () => ({
      servers: manager.list().map(r => ({
        serverName: r.serverName,
        transport: r.spec.transport,
        connected: r.connected,
        toolCount: r.toolCount,
      })) satisfies ServerListEntry[],
    }),
  })
}

function mcpAddTool(manager: McpManager) {
  return defineTool({
    name: 'mcp_add',
    description:
      'Register an MCP server so the harness can call its tools. The server is '
      + 'connected live and its tools become available as `mcp__<serverName>__<tool>`. '
      + 'Use transport "stdio" for a spawned child process (set command/args/env/cwd) '
      + 'or "streamable-http" for a remote endpoint (set url/headers).',
    parameters: {
      server: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'The MCP server definition to register.',
        properties: {
          serverName: { type: 'string', required: true, description: 'Unique [A-Za-z0-9_-] namespace (1-32 chars) for this server\'s tools.' },
          transport: { type: 'string', required: true, enum: ['stdio', 'streamable-http'], description: 'How the harness reaches the server.' },
          command: { type: 'string', description: 'stdio only: the executable to spawn (e.g. "npx", "node", "uvx").' },
          args: { type: 'array', description: 'stdio only: arguments, passed without a shell.', items: { type: 'string' } },
          env: { type: 'object', additionalProperties: true, description: 'stdio only: extra environment variables.' },
          cwd: { type: 'string', description: 'stdio only: working directory for the child process.' },
          url: { type: 'string', description: 'streamable-http only: the MCP endpoint URL.' },
          headers: { type: 'object', additionalProperties: true, description: 'streamable-http only: request headers to attach.' },
          toolCallTimeoutMs: { type: 'integer', description: 'Per-tool-call timeout in milliseconds.' },
          failOnStartupError: { type: 'boolean', description: 'Fail registration if the initial connection fails.' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serverName: { type: 'string' },
          connected: { type: 'boolean' },
          toolCount: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const record = value as ServerResult
        return [{
          type: 'text',
          text: `Added MCP server "${record.serverName}": ${record.connected ? 'connected' : 'connecting'}, ${record.toolCount} tool${record.toolCount === 1 ? '' : 's'} available.`,
        }]
      },
    },
    execute: async (args) => {
      const server = args.server as unknown as McpServerInput | undefined
      if (server === undefined) throw new Error('mcp_add: missing "server" argument')
      return toResult(await manager.add(server))
    },
  })
}

function mcpModifyTool(manager: McpManager) {
  return defineTool({
    name: 'mcp_modify',
    description:
      'Change a registered MCP server and reconnect it: the old connection is '
      + 'torn down, the new configuration is persisted, and a fresh connection is '
      + 'made live. Provide the target serverName and only the fields to change; '
      + 'unchanged fields are kept. A serverName cannot be renamed.',
    parameters: {
      serverName: { type: 'string', required: true, description: 'The registered server to change.' },
      changes: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'The fields to update (same fields as mcp_add, without a new serverName). Omit fields to keep them.',
        properties: {
          transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'Switch or keep the transport.' },
          command: { type: 'string', description: 'stdio only: the executable to spawn.' },
          args: { type: 'array', description: 'stdio only: arguments.', items: { type: 'string' } },
          env: { type: 'object', additionalProperties: true, description: 'stdio only: extra environment variables.' },
          cwd: { type: 'string', description: 'stdio only: working directory.' },
          url: { type: 'string', description: 'streamable-http only: the MCP endpoint URL.' },
          headers: { type: 'object', additionalProperties: true, description: 'streamable-http only: request headers.' },
          toolCallTimeoutMs: { type: 'integer', description: 'Per-tool-call timeout in milliseconds.' },
          failOnStartupError: { type: 'boolean', description: 'Fail reconnection if the initial connection fails.' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serverName: { type: 'string' },
          connected: { type: 'boolean' },
          toolCount: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const record = value as ServerResult
        return [{
          type: 'text',
          text: `Modified MCP server "${record.serverName}": ${record.connected ? 'connected' : 'connecting'}, ${record.toolCount} tool${record.toolCount === 1 ? '' : 's'} available.`,
        }]
      },
    },
    execute: async (args) => {
      const serverName = args.serverName as unknown as string
      const changes = (args.changes ?? {}) as unknown as Partial<McpServerInput>
      return toResult(await manager.modify({ ...changes, serverName } as unknown as McpServerInput))
    },
  })
}

function mcpRemoveTool(manager: McpManager) {
  return defineTool({
    name: 'mcp_remove',
    description:
      'Remove a registered MCP server: disconnect it live (its tools become '
      + 'unavailable) and delete it from the persistent store.',
    parameters: {
      serverName: { type: 'string', required: true, description: 'The registered server to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serverName: { type: 'string' },
          removed: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const result = value as { serverName: string; removed: boolean }
        return [{ type: 'text', text: `Removed MCP server "${result.serverName}" (its tools are no longer available).` }]
      },
    },
    execute: async (args) => {
      const serverName = args.serverName as unknown as string
      await manager.remove(serverName)
      return { serverName, removed: true }
    },
  })
}

// ---------------------------------------------------------------------------
// Per-session preference: the model-facing context entry
// ---------------------------------------------------------------------------

/**
 * Minimal view of the merge-extensible AssembleContext fields the preference
 * provider reads: the agent subject and its session id. The dsh-agent merge is
 * not imported, so the fields are read through this structural view.
 */
interface PrefAssembleContext {
  agent?: { session?: { id?: unknown } } | null
}

/**
 * The pinned model-facing text for a session's selected MCP server. It steers
 * the model toward the selection's tools without forbidding any other tool.
 * @param serverName - the selected server's mcp-client namespace.
 * @returns the context entry's text.
 */
function preferenceHintText(serverName: string): string {
  return (
    `MCP server preference: the user selected MCP server "${serverName}" for this session. `
    + `When it can help fulfill the request, prefer that server's tools (mcp__${serverName}__*) `
    + `over MCP tools from other servers, and invoke them as needed. If its tools are not `
    + `available yet, say so and fall back to what can complete the task.`
  )
}

// ---------------------------------------------------------------------------
// Webserver API — the client settings panel and composer-dock picker reach the
// manager over HTTP (the standalone-plugin bridge, mirroring dsh-oauth's
// /api/auth/* routes). No-op when the host has no webServer (a non-web profile).
// ---------------------------------------------------------------------------

/** Minimal webserver registrar this plugin drives (a subset of the real service). */
interface WebServerRegistrar {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Read and parse a JSON request body; `{}` on absent or malformed input. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let chunks = ''
    req.on('data', (chunk: Buffer) => { chunks += chunk.toString() })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try {
        const parsed: unknown = JSON.parse(chunks)
        resolve(typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/** Write one JSON response body. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A stable, loggable message for a rejected mutation. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}

/** The `sessionId` query parameter of a request, or an empty string when absent. */
function sessionIdFromRequest(req: IncomingMessage): string {
  if (req.url === undefined) return ''
  const params = new URL(req.url, 'http://localhost').searchParams
  return params.get('sessionId') ?? ''
}

/**
 * Register the /api/mcp/* routes that drive the manager: list / add / modify /
 * remove plus the per-session preference (GET and POST /api/mcp/pref) the
 * composer-dock picker reads and writes. Each route answers with plain JSON.
 * Routes are effect-wrapped so stopping the plugin removes them.
 * @param manager - the manager these routes delegate to.
 * @param ctx - the owning context (provides the webServer service, when present).
 */
function registerMcpApi(manager: McpManager, ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServerRegistrar | undefined
  if (webServer === undefined) return
  ctx.effect(() => {
    const disposers: Array<() => void> = [
      webServer.register({
        kind: 'exact',
        path: '/api/mcp/list',
        handler: async (_req, res): Promise<void> => {
          sendJson(res, 200, { servers: manager.list() })
        },
      }),
      webServer.register({
        kind: 'exact',
        path: '/api/mcp/add',
        handler: async (req, res): Promise<void> => {
          const input = (await readJsonBody(req)) as unknown as McpServerInput
          try {
            const record = await manager.add(input)
            sendJson(res, 200, { record })
          } catch (err) {
            sendJson(res, 400, { error: errorMessage(err) })
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: '/api/mcp/modify',
        handler: async (req, res): Promise<void> => {
          const input = (await readJsonBody(req)) as unknown as McpServerInput
          try {
            const record = await manager.modify(input)
            sendJson(res, 200, { record })
          } catch (err) {
            sendJson(res, 400, { error: errorMessage(err) })
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: '/api/mcp/remove',
        handler: async (req, res): Promise<void> => {
          const body = await readJsonBody(req)
          const serverName = typeof body.serverName === 'string' ? body.serverName : ''
          if (serverName.length === 0) {
            sendJson(res, 400, { error: 'missing serverName' })
            return
          }
          try {
            await manager.remove(serverName)
            sendJson(res, 200, { ok: true })
          } catch (err) {
            sendJson(res, 400, { error: errorMessage(err) })
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: '/api/mcp/pref',
        handler: async (req, res): Promise<void> => {
          if (req.method === 'GET') {
            const sessionId = sessionIdFromRequest(req)
            if (sessionId.length === 0) {
              sendJson(res, 400, { error: 'missing sessionId' })
              return
            }
            sendJson(res, 200, { sessionId, serverName: manager.preferenceFor(sessionId) ?? null })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (sessionId.length === 0) {
            sendJson(res, 400, { error: 'missing sessionId' })
            return
          }
          const raw = body.serverName
          const serverName = raw === null ? null : typeof raw === 'string' && raw.length > 0 ? raw : undefined
          if (serverName === undefined) {
            sendJson(res, 400, { error: 'serverName must be a non-empty string or null' })
            return
          }
          try {
            const applied = manager.setPreference(sessionId, serverName)
            sendJson(res, 200, { sessionId, serverName: applied ?? null })
          } catch (err) {
            sendJson(res, 400, { error: errorMessage(err) })
          }
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* route already torn down */ }
      }
    }
  }, 'dsh-mcp-plugin: /api/mcp routes')
}

// ---------------------------------------------------------------------------
// Plugin descriptor
// ---------------------------------------------------------------------------

/** The plugin name registered with the Cordis loader. */
export const name = 'dsh-mcp-plugin'

/**
 * Services required before the manager can register its tools + prompt context.
 * `webServer` is deliberately NOT in this list: the /api/mcp/* routes are an
 * optional no-op when the host has no webserver (non-web profiles), so a hard
 * inject would leave the whole plugin pending there. `registerMcpApi` reads it
 * via `ctx.get` instead.
 */
export const inject = ['tools', 'systemPrompt']

/**
 * Build and register the manager: instantiate the service, register the four
 * control tools (reversibly, on the manager fiber), register the per-session
 * `mcp-server-preference` prompt context, register the /api/mcp/* webserver
 * routes that back the client settings panel and composer-dock picker, and
 * re-mount any persisted servers. The tools register synchronously so they
 * are usable even while a downed server is still reconnecting in the
 * background.
 * @param ctx - the owning context carrying the tool registry.
 * @param config - the resolved plugin config.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const manager = new McpManager(ctx, config)

  ctx.effect(() => {
    const disposers: Array<() => void> = [
      ctx.tools.register(mcpListTool(manager)),
      ctx.tools.register(mcpAddTool(manager)),
      ctx.tools.register(mcpModifyTool(manager)),
      ctx.tools.register(mcpRemoveTool(manager)),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-mcp-plugin.tools')

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'mcp-server-preference',
    order: 130,
    text: (assembleContext: AssembleContext): string => {
      const sessionId = (assembleContext as PrefAssembleContext).agent?.session?.id
      if (sessionId === undefined) return ''
      const preferred = manager.preferenceFor(String(sessionId))
      return preferred === undefined ? '' : preferenceHintText(preferred)
    },
  }), 'dsh-mcp-plugin.mcp-server-preference')

  registerMcpApi(manager, ctx)

  // Re-mount persisted servers; their fibers are children of this context and
  // unwind with it. A still-down server keeps reconnecting without blocking.
  await manager.restore()
}
