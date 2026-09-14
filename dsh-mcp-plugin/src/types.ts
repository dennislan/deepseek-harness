/**
 * Type surface for the dsh-mcp-plugin store and records. The persisted spec is
 * exactly the `@deepseek-ai/dsh-mcp-client` `Config` the plugin mounts, so a
 * stored entry is always wire-ready for a live mount with no schema drift.
 * @module dsh-mcp-plugin/types
 */

import type { Config } from '@deepseek-ai/dsh-mcp-client'

/**
 * The definition of one MCP server, persisted verbatim and mounted verbatim.
 * It is the mcp-client {@link Config} union (stdio or streamable-http).
 */
export type McpServerSpec = Config

/** A stored server and its live-connection bookkeeping. */
export interface McpServerRecord {
  /** The mcp-client `serverName`; the namespace prefix for its tools. */
  serverName: string
  /** The persisted, mount-ready definition. */
  spec: McpServerSpec
  /** Whether a live mcp-client fiber is mounted and has published tools. */
  connected: boolean
  /** Number of `mcp__<serverName>__*` tools currently registered. */
  toolCount: number
}

/** The on-disk store envelope. */
export interface McpStore {
  /** Store format version; `1` for the first release. */
  version: number
  /** Server definitions keyed by their mcp-client `serverName`. */
  servers: Record<string, McpServerSpec>
}

/** The flat fields a model-facing tool accepts; assembled into a {@link McpServerSpec}. */
export interface McpServerInput {
  /** Unique `[A-Za-z0-9_-]{1,32}` namespace for the server's tools. */
  serverName: string
  /** Transport kind. */
  transport: 'stdio' | 'streamable-http'
  /** stdio: executable to spawn. */
  command?: string
  /** stdio: arguments, no shell interpolation. */
  args?: string[]
  /** stdio: extra env vars merged over the scrubbed ambient env. */
  env?: Record<string, string>
  /** stdio: working directory for the child. */
  cwd?: string
  /** streamable-http: MCP endpoint URL. */
  url?: string
  /** streamable-http: extra request headers. */
  headers?: Record<string, string>
  /** Per-tool-call timeout in ms (defaults to the mcp-client default). */
  toolCallTimeoutMs?: number
  /** Fail activation when the initial connection fails (defaults to false). */
  failOnStartupError?: boolean
}

/** Defaults mirror the mcp-client `Config` so a live mount matches a static row. */
export const MCP_CLIENT_DEFAULTS = {
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
} as const

/**
 * Assemble a mount-ready {@link McpServerSpec} from flat tool input.
 * @param input - the tool-supplied fields.
 * @returns the completed mcp-client `Config` for the declared transport.
 * @throws when the transport's required field (`command` or `url`) is absent.
 */
export function assembleSpec(input: McpServerInput): McpServerSpec {
  const serverName = input.serverName
  const toolCallTimeoutMs = input.toolCallTimeoutMs ?? MCP_CLIENT_DEFAULTS.toolCallTimeoutMs
  const failOnStartupError = input.failOnStartupError ?? MCP_CLIENT_DEFAULTS.failOnStartupError
  if (input.transport === 'stdio') {
    if (input.command === undefined || input.command === '') {
      throw new Error(`mcp_add: stdio server "${serverName}" requires a non-empty "command"`)
    }
    return {
      transport: 'stdio',
      serverName,
      command: input.command,
      args: input.args ?? [],
      env: input.env ?? {},
      cwd: input.cwd ?? '',
      toolCallTimeoutMs,
      failOnStartupError,
    }
  }
  if (input.transport === 'streamable-http') {
    if (input.url === undefined || input.url === '') {
      throw new Error(`mcp_add: streamable-http server "${serverName}" requires a non-empty "url"`)
    }
    return {
      transport: 'streamable-http',
      serverName,
      url: input.url,
      headers: input.headers ?? {},
      toolCallTimeoutMs,
      failOnStartupError,
    }
  }
  // The tool schema restricts `transport` to the two literals, so this only
  // catches a programmatically-constructed input that skipped the schema.
  throw new Error(`mcp_add: unknown transport "${String(input.transport)}" for server "${serverName}"`)
}

/**
 * Overlay defined `patch` fields onto an existing {@link McpServerSpec}, keeping
 * every unchanged field. `serverName` is immutable: a patch that would rename
 * the server is rejected here.
 * @param existing - the stored spec being modified.
 * @param patch - the fields to change; absent keys keep their current value.
 * @returns the merged mount-ready spec.
 */
export function applyPatch(existing: McpServerSpec, patch: McpServerInput): McpServerSpec {
  if (patch.serverName !== undefined && patch.serverName !== existing.serverName) {
    throw new Error(`mcp_modify: cannot rename server "${existing.serverName}" to "${patch.serverName}" — use mcp_remove + mcp_add`)
  }
  const base: McpServerInput = {
    serverName: existing.serverName,
    transport: existing.transport,
    ...(existing.transport === 'stdio' ? {
      command: existing.command,
      args: existing.args,
      env: existing.env,
      cwd: existing.cwd,
    } : {
      url: existing.url,
      headers: existing.headers,
    }),
    toolCallTimeoutMs: existing.toolCallTimeoutMs,
    failOnStartupError: existing.failOnStartupError,
  }
  const merged: McpServerInput = { ...base, ...onlyDefined(patch) }
  merged.serverName = existing.serverName
  return assembleSpec(merged)
}

/** Drop `undefined` keys so a patch only overwrites the fields it actually set. */
function onlyDefined(patch: McpServerInput): McpServerInput {
  const out: McpServerInput = { serverName: patch.serverName, transport: patch.transport }
  if (patch.command !== undefined) out.command = patch.command
  if (patch.args !== undefined) out.args = patch.args
  if (patch.env !== undefined) out.env = patch.env
  if (patch.cwd !== undefined) out.cwd = patch.cwd
  if (patch.url !== undefined) out.url = patch.url
  if (patch.headers !== undefined) out.headers = patch.headers
  if (patch.toolCallTimeoutMs !== undefined) out.toolCallTimeoutMs = patch.toolCallTimeoutMs
  if (patch.failOnStartupError !== undefined) out.failOnStartupError = patch.failOnStartupError
  return out
}
