/**
 * Persistence for the MCP server store: a JSON file of mount-ready definitions.
 * A missing or corrupt file yields the empty store rather than a load failure —
 * the in-memory map stays authoritative and the next write repairs the file.
 * @module dsh-mcp-plugin/store
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type { McpServerSpec, McpStore } from './types.ts'

/** The store format version this build writes. */
export const STORE_VERSION = 1

/** `~/.dsh/mcp-servers.json` under `$DSH_HOME`, matching the other DSH state files. */
export function defaultStorePath(): string {
  const dshHome = process.env.DSH_HOME ?? '~/.dsh'
  return `${expandHomePath(dshHome)}/mcp-servers.json`
}

/** Whether a parsed value is the `{ version, servers: {…} }` envelope. */
function isStore(value: unknown): value is McpStore {
  if (value === null || typeof value !== 'object') return false
  const servers = (value as Partial<McpStore>).servers
  return servers !== null && typeof servers === 'object' && !Array.isArray(servers)
}

/**
 * Whether a parsed value is the legacy Claude-Code-style shape:
 * `{ mcpServers: { <name>: { command?, url?, … } } }` where entries carry no
 * `serverName`/`transport` and the server id lives in the key. This is the
 * format a user hand-writes into `~/.dsh/mcp-servers.json` by copy-pasting a
 * Claude `mcpServers` block.
 */
function legacyServers(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const mcpServers = (value as { mcpServers?: unknown }).mcpServers
  if (mcpServers === null || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) return undefined
  return mcpServers as Record<string, unknown>
}

/**
 * Coerce one legacy entry (a plain `{ command?, url?, … }` without a
 * `serverName`) into a mount-ready {@link McpServerSpec} by inferring the
 * transport and filling `serverName` from the map key. Returns undefined when
 * the entry is not a recognizable stdio or streamable-http definition.
 */
function legacyToSpec(serverName: string, raw: unknown): McpServerSpec | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entry = raw as Record<string, unknown>
  const toolCallTimeoutMs = typeof entry.toolCallTimeoutMs === 'number' ? entry.toolCallTimeoutMs : 60_000
  const failOnStartupError = entry.failOnStartupError === true
  if (typeof entry.command === 'string' && entry.command.length > 0) {
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : []
    const env = recordOfStrings(entry.env)
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
    return {
      transport: 'stdio',
      serverName,
      command: entry.command,
      args,
      env,
      cwd,
      toolCallTimeoutMs,
      failOnStartupError,
    }
  }
  if (typeof entry.url === 'string' && entry.url.length > 0) {
    const headers = recordOfStrings(entry.headers)
    return {
      transport: 'streamable-http',
      serverName,
      url: entry.url,
      headers,
      toolCallTimeoutMs,
      failOnStartupError,
    }
  }
  return undefined
}

/** Keep only the string-valued entries of a record-shaped value ({} otherwise). */
function recordOfStrings(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string') out[key] = v
  }
  return out
}

/**
 * Read the store from `path`. Absent or malformed files return the empty store
 * so a fresh install and a corrupted file behave identically at load time.
 * Both the native `{ version, servers }` envelope and the legacy Claude-Code
 * `{ mcpServers }` shape are accepted; legacy entries are migrated in place so
 * a user hand-written file is visible without a manual schema rewrite.
 * @param path - absolute path to the store file.
 * @returns the parsed store, or an empty one.
 */
export async function loadStore(path: string): Promise<McpStore> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { version: STORE_VERSION, servers: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { version: STORE_VERSION, servers: {} }
  }
  // Native envelope: keep every mount-ready entry, drop anything malformed.
  if (isStore(parsed)) {
    const servers: Record<string, McpServerSpec> = {}
    for (const [key, spec] of Object.entries(parsed.servers)) {
      if (spec !== null && typeof spec === 'object' && typeof (spec as McpServerSpec).serverName === 'string') {
        servers[key] = spec as McpServerSpec
      }
    }
    return { version: parsed.version ?? STORE_VERSION, servers }
  }
  // Legacy Claude-Code shape: migrate each entry into a mount-ready spec.
  const legacy = legacyServers(parsed)
  if (legacy !== undefined) {
    const servers: Record<string, McpServerSpec> = {}
    for (const [serverName, raw] of Object.entries(legacy)) {
      const spec = legacyToSpec(serverName, raw)
      if (spec !== undefined) servers[serverName] = spec
    }
    return { version: STORE_VERSION, servers }
  }
  return { version: STORE_VERSION, servers: {} }
}

/**
 * Write `store` to `path`, creating the parent directory. A successful write is
 * the store's commit point; callers treat the in-memory map as authoritative and
 * retry on the next change if this rejects. Native entries stay verbatim; a
 * legacy-migrated entry round-trips in the native `{ version, servers }`
 * envelope so a hand-written `mcpServers` file is normalized on first mount.
 * @param path - absolute path to the store file.
 * @param store - the complete store to persist.
 */
export async function saveStore(path: string, store: McpStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}
