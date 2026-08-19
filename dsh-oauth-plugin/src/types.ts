/**
 * Shared type definitions for the dsh-oauth-plugin.
 * @module dsh-oauth-plugin/types
 */

/** A signed-in user identity. */
export interface UserInfo {
  /** Stable user identifier. */
  readonly id: string
  /** Display name or email. */
  readonly displayName: string
  /** Auth token returned by the remote API. */
  readonly token: string
}

/** Request body for the username/password login endpoint. */
export interface LoginRequest {
  /** Username or email. */
  username: string
  /** Password. */
  password: string
}

/** Response body for a successful login. */
export interface LoginResponse {
  /** The authenticated user info. */
  user: UserInfo
  /** Optional expiration in seconds; null means no expiry. */
  expiresIn: number | null
}

/** Error response from the auth API. */
export interface AuthError {
  /** Machine-readable error code. */
  code: 'INVALID_CREDENTIALS' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'SERVER_ERROR'
  /** Human-readable message. */
  message: string
}

/**
 * Session↔user mapping persisted on disk.
 * Keyed by sessionId → userId.
 */
export interface SessionUserMapping {
  /** sessionId → userId */
  [sessionId: string]: string
}

/**
 * Plugin configuration.
 */
export interface Config {
  /**
   * Base URL of the auth API. Examples:
   * - `http://localhost:3000/api/auth`
   * - `https://auth.example.com`
   */
  apiUrl: string
  /**
   * Path appended to apiUrl for the login endpoint.
   * Default: `/login`
   */
  loginPath?: string
  /**
   * Path appended to apiUrl for the verify/me endpoint.
   * Default: `/me`
   */
  mePath?: string
  /**
   * Path appended to apiUrl for the logout endpoint.
   * Default: `/logout`
   */
  logoutPath?: string
  /**
   * File inside $DSH_HOME to persist session↔user mappings.
   * Default: `.oauth-sessions.json`
   */
  sessionMapFile?: string
  /**
   * Whether to enable the WeChat Enterprise QR login tab.
   * Default: `false`
   */
  wechatEnabled?: boolean
  /**
   * Whether to enable mock mode: admin/admin logs in without a remote API.
   * When true, apiUrl is unused for login and `/api/auth/me` returns a fixed user.
   * Default: `false`
   */
  mockEnabled?: boolean
  /**
   * Base URL of the WeChat Enterprise auth API (e.g. `https://open.weixin.qq.com/connect/quc`).
   * Required when `wechatEnabled` is true.
   */
  wechatApiUrl?: string
  /**
   * Path for WeChat QR generation.
   * Default: `/wechat/qr`
   */
  wechatQrPath?: string
  /**
   * Path for WeChat QR status polling.
   * Default: `/wechat/status`
   */
  wechatStatusPath?: string
  /**
   * Path for WeChat login callback (exchanging code for user info).
   * Default: `/wechat/login`
   */
  wechatLoginPath?: string
}

export const DEFAULT_CONFIG: Required<Omit<Config, 'apiUrl'>> = {
  loginPath: '/login',
  mePath: '/me',
  logoutPath: '/logout',
  sessionMapFile: '.oauth-sessions.json',
  wechatEnabled: false,
  mockEnabled: false,
  wechatApiUrl: '',
  wechatQrPath: '/wechat/qr',
  wechatStatusPath: '/wechat/status',
  wechatLoginPath: '/wechat/login',
}

/** QR code data returned by the WeChat auth API. */
export interface WeChatQrData {
  /** Unique flow id for this QR session. */
  flowId: string
  /** QR code image URL (base64 data URI or remote URL). */
  qrUrl: string
  /** QR code raw content (e.g. wxquota://… URL to render as QR). */
  qrContent: string
  /** Timeout in seconds after which the QR expires. */
  ttlSeconds: number
}

/** Request body for generating a WeChat QR code. */
export interface WeChatQrRequest {
  /** Client-generated unique flow id (UUID v4 recommended). */
  flowId: string
}

/** Response body for the WeChat QR generation endpoint. */
export interface WeChatQrResponse {
  /** The QR code data. */
  qr: WeChatQrData
  /** Whether the request was accepted. */
  ok: boolean
}

/** Polling status response for a WeChat QR login session. */
export interface WeChatStatusResponse {
  /** Current status: `'waiting'` | `'scanned'` | `'confirmed'` | `'expired'` | `'error'`. */
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'
  /** Error message, if status is `'error'`. */
  message?: string
  /** User info, once status reaches `'confirmed'`. */
  user?: UserInfo
}
