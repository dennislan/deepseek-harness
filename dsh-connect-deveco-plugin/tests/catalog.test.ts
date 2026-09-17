/**
 * Behaviour tests for the model-catalog cache.
 *
 * The cache exists to keep a gateway round trip off the model-picker render
 * path while never letting a transient failure empty the picker. The tests
 * below pin both halves: the first call must fetch, and a later failure must
 * keep serving the last known models.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Mutable fetch behaviour the mocked module observes. */
const harness = {
  calls: 0,
  respond: async () => [{ id: 'GLM-5.3', name: 'GLM-5.3', contextWindow: 170000, maxTokens: 32000, inputModalities: ['text'], reasoning: true, toolCall: true }],
}

vi.mock('../src/api.ts', () => ({
  fetchModelCatalog: async () => {
    harness.calls += 1
    return harness.respond()
  },
}))

const { discoverCatalog, invalidateCatalog } = await import('../src/catalog.ts')

/** Options shared by the tests, with a controllable fetch. */
function options(overrides: { ttlMs?: number } = {}) {
  return {
    resolveToken: async () => 'tok',
    baseUrl: 'https://example.test',
    ttlMs: overrides.ttlMs ?? 60_000,
    timeoutMs: 5_000,
  }
}

beforeEach(() => {
  invalidateCatalog()
  harness.calls = 0
  harness.respond = async () => [{ id: 'GLM-5.3', name: 'GLM-5.3', contextWindow: 170000, maxTokens: 32000, inputModalities: ['text'], reasoning: true, toolCall: true }]
})

describe('catalog.list', () => {
  it('fetches on a cold cache, because the first caller has nothing else', async () => {
    const catalog = discoverCatalog(options())
    const models = await catalog.list()
    expect(harness.calls).toBe(1)
    expect(models.map(model => model.id)).toEqual(['GLM-5.3'])
  })

  it('serves a warm cache without another request', async () => {
    const catalog = discoverCatalog(options())
    await catalog.list()
    await catalog.list()
    expect(harness.calls).toBe(1)
  })

  it('reports nothing from current() before the first fetch', () => {
    expect(discoverCatalog(options()).current()).toEqual([])
  })

  it('reflects fetched models in current()', async () => {
    const catalog = discoverCatalog(options())
    await catalog.list()
    expect(catalog.current().map(model => model.id)).toEqual(['GLM-5.3'])
  })

  it('shares one in-flight fetch across concurrent callers', async () => {
    const catalog = discoverCatalog(options())
    // A selector render fan-out must not become a request fan-out.
    await Promise.all([catalog.list(), catalog.list(), catalog.list()])
    expect(harness.calls).toBe(1)
  })

  it('refetches once the TTL has elapsed', async () => {
    const catalog = discoverCatalog(options({ ttlMs: 0 }))
    await catalog.list()
    await catalog.list()
    expect(harness.calls).toBe(2)
  })
})

describe('catalog.refresh failure handling', () => {
  it('propagates a failure when nothing is cached', async () => {
    const catalog = discoverCatalog(options({ ttlMs: 0 }))
    harness.respond = async () => { throw new Error('gateway down') }
    await expect(catalog.refresh()).rejects.toThrow('gateway down')
  })

  it('keeps serving the last known models when a refresh fails', async () => {
    const catalog = discoverCatalog(options({ ttlMs: 0 }))
    await catalog.refresh()
    harness.respond = async () => { throw new Error('gateway down') }
    // A transient fault must not empty the picker mid-session.
    expect((await catalog.refresh()).map(model => model.id)).toEqual(['GLM-5.3'])
  })

  it('warns when it falls back to a stale catalog', async () => {
    const warnings: string[] = []
    const catalog = discoverCatalog({ ...options({ ttlMs: 0 }), onWarning: message => warnings.push(message) })
    await catalog.refresh()
    harness.respond = async () => { throw new Error('gateway down') }
    await catalog.refresh()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/serving 1 cached model/)
  })
})

describe('invalidateCatalog', () => {
  it('drops the cached models so a new instance refetches', async () => {
    const catalog = discoverCatalog(options())
    await catalog.list()
    invalidateCatalog()
    expect(catalog.current()).toEqual([])
    await catalog.list()
    expect(harness.calls).toBe(2)
  })
})
