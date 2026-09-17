/**
 * Discovered-model cache for the DevEco Code route.
 *
 * The catalog is a gateway HTTP call, but the harness asks for the model list
 * on every selector render and every model resolution. The cache therefore
 * serves a recent answer immediately and refreshes behind a TTL, and it never
 * lets a refresh failure erase a previously known catalog — a transient
 * network fault must not empty the model picker mid-session.
 *
 * The first call is blocking, because a caller asking for models with nothing
 * cached has no alternative but to wait.
 *
 * @module dsh-connect-deveco/catalog
 */

import { fetchModelCatalog } from './api.ts'
import type { DevecoModel } from './api.ts'

/** One cached catalog generation. */
interface CatalogState {
  /** Models from the last successful fetch. */
  models: readonly DevecoModel[]
  /** When the models were fetched, in epoch milliseconds. */
  fetchedAt: number
}

/** Process-wide cache slot. */
let state: CatalogState | undefined

/** Options the cache needs to fetch. */
export interface CatalogOptions {
  /** Resolve the bearer token at fetch time. */
  resolveToken: () => Promise<string>
  /** Gateway origin. */
  baseUrl: string
  /** How long a fetched catalog stays fresh. */
  ttlMs: number
  /** Per-attempt timeout. */
  timeoutMs: number
  /**
   * Model ids to advertise instead of querying the gateway.
   *
   * Set when the catalog route is unreachable but the ids are known. These are
   * advertisement-only: the gateway remains the authority on what it serves, so
   * declaring an id does not make a request to it succeed.
   */
  declaredModels?: readonly string[]
  /** Records a refresh failure without failing the caller that served a cached answer. */
  onWarning?: (message: string) => void
}

/** The catalog accessor the adapter reads and the discovery hook refreshes. */
export interface Catalog {
  /** Models known right now, without any network call. */
  current: () => readonly DevecoModel[]
  /**
   * Models to advertise, fetching when the cache is cold or stale.
   *
   * This is what the adapter serves to the model picker: it resolves a
   * fresh-enough list without the caller having to know whether a fetch is
   * needed. A warm cache answers without I/O.
   *
   * @param signal - cancellation for the fetch.
   * @returns the model list.
   */
  list: (signal?: AbortSignal) => Promise<readonly DevecoModel[]>
  /**
   * Return a fresh catalog, fetching when the cache is cold or stale.
   * @param signal - cancellation for the fetch.
   * @returns the model list.
   */
  refresh: (signal?: AbortSignal) => Promise<readonly DevecoModel[]>
}

/**
 * Discard the cached catalog.
 *
 * Called on plugin disposal: the cache is process-global, and a disposed plugin
 * must not leave a catalog behind that a later, differently configured instance
 * would serve as its own.
 */
export function invalidateCatalog(): void {
  state = undefined
}

/**
 * Build the catalog accessor for one plugin instance.
 * @param options - fetch inputs and cache policy.
 * @returns the catalog accessor.
 */
export function discoverCatalog(options: CatalogOptions): Catalog {
  // A declared list bypasses the gateway entirely: no token is resolved and no
  // request is made. Only the id and name are known, so capacity metadata is
  // left absent and `resolveModel` falls back to its conservative floor.
  if (options.declaredModels !== undefined) {
    const declared: readonly DevecoModel[] = options.declaredModels.map(id => ({
      id,
      name: id,
      reasoning: false,
      toolCall: true,
      contextWindow: 32768,
      maxTokens: 8192,
      inputModalities: ['text'],
    }))
    state = { models: declared, fetchedAt: Date.now() }
    return {
      current: () => declared,
      list: async () => declared,
      refresh: async () => declared,
    }
  }

  const fetchOnce = async (signal?: AbortSignal): Promise<readonly DevecoModel[]> => {
    const accessToken = await options.resolveToken()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const models = await fetchModelCatalog({
        accessToken,
        baseUrl: options.baseUrl,
        signal: controller.signal,
      })
      state = { models, fetchedAt: Date.now() }
      return models
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  const refresh = async (signal?: AbortSignal): Promise<readonly DevecoModel[]> => {
    const cached = state
    const fresh = cached !== undefined && Date.now() - cached.fetchedAt < options.ttlMs
    if (fresh) return cached.models
    try {
      return await fetchOnce(signal)
    } catch (error) {
      // A cold cache has nothing to fall back to, so the failure propagates
      // and the caller reports it; a warm cache keeps serving its last known
      // models and only warns.
      if (cached === undefined) throw error
      const reason = error instanceof Error ? error.message : String(error)
      options.onWarning?.(`model catalog refresh failed, serving ${cached.models.length} cached model(s): ${reason}`)
      return cached.models
    }
  }

  // One in-flight fetch is shared by every concurrent caller, so a burst of
  // selector renders cannot turn into a burst of gateway requests.
  let pending: Promise<readonly DevecoModel[]> | undefined
  const list = async (signal?: AbortSignal): Promise<readonly DevecoModel[]> => {
    const cached = state
    if (cached !== undefined && Date.now() - cached.fetchedAt < options.ttlMs) return cached.models
    pending ??= refresh(signal).finally(() => {
      pending = undefined
    })
    return pending
  }

  return { current: () => state?.models ?? [], list, refresh }
}
