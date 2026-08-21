/**
 * Host plugin: provides the `auth` service, registers HTTP routes on the
 * webserver, and tracks which sessions belong to which authenticated user.
 *
 * Supports two login modes:
 * - **Username/password** — POST /api/auth/login proxies to the remote API.
 * - **WeChat Website App scan login** — the client embeds the official
 *   wxLogin.js QR; WeChat redirects to /api/auth/wechat/callback with a
 *   `code`; the host exchanges it for a session.
 *
 * Session isolation is achieved by recording a `sessionId → userId` mapping
 * whenever a session is created while a user is authenticated.
 *
 * @module dsh-oauth-plugin
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync, unlinkSync } from 'node:fs'
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
  type WeChatCallbackQuery,
  type WeChatConfigResponse,
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
// Pending WeChat OAuth states (in-memory only)
// ---------------------------------------------------------------------------

interface PendingWeChatState {
  /** Timestamp (ms) when the state was issued. */
  createdAt: number
  /** TTL in ms. */
  ttlMs: number
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
      wechatAppId: z.string(),
      wechatAppSecret: z.string(),
      wechatRedirectUri: z.string(),
      wechatStateTtlMs: z.number(),
      wechatFastLogin: z.boolean(),
      mockEnabled: z.boolean(),
    })
    .required()

  /** Resolved config after construction. */
  readonly config: Required<PluginConfig>

  /** Currently authenticated user, or `undefined` if not logged in. */
  private currentUser: UserInfo | undefined = undefined

  /** sessionId → userId mapping, loaded from disk on init. */
  private sessionMap: SessionUserMapping = {}

  /** workspaceId → userId mapping, loaded from disk on init. */
  private workspaceMap: Record<string, string> = {}

  /** Absolute path to the on-disk session map. */
  private sessionMapPath: string

  /** Absolute path to the on-disk workspace map. */
  private workspaceMapPath: string

  /** Path to the persisted current-user JSON file (id + displayName, no token). */
  private currentUserPath: string

  /** Pending WeChat OAuth states, keyed by the single-use `state`. */
  private pendingWeChatStates: Map<string, PendingWeChatState> = new Map()

  /**
   * @param ctx - Cordis context.
   * @param config - plugin configuration.
   */
  constructor(ctx: Context, config: PluginConfig) {
    super(ctx, 'auth')
    this.config = { ...DEFAULT_CONFIG, ...config }
    const mapFileName = this.config.sessionMapFile ?? DEFAULT_CONFIG.sessionMapFile
    this.sessionMapPath = join(expandHomePath(process.env.DSH_HOME ?? '~/.dsh'), mapFileName)
    this.workspaceMapPath = join(expandHomePath(process.env.DSH_HOME ?? '~/.dsh'), '.oauth-workspaces.json')
    this.currentUserPath = join(expandHomePath(process.env.DSH_HOME ?? '~/.dsh'), 'oauth-user.json')
    void this._loadUserState()
    void this.loadWorkspaceMap()
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
      // Mock admin
      if (request.username === 'admin' && request.password === 'admin') {
        const user: UserInfo = { id: 'mock-admin', displayName: 'Admin', token: 'mock-token' }
        this._setCurrentUser(user)
        return user
      }
      // Mock dennis
      if (request.username === 'dennis' && request.password === 'dennis') {
        const user: UserInfo = { id: 'mock-dennis', displayName: 'Dennis', token: 'mock-token' }
        this._setCurrentUser(user)
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
    this._setCurrentUser(data.user)
    return this.currentUser
  }

  /**
   * Log out the current user. Sessions remain on disk but are no longer
   * attributed to the logged-in identity until the next login.
   */
  logout(): void {
    this._setCurrentUser(undefined)
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
  // Workspace ownership
  // ---------------------------------------------------------------------------

  /** Returns all workspace IDs owned by `userId`. */
  getWorkspacesForUser(userId: string): string[] {
    return Object.entries(this.workspaceMap)
      .filter(([, uid]) => uid === userId)
      .map(([wid]) => wid)
  }

  /** Returns whether `workspaceId` is owned by `userId`. */
  hasWorkspace(workspaceId: string, userId: string): boolean {
    return this.workspaceMap[workspaceId] === userId
  }

  /** Associate `workspaceId` with `userId` and persist. */
  associateWorkspace(workspaceId: string, userId: string): void {
    this.workspaceMap[workspaceId] = userId
    void this._persistWorkspaceMap()
  }

  private async _persistWorkspaceMap(): Promise<void> {
    try {
      // Plain overwrite: the in-memory map is authoritative and every change
      // must replace the previous contents (a first-write-wins flag would
      // freeze the file after the first association). This plugin owns
      // $DSH_HOME state files under the single-process assumption in README.
      await writeFile(this.workspaceMapPath, JSON.stringify(this.workspaceMap, null, 2), 'utf8')
    } catch {
      // A write failure keeps the in-memory map authoritative; the next
      // association retries the write.
    }
  }

  async loadWorkspaceMap(): Promise<void> {
    try {
      const text = await readFile(this.workspaceMapPath, 'utf8')
      this.workspaceMap = JSON.parse(text) as Record<string, string>
    } catch {
      this.workspaceMap = {}
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — WeChat Website App scan login
  // ---------------------------------------------------------------------------

  /**
   * Bootstrap a WeChat login session: mint a single-use CSRF `state` and
   * return the client-safe parameters for wxLogin.js.
   * @returns the WeChat config, or `enabled: false` when not configured.
   */
  getWeChatConfig(): WeChatConfigResponse {
    if (!this.config.wechatEnabled) {
      return { enabled: false, appId: '', redirectUri: '', state: '', scope: 'snsapi_login', fastLogin: true }
    }
    const state = randomUUID()
    this.pendingWeChatStates.set(state, {
      createdAt: Date.now(),
      ttlMs: this.config.wechatStateTtlMs,
    })
    return {
      enabled: true,
      appId: this.config.wechatAppId,
      redirectUri: this.config.wechatRedirectUri,
      state,
      scope: 'snsapi_login',
      fastLogin: this.config.wechatFastLogin ?? true,
    }
  }

  /**
   * Complete a WeChat Website App login from the OAuth callback.
   * Validates the single-use `state` (CSRF guard), exchanges the `code`
   * for an access token, fetches the user profile, and signs the user in.
   * @param query - the callback query (`code` and `state`).
   * @returns the authenticated user info.
   * @throws {AuthError} on invalid state or upstream failure.
   */
  async completeWeChatLogin(query: WeChatCallbackQuery): Promise<UserInfo> {
    const pending = this.pendingWeChatStates.get(query.state)
    if (pending === undefined) {
      throw { code: 'UNAUTHORIZED', message: 'invalid wechat state' }
    }
    this.pendingWeChatStates.delete(query.state) // single-use: never replayable
    if (Date.now() - pending.createdAt > pending.ttlMs) {
      throw { code: 'UNAUTHORIZED', message: 'wechat state expired' }
    }

    const tokenRes = await fetch(
      'https://api.weixin.qq.com/sns/oauth2/access_token'
      + `?appid=${encodeURIComponent(this.config.wechatAppId)}`
      + `&secret=${encodeURIComponent(this.config.wechatAppSecret)}`
      + `&code=${encodeURIComponent(query.code)}`
      + '&grant_type=authorization_code',
    )
    if (!tokenRes.ok) {
      throw { code: 'SERVER_ERROR', message: `wechat access_token API returned ${tokenRes.status}` }
    }
    const tokenData = (await tokenRes.json()) as {
      access_token?: string
      openid?: string
      unionid?: string
      errcode?: number
      errmsg?: string
    }
    if (tokenData.errcode || !tokenData.access_token || !tokenData.openid) {
      throw { code: 'UNAUTHORIZED', message: tokenData.errmsg ?? 'wechat code exchange failed' }
    }

    const infoRes = await fetch(
      'https://api.weixin.qq.com/sns/userinfo'
      + `?access_token=${encodeURIComponent(tokenData.access_token)}`
      + `&openid=${encodeURIComponent(tokenData.openid)}`,
    )
    if (!infoRes.ok) {
      throw { code: 'SERVER_ERROR', message: `wechat userinfo API returned ${infoRes.status}` }
    }
    const infoData = (await infoRes.json()) as {
      openid?: string
      unionid?: string
      nickname?: string
      headimgurl?: string
      errcode?: number
      errmsg?: string
    }
    if (infoData.errcode || !infoData.openid) {
      throw { code: 'UNAUTHORIZED', message: infoData.errmsg ?? 'wechat userinfo failed' }
    }

    const user: UserInfo = {
      id: infoData.unionid ?? infoData.openid,
      displayName: infoData.nickname ?? infoData.openid,
      token: tokenData.access_token,
    }
    this._setCurrentUser(user)
    return user
  }

  // ---------------------------------------------------------------------------
  // User persistence — survives server restart so the client skips the login overlay
  // ---------------------------------------------------------------------------

  private _loadUserState(): void {
    try {
      const text = readFileSync(this.currentUserPath, 'utf8')
      const saved = JSON.parse(text) as { id: string; displayName: string }
      this.currentUser = { id: saved.id, displayName: saved.displayName, token: '' }
    } catch {
      // Corrupt or missing file — start clean.
    }
  }

  private _saveUserState(): void {
    if (this.currentUser === undefined) return
    const safe: { id: string; displayName: string } = {
      id: this.currentUser.id,
      displayName: this.currentUser.displayName,
    }
    try {
      // Plain overwrite: the persisted user must reflect the most recent
      // login, so a user switch replaces the previous user on disk (a
      // first-write-wins flag would restore the stale user after restart).
      writeFile(this.currentUserPath, JSON.stringify(safe), 'utf8')
    } catch {
      // A write failure leaves the previous user on disk; the in-memory
      // current user stays authoritative and the next login retries.
    }
  }

  /** Set the current user and persist to disk (or clear the file on logout). */
  private _setCurrentUser(user: UserInfo | undefined): void {
    this.currentUser = user
    if (user === undefined) {
      try { unlinkSync(this.currentUserPath) } catch { /* absent is fine */ }
    } else {
      this._saveUserState()
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _persistSessionMap(): Promise<void> {
    try {
      // Plain overwrite: the in-memory map is authoritative and every change
      // must replace the previous contents (a first-write-wins flag would
      // freeze the file after the first association). This plugin owns
      // $DSH_HOME state files under the single-process assumption in README.
      await writeFile(this.sessionMapPath, JSON.stringify(this.sessionMap, null, 2), 'utf8')
    } catch {
      // A write failure keeps the in-memory map authoritative; the next
      // association retries the write.
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

  // GET /api/auth/wechat/config — bootstrap a WeChat scan-login session.
  webServer.register({
    kind: 'exact',
    path: '/api/auth/wechat/config',
    handler: async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
      res.setHeader('Content-Type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify(auth.getWeChatConfig()))
    },
  })

  // GET /api/auth/wechat/callback — WeChat OAuth callback (code + state).
  // Runs inside the wxLogin.js iframe, so it answers with an HTML page that
  // reports the result to the parent via postMessage.
  webServer.register({
    kind: 'exact',
    path: '/api/auth/wechat/callback',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const query: WeChatCallbackQuery = {
        code: url.searchParams.get('code') ?? '',
        state: url.searchParams.get('state') ?? '',
      }
      if (!query.code || !query.state) {
        res.writeHead(400)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end('<html><body><h1>微信登录失败</h1><p>缺少 code 或 state 参数</p></body></html>')
        return
      }
      try {
        const user = await auth.completeWeChatLogin(query)
        const safe = { id: user.id, displayName: user.displayName }
        const payload = JSON.stringify({ type: 'dsh-wechat-login', user: safe })
        res.writeHead(200)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(`<!DOCTYPE html><html><body>
<script>window.parent.postMessage(${payload}, '*')</script>
<h1>微信登录成功</h1><p>欢迎，${safe.displayName}。本窗口可关闭。</p>
</body></html>`)
      } catch (err) {
        const error = err as AuthError
        const payload = JSON.stringify({ type: 'dsh-wechat-login', error: error.message })
        res.writeHead(200)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(`<!DOCTYPE html><html><body>
<script>window.parent.postMessage(${payload}, '*')</script>
<h1>微信登录失败</h1><p>${error.message}</p>
</body></html>`)
      }
    },
  })

  // GET /api/auth/sessions — return session IDs owned by the current user.
  webServer.register({
    kind: 'exact',
    path: '/api/auth/sessions',
    handler: async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
      res.setHeader('Content-Type', 'application/json')
      if (!auth.isAuthenticated()) {
        res.writeHead(401)
        res.end(JSON.stringify({ sessions: [] }))
        return
      }
      const sessions = auth.getSessionsForUser(auth.getCurrentUser()!.id)
      res.writeHead(200)
      res.end(JSON.stringify({ sessions }))
    },
  })

  // GET /api/auth/workspaces — return workspace IDs owned by the current user.
  webServer.register({
    kind: 'exact',
    path: '/api/auth/workspaces',
    handler: async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
      res.setHeader('Content-Type', 'application/json')
      if (!auth.isAuthenticated()) {
        res.writeHead(401)
        res.end(JSON.stringify({ workspaces: [] }))
        return
      }
      const workspaces = auth.getWorkspacesForUser(auth.getCurrentUser()!.id)
      res.writeHead(200)
      res.end(JSON.stringify({ workspaces }))
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

  // Intercept the wire API to enforce per-user isolation. Exact routes
  // override the built-in handlers, so the filter runs instead of them.
  /** Wire subset of the ApiProxy `workspace`/`session` domains these
   *  interceptors call. Declared locally because the plugin is standalone
   *  and does not depend on @deepseek-ai/dsh-host-apiproxy; mirrors the
   *  WorkspaceApi and SessionsApi RpcResponse shapes. */
  interface ApiProxyWire {
    workspace: {
      list(request: { rpcId: string; payload: Record<string, unknown> }): Promise<{
        rpcId: string
        result:
          | { ok: true; value: { items: Array<{ workspaceId: string; sessionIds?: string[] }> } }
          | { ok: false; error: { code: string; message: string } }
      }>
      create(request: { rpcId: string; payload: Record<string, unknown> }): Promise<{
        rpcId: string
        result:
          | { ok: true; value: { workspace: { workspaceId: string } } }
          | { ok: false; error: { code: string; message: string } }
      }>
    }
    sessions: {
      list(request: { rpcId: string; payload: Record<string, unknown> }): Promise<{
        rpcId: string
        result:
          | { ok: true; value: { items: Array<{ sessionId: string }> } }
          | { ok: false; error: { code: string; message: string } }
      }>
      history(request: { rpcId: string; payload: Record<string, unknown> }): Promise<{
        rpcId: string
        result: { ok: boolean }
      }>
    }
  }

  /** Reads and parses a JSON-RPC request body shared by the interceptors.
   *  Returns `undefined` on malformed input; the caller answers 400. */
  function readRpcBody(req: IncomingMessage): Promise<{ rpcId: string; payload: Record<string, unknown> } | undefined> {
    return new Promise((resolve) => {
      let chunks = ''
      req.on('data', (chunk: Buffer) => { chunks += chunk.toString() })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(chunks) as { rpcId?: unknown; payload?: unknown }
          if (typeof parsed.rpcId !== 'string') {
            resolve(undefined)
            return
          }
          const payload = parsed.payload
          resolve({
            rpcId: parsed.rpcId,
            payload: payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {},
          })
        } catch {
          resolve(undefined)
        }
      })
      req.on('error', () => resolve(undefined))
    })
  }

  ctx.inject(['apiProxy'], (apiCtx) => {
    const apiProxy = apiCtx.get('apiProxy')
    if (apiProxy === undefined) return
    const injectedWebServer = apiCtx.get('webServer')
    if (injectedWebServer === undefined) return
    apiCtx.effect(() => injectedWebServer.register({
      kind: 'exact',
      path: '/api/workspace.list',
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        res.setHeader('Content-Type', 'application/json')
        const parsed = await readRpcBody(req)
        if (parsed === undefined) {
          res.writeHead(400)
          res.end(JSON.stringify({ type: 'server-response', rpcId: 'invalid', result: { ok: false, error: { code: 'bad-request', message: 'invalid request body' } } }))
          return
        }
        const rpcResponse = await (apiProxy as ApiProxyWire).workspace.list({ rpcId: parsed.rpcId, payload: parsed.payload })
        if (rpcResponse.result.ok) {
          const value = rpcResponse.result.value
          if (auth.isAuthenticated()) {
            const userId = auth.getCurrentUser()!.id
            const ownedWids = new Set(auth.getWorkspacesForUser(userId))
            const ownedSessions = new Set<string>(auth.getSessionsForUser(userId))
            // A workspace stays visible when the user owns it outright, or
            // when it holds at least one session the user owns (a fresh
            // user's default workspace is never associated until a session
            // lands in it). Retained items keep only the user's own session
            // ids, so a shared workspace shows only the user's sessions.
            value.items = value.items.filter((item) => {
              if (ownedWids.has(item.workspaceId)) return true
              const ownedHere = (item.sessionIds ?? []).filter((sid) => ownedSessions.has(sid))
              if (ownedHere.length > 0) {
                item.sessionIds = ownedHere
                return true
              }
              return false
            })
          } else {
            // Unauthenticated callers own nothing and see no workspaces.
            value.items = []
          }
        }
        res.writeHead(200)
        res.end(JSON.stringify({ type: 'server-response', ...rpcResponse }))
      },
    }), 'oauth: /api/workspace.list interception')

    // Associate a newly created workspace with the current user. Runs on
    // every successful create — picking an already-existing directory
    // returns that workspace (created: false) and still associates it, so a
    // directory shared between users is owned by each of them.
    apiCtx.effect(() => injectedWebServer.register({
      kind: 'exact',
      path: '/api/workspace.create',
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        res.setHeader('Content-Type', 'application/json')
        const parsed = await readRpcBody(req)
        if (parsed === undefined) {
          res.writeHead(400)
          res.end(JSON.stringify({ type: 'server-response', rpcId: 'invalid', result: { ok: false, error: { code: 'bad-request', message: 'invalid request body' } } }))
          return
        }
        const rpcResponse = await (apiProxy as ApiProxyWire).workspace.create({ rpcId: parsed.rpcId, payload: parsed.payload })
        if (rpcResponse.result.ok && auth.isAuthenticated()) {
          auth.associateWorkspace(rpcResponse.result.value.workspace.workspaceId, auth.getCurrentUser()!.id)
        }
        res.writeHead(200)
        res.end(JSON.stringify({ type: 'server-response', ...rpcResponse }))
      },
    }), 'oauth: /api/workspace.create interception')

    // Enforce session isolation server-side. The session-search route
    // revalidates its hits against this list, so filtering here also
    // isolates search results.
    apiCtx.effect(() => injectedWebServer.register({
      kind: 'exact',
      path: '/api/session.list',
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        res.setHeader('Content-Type', 'application/json')
        const parsed = await readRpcBody(req)
        if (parsed === undefined) {
          res.writeHead(400)
          res.end(JSON.stringify({ type: 'server-response', rpcId: 'invalid', result: { ok: false, error: { code: 'bad-request', message: 'invalid request body' } } }))
          return
        }
        const rpcResponse = await (apiProxy as ApiProxyWire).sessions.list({ rpcId: parsed.rpcId, payload: parsed.payload })
        if (rpcResponse.result.ok) {
          const value = rpcResponse.result.value
          if (auth.isAuthenticated()) {
            const owned = new Set<string>(auth.getSessionsForUser(auth.getCurrentUser()!.id))
            value.items = value.items.filter((item) => owned.has(item.sessionId))
          } else {
            value.items = []
          }
        }
        res.writeHead(200)
        res.end(JSON.stringify({ type: 'server-response', ...rpcResponse }))
      },
    }), 'oauth: /api/session.list interception')

    // Guard session.history reads by ownership. A request for a session the
    // current user does not own answers exactly like a missing session, so
    // existence never leaks; unauthenticated callers own nothing and are
    // denied the same way. Payloads without a sessionId are forwarded, so a
    // future payload change cannot lock callers out.
    apiCtx.effect(() => injectedWebServer.register({
      kind: 'exact',
      path: '/api/session.history',
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        res.setHeader('Content-Type', 'application/json')
        const parsed = await readRpcBody(req)
        if (parsed === undefined) {
          res.writeHead(400)
          res.end(JSON.stringify({ type: 'server-response', rpcId: 'invalid', result: { ok: false, error: { code: 'bad-request', message: 'invalid request body' } } }))
          return
        }
        const sessionId = parsed.payload.sessionId
        if (typeof sessionId === 'string') {
          const owned = auth.isAuthenticated() && new Set<string>(auth.getSessionsForUser(auth.getCurrentUser()!.id)).has(sessionId)
          if (!owned) {
            res.writeHead(200)
            res.end(JSON.stringify({
              type: 'server-response',
              rpcId: parsed.rpcId,
              result: { ok: false, error: { code: 'session-not-found', message: 'Session not found', details: { sessionId } } },
            }))
            return
          }
        }
        const rpcResponse = await (apiProxy as ApiProxyWire).sessions.history({ rpcId: parsed.rpcId, payload: parsed.payload })
        res.writeHead(200)
        res.end(JSON.stringify({ type: 'server-response', ...rpcResponse }))
      },
    }), 'oauth: /api/session.history interception')
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
