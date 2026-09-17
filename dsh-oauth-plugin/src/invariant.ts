/**
 * Invariant companion for `dsh-oauth`.
 * No runtime invariant: auth state is process-local in-memory with a
 * best-effort on-disk map. No independent event stream to compare against.
 * @module dsh-oauth/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = 'dsh-oauth'

/** Cordis companion plugin name. */
export const name = 'dsh-oauth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariants service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(
    (ctx as unknown as {
      invariants: {
        register(name: string, install: () => void | Promise<void>): () => void
      }
    }).invariants.register(PACKAGE_NAME, () => {}),
  )
/* jscpd:ignore-end */
