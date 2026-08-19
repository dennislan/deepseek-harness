/**
 * Invariant companion for `dsh-oauth-plugin`.
 * @module dsh-oauth-plugin/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-oauth-plugin'

/** Cordis companion plugin name. */
export const name = 'dsh-oauth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: auth state is process-local in-memory with a
 * best-effort on-disk map. There is no independent event stream to
 * compare against beyond what the service itself owns.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
