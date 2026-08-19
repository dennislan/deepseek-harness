/**
 * Host plugin: provides the `auth` service, registers HTTP routes on the
 * webserver, and tracks which sessions belong to which authenticated user.
 *
 * Supports two login modes:
 * - **Username/password** — POST /api/auth/login proxies to the remote API.
 * - **WeChat Enterprise QR** — POST /api/auth/wechat-qr generates a QR flow,
 *   GET  /api/auth/wechat-status polls for scan/confirm,
 *   POST /api/auth/wechat-login exchanges the WeChat code for a session.
 *
 * Session isolation is achieved by recording a `sessionId → userId` mapping
 * whenever a session is created while a user is authenticated.
 *
 * @module dsh-oauth-plugin
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  type AuthError,
  type Config as PluginConfig,
  DEFAULT_CONFIG,
  type LoginRequest,
  type LoginResponse,
  type SessionUserMapping,
  type UserInfo,
  type WeChatQrData,
  type WeChatQrRequest,
  type WeChatStatusResponse,
} from './types.ts'

// ---------------------------------------------------------------------------
// Module augmentation: declare `ctx.auth`
// ---------------------------------------------------------------------------
declare module '@deepseek-ai/cordis' {
  interface Context {
    auth: Auth
  }
}

// ---------------------------------------------------------------------------
// Pending WeChat QR login state (in-memory only)
// ---------------------------------------------------------------------------

interface PendingWeChatLogin {
  flowId: string
  /** Timestamp (ms) when the QR was created. */
  createdAt: number
  /** TTL in ms. */
  ttlMs: number
  /** QR data returned by the upstream API. */
  qr: WeChatQrData
  /** Resolved user after the user scans + confirms, or `undefined`. */
  user: UserInfo | undefined
  /** Status: waiting → scanned → confirmed → expired / error. */
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'
  errorMessage?: string
}

// ---------------------------------------------------------------------------
// Service: Auth
// ---------------------------------------------------------------------------

/**
 * Authentication service. Callers authenticate via the remote API; the
 * service keeps the current token and maps sessions to users.
 */
export class Auth extends Service {
  /** Config schema for Cordis loader validation. */
  static readonly Config = z
    .object({
      apiUrl: z.string().pattern(/^https?:\/\/.+$/).required(),
      loginPath: z.string(),
      mePath: z.string(),
      logoutPath: z.string(),
      sessionMapFile: z.string(),
      wechatEnabled: z.boolean(),
      wechatApiUrl: z.string(),
      wechatQrPath: z.string(),
      wechatStatusPath: z.string(),
      wechatLoginPath: z.string(),
      mockEnabled: z.boolean(),
    })
    .required()

  /** Resolved config after construction. */
  readonly config: Required<PluginConfig>

  /** Currently authenticated user, or `undefined` if not logged in. */
  private currentUser: UserInfo | undefined = undefined

  /** sessionId → userId mapping, loaded from disk on init. */
  private sessionMap: SessionUserMapping = {}

  /** Absolute path to the on-disk session map. */
  private sessionMapPath: string

  /** Pending WeChat QR login flows, keyed by flowId. */
  private pendingWeChatLogins: Map<string, PendingWeChatLogin> = new Map()

  /**
   * @param ctx - Cordis context.
   * @param config - plugin configuration.
   */
  constructor(ctx: Context, config: PluginConfig) {
    super(ctx, 'auth')
    this.config = { ...DEFAULT_CONFIG, ...config }
    const mapFileName = this.config.sessionMapFile ?? DEFAULT_CONFIG.sessionMapFile
    this.sessionMapPath = join(expandHomePath(process.env.DSH_HOME ?? '~/.dsh'), mapFileName)
  }

  // ---------------------------------------------------------------------------
  // Public API — core auth
  // ---------------------------------------------------------------------------

  /** Whether a user is currently authenticated. */
  isAuthenticated(): boolean {
    return this.currentUser !== undefined
  }

  /** Returns the current user, or `undefined`. */
  getCurrentUser(): UserInfo | undefined {
    return this.currentUser
  }

  /**
   * Authenticate with the remote API via username/password.
   * @param request - username and password.
   * @returns the authenticated user info.
   * @throws {AuthError} when credentials are invalid.
   */
  async login(request: LoginRequest): Promise<UserInfo> {
    // Mock mode: accept admin/admin without a remote API.
    if (this.config.mockEnabled) {
      if (request.username === 'admin' && request.password === 'admin') {
        const user: UserInfo = { id: 'mock-admin', displayName: 'Admin', token: 'mock-token' }
        this.currentUser = user
        return user
      }
      throw { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' }
    }

    const body = JSON.stringify({ username: request.username, password: request.password })
    const url = this.config.apiUrl + this.config.loginPath
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    if (!response.ok) {
      let error: AuthError
      try {
        error = (await response.json()) as AuthError
      } catch {
        error = {
          code: 'SERVER_ERROR',
          message: `auth API returned ${response.status}`,
        }
      }
      throw error
    }

    const data = (await response.json()) as LoginResponse
    this.currentUser = data.user
    return this.currentUser
  }

  /**
   * Log out the current user. Sessions remain on disk but are no longer
   * attributed to the logged-in identity until the next login.
   */
  logout(): void {
    this.currentUser = undefined
  }

  /**
   * Return the user id that owns a session, if one is recorded.
   */
  getSessionUserId(sessionId: SessionId): string | undefined {
    return this.sessionMap[sessionId]
  }

  /**
   * Return all sessions that belong to the given user id.
   */
  getSessionsForUser(userId: string): SessionId[] {
    return Object.entries(this.sessionMap)
      .filter(([, uid]) => uid === userId)
      .map(([sid]) => sid as SessionId)
  }

  /**
   * Record that `sessionId` belongs to `userId`.
   */
  associateSession(sessionId: SessionId, userId: string): void {
    this.sessionMap[sessionId] = userId
    void this._persistSessionMap()
  }

  /**
   * Remove the session↔user association.
   */
  dissociateSession(sessionId: SessionId): void {
    delete this.sessionMap[sessionId]
    void this._persistSessionMap()
  }

  /**
   * Get the current session-to-user mapping (for debugging / testing).
   */
  getSessionMap(): SessionUserMapping {
    return { ...this.sessionMap }
  }

  // ---------------------------------------------------------------------------
  // Public API — WeChat Enterprise QR
  // ---------------------------------------------------------------------------

  /**
   * Generate (or return cached) a WeChat Enterprise QR code for the given flow.
   * Calls the upstream WeChat API to obtain the QR data.
   * @param flowId - client-generated unique flow identifier.
   * @returns the QR data, or throws on error.
   */
  async getWeChatQr(flowId: string): Promise<WeChatQrData> {
    const url = this.config.wechatApiUrl + this.config.wechatQrPath
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId }),
    })

    if (!response.ok) {
      throw { code: 'SERVER_ERROR', message: `wechat QR API returned ${response.status}` }
    }

    const data = (await response.json()) as { qr: WeChatQrData; ok: boolean }
    if (!data.ok || !data.qr) throw { code: 'SERVER_ERROR', message: 'wechat QR API returned invalid response' }

    const qr = data.qr
    const ttlMs = (qr.ttlSeconds ?? 300) * 1000
    this.pendingWeChatLogins.set(flowId, {
      flowId,
      createdAt: Date.now(),
      ttlMs,
      qr,
      user: undefined,
      status: 'waiting',
    })
    return qr
  }

  /**
   * Poll the status of a WeChat QR login flow.
   * @param flowId - the flow identifier.
   * @returns the current status response.
   */
  getWeChatStatus(flowId: string): WeChatStatusResponse {
    const pending = this.pendingWeChatLogins.get(flowId)
    if (pending === undefined) {
      return { status: 'error', message: 'flow not found' }
    }

    // Check expiry.
    if (Date.now() - pending.createdAt > pending.ttlMs) {
      pending.status = 'expired'
      return { status: 'expired' }
    }

    return {
      status: pending.status,
      message: pending.errorMessage,
      user: pending.user,
    }
  }

  /**
   * Complete a WeChat QR login once the upstream callback signals confirmation.
   * Called internally by the `/api/auth/wechat-login` route.
   * @param flowId - the flow identifier.
   * @param code - auth code from the WeChat callback.
   * @returns the authenticated user info.
   */
  async completeWeChatLogin(flowId: string, code: string): Promise<UserInfo> {
    const pending = this.pendingWeChatLogins.get(flowId)
    if (pending === undefined) {
      throw { code: 'SERVER_ERROR', message: 'flow not found' }
    }

    // Exchange the code for user info via the upstream API.
    const url = this.config.wechatApiUrl + this.config.wechatLoginPath
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId, code }),
    })

    if (!response.ok) {
      pending.status = 'error'
      pending.errorMessage = `wechat login returned ${response.status}`
      throw { code: 'SERVER_ERROR', message: pending.errorMessage }
    }

    const data = (await response.json()) as LoginResponse
    const user = data.user
    pending.user = user
    pending.status = 'confirmed'
    this.currentUser = user
    return user
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _persistSessionMap(): Promise<void> {
    try {
      await writeFile(this.sessionMapPath, JSON.stringify(this.sessionMap, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
      })
    } catch {
      // EEXIST means another process wrote it first — reread instead.
      try {
        const text = await readFile(this.sessionMapPath, 'utf8')
        this.sessionMap = JSON.parse(text) as SessionUserMapping
      } catch {
        // File absent or corrupt: keep in-memory state; retry next write.
      }
    }
  }

  async loadSessionMap(): Promise<void> {
    try {
      const text = await readFile(this.sessionMapPath, 'utf8')
      this.sessionMap = JSON.parse(text) as SessionUserMapping
    } catch {
      this.sessionMap = {}
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin factory: wires the service into the host composition
// ---------------------------------------------------------------------------

/**
 * Host-side plugin body. Registers HTTP routes on the webserver and hooks
 * into session lifecycle events to maintain the user↔session mapping.
 *
 * @param auth - the auth service instance.
 * @param ctx - Cordis host context.
 */
function setupPlugin(auth: Auth, ctx: Context): void {
  void auth.loadSessionMap()
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  // GET /api/auth/me — return current user info (or 401).
  webServer.register({
    kind: 'exact',
    path: '/api/auth/me',
    handler: async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
      res.setHeader('Content-Type', 'application/json')
      if (!auth.isAuthenticated()) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const { token: _t, ...safe } = auth.getCurrentUser()!
      res.writeHead(200)
      res.end(JSON.stringify(safe))
    },
  })

  // POST /api/auth/login — proxy username/password to remote API.
  webServer.register({
    kind: 'exact',
    path: '/api/auth/login',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      res.setHeader('Content-Type', 'application/json')
      let body: string
      try {
        body = await new Promise<string>((resolve, reject) => {
          let chunks = ''
          req.on('data', (chunk: Buffer) => { chunks += chunk.toString() })
          req.on('end', () => resolve(chunks))
          req.on('error', reject)
        })
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ code: 'SERVER_ERROR', message: 'invalid request body' }))
        return
      }
      let parsed: LoginRequest
      try {
        parsed = JSON.parse(body) as LoginRequest
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ code: 'SERVER_ERROR', message: 'malformed JSON' }))
        return
      }
      try {
        const user = await auth.login(parsed)
        res.writeHead(200)
        res.end(JSON.stringify({ user }))
      } catch (err) {
        const error = err as AuthError
        const status = error.code === 'INVALID_CREDENTIALS' ? 401 : 500
        res.writeHead(status)
        res.end(JSON.stringify(error))
      }
    },
  })

  // POST /api/auth/logout — clear current session.
  webServer.register({
    kind: 'exact',
    path: '/api/auth/logout',
    handler: async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
      auth.logout()
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true }))
    },
  })

  // POST /api/auth/wechat-qr — generate a WeChat Enterprise QR login flow.
  webServer.register({
    kind: 'exact',
    path: '/api/auth/wechat-qr',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      res.setHeader('Content-Type', 'application/json')
      let body: string
      try {
        body = await new Promise<string>((resolve, reject) => {
          let chunks = ''
          req.on('data', (chunk: Buffer) => { chunks += chunk.toString() })
          req.on('end', () => resolve(chunks))
          req.on('error', reject)
        })
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ ok: false, error: 'invalid body' }))
        return
      }
      let parsed: WeChatQrRequest
      try {
        parsed = JSON.parse(body) as WeChatQrRequest
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ ok: false, error: 'malformed JSON' }))
        return
      }
      try {
        const qr = await auth.getWeChatQr(parsed.flowId)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, qr }))
      } catch (err) {
        const error = err as { code: string; message: string }
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, error: error.message }))
      }
    },
  })

  // GET /api/auth/wechat-status?flowId=xxx — poll WeChat QR login status.
  webServer.register({
    kind: 'exact',
    path: '/api/auth/wechat-status',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      res.setHeader('Content-Type', 'application/json')
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const flowId = url.searchParams.get('flowId')
      if (!flowId) {
        res.writeHead(400)
        res.end(JSON.stringify({ status: 'error', message: 'flowId is required' }))
        return
      }
      const status = auth.getWeChatStatus(flowId)
      res.writeHead(200)
      res.end(JSON.stringify(status))
    },
  })

  // POST /api/auth/wechat-login — exchange WeChat code for a session.
  webServer.register({
    kind: 'exact',
    path: '/api/auth/wechat-login',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      res.setHeader('Content-Type', 'application/json')
      let body: string
      try {
        body = await new Promise<string>((resolve, reject) => {
          let chunks = ''
          req.on('data', (chunk: Buffer) => { chunks += chunk.toString() })
          req.on('end', () => resolve(chunks))
          req.on('error', reject)
        })
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ ok: false, error: 'invalid body' }))
        return
      }
      let parsed: { flowId: string; code: string }
      try {
        parsed = JSON.parse(body) as { flowId: string; code: string }
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ ok: false, error: 'malformed JSON' }))
        return
      }
      try {
        const user = await auth.completeWeChatLogin(parsed.flowId, parsed.code)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, user }))
      } catch (err) {
        const error = err as { code: string; message: string }
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, error: error.message }))
      }
    },
  })

  // Session lifecycle: auto-associate sessions with the current user.
  ctx.on('session/created', (session: { id: SessionId }): void => {
    if (auth.isAuthenticated()) {
      auth.associateSession(session.id, auth.getCurrentUser()!.id)
    }
  })

  ctx.on('session/disposed', (session: { id: SessionId }): void => {
    auth.dissociateSession(session.id)
  })
}

// ---------------------------------------------------------------------------
// Plugin descriptor (exported as default for Cordis loader)
// ---------------------------------------------------------------------------

/** Plugin name registered with Cordis. */
export const name = 'dsh-oauth-host'

/** Services required before this plugin can activate. */
export const inject = ['webServer']

/** Plugin config schema (re-exported for cordis.yml `config` validation). */
export const Config = Auth.Config

/**
 * Plugin apply function. Constructs the Auth service, registers routes,
 * and hooks into session lifecycle events.
 * @param ctx - Cordis host context.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const auth = new Auth(ctx, config)
  ctx.effect(() => {
    return (): void => { /* cleanup if needed */ }
  }, 'auth-service')
  setupPlugin(auth, ctx)
}
