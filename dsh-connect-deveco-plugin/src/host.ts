/**
 * `dsh-connect-deveco`: connects models served by the locally signed-in DevEco
 * Code (`deveco`) CLI to DeepSeek Harness.
 *
 * The plugin registers one configurable provider route on `ctx.llm` and serves
 * it with {@link DevecoAdapter}. Credentials are read from the CLI's own
 * encrypted stores at request time, so a `deveco providers login` in a terminal
 * takes effect on the next model call without restarting the harness.
 *
 * ```yaml
 * - id: dsh-connect-deveco
 *   name: 'dsh-connect-deveco'
 *   config:
 *     displayName: DevEco Code
 *     baseUrl: https://cn.devecostudio.huawei.com
 * ```
 *
 * @module dsh-connect-deveco
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { DevecoAdapter } from './adapter.ts'
import { DEFAULT_BASE_URL } from './api.ts'
import { resolveCredential, processEnvironment } from './credentials.ts'
import type { DevecoCredential, DevecoEnvironment } from './credentials.ts'
import { discoverCatalog, invalidateCatalog } from './catalog.ts'

/** Provider route this plugin registers on `ctx.llm`. */
export const PROVIDER = 'deveco'

/** User-settings namespace holding this route's overrides. */
export const SETTINGS_NS = 'dsh-connect-deveco'

/** Plugin configuration schema, validated at load. */
export interface Config {
  /** Label shown by provider selectors. */
  displayName?: string
  /** Gateway origin; defaults to the China site the CLI itself uses. */
  baseUrl?: string
  /** Explicit credential document, replacing discovery of both default stores. */
  authFile?: string
  /** Directory holding `auth.json`; defaults to the platform location. */
  dataDir?: string
  /** Directory holding `token.enc`, `token.dek`, and `keys/`. */
  configDir?: string
  /** Seconds a discovered catalog is reused before re-querying the gateway. */
  catalogTtlSeconds?: number
  /** Seconds to wait for gateway catalog and chat calls before aborting. */
  requestTimeoutSeconds?: number
  /** Model ids to advertise instead of discovering a catalog. */
  models?: string[]
}

/** Validated configuration with every default applied. */
export interface ResolvedConfig {
  /** Label shown by provider selectors. */
  readonly displayName: string
  /** Gateway origin. */
  readonly baseUrl: string
  /** Explicit credential document, when configured. */
  readonly authFile?: string
  /** Directory holding `auth.json`. */
  readonly dataDir?: string
  /** Directory holding `token.enc`, `token.dek`, and `keys/`. */
  readonly configDir?: string
  /** Catalog cache lifetime in milliseconds. */
  readonly catalogTtlMs: number
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs: number
  /** Configured model ids, when discovery is bypassed. */
  readonly models?: readonly string[]
}

/** Default catalog cache lifetime: long enough to avoid a call per model step, short enough to notice a plan change. */
export const DEFAULT_CATALOG_TTL_MS = 15 * 60 * 1000

/** Default per-request timeout. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

/** Configuration validator applied by the loader. */
export const Config: z<Config> = z.object({
  displayName: z.string().default('DevEco Code'),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  authFile: z.string(),
  dataDir: z.string(),
  configDir: z.string(),
  catalogTtlSeconds: z.number().min(0).default(DEFAULT_CATALOG_TTL_MS / 1000),
  requestTimeoutSeconds: z.number().min(1).default(DEFAULT_REQUEST_TIMEOUT_MS / 1000),
  models: z.array(z.string()),
})

/**
 * Apply defaults and bounds to validated configuration.
 *
 * Ranges are clamped rather than rejected: a misconfigured cache lifetime is a
 * performance choice, not a reason to refuse to load, and the CLI reports the
 * effective value so the clamp is visible.
 *
 * @param config - validated user configuration.
 * @returns configuration with every default and bound applied.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const ttlSeconds = Math.max(0, config.catalogTtlSeconds ?? DEFAULT_CATALOG_TTL_MS / 1000)
  const timeoutSeconds = Math.max(1, config.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_MS / 1000)
  return {
    displayName: config.displayName ?? 'DevEco Code',
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    ...(config.authFile !== undefined ? { authFile: config.authFile } : {}),
    ...(config.dataDir !== undefined ? { dataDir: config.dataDir } : {}),
    ...(config.configDir !== undefined ? { configDir: config.configDir } : {}),
    catalogTtlMs: ttlSeconds * 1000,
    requestTimeoutMs: timeoutSeconds * 1000,
    ...(config.models !== undefined && config.models.length > 0 ? { models: config.models } : {}),
  }
}

/**
 * Build the credential environment for a resolved configuration.
 * @param config - resolved configuration.
 * @param env - base environment; defaults to the real process and filesystem.
 * @returns an environment whose explicit directory overrides replace the platform defaults.
 */
export function credentialEnvironment(
  config: ResolvedConfig,
  env: DevecoEnvironment = processEnvironment(),
): { env: DevecoEnvironment; authFile?: string; paths?: { configDir: string; dataDir: string } } {
  const hasOverride = config.dataDir !== undefined || config.configDir !== undefined
  const paths = hasOverride
    ? {
      configDir: config.configDir ?? '',
      dataDir: config.dataDir ?? '',
    }
    : undefined
  // A partial override is completed from the platform defaults so an operator
  // setting only one directory does not silently lose the other store.
  const resolved = paths === undefined
    ? undefined
    : (() => {
      const defaults = {
        configDir: joinPath(env.homeDir, '.config', 'deveco'),
        dataDir: joinPath(env.homeDir, '.local', 'share', 'deveco'),
      }
      return {
        configDir: paths.configDir.length > 0 ? paths.configDir : defaults.configDir,
        dataDir: paths.dataDir.length > 0 ? paths.dataDir : defaults.dataDir,
      }
    })()
  return {
    env,
    ...(config.authFile !== undefined ? { authFile: config.authFile } : {}),
    ...(resolved !== undefined ? { paths: resolved } : {}),
  }
}

/**
 * Join path segments for the credential directory overrides.
 * @param segments - path segments.
 * @returns the joined path.
 */
function joinPath(...segments: string[]): string {
  return segments.join('/').replace(/\/+/g, '/')
}

/**
 * Plugin name used by the loader.
 *
 * @param ctx - the plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const { env, authFile, paths } = credentialEnvironment(resolved)

  /** Cache one resolved credential for the current request only. */
  const resolveToken = async (): Promise<string> => {
    const credential: DevecoCredential = await resolveCredential(env, {
      ...(authFile !== undefined ? { authFile } : {}),
      ...(paths !== undefined ? { paths } : {}),
    })
    return credential.accessToken
  }

  const catalog = discoverCatalog({
    resolveToken,
    baseUrl: resolved.baseUrl,
    ttlMs: resolved.catalogTtlMs,
    timeoutMs: resolved.requestTimeoutMs,
    ...(resolved.models !== undefined ? { declaredModels: resolved.models } : {}),
    onWarning: message => ctx.logger.warn(`dsh-connect-deveco: ${message}`),
  })

  const adapter = new DevecoAdapter({
    registryKey: PROVIDER,
    displayName: resolved.displayName,
    resolveToken,
    listCatalog: () => catalog.list(),
    baseUrl: resolved.baseUrl,
    onWarning: message => ctx.logger.warn(`dsh-connect-deveco: ${message}`),
  })

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: resolved.displayName, settingsNs: SETTINGS_NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)

  ctx.llm.registerModelDiscovery(SETTINGS_NS, async (_request, signal) => {
    const models = await catalog.refresh(signal)
    return models.map(model => ({
      id: model.id,
      name: model.name,
      ...(model.groupName !== undefined ? { description: `DevEco Code · ${model.groupName}` } : {}),
    }))
  })

  // The catalog is a network resource, so the first call is made lazily: a
  // harness that never routes a request to this provider must not pay for a
  // gateway round trip at boot, and must still load when the gateway is down.
  ctx.logger.info(`dsh-connect-deveco: registered provider "${PROVIDER}" as "${resolved.displayName}"`)

  // Both registrations bind to this apply fiber through `ctx.llm`, and the
  // process-global catalog cache is the one thing that outlives them, so it is
  // released explicitly on dispose.
  ctx.effect(() => () => {
    invalidateCatalog()
    registration()
  })
}

export { DevecoAdapter } from './adapter.ts'
export { resolveCredential, fingerprint, processEnvironment } from './credentials.ts'
export type { DevecoCredential, DevecoAccount, DevecoEnvironment } from './credentials.ts'
export { fetchModelCatalog, parseModelCatalog, streamChat, DevecoApiError, DEFAULT_BASE_URL } from './api.ts'
export type { DevecoModel, ChatRequest, ChatStreamChunk } from './api.ts'
export { createReasoningSplitter } from './reasoning.ts'
export type { ReasoningSpan, ReasoningSplitter } from './reasoning.ts'


/** Cordis plugin name; the loader keys the composition row by this. */
export const name = 'dsh-connect-deveco'

/** Hard dependency: this plugin contributes a provider route and nothing else. */
export const inject = ['llm']

/** Re-exported so a composition can assert the failure vocabulary it may see. */
export { LlmError }
