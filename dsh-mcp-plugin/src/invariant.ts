/**
 * Invariant companion for `dsh-mcp-plugin`. Registered only when the dev
 * `invariants` composition is loaded; a shipped host never mounts it, so this
 * resolves to a no-op in normal operation.
 * @module dsh-mcp-plugin/invariant
 */

import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = 'dsh-mcp-plugin'

/** The companion plugin name used by the loader. */
export const name = 'dsh-mcp-plugin-invariant'

/**
 * No runtime invariant: the manager's effects (live mcp-client fibers and their
 * tools) are observable only through the tool registry, which the host owns;
 * this package publishes no independent snapshot to check.
 * @param ctx - the Cordis context; `invariants` is optional at runtime.
 * @returns the registration's disposer, or a no-op when the service is absent.
 */
export const apply = (ctx: Context): Promise<() => void> => {
  const invariants = ctx.get('invariants') as
    | { register(packageName: string, installer: () => void): unknown }
    | undefined
  if (invariants === undefined) return Promise.resolve(() => {})
  const handle = invariants.register(PACKAGE_NAME, () => {})
  return Promise.resolve(() => {
    if (typeof handle === 'function') handle()
  })
}
