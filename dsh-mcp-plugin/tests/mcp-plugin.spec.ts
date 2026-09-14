/**
 * REAL-composition integration test for dsh-mcp-plugin. Boots a live cordis
 * Context (SystemPrompt + ToolRuntime) plus the manager, then drives the
 * mcp_list / mcp_add / mcp_modify / mcp_remove tools against an in-process
 * Streamable-HTTP MCP server to prove the live mount, the tool namespace, and
 * persistence across a "restart". No API key required.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { apply, name, inject, Config } from '../src/host.ts'
import { loadStore, STORE_VERSION } from '../src/store.ts'

// ---- In-process Streamable-HTTP MCP fixture (one `ping` tool) ----

interface HttpFixture {
  url: string
  close: () => Promise<void>
}

async function startHttpMcpFixture(): Promise<HttpFixture> {
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const mcp = new McpServer({ name: 'http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    mcp.registerTool('ping', { description: 'Replies pong.', inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    const transport = new StreamableHTTPServerTransport({})
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport as unknown as Transport)
    await transport.handleRequest(req, res)
  }
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      res.writeHead(500).end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture has no TCP address')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error)))),
  }
}

// ---- Manager mount + tool invocation helpers ----

const descriptor = { name, inject, Config, apply }

async function boot(storePath: string): Promise<{ ctx: Context; handle: Fiber & PromiseLike<Fiber> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const handle = ctx.plugin(descriptor, { storePath })
  await handle
  return { ctx, handle }
}

let callSeq = 0
async function call(ctx: Context, toolName: string, args: unknown) {
  const callId = ToolCallId(`mcp-plugin-test-${++callSeq}`)
  return await ctx.tools.execute({ callId, name: toolName, arguments: args, signal: new AbortController().signal })
}

function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name)
}

/** Poll until `predicate` holds (a downed-then-ready server) or time out. */
async function waitFor(predicate: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('waitFor: condition not met before timeout')
}

// ---- Tests ----

describe('dsh-mcp-plugin live manager', () => {
  let fixture: HttpFixture

  beforeAll(async () => {
    fixture = await startHttpMcpFixture()
  }, 30_000)

  afterAll(async () => {
    await fixture.close()
  })

  it('adds a live server: its tools appear and mcp_list reports it connected', async () => {
    const store = await mkdtemp(join(tmpdir(), 'mcp-plugin-add-'))
    const { ctx } = await boot(join(store, 'mcp-servers.json'))
    try {
      const added = await call(ctx, 'mcp_add', {
        server: { serverName: 'live', transport: 'streamable-http', url: fixture.url },
      })
      expect(added.isError).toBe(false)

      await waitFor(() => toolNames(ctx).includes('mcp__live__ping'))
      expect(toolNames(ctx)).toContain('mcp__live__ping')

      const listResult = await call(ctx, 'mcp_list', {})
      expect(listResult.isError).toBe(false)
      const servers = (listResult.value as { servers: Array<{ serverName: string; connected: boolean; toolCount: number }> }).servers
      const live = servers.find(s => s.serverName === 'live')
      expect(live).toBeDefined()
      expect(live?.connected).toBe(true)
      expect(live?.toolCount).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
      await rm(store, { recursive: true, force: true })
    }
  })

  it('removes a server: its tools disappear', async () => {
    const store = await mkdtemp(join(tmpdir(), 'mcp-plugin-remove-'))
    const { ctx } = await boot(join(store, 'mcp-servers.json'))
    try {
      await call(ctx, 'mcp_add', { server: { serverName: 'live', transport: 'streamable-http', url: fixture.url } })
      await waitFor(() => toolNames(ctx).includes('mcp__live__ping'))

      const removed = await call(ctx, 'mcp_remove', { serverName: 'live' })
      expect(removed.isError).toBe(false)
      expect(toolNames(ctx)).not.toContain('mcp__live__ping')
    } finally {
      await ctx.fiber.dispose()
      await rm(store, { recursive: true, force: true })
    }
  })

  it('persists the store and re-mounts on a fresh context (restart)', async () => {
    const store = await mkdtemp(join(tmpdir(), 'mcp-plugin-persist-'))
    const storePath = join(store, 'mcp-servers.json')
    try {
      // First "run": add a server, then dispose the whole context (teardown).
      const first = await boot(storePath)
      await call(first.ctx, 'mcp_add', { server: { serverName: 'persist', transport: 'streamable-http', url: fixture.url } })
      await waitFor(() => toolNames(first.ctx).includes('mcp__persist__ping'))
      await first.handle.dispose()

      // Second "run": a brand-new context sharing the store re-mounts it on load.
      const second = await boot(storePath)
      try {
        await waitFor(() => toolNames(second.ctx).includes('mcp__persist__ping'))
        expect(toolNames(second.ctx)).toContain('mcp__persist__ping')
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      await rm(store, { recursive: true, force: true })
    }
  })

  it('rejects duplicate add and unknown modify/remove as tool errors', async () => {
    const store = await mkdtemp(join(tmpdir(), 'mcp-plugin-errors-'))
    const { ctx } = await boot(join(store, 'mcp-servers.json'))
    try {
      await call(ctx, 'mcp_add', { server: { serverName: 'dup', transport: 'streamable-http', url: fixture.url } })

      const dup = await call(ctx, 'mcp_add', { server: { serverName: 'dup', transport: 'streamable-http', url: fixture.url } })
      expect(dup.isError).toBe(true)

      const badModify = await call(ctx, 'mcp_modify', { serverName: 'ghost', changes: {} })
      expect(badModify.isError).toBe(true)

      const badRemove = await call(ctx, 'mcp_remove', { serverName: 'ghost' })
      expect(badRemove.isError).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await rm(store, { recursive: true, force: true })
    }
  })
})

// ---- Per-session preference (the composer-dock picker) ----

describe('loadStore legacy mcpServers migration', () => {
  it('migrates a Claude-Code-style mcpServers block into mount-ready specs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-plugin-legacy-'))
    try {
      const legacy = join(dir, 'mcp-servers.json')
      await writeFile(legacy, JSON.stringify({
        mcpServers: {
          postgres: {
            command: 'docker',
            args: ['run', '-i', '--rm', 'mcp/postgres'],
          },
          remote: { url: 'https://host.example/mcp', headers: { Authorization: 'Bearer x' } },
        },
      }, null, 2))
      const store = await loadStore(legacy)
      expect(store.version).toBe(STORE_VERSION)
      expect(Object.keys(store.servers)).toEqual(['postgres', 'remote'])
      const pg = store.servers.postgres
      expect(pg.transport).toBe('stdio')
      expect(pg.serverName).toBe('postgres')
      expect((pg as { command: string }).command).toBe('docker')
      const remote = store.servers.remote
      expect(remote.transport).toBe('streamable-http')
      expect((remote as { url: string }).url).toBe('https://host.example/mcp')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the native envelope and ignores unrecognized legacy entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-plugin-native-'))
    try {
      const native = join(dir, 'mcp-servers.json')
      await writeFile(native, JSON.stringify({
        version: STORE_VERSION,
        servers: {
          live: { transport: 'stdio', serverName: 'live', command: 'echo', args: [], env: {}, cwd: '', toolCallTimeoutMs: 1000, failOnStartupError: false },
        },
      }))
      const store = await loadStore(native)
      expect(Object.keys(store.servers)).toEqual(['live'])
      expect(store.servers.live.serverName).toBe('live')

      // A legacy entry without a recognizable command/url is dropped, not poison.
      const bad = join(dir, 'bad.json')
      await writeFile(bad, JSON.stringify({ mcpServers: { ghost: { bogus: 1 } } }))
      const empty = await loadStore(bad)
      expect(Object.keys(empty.servers)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('dsh-mcp-plugin per-session preference', () => {
  let fixture: HttpFixture

  beforeAll(async () => {
    fixture = await startHttpMcpFixture()
  }, 30_000)

  afterAll(async () => {
    await fixture.close()
  })

  it('a set preference contributes the mcp-server-preference context only for its session', async () => {
    const store = await mkdtemp(join(tmpdir(), 'mcp-plugin-pref-'))
    const { ctx } = await boot(join(store, 'mcp-servers.json'))
    try {
      await call(ctx, 'mcp_add', { server: { serverName: 'live', transport: 'streamable-http', url: fixture.url } })
      await waitFor(() => toolNames(ctx).includes('mcp__live__ping'))

      const manager = ctx.mcpManager
      expect(manager.preferenceFor('sess-1')).toBeUndefined()
      manager.setPreference('sess-1', 'live')
      expect(manager.preferenceFor('sess-1')).toBe('live')

      const assembly = await ctx.systemPrompt.assemble({ agent: { session: { id: 'sess-1' } } } as never)
      const entry = assembly.contexts.find(context => context.name === 'mcp-server-preference')
      expect(entry?.text).toContain('mcp__live__')
      expect(entry?.text).toContain('the user selected MCP server "live"')

      // No preference for another session, and none without an agent subject.
      const other = await ctx.systemPrompt.assemble({ agent: { session: { id: 'sess-2' } } } as never)
      expect(other.contexts.find(context => context.name === 'mcp-server-preference')?.text).toBe('')
      const bare = await ctx.systemPrompt.assemble()
      expect(bare.contexts.find(context => context.name === 'mcp-server-preference')?.text).toBe('')

      // Clearing the preference empties the entry again.
      manager.setPreference('sess-1', null)
      expect(manager.preferenceFor('sess-1')).toBeUndefined()
      const cleared = await ctx.systemPrompt.assemble({ agent: { session: { id: 'sess-1' } } } as never)
      expect(cleared.contexts.find(context => context.name === 'mcp-server-preference')?.text).toBe('')
    } finally {
      await ctx.fiber.dispose()
      await rm(store, { recursive: true, force: true })
    }
  })

  it('rejects an unknown server and drops the preference when the server is removed', async () => {
    const store = await mkdtemp(join(tmpdir(), 'mcp-plugin-pref-drop-'))
    const { ctx } = await boot(join(store, 'mcp-servers.json'))
    try {
      await call(ctx, 'mcp_add', { server: { serverName: 'live', transport: 'streamable-http', url: fixture.url } })
      await waitFor(() => toolNames(ctx).includes('mcp__live__ping'))

      const manager = ctx.mcpManager
      expect(() => manager.setPreference('sess-1', 'ghost')).toThrow(/not registered/)
      manager.setPreference('sess-1', 'live')

      await call(ctx, 'mcp_remove', { serverName: 'live' })
      expect(manager.preferenceFor('sess-1')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(store, { recursive: true, force: true })
    }
  })

  it('serves GET/POST /api/mcp/pref over the webserver bridge', async () => {
    const store = await mkdtemp(join(tmpdir(), 'mcp-plugin-pref-api-'))
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
    const fakeRegistrar = {
      register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    }
    const ctx = new Context()
    ctx.reflect.provide('webServer', fakeRegistrar)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const handle = ctx.plugin(descriptor, { storePath: join(store, 'mcp-servers.json') })
    await handle
    try {
      await call(ctx, 'mcp_add', { server: { serverName: 'live', transport: 'streamable-http', url: fixture.url } })
      await waitFor(() => toolNames(ctx).includes('mcp__live__ping'))
      const handler = routes.get('/api/mcp/pref')
      expect(handler).toBeDefined()

      // GET: no sessionId → 400; an unknown session → null.
      let result = await invokeHandler(handler!, 'GET', '/api/mcp/pref')
      expect(result.status).toBe(400)
      result = await invokeHandler(handler!, 'GET', '/api/mcp/pref?sessionId=sess-1')
      expect(result.status).toBe(200)
      expect(result.json).toEqual({ sessionId: 'sess-1', serverName: null })

      // POST: unknown server → 400, valid → 200, then visible on GET.
      result = await invokeHandler(handler!, 'POST', '/api/mcp/pref', { sessionId: 'sess-1', serverName: 'ghost' })
      expect(result.status).toBe(400)
      result = await invokeHandler(handler!, 'POST', '/api/mcp/pref', { sessionId: 'sess-1', serverName: 'live' })
      expect(result.status).toBe(200)
      expect(result.json).toEqual({ sessionId: 'sess-1', serverName: 'live' })
      result = await invokeHandler(handler!, 'GET', '/api/mcp/pref?sessionId=sess-1')
      expect(result.json).toEqual({ sessionId: 'sess-1', serverName: 'live' })

      // POST without a sessionId → 400; an empty-string serverName → 400.
      result = await invokeHandler(handler!, 'POST', '/api/mcp/pref', { serverName: 'live' })
      expect(result.status).toBe(400)
      result = await invokeHandler(handler!, 'POST', '/api/mcp/pref', { sessionId: 'sess-1', serverName: '' })
      expect(result.status).toBe(400)

      // POST null clears it.
      result = await invokeHandler(handler!, 'POST', '/api/mcp/pref', { sessionId: 'sess-1', serverName: null })
      expect(result.status).toBe(200)
      expect(result.json).toEqual({ sessionId: 'sess-1', serverName: null })
    } finally {
      await ctx.fiber.dispose()
      await rm(store, { recursive: true, force: true })
    }
  })

  it('boots with an empty config and defaults the store under $DSH_HOME', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mcp-plugin-home-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const handle = ctx.plugin(descriptor, {})
      await handle
      // The optional `storePath` resolves under the (test-isolated) $DSH_HOME.
      expect(ctx.mcpManager.storeFilePath).toBe(join(home, 'mcp-servers.json'))
      await ctx.fiber.dispose()
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      await rm(home, { recursive: true, force: true })
    }
  })
})

/** Drive one fake webserver handler with a synthetic request/response pair. */
async function invokeHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  // The handler registers its data/end listeners synchronously, so the fake
  // request emits them one tick after the handler is invoked.
  const req = new EventEmitter() as EventEmitter & IncomingMessage
  req.method = method
  req.url = url
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  // A detached ServerResponse buffers rather than emitting, so capture the two
  // methods the handler actually calls (writeHead / end) on a plain object.
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status: number): this { this.statusCode = status; return this },
    end(payload?: string): void { this.body = payload ?? '' },
  } as unknown as ServerResponse
  await handler(req, res)
  const captured = res as unknown as { statusCode: number; body: string }
  const text = captured.body
  return { status: captured.statusCode, json: text.length > 0 ? JSON.parse(text) : {} }
}
