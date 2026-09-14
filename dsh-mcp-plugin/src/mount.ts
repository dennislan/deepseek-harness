/**
 * Live mounting of `@deepseek-ai/dsh-mcp-client` bridges. Each stored MCP
 * server becomes a child fiber under the owning manager context: `ctx.plugin()`
 * connects it and registers its tools on `ctx.tools` under `mcp__<name>__*`.
 * Disposing the fiber tears the connection down and unregisters its tools.
 * @module dsh-mcp-plugin/mount
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import {
  name as MCP_CLIENT_NAME,
  inject as MCP_CLIENT_INJECT,
  apply as MCP_CLIENT_APPLY,
} from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'

/** The mcp-client object plugin reused for every live mount. */
export const MCP_CLIENT_PLUGIN = {
  name: MCP_CLIENT_NAME,
  inject: MCP_CLIENT_INJECT,
  apply: MCP_CLIENT_APPLY,
}

/** A live mcp-client fiber and the definition it was mounted with. */
export interface LiveMount {
  serverName: string
  spec: McpClientConfig
  fiber: Fiber
}

/**
 * Mount one mcp-client fiber under `ctx` for `spec` and wait for its initial
 * activation. With `failOnStartupError: false` (the manager default) a downed
 * server does not reject — its reconnect loop keeps retrying in the background
 * and its tools appear once a connection succeeds.
 * @param ctx - the owning context; the child fiber unwinds when it is disposed.
 * @param spec - a mount-ready mcp-client definition.
 * @returns the live mount and its fiber.
 */
export async function mountServer(ctx: Context, spec: McpClientConfig): Promise<LiveMount> {
  const fiber = ctx.plugin(MCP_CLIENT_PLUGIN, spec)
  await fiber
  return { serverName: spec.serverName, spec, fiber }
}

/** Disconnect `mount` and unregister all of its tools. */
export async function unmountServer(mount: LiveMount): Promise<void> {
  await mount.fiber.dispose()
}

/**
 * Count the `mcp__<serverName>__*` tools currently visible on the runtime.
 * Zero means the server has not published tools yet (not connected, or tools
 * not yet synced).
 * @param ctx - a context with the tool registry available.
 * @param serverName - the mcp-client namespace to probe.
 * @returns the number of registered tools under that namespace.
 */
export function toolsForServer(ctx: Context, serverName: string): number {
  const prefix = `mcp__${serverName}__`
  return ctx.tools.schemas().filter(schema => schema.name.startsWith(prefix)).length
}
