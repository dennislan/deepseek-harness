/**
 * Client plugin: login overlay rendered into document.body.
 *
 * Premium split-screen login experience with two modes:
 *  - **Password** — username/password form → POST /api/auth/login
 *  - **WeChat Website App scan login** — official OAuth2 flow: the client loads
 *    wxLogin.js from res.wx.qq.com, gets a one-time state from the server, and
 *    shows WeChat's official QR iframe; the callback page (running inside the
 *    iframe) reports the result to the parent via postMessage.
 *
 * Mode is toggled by a WeChat / Account icon in the top-right corner of the
 * form panel. The left panel carries the brand identity with an animated mesh.
 *
 * @module dsh-oauth-plugin/client
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthState {
  user: { id: string; displayName: string } | null
  loading: boolean
  error: string | null
  mode: 'password' | 'wechat'
  wechatReady: boolean
  wechatError: string | null
}

export interface AuthStore {
  readonly snapshot: AuthState
  subscribe(listener: () => void): () => void
  setState(next: Partial<AuthState>): void
}

function createAuthStore(): AuthStore {
  let state: AuthState = {
    user: null,
    loading: false,
    error: null,
    mode: 'password',
    wechatReady: false,
    wechatError: null,
  }
  const listeners = new Set<() => void>()

  return {
    get snapshot() { return state },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setState(next: Partial<AuthState>): void {
      state = { ...state, ...next }
      for (const fn of [...listeners]) fn()
    },
  }
}

// ─── Icons (SVG path strings) ─────────────────────────────────────────────────

/** WeChat bubble icon — shown when password mode is active (click to switch to WeChat). */
const ICON_WECHAT = [
  'M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.9-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05a6.127 6.127 0 0 1-.253-1.735c0-3.723 3.381-6.746 7.554-6.746.24 0 .471.015.7.04C16.543 4.988 12.988 2.188 8.691 2.188zm-2.6 4.408c.56 0 1.016.455 1.016 1.016 0 .56-.455 1.016-1.016 1.016-.56 0-1.016-.455-1.016-1.016 0-.56.456-1.016 1.016-1.016zm5.22 0c.56 0 1.016.455 1.016 1.016 0 .56-.456 1.016-1.016 1.016-.56 0-1.016-.455-1.016-1.016 0-.56.455-1.016 1.016-1.016zM16.33 7.27c-3.793 0-6.87 2.688-6.87 6.004 0 3.315 3.077 6.004 6.87 6.004a8.29 8.29 0 0 0 2.186-.292.707.707 0 0 1 .587.08l1.403.823a.25.25 0 0 0 .128.041.227.227 0 0 0 .222-.226c0-.056-.022-.11-.036-.166l-.288-1.092a.444.444 0 0 1 .16-.499C21.976 16.55 22.74 14.793 22.74 12.93v-.002c0-3.315-3.076-6.004-6.87-6.004h.46zm-2.45 3.393c.466 0 .844.378.844.844s-.378.844-.844.844-.844-.378-.844-.844.378-.844.844-.844zm4.896 0c.466 0 .844.378.844.844s-.378.844-.844.844-.844-.378-.844-.844.378-.844.844-.844z',
].join(' ')

/** Account icon — shown when WeChat mode is active (click to switch back). */
const ICON_ACCOUNT = [
  'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z',
].join(' ')

/** Eye open icon — password visible */
const ICON_EYE_OPEN = [
  'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z',
  'M12 12a3 3 0 100-6 3 3 0 000 6z',
].join(' ')

/** Eye closed icon — password hidden */
const ICON_EYE_CLOSED = [
  'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z',
  'M12 12a3 3 0 100-6 3 3 0 000 6z',
  'M1 1l22 22',
].join(' ')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadWxLogin(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).WxLogin) { resolve(); return }
    const script = document.createElement('script')
    script.src = 'https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load wxLogin.js'))
    document.head.appendChild(script)
  })
}

// ─── Apply ────────────────────────────────────────────────────────────────────

export function apply(_ctx: unknown): void {
  const store = createAuthStore()
  let overlay: HTMLElement | null = null

  // ── Fetch interception: filter session.list by current user ──────────────
  // The harness does not expose per-user session filtering, so the client
  // shadows the global fetch to strip other users' sessions from the list.
  const __dsh_oauth_original_fetch = typeof window !== 'undefined' ? (window as any).fetch : undefined
  if (__dsh_oauth_original_fetch && typeof __dsh_oauth_original_fetch === 'function') {
    ; (window as any).fetch = async function dshOauthFetch(input: any, init?: any): Promise<Response> {
      const response = await __dsh_oauth_original_fetch(input, init)
      const url = typeof input === 'string' ? input : input?.url ?? ''
      if (!url.includes('/api/session.list')) return response
      if (!response.ok) return response
      const ct = response.headers.get('content-type') ?? ''
      if (!ct.includes('application/json')) return response
      const text = await response.text()
      let parsed: { type: string; result: { ok: boolean; value?: { items: { sessionId: string }[] } } }
      try { parsed = JSON.parse(text) as any } catch { return new Response(text, response) }
      if (!parsed?.result?.ok) return new Response(text, response)
      const owned = new Set<string>()
      try {
        const meRes = await __dsh_oauth_original_fetch('/api/auth/sessions')
        if (meRes.ok) {
          const meData = await meRes.json() as { sessions: string[] }
          for (const sid of meData.sessions ?? []) owned.add(sid)
        }
      } catch { /* ignore */ }
      if (owned.size === 0) {
        const empty = { ...parsed, result: { ...parsed.result, value: { ...(parsed.result.value ?? {}), items: [] } } }
        return new Response(JSON.stringify(empty), {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers({ ...Object.fromEntries(response.headers.entries()), 'content-length': String(new TextEncoder().encode(JSON.stringify(empty)).length) }),
        })
      }
      const value = parsed.result.value as { items: { sessionId: string }[] }
      value.items = (value.items ?? []).filter(item => owned.has(item.sessionId))
      const filtered = JSON.stringify(parsed)
      return new Response(filtered, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers({ ...Object.fromEntries(response.headers.entries()), 'content-length': String(new TextEncoder().encode(filtered).length) }),
      })
    } as typeof fetch
  }

  // ── Workspace interception: filter workspace.list by current user ────────
  // Mirrors the server-side filter: a workspace stays when the current user
  // owns it outright, or when it holds at least one session the user owns
  // (the fresh-user default workspace case); retained items keep only the
  // user's own session ids, so a shared workspace shows only the user's
  // sessions. Unauthenticated callers own nothing and get an empty list.
  const __dsh_oauth_original_fetch_ws = typeof window !== 'undefined' ? (window as any).fetch : undefined
  if (__dsh_oauth_original_fetch_ws && typeof __dsh_oauth_original_fetch_ws === 'function') {
    ; (window as any).fetch = async function dshOauthFetchWs(input: any, init?: any): Promise<Response> {
      const response = await __dsh_oauth_original_fetch_ws(input, init)
      const url = typeof input === 'string' ? input : input?.url ?? ''
      if (!url.includes('/api/workspace.list')) return response
      if (!response.ok) return response
      const ct = response.headers.get('content-type') ?? ''
      if (!ct.includes('application/json')) return response
      const text = await response.text()
      let parsed: { type: string; result: { ok: boolean; value?: { items: Array<Record<string, unknown>>; archivedSessionIds: string[] } } }
      try { parsed = JSON.parse(text) as any } catch { return new Response(text, response) }
      if (!parsed?.result?.ok) return new Response(text, response)
      const ownedWids = new Set<string>()
      const ownedSessions = new Set<string>()
      try {
        const [wsRes, sesRes] = await Promise.all([
          __dsh_oauth_original_fetch_ws('/api/auth/workspaces'),
          __dsh_oauth_original_fetch_ws('/api/auth/sessions'),
        ])
        if (wsRes.ok) {
          const wsData = await wsRes.json() as { workspaces: string[] }
          for (const wid of wsData.workspaces ?? []) ownedWids.add(wid)
        }
        if (sesRes.ok) {
          const sesData = await sesRes.json() as { sessions: string[] }
          for (const sid of sesData.sessions ?? []) ownedSessions.add(sid)
        }
      } catch { /* ignore */ }
      const value = parsed.result.value as { items: Array<Record<string, unknown>> }
      value.items = (value.items ?? []).filter((item: Record<string, unknown>) => {
        if (ownedWids.has(item.workspaceId as string)) return true
        const sessionIds = Array.isArray(item.sessionIds)
          ? (item.sessionIds as unknown[]).filter((sid): sid is string => typeof sid === 'string')
          : []
        const ownedHere = sessionIds.filter(sid => ownedSessions.has(sid))
        if (ownedHere.length > 0) {
          item.sessionIds = ownedHere
          return true
        }
        return false
      })
      const filtered = JSON.stringify(parsed)
      return new Response(filtered, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers({ ...Object.fromEntries(response.headers.entries()), 'content-length': String(new TextEncoder().encode(filtered).length) }),
      })
    } as typeof fetch
  }

  // ── User-session cache (synced from /api/auth/sessions) ───────────────────
  let _cachedUserSessions: Set<string> | null = null
  let _cachedWorkspaceIds: Set<string> | null = null

  async function refreshSessionCache(): Promise<void> {
    try {
      const res = await fetch('/api/auth/sessions')
      if (res.ok) {
        const data = await res.json() as { sessions: string[] }
        _cachedUserSessions = new Set(data.sessions ?? [])
      }
    } catch { /* ignore */ }
  }

  // Poll session cache every 5s so the interceptor stays fresh
  setInterval(refreshSessionCache, 5000)
  void refreshSessionCache()

  // ── Auth polling ──────────────────────────────────────────────────────────

  async function tick(): Promise<void> {
    try {
      const res = await fetch('/api/auth/me')
      if (res.ok) {
        const data = await res.json() as { id: string; displayName: string }
        if (store.snapshot.user === null || store.snapshot.user.id !== data.id) {
          store.setState({ user: { id: data.id, displayName: data.displayName }, error: null })
        }
      } else {
        store.setState({ user: null })
      }
    } catch { /* ignore */ }
  }

  const intervalId = setInterval(tick, 2000)
  void tick()

  const ctx = _ctx as { effect(fn: () => () => void, tag: string): void } | undefined
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => clearInterval(intervalId), 'oauth-client: timer')
    ctx.effect(() => () => { if (overlay) { overlay.remove(); overlay = null } }, 'oauth-client: cleanup')
  }
  if (typeof document !== 'undefined' && document) {
    const onFocus = (): void => { void tick() }
    document.addEventListener('visibilitychange', onFocus)
    if (ctx && typeof ctx.effect === 'function') {
      ctx.effect(() => () => document.removeEventListener('visibilitychange', onFocus), 'oauth-client: visibility')
    }
  }

  // ── WeChat callback bridge ────────────────────────────────────────────────
  // The official QR iframe (wxLogin.js) redirects to the callback page after
  // scan-confirm; the callback posts the user to this window via postMessage.
  const onWeChatMessage = (event: MessageEvent): void => {
    if (event.origin !== window.location.origin) return
    const data = event.data as { type?: string; user?: { id: string; displayName: string } } | null
    if (!data || data.type !== 'dsh-wechat-login' || !data.user) return
    store.setState({ user: { id: data.user.id, displayName: data.user.displayName }, error: null })
    try { localStorage.removeItem('dsh.sessions.current') } catch { /* ignore */ }
    void refreshSessionCache()
    window.location.reload()
  }
  window.addEventListener('message', onWeChatMessage)
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => window.removeEventListener('message', onWeChatMessage), 'oauth-client: wechat-bridge')
  }

  // ── Inject shared stylesheet ───────────────────────────────────────────────

  function injectStyles(): void {
    if (document.getElementById('dsh-oauth-styles')) return
    const style = document.createElement('style')
    style.id = 'dsh-oauth-styles'
    style.textContent = css
    document.head.appendChild(style)
  }

  // ── Build overlay DOM (once) ───────────────────────────────────────────────

  function buildOverlay(): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('id', 'dsh-oauth-overlay')
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    el.setAttribute('aria-labelledby', 'dsh-oauth-title')
    el.setAttribute('aria-describedby', 'dsh-status-announcer')
    el.innerHTML = /* html */ `
      <!-- Screen reader status announcer -->
      <div id="dsh-status-announcer" aria-live="polite" aria-atomic="true" class="sr-only" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;"></div>

      <!-- LEFT: Brand panel with animated mesh -->
      <div class="dsh-brand" aria-hidden="true">
        <div class="dsh-mesh"></div>
        <div class="dsh-mesh-glow"></div>
        <div class="dsh-geo-shapes"></div>
        <div class="dsh-brand-content">
          <span class="dsh-eyebrow">
            <svg width="143" height="23" viewBox="0 0 143 23" fill="none"><path d="M78.6784 18.6813H77.1077V16.2462H78.6784C79.6513 16.2462 80.6341 16.0037 81.2672 15.3298C81.9009 14.6559 82.14 13.6222 82.14 12.589C82.14 11.5559 81.9109 10.5222 81.2672 9.84884C80.6246 9.17496 79.6513 8.93245 78.6784 8.93245C77.7056 8.93245 76.7227 9.17496 76.0885 9.84884C75.4549 10.5227 75.2157 11.5559 75.2157 12.589V22.5899H72.4604V6.50684H75.2157V7.53106H75.7209C75.7756 7.46792 75.8304 7.41428 75.8857 7.36064C76.5752 6.73146 77.6307 6.50684 78.6684 6.50684C80.2944 6.50684 81.9193 6.91138 82.9849 8.03451C84.0499 9.15764 84.4265 10.8826 84.4265 12.5991C84.4265 14.3156 84.0404 16.0316 82.9849 17.1637C81.9288 18.2958 80.2944 18.6824 78.6784 18.6824V18.6813Z" fill="currentColor"></path><path d="M36.7486 6.93999H38.3188V9.37511H36.7486C35.7752 9.37511 34.7929 9.61762 34.1593 10.2915C33.5256 10.9654 33.287 11.9991 33.287 13.0323C33.287 14.0654 33.5167 15.0986 34.1593 15.7725C34.8019 16.4463 35.7752 16.6888 36.7486 16.6888C37.722 16.6888 38.7049 16.4463 39.3385 15.7725C39.9722 15.0986 40.2108 14.0654 40.2108 13.0323V3.02246H42.9655V19.115H40.2108V18.0908H39.7056C39.6503 18.1534 39.5955 18.2076 39.5402 18.2612C38.8513 18.8898 37.7952 19.115 36.7576 19.115C35.1321 19.115 33.5066 18.711 32.4416 17.5879C31.3766 16.4648 31 14.7393 31 13.0233C31 11.3073 31.3856 9.5908 32.4416 8.45873C33.5066 7.3356 35.1321 6.93999 36.7486 6.93999Z" fill="currentColor"></path><path d="M56.7855 12.8145V13.794H49.4483V11.8445H54.3151C54.2051 11.1348 53.948 10.4699 53.4887 9.98433C52.8277 9.28363 51.8079 9.03218 50.7982 9.03218C49.7886 9.03218 48.7688 9.28363 48.1078 9.98433C47.4468 10.685 47.2076 11.7545 47.2076 12.8151C47.2076 13.8756 47.4462 14.9535 48.1078 15.6452C48.7688 16.337 49.788 16.5979 50.7982 16.5979C51.8085 16.5979 52.8277 16.3465 53.4887 15.6452C53.5804 15.5463 53.6631 15.4385 53.7458 15.3306H56.4642C56.2256 16.1755 55.849 16.9393 55.2796 17.5322C54.1777 18.6911 52.479 19.1135 50.7982 19.1135C49.1175 19.1135 47.4188 18.7 46.3169 17.5322C45.215 16.3644 44.811 14.5852 44.811 12.8151C44.811 11.0449 45.2061 9.25681 46.3169 8.09792C47.4283 6.93903 49.1175 6.5166 50.7982 6.5166C52.479 6.5166 54.1777 6.93009 55.2796 8.09792C56.3904 9.26575 56.7855 11.0449 56.7855 12.8151V12.8145Z" fill="currentColor"></path><path d="M70.6151 12.8145V13.794H63.2779V11.8445H68.1447C68.0341 11.1348 67.7776 10.4699 67.3183 9.98433C66.6573 9.28363 65.6375 9.03218 64.6278 9.03218C63.6181 9.03218 62.5984 9.28363 61.9374 9.98433C61.2763 10.685 61.0372 11.7545 61.0372 12.8151C61.0372 13.8756 61.2758 14.9535 61.9374 15.6452C62.5984 16.337 63.6181 16.5979 64.6278 16.5979C65.6375 16.5979 66.6573 16.3465 67.3183 15.6452C67.4105 15.5463 67.4927 15.4385 67.5748 15.3306H70.2938C70.0546 16.1755 69.678 16.9393 69.1086 17.5322C68.0067 18.6911 66.3081 19.1135 64.6278 19.1135C62.9476 19.1135 61.2484 18.7 60.1465 17.5322C59.0446 16.3644 58.6406 14.5852 58.6406 12.8151C58.6406 11.0449 59.0357 9.25681 60.1465 8.09792C61.2579 6.93903 62.9471 6.5166 64.6278 6.5166C66.3086 6.5166 68.0067 6.93009 69.1086 8.09792C70.22 9.26575 70.6151 11.0449 70.6151 12.8151V12.8145Z" fill="currentColor"></path><path d="M92.2781 19.1146C93.9589 19.1146 95.657 18.8721 96.7589 18.1804C97.8607 17.4886 98.2653 16.437 98.2653 15.3949C98.2653 14.3528 97.8697 13.2922 96.7589 12.6094C95.657 11.9266 93.9583 11.6746 92.2781 11.6746C91.5612 11.6746 90.9002 11.5757 90.4319 11.3153C89.9637 11.0454 89.7893 10.6414 89.7893 10.2369C89.7893 9.83234 89.9547 9.41941 90.4319 9.15846C90.9002 8.88858 91.626 8.79917 92.3418 8.79917C93.0576 8.79917 93.7834 8.89808 94.2528 9.15846C94.721 9.42835 94.8954 9.83234 94.8954 10.2369H97.6959C97.6959 9.19422 97.3383 8.13424 96.3375 7.45142C95.3368 6.76861 93.803 6.5166 92.2786 6.5166C90.7543 6.5166 89.2211 6.75911 88.2197 7.45142C87.219 8.14318 86.8603 9.19422 86.8603 10.2369C86.8603 11.2796 87.2184 12.3395 88.2197 13.0224C89.2205 13.7052 90.7538 13.9572 92.2786 13.9572C93.0682 13.9572 93.941 14.0561 94.464 14.3165C94.9881 14.5774 95.1714 14.9903 95.1714 15.3949C95.1714 15.7994 94.9881 16.2124 94.464 16.4733C93.941 16.7337 93.1419 16.8326 92.3524 16.8326C91.5629 16.8326 90.7543 16.7337 90.2397 16.4733C89.7256 16.2129 89.5323 15.7994 89.5323 15.3949H86.2998C86.2998 16.4376 86.6943 17.4975 87.8063 18.1804C88.9171 18.8632 90.5979 19.1146 92.2786 19.1146H92.2781Z" fill="currentColor"></path><path d="M112.094 12.8145V13.794H104.757V11.8445H109.624C109.514 11.1348 109.257 10.4699 108.798 9.98433C108.136 9.28363 107.117 9.03218 106.106 9.03218C105.095 9.03218 104.077 9.28363 103.416 9.98433C102.755 10.685 102.517 11.7545 102.517 12.8151C102.517 13.8756 102.755 14.9535 103.416 15.6452C104.077 16.337 105.097 16.5979 106.106 16.5979C107.116 16.5979 108.136 16.3465 108.798 15.6452C108.889 15.5463 108.972 15.4385 109.054 15.3306H111.772C111.533 16.1755 111.157 16.9393 110.588 17.5322C109.486 18.6911 107.787 19.1135 106.106 19.1135C104.425 19.1135 102.727 18.7 101.625 17.5322C100.524 16.3644 100.12 14.5852 100.12 12.8151C100.12 11.0449 100.515 9.25681 101.625 8.09792C102.737 6.93903 104.427 6.5166 106.106 6.5166C107.786 6.5166 109.486 6.93009 110.588 8.09792C111.699 9.26575 112.093 11.0449 112.093 12.8151L112.094 12.8145Z" fill="currentColor"></path><path d="M125.924 12.8145V13.794H118.586V11.8445H123.453C123.344 11.1348 123.086 10.4699 122.627 9.98433C121.966 9.28363 120.947 9.03218 119.936 9.03218C118.926 9.03218 117.907 9.28363 117.246 9.98433C116.585 10.685 116.346 11.7545 116.346 12.8151C116.346 13.8756 116.585 14.9535 117.246 15.6452C117.907 16.337 118.927 16.5979 119.936 16.5979C120.946 16.5979 121.966 16.3465 122.627 15.6452C122.719 15.5463 122.801 15.4385 122.884 15.3306H125.602C125.363 16.1755 124.987 16.9393 124.418 17.5322C123.316 18.6911 121.617 19.1135 119.936 19.1135C118.256 19.1135 116.558 18.7 115.456 17.5322C114.354 16.3644 113.949 14.5852 113.949 12.8151C113.949 11.0449 114.344 9.25681 115.456 8.09792C116.566 6.93903 118.256 6.5166 119.936 6.5166C121.617 6.5166 123.315 6.93009 124.418 8.09792C125.529 9.26575 125.924 11.0449 125.924 12.8151V12.8145Z" fill="currentColor"></path><path d="M130.524 3.02246H127.77V19.115H130.524V3.02246Z" fill="currentColor"></path><path d="M135.227 12.4374L139.744 19.1136H136.337L131.819 12.4374L136.337 7.07324H139.744L135.227 12.4374Z" fill="currentColor"></path><g clip-path="url(#clip0_logo)"><path d="M26.5174 3.39471C26.235 3.2567 26.1137 3.52006 25.9487 3.65346C25.8923 3.69659 25.8446 3.75294 25.7969 3.80469C25.3846 4.24516 24.9027 4.53439 24.2737 4.49989C23.3536 4.44814 22.5682 4.73737 21.8735 5.44119C21.7258 4.57349 21.2353 4.0554 20.4889 3.72304C20.0985 3.55054 19.7034 3.37746 19.4297 3.00197C19.2388 2.73459 19.1865 2.43673 19.091 2.14289C19.0301 1.96579 18.9697 1.78466 18.7656 1.75418C18.5442 1.71968 18.4574 1.90541 18.3705 2.06067C18.0232 2.69549 17.8887 3.39471 17.9019 4.10313C17.9324 5.6965 18.6051 6.96556 19.9421 7.86834C20.0939 7.97184 20.133 8.07535 20.0852 8.22658C19.9938 8.53766 19.8857 8.83955 19.7903 9.15063C19.7293 9.34901 19.6384 9.39271 19.4257 9.30588C18.692 8.9994 18.0583 8.54571 17.4982 7.99772C16.5477 7.07827 15.6881 6.06336 14.6162 5.26869C14.3644 5.08296 14.1125 4.91045 13.8521 4.746C12.7584 3.68394 13.9952 2.81164 14.2816 2.70814C14.5812 2.60003 14.3857 2.22857 13.4179 2.23317C12.4502 2.2372 11.5646 2.56151 10.4359 2.99335C10.2708 3.05832 10.0972 3.10547 9.91951 3.14457C8.8954 2.95022 7.83162 2.90709 6.72069 3.03245C4.62877 3.26533 2.95777 4.25436 1.72954 5.94261C0.254043 7.97184 -0.0932678 10.2777 0.33167 12.6824C0.778458 15.2171 2.07225 17.3153 4.06008 18.9558C6.12152 20.6567 8.49577 21.4905 11.2047 21.3306C12.8498 21.2358 14.6812 21.0155 16.7473 19.2669C17.2682 19.5262 17.8151 19.6297 18.7219 19.7074C19.4205 19.7723 20.0933 19.6729 20.6143 19.5648C21.4302 19.3923 21.3739 18.6367 21.0789 18.4981C18.6874 17.3843 19.2124 17.8374 18.7351 17.4706C19.9501 16.033 21.8063 13.4776 22.379 9.99821C22.4353 9.61409 22.5072 9.073 22.4986 8.76192C22.494 8.57216 22.5377 8.49856 22.7545 8.47671C23.3536 8.40771 23.935 8.24383 24.4692 7.94999C26.0188 7.10357 26.6439 5.71318 26.7911 4.04678C26.8129 3.79204 26.7865 3.52869 26.5174 3.39471ZM13.0143 18.3946C10.6964 16.5724 9.5722 15.9726 9.10816 15.9985C8.67402 16.0244 8.75222 16.5212 8.84768 16.8449C8.94773 17.1646 9.07768 17.3849 9.25996 17.6655C9.38589 17.8512 9.47272 18.1272 9.13404 18.3348C8.38766 18.7965 7.08985 18.1796 7.0289 18.1491C5.51833 17.2595 4.25559 16.0853 3.36546 14.4793C2.50581 12.9337 2.0067 11.2753 1.92447 9.50542C1.90262 9.07818 2.02855 8.92695 2.45406 8.84932C3.01413 8.74582 3.59144 8.72397 4.15093 8.80619C6.51656 9.15178 8.53027 10.2092 10.2185 11.8848C11.1822 12.8388 11.9114 13.979 12.6623 15.0929C13.461 16.2757 14.3201 17.4027 15.4144 18.3268C15.8008 18.6505 16.109 18.8966 16.404 19.0783C15.5144 19.1778 14.0297 19.1991 13.0143 18.3958V18.3946ZM14.1252 11.2489C14.1252 11.0591 14.277 10.9079 14.4679 10.9079C14.511 10.9079 14.5501 10.9165 14.5852 10.9292C14.6329 10.9464 14.6766 10.9723 14.7111 11.0114C14.7721 11.0718 14.8066 11.158 14.8066 11.2489C14.8066 11.4386 14.6548 11.5899 14.4639 11.5899C14.273 11.5899 14.1252 11.4386 14.1252 11.2489ZM17.5759 13.0188C17.3545 13.1096 17.1331 13.1873 16.9203 13.1959C16.5903 13.2131 16.2303 13.0791 16.0348 12.9153C15.7312 12.6605 15.5139 12.5179 15.423 12.0734C15.3839 11.8837 15.4057 11.5899 15.4402 11.4214C15.5185 11.0585 15.4316 10.8257 15.1757 10.614C14.9676 10.4415 14.7025 10.3938 14.4115 10.3938C14.3029 10.3938 14.2034 10.3461 14.1292 10.3076C14.0079 10.2472 13.9078 10.096 14.0033 9.91023C14.0338 9.84985 14.1815 9.70322 14.216 9.67734C14.6111 9.45251 15.0665 9.52612 15.488 9.6946C15.8784 9.85445 16.174 10.1477 16.5989 10.5623C17.033 11.0631 17.1112 11.2011 17.3585 11.5772C17.554 11.871 17.7317 12.1729 17.8536 12.5185C17.9272 12.7341 17.8317 12.9107 17.5759 13.0188Z" fill="currentColor"></path></g><defs><clipPath id="clip0_logo"><rect width="26.634" height="19.6" fill="white" transform="translate(0.163086 1.75)"></rect></clipPath></defs></svg>
          </span>

          <h1 class="dsh-brand-title">运行有迹可循 ｜ 探索未至之境</h1>
          <p class="dsh-brand-sub">Powered by DeepSeek Harness</p>
          <div class="dsh-brand-divider"></div>
          <p class="dsh-brand-tagline">Dennis</p>
        </div>
        <div class="dsh-noise"></div>
      </div>

      <!-- RIGHT: Form panel -->
      <div class="dsh-form-panel">
        <!-- Top bar: title + mode toggle -->
        <div class="dsh-topbar">
          <div>
            <h2 id="dsh-oauth-title" class="dsh-title">Welcome back</h2>
            <p class="dsh-subtitle">DeepSeek Harness</p>
          </div>
          <button id="dsh-mode-toggle" class="dsh-toggle" type="button" aria-label="Switch login method" title="Switch login method">
            <span id="dsh-toggle-icon"></span>
          </button>
        </div>

        <!-- Error banner -->
        <div id="dsh-error-wrap" class="dsh-error-wrap" role="alert" style="display:none">
          <div class="dsh-error-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 10.5a.75.75 0 110-1.5.75.75 0 010 1.5zM8.75 4.5v4a.75.75 0 01-1.5 0v-4a.75.75 0 011.5 0z"/></svg>
          </div>
          <span id="dsh-error-msg"></span>
        </div>

        <!-- Password form -->
        <form id="dsh-pwd-form" class="dsh-form" autocomplete="off">
          <div class="dsh-field">
            <label for="dsh-username" class="dsh-label">Username</label>
            <input id="dsh-username" name="username" type="text" autocomplete="username" required
                   class="dsh-input" placeholder="Enter your username" />
            <div id="dsh-username-error" class="dsh-field-error" style="display:none" aria-live="polite"></div>
          </div>
          <div class="dsh-field">
            <label for="dsh-password" class="dsh-label">Password</label>
            <div class="dsh-input-wrapper">
              <input id="dsh-password" name="password" type="password" autocomplete="current-password" required
                     class="dsh-input" placeholder="Enter your password" />
              <button type="button" id="dsh-pwd-toggle" class="dsh-pwd-toggle" aria-label="Toggle password visibility" aria-pressed="false">
                <span class="dsh-pwd-toggle-icon"></span>
              </button>
            </div>
            <div id="dsh-capslock-hint" class="dsh-field-hint" style="display:none" aria-live="polite">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 10.5a.75.75 0 110-1.5.75.75 0 010 1.5zM8.75 4.5v4a.75.75 0 01-1.5 0v-4a.75.75 0 011.5 0z"/></svg>
              <span>Caps Lock is on</span>
            </div>
            <div id="dsh-password-error" class="dsh-field-error" style="display:none" aria-live="polite"></div>
          </div>
          <button id="dsh-pwd-submit" type="submit" class="dsh-btn-primary">
            <span class="dsh-btn-text">Sign in</span>
            <span class="dsh-btn-loader" style="display:none">
              <svg class="dsh-spin" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="2" stroke-opacity="0.3"/><path d="M10 2a8 8 0 018 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </span>
          </button>
        </form>

        <!-- WeChat QR form -->
        <div id="dsh-wechat-form" class="dsh-form dsh-form--hidden">
          <div class="dsh-qr-wrap">
            <div id="dsh-qr-placeholder" class="dsh-qr-placeholder">
              <svg class="dsh-qr-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                <rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14h1v3h-1zM14 20h3v1h-3zM20 20h1v1h-1z"/>
              </svg>
              <span>Loading QR…</span>
            </div>
            <div id="dsh-qr-container" class="dsh-qr-container" style="display:none"></div>
          </div>
          <p id="dsh-wechat-status" class="dsh-qr-status" aria-live="polite">Waiting for scan</p>
          <p class="dsh-qr-hint">Open WeChat · Scan the code · Confirm to log in</p>
        </div>

        <!-- Footer -->
        <div class="dsh-footer">
          <span class="dsh-footer-copyright">Powered by DeepSeek 深度探索</span>
          <span class="dsh-footer-version">v0.1.0</span>
        </div>
      </div>
    ` as unknown as string

    return el
  }

  // ── WeChat QR init ─────────────────────────────────────────────────────────

  async function initWeChatQr(): Promise<void> {
    if (!overlay) return
    store.setState({ wechatReady: false, wechatError: null })

    const ph = overlay.querySelector('#dsh-qr-placeholder') as HTMLElement
    const phLabel = ph?.querySelector('span')
    if (ph) ph.style.display = 'flex'
    if (phLabel) phLabel.textContent = 'Loading QR…'
    const container = overlay.querySelector('#dsh-qr-container') as HTMLElement
    if (container) container.style.display = 'none'

    try {
      const res = await fetch('/api/auth/wechat/config')
      if (!res.ok) throw new Error('Failed to load WeChat config')
      const cfg = await res.json() as { enabled: boolean; appId: string; redirectUri: string; state: string; scope: string; fastLogin: boolean }
      if (!cfg.enabled || !cfg.appId || !cfg.redirectUri || !cfg.state) {
        store.setState({ wechatError: 'WeChat login is not configured on the server.' })
        if (phLabel) phLabel.textContent = 'WeChat login unavailable'
        return
      }
      await loadWxLogin()
      new (window as any).WxLogin({
        self_redirect: true,
        id: 'dsh-qr-container',
        appid: cfg.appId,
        scope: cfg.scope,
        redirect_uri: cfg.redirectUri,
        state: cfg.state,
        style: 'white',
        ...(cfg.fastLogin ? {} : { fast_login: 0 }),
      })
      store.setState({ wechatReady: true })
      if (ph) ph.style.display = 'none'
      if (container) container.style.display = 'block'
    } catch (err) {
      store.setState({ wechatError: err instanceof Error ? err.message : 'Failed to load QR' })
      if (phLabel) phLabel.textContent = 'Failed to load QR. Please try again.'
    }
  }

  // ── Render loop ────────────────────────────────────────────────────────────
  let previousMode: 'password' | 'wechat' = 'password'
  let previousError: string | null = null
  let focusTrapCleanup: (() => void) | null = null

  function renderOverlay(): void {
    const snap = store.snapshot

    if (snap.user !== null) {
      // Logged in: remove overlay, show sidebar user badge
      if (overlay) { overlay.remove(); overlay = null }
      if (focusTrapCleanup) { focusTrapCleanup(); focusTrapCleanup = null }
      showLogoutButton(snap.user.displayName)
      return
    }

    // Logged out: ensure overlay is shown
    if (!overlay) {
      injectStyles()
      overlay = buildOverlay()
      document.body.appendChild(overlay)
      bindEvents(overlay)
      // Setup focus trap after overlay is in DOM
      focusTrapCleanup = setupFocusTrap(overlay)
    }
    hideLogoutButton()

    // Announce mode change
    if (snap.mode !== previousMode) {
      if (snap.mode === 'wechat') {
        announceStatus('Switched to WeChat login. Scan QR code to sign in.')
      } else {
        announceStatus('Switched to password login. Enter username and password.')
      }
      previousMode = snap.mode
    }

    // Announce error changes
    const currentError = snap.error ?? snap.wechatError ?? null
    if (currentError !== previousError) {
      if (currentError) {
        announceStatus(`Error: ${currentError}`)
      } else if (previousError) {
        announceStatus('Error cleared')
      }
      previousError = currentError
    }

    // Sync content
    const titleEl = overlay.querySelector('#dsh-oauth-title') as HTMLHeadingElement | null
    if (titleEl) titleEl.textContent = snap.mode === 'wechat' ? 'WeChat 登录' : 'Welcome back'

    const subEl = overlay.querySelector('.dsh-subtitle') as HTMLElement | null
    if (subEl) subEl.textContent = snap.mode === 'wechat' ? 'Scan to sign in' : 'DeepSeek Harness'

    // Toggle icon
    const toggleBtn = overlay.querySelector('#dsh-mode-toggle') as HTMLButtonElement | null
    const toggleIcon = overlay.querySelector('#dsh-toggle-icon') as HTMLElement | null
    if (toggleBtn && toggleIcon) {
      const isWx = snap.mode === 'wechat'
      toggleIcon.innerHTML = isWx
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="${ICON_ACCOUNT}"/></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="${ICON_WECHAT}"/></svg>`
    }

    // Forms
    const pwdForm = overlay.querySelector('#dsh-pwd-form') as HTMLElement | null
    const wxForm = overlay.querySelector('#dsh-wechat-form') as HTMLElement | null
    if (pwdForm) pwdForm.classList.toggle('dsh-form--hidden', snap.mode !== 'password')
    if (wxForm) wxForm.classList.toggle('dsh-form--hidden', snap.mode !== 'wechat')

    // Error
    const errWrap = overlay.querySelector('#dsh-error-wrap') as HTMLElement | null
    const errMsg = overlay.querySelector('#dsh-error-msg') as HTMLElement | null
    if (errWrap && errMsg) {
      const hasErr = !!(snap.error || snap.wechatError)
      errWrap.style.display = hasErr ? '' : 'none'
      errMsg.textContent = snap.error ?? snap.wechatError ?? ''
    }

    // WeChat QR section
    if (snap.mode === 'wechat') {
      const ph = overlay.querySelector('#dsh-qr-placeholder') as HTMLElement | null
      const container = overlay.querySelector('#dsh-qr-container') as HTMLElement | null
      if (!snap.wechatReady && !snap.wechatError) void initWeChatQr()
      if (container) container.style.display = snap.wechatReady ? 'block' : 'none'
      if (ph) ph.style.display = snap.wechatReady ? 'none' : 'flex'
    }
  }

  // ── Event bindings (once) ──────────────────────────────────────────────────

  function setFieldError(fieldId: string, message: string): void {
    const errEl = overlay?.querySelector(`#${fieldId}-error`) as HTMLElement | null
    const inputEl = overlay?.querySelector(`#${fieldId}`) as HTMLInputElement | null
    if (errEl) {
      errEl.textContent = message
      errEl.style.display = message ? 'block' : 'none'
    }
    if (inputEl) {
      inputEl.setAttribute('aria-invalid', message ? 'true' : 'false')
      if (message) inputEl.setAttribute('aria-describedby', `${fieldId}-error`)
      else inputEl.removeAttribute('aria-describedby')
    }
  }

  function clearAllFieldErrors(): void {
    setFieldError('dsh-username', '')
    setFieldError('dsh-password', '')
  }

  function validateFields(username: string, password: string): boolean {
    let valid = true
    if (!username.trim()) {
      setFieldError('dsh-username', 'Username is required')
      valid = false
    }
    if (!password) {
      setFieldError('dsh-password', 'Password is required')
      valid = false
    }
    return valid
  }

  // Announce status changes to screen readers
  function announceStatus(message: string): void {
    const announcer = overlay?.querySelector('#dsh-status-announcer') as HTMLElement | null
    if (announcer) {
      announcer.textContent = ''
      // Force reflow to ensure announcement
      void announcer.offsetWidth
      announcer.textContent = message
    }
  }

  // Focus trap for modal dialog
  function setupFocusTrap(root: HTMLElement): () => void {
    const focusableSelector = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    let focusableElements: HTMLElement[] = []

    function updateFocusableElements(): void {
      focusableElements = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector))
        .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0)
    }

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return

      updateFocusableElements()
      if (focusableElements.length === 0) return

      const first = focusableElements[0]
      const last = focusableElements[focusableElements.length - 1]

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    function handleEscape(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        // Don't close the login overlay (it's required), but announce current state
        const mode = store.snapshot.mode
        const error = store.snapshot.error || store.snapshot.wechatError
        if (error) {
          announceStatus(`Error: ${error}`)
        } else if (mode === 'wechat') {
          announceStatus('WeChat login mode. Waiting for QR code scan.')
        } else {
          announceStatus('Password login mode. Enter username and password.')
        }
      }
    }

    root.addEventListener('keydown', handleKeyDown)
    root.addEventListener('keydown', handleEscape)

    // Initial focus on first input when overlay appears
    updateFocusableElements()
    if (focusableElements.length > 0) {
      // Focus username input in password mode, or first focusable in wechat mode
      const usernameInput = root.querySelector('#dsh-username') as HTMLElement | null
      if (usernameInput && store.snapshot.mode === 'password') {
        usernameInput.focus()
      } else if (focusableElements[0]) {
        focusableElements[0].focus()
      }
    }

    return () => {
      root.removeEventListener('keydown', handleKeyDown)
      root.removeEventListener('keydown', handleEscape)
    }
  }

  function bindEvents(root: HTMLElement): void {
    // Password visibility toggle
    const pwdToggle = root.querySelector('#dsh-pwd-toggle') as HTMLButtonElement | null
    const pwdInput = root.querySelector('#dsh-password') as HTMLInputElement | null
    const pwdToggleIcon = root.querySelector('#dsh-pwd-toggle .dsh-pwd-toggle-icon') as HTMLElement | null
    if (pwdToggle && pwdInput && pwdToggleIcon) {
      pwdToggle.addEventListener('click', () => {
        const isPassword = pwdInput.type === 'password'
        pwdInput.type = isPassword ? 'text' : 'password'
        pwdToggle.setAttribute('aria-pressed', String(isPassword))
        pwdToggle.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password')
        pwdToggleIcon.innerHTML = isPassword
          ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="${ICON_EYE_OPEN}"/></svg>`
          : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="${ICON_EYE_CLOSED}"/></svg>`
      })
    }

    // Caps Lock detection
    const capsLockHint = root.querySelector('#dsh-capslock-hint') as HTMLElement | null
    if (pwdInput && capsLockHint) {
      pwdInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.getModifierState('CapsLock')) {
          capsLockHint.style.display = 'flex'
        } else {
          capsLockHint.style.display = 'none'
        }
      })
      pwdInput.addEventListener('keyup', (e: KeyboardEvent) => {
        if (!e.getModifierState('CapsLock')) {
          capsLockHint.style.display = 'none'
        }
      })
      pwdInput.addEventListener('blur', () => {
        capsLockHint.style.display = 'none'
      })
    }

    // Mesh parallax (brand panel)
    const brandPanel = root.querySelector('.dsh-brand') as HTMLElement | null
    const mesh = root.querySelector('.dsh-mesh') as HTMLElement | null
    let parallaxEnabled = true
    if (brandPanel && mesh) {
      const checkReducedMotion = (): boolean => {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches
      }
      parallaxEnabled = !checkReducedMotion()
      const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
      mediaQuery.addEventListener?.('change', () => {
        parallaxEnabled = !mediaQuery.matches
        if (!parallaxEnabled) {
          mesh.style.setProperty('--mx', '0')
          mesh.style.setProperty('--my', '0')
        }
      })

      brandPanel.addEventListener('pointermove', (e: PointerEvent) => {
        if (!parallaxEnabled) return
        const rect = brandPanel.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const dx = (e.clientX - cx) / (rect.width / 2)
        const dy = (e.clientY - cy) / (rect.height / 2)
        const maxOffset = 20 // pixels
        mesh.style.setProperty('--mx', `${dx * maxOffset}px`)
        mesh.style.setProperty('--my', `${dy * maxOffset}px`)
      })
      brandPanel.addEventListener('pointerleave', () => {
        if (!parallaxEnabled) return
        mesh.style.setProperty('--mx', '0')
        mesh.style.setProperty('--my', '0')
      })
    }

    // Mode toggle
    root.querySelector('#dsh-mode-toggle')?.addEventListener('click', () => {
      const next = store.snapshot.mode === 'password' ? 'wechat' : 'password'
      store.setState({ mode: next, wechatReady: false, wechatError: null })
      clearAllFieldErrors()
      if (next === 'wechat') void initWeChatQr()
    })

    // Password submit
    root.querySelector('#dsh-pwd-form')?.addEventListener('submit', async (e: Event) => {
      e.preventDefault()
      const username = (root.querySelector('#dsh-username') as HTMLInputElement)?.value ?? ''
      const password = (root.querySelector('#dsh-password') as HTMLInputElement)?.value ?? ''
      const btn = root.querySelector('#dsh-pwd-submit') as HTMLButtonElement | null
      const btnText = btn?.querySelector('.dsh-btn-text') as HTMLElement | null
      const btnLoader = btn?.querySelector('.dsh-btn-loader') as HTMLElement | null

      clearAllFieldErrors()
      if (!validateFields(username, password)) {
        return
      }

      if (btn) { btn.disabled = true; btnText!.textContent = 'Signing in…'; if (btnLoader) btnLoader.style.display = '' }
      store.setState({ loading: true, error: null })

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        })
        const data = await res.json() as { user?: { id: string; displayName: string }; error?: { code: string; message: string } }
        if (data.user) {
          store.setState({ user: { id: data.user.id, displayName: data.user.displayName }, loading: false, error: null })
          // Success transition on button
          if (btn) {
            btn.classList.add('dsh-btn--success')
            btnText!.textContent = 'Success'
            btnLoader!.style.display = 'none'
          }
          try { localStorage.removeItem('dsh.sessions.current') } catch { /* ignore */ }
          void refreshSessionCache()
          // Brief delay for success animation before reload
          setTimeout(() => { window.location.reload() }, 400)
        } else {
          const msg = data.error?.message ?? 'Login failed'
          store.setState({ loading: false, error: msg })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Login failed'
        store.setState({ loading: false, error: msg })
      } finally {
        if (btn && !btn.classList.contains('dsh-btn--success')) {
          btn.disabled = false; btnText!.textContent = 'Sign in'; if (btnLoader) btnLoader.style.display = 'none'
        }
      }
    })
  }

  // ── Sidebar user badge (shown when logged in, outside the overlay) ──────────
  // Injects the user name into the sidebar "设定" trigger row so the row reads
  // [user name][gear icon]. The harness button is React-owned and re-renders on
  // wide↔rail toggles and sidebar remounts, so a body-level MutationObserver
  // re-applies the badge and label hiding after any structural change while a
  // ResizeObserver tracks the rail state. Clicking the name signs out; clicking
  // the gear opens settings (React keeps the button's own onClick).

  const SETTINGS_TRIGGER_SELECTOR = 'button[aria-haspopup="dialog"]:not([aria-label])'
  const USER_BADGE_ID = 'dsh-sidebar-user'
  const RAIL_WIDTH_THRESHOLD = 80

  let sidebarTrigger: HTMLButtonElement | null = null
  let userBadge: HTMLSpanElement | null = null
  let sidebarObserver: MutationObserver | null = null
  let railObserver: ResizeObserver | null = null
  let currentDisplayName = ''
  let syncingBadge = false

  function findSettingsTrigger(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(SETTINGS_TRIGGER_SELECTOR)
  }

  function applyRailState(trigger: HTMLButtonElement): void {
    const narrow = trigger.getBoundingClientRect().width < RAIL_WIDTH_THRESHOLD
    if (userBadge && userBadge.parentElement === trigger) {
      userBadge.classList.toggle('dsh-sidebar-user--hidden', narrow)
    }
    // Push the gear to the right edge in wide mode; clear it in rail mode so the
    // harness's own centered rail layout applies.
    const gear = trigger.querySelector('svg')
    if (gear) gear.style.marginLeft = narrow ? '' : 'auto'
  }

  function syncSidebarBadge(): void {
    if (syncingBadge) return
    syncingBadge = true
    try {
      const trigger = findSettingsTrigger()
      if (!trigger) return
      if (sidebarTrigger !== trigger) {
        sidebarTrigger = trigger
        userBadge = null
        railObserver?.disconnect()
        railObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => applyRailState(trigger)) : null
        railObserver?.observe(trigger)
      }
      if (!userBadge || userBadge.parentElement !== trigger) {
        userBadge = trigger.querySelector<HTMLSpanElement>('#' + USER_BADGE_ID)
        if (!userBadge) {
          userBadge = document.createElement('span')
          userBadge.id = USER_BADGE_ID
          userBadge.title = 'Sign out'
          userBadge.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault()
            e.stopPropagation()
            if (!confirm('确定要退出登录吗？')) return
            void logout()
          })
          trigger.insertBefore(userBadge, trigger.firstChild)
        }
      }
      if (userBadge.textContent !== currentDisplayName) userBadge.textContent = currentDisplayName
      for (const span of trigger.querySelectorAll('span')) {
        if (span !== userBadge && span.style.display !== 'none') span.style.display = 'none'
      }
      applyRailState(trigger)
    } finally {
      syncingBadge = false
    }
  }

  async function logout(): Promise<void> {
    try { await fetch('/api/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
    try { localStorage.removeItem('dsh.sessions.current') } catch { /* ignore */ }
    _cachedUserSessions = null
    _cachedWorkspaceIds = null
    store.setState({ user: null, error: null })
  }

  function showLogoutButton(displayName: string): void {
    injectStyles()
    currentDisplayName = displayName
    if (!sidebarObserver) {
      sidebarObserver = new MutationObserver(() => syncSidebarBadge())
      sidebarObserver.observe(document.body, { childList: true, subtree: true })
    }
    syncSidebarBadge()
  }

  function hideLogoutButton(): void {
    sidebarObserver?.disconnect()
    sidebarObserver = null
    railObserver?.disconnect()
    railObserver = null
    if (sidebarTrigger) {
      for (const span of sidebarTrigger.querySelectorAll('span')) {
        if (span !== userBadge && span.style.display === 'none') span.style.display = ''
      }
      const gear = sidebarTrigger.querySelector('svg')
      if (gear) gear.style.marginLeft = ''
    }
    if (userBadge) { userBadge.remove(); userBadge = null }
    sidebarTrigger = null
  }

  store.subscribe(renderOverlay)
  renderOverlay()
}

export const inject: string[] = []
export { createAuthStore }

// ─── CSS ──────────────────────────────────────────────────────────────────────

const css = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600&family=Manrope:wght@400;500;600&family=JetBrains+Mono&display=swap');

/* ── Tokens ───────────────────────────────────────────────────────────────── */
#dsh-oauth-overlay,
#dsh-sidebar-user {
  /* Warm amber-gold Art Deco palette */
  --dsh-accent: #d4a574;
  --dsh-accent-bright: #e8c49a;
  --dsh-accent-deep: #b8864e;
  --dsh-accent-soft: rgba(212,165,116,0.15);
  /* Deep warm black background */
  --dsh-bg: #0c0a09;
  /* Warm off-white text tones */
  --dsh-text-1: #f5f0eb;
  --dsh-text-2: rgba(245,240,235,0.62);
  --dsh-text-3: rgba(245,240,235,0.50);
  --dsh-text-4: rgba(245,240,235,0.40);
  --dsh-border: rgba(255,255,255,0.08);
  --dsh-border-hover: rgba(255,255,255,0.16);
  --dsh-surface: rgba(255,255,255,0.03);
  --dsh-surface-hover: rgba(255,255,255,0.06);
  --dsh-error: #f87171;
  --dsh-error-soft: rgba(248,113,113,0.1);
  --dsh-success: #22c55e;
  --dsh-success-soft: rgba(34,197,94,0.15);
  --dsh-radius: 8px;
  --dsh-radius-lg: 12px;
  --dsh-ease: cubic-bezier(0.16, 1, 0.3, 1);
  --dsh-speed: 180ms;
  --dsh-speed-fast: 120ms;
}

/* ── Reset & base ───────────────────────────────────────────────────────── */
.dsh-brand, .dsh-form-panel { display: flex; flex-direction: column }
.dsh-form--hidden { display: none !important }

/* ── Overlay shell ───────────────────────────────────────────────────────── */
#dsh-oauth-overlay {
  position: fixed; inset: 0; z-index: 99999;
  display: flex; align-items: stretch;
  font-family: 'Manrope', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
  background: var(--dsh-bg);
  color: var(--dsh-text-1);
  overflow: hidden;
}

/* ── Entrance motion (staggered rise; restarts on each mode switch) ─────── */
@keyframes dsh-rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
.dsh-brand-content { animation: dsh-rise 0.4s var(--dsh-ease) 0.05s both; }
.dsh-topbar { animation: dsh-rise 0.35s var(--dsh-ease) 0.1s both; }
#dsh-error-wrap { animation: dsh-rise 0.3s var(--dsh-ease) 0.14s both; }
.dsh-form { animation: dsh-rise 0.3s var(--dsh-ease) 0.14s both; }
.dsh-footer { animation: dsh-rise 0.3s var(--dsh-ease) 0.18s both; }

/* ── LEFT: Brand panel — dominant asymmetric 62% ─────────────────────────── */
.dsh-brand {
  flex: 0 0 62%;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--dsh-bg);
}

/* Diagonal light rays — Art Deco geometric brand field */
.dsh-mesh {
  position: absolute; inset: 0;
  background:
    conic-gradient(from 135deg at 30% 40%, transparent 30%, rgba(212,165,116,0.08) 42%, transparent 54%),
    conic-gradient(from 200deg at 70% 60%, transparent 25%, rgba(232,196,154,0.06) 38%, transparent 51%),
    linear-gradient(135deg, rgba(184,134,78,0.06) 0%, transparent 50%),
    linear-gradient(225deg, rgba(212,165,116,0.04) 0%, transparent 45%);
  animation: dsh-rays-drift 20s ease-in-out infinite alternate;
  transform: translate(var(--mx, 0), var(--my, 0));
  will-change: transform;
}
@keyframes dsh-rays-drift {
  0%   { opacity: 0.7; transform: scale(1) translate(0, 0) rotate(0deg); }
  50%  { opacity: 1;   transform: scale(1.03) translate(-8px, 6px) rotate(0.6deg); }
  100% { opacity: 0.8; transform: scale(1) translate(6px, -4px) rotate(-0.3deg); }
}

/* Soft ambient glow — warm gold pulse */
.dsh-mesh-glow {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 70% 35% at 30% 60%, rgba(212,165,116,0.06) 0%, transparent 65%);
  animation: dsh-glow-pulse 10s ease-in-out infinite alternate;
}
@keyframes dsh-glow-pulse {
  0%   { opacity: 0.4; transform: scale(1); }
  100% { opacity: 0.7; transform: scale(1.02); }
}

/* Art Deco geometric diamond overlay */
.dsh-geo-shapes {
  position: absolute; inset: 0;
  background-image:
    linear-gradient(45deg, rgba(212,165,116,0.04) 1px, transparent 1px),
    linear-gradient(-45deg, rgba(212,165,116,0.04) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 55% 60% at 50% 50%, black 10%, transparent 70%);
  -webkit-mask-image: radial-gradient(ellipse 55% 60% at 50% 50%, black 10%, transparent 70%);
  pointer-events: none;
}

/* ── Geometric diamond shapes — Art Deco overlay ───────────────────────── */
.dsh-geo-shapes {
  position: absolute; inset: 0;
  background-image:
    linear-gradient(45deg, rgba(212,165,116,0.035) 1px, transparent 1px),
    linear-gradient(-45deg, rgba(212,165,116,0.035) 1px, transparent 1px);
  background-size: 56px 56px;
  mask-image: radial-gradient(ellipse 55% 60% at 50% 50%, black 10%, transparent 70%);
  -webkit-mask-image: radial-gradient(ellipse 55% 60% at 50% 50%, black 10%, transparent 70%);
  pointer-events: none;
}

/* Film grain overlay — warm tone */
.dsh-noise {
  position: absolute; inset: 0;
  opacity: 0.022;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 180px 180px;
  pointer-events: none;
  mix-blend-mode: overlay;
}

.dsh-brand-content {
  position: relative; z-index: 2;
  text-align: left;
  padding: 64px 56px;
  max-width: 420px;
}
/* Eyebrow badge — harness-style label above title */
.dsh-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  background: var(--dsh-surface);
  border: 1px solid var(--dsh-border);
  font-size: 12px;
  font-weight: 500;
  color: var(--dsh-text-3);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 20px;
}

.dsh-brand-title {
  font-size: 32px;
  font-weight: 600;
  letter-spacing: -0.032em;
  line-height: 1.15;
  margin: 0 0 14px;
  background: linear-gradient(135deg, var(--dsh-text-1) 0%, var(--dsh-accent-bright) 55%, var(--dsh-accent) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  background-size: 200% 200%;
  animation: dsh-title-gradient 3s var(--dsh-ease) infinite alternate;
}
@keyframes dsh-title-gradient {
  0% { background-position: 0% 50%; }
  100% { background-position: 100% 50%; }
}
.dsh-brand-sub {
  font-size: 14px;
  color: var(--dsh-text-2);
  letter-spacing: -0.01em;
  line-height: 1.6;
  margin: 0 0 28px;
  font-weight: 400;
}
.dsh-brand-divider {
  width: 32px; height: 2px;
  margin: 0 0 20px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--dsh-accent), transparent);
}
.dsh-brand-tagline {
  font-size: 13px;
  color: var(--dsh-text-4);
  line-height: 1.7;
  margin: 0;
  letter-spacing: 0.01em;
}

/* ── RIGHT: Form panel — harness dark surface ────────────────────────────── */
.dsh-form-panel {
  flex: 1;
  background: var(--dsh-bg);
  display: flex;
  flex-direction: column;
  padding: 64px 56px;
  overflow-y: auto;
  position: relative;
  border-left: 1px solid var(--dsh-border);
  border-top: 2px solid var(--dsh-accent);
  justify-content: center;
  min-height: 0;
}

/* Warm gold top gradient on form panel */
.dsh-form-panel::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 140px;
  background: linear-gradient(to bottom, rgba(212,165,116,0.06), transparent);
  pointer-events: none;
}

/* Bottom fade for clean scroll edge */
.dsh-form-panel::after {
  content: '';
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 80px;
  background: linear-gradient(to top, var(--dsh-bg), transparent);
  pointer-events: none;
  opacity: 0.6;
}

/* Top bar */
.dsh-topbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 32px;
  width: 100%;
  max-width: 360px;
  align-self: center;
}
.dsh-title {
  font-size: 26px;
  font-weight: 600;
  color: var(--dsh-text-1);
  letter-spacing: -0.032em;
  margin: 0 0 6px;
  line-height: 1.15;
}
.dsh-subtitle {
  font-size: 14px;
  color: var(--dsh-text-3);
  margin: 0;
  line-height: 1.45;
}

/* Mode toggle button */
.dsh-toggle {
  flex-shrink: 0;
  width: 44px; height: 44px;
  border-radius: 10px;
  border: 1px solid var(--dsh-border);
  background: var(--dsh-surface);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: var(--dsh-text-3);
  transition: border-color var(--dsh-speed) var(--dsh-ease),
    color var(--dsh-speed) var(--dsh-ease),
    background var(--dsh-speed) var(--dsh-ease);
}
.dsh-toggle:hover {
  border-color: var(--dsh-border-hover);
  color: var(--dsh-text-2);
  background: var(--dsh-surface-hover);
}
.dsh-toggle:active {
  background: var(--dsh-surface);
}
.dsh-toggle:focus-visible {
  outline: 2px solid var(--dsh-accent);
  outline-offset: 2px;
}

/* Error banner */
.dsh-error-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--dsh-radius);
  background: rgba(220, 38, 38, 0.08);
  border: 1px solid rgba(220, 38, 38, 0.18);
  margin-bottom: 20px;
  font-size: 13px;
  color: var(--dsh-error);
  line-height: 1.4;
  width: 100%;
  max-width: 360px;
  align-self: center;
}
.dsh-error-icon {
  flex-shrink: 0;
  width: 16px; height: 16px;
  color: var(--dsh-error);
}
.dsh-error-icon svg { width: 100%; height: 100%; }

/* ── Form ────────────────────────────────────────────────────────────────── */
.dsh-form {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 360px;
  align-self: center;
}
.dsh-field { margin-bottom: 16px; }
.dsh-label {
  display: block;
  font-family: 'JetBrains Mono', 'PingFang SC', monospace;
  font-size: 11px;
  font-weight: 500;
  color: var(--dsh-text-3);
  margin-bottom: 7px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  transition: color var(--dsh-speed-fast) var(--dsh-ease);
}
.dsh-input {
  width: 100%;
  padding: 11px 13px;
  border: 1px solid var(--dsh-border);
  border-radius: var(--dsh-radius);
  font-size: 14px;
  color: var(--dsh-text-1);
  background: var(--dsh-surface);
  transition: border-color var(--dsh-speed), box-shadow var(--dsh-speed), background var(--dsh-speed);
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
}
.dsh-input::placeholder { color: rgba(255,255,255,0.32); }
.dsh-input:focus {
  border-color: rgba(212,165,116,0.55);
  background: rgba(255,255,255,0.04);
  box-shadow: 0 0 0 3px rgba(212,165,116,0.12), inset 0 1px 0 rgba(255,255,255,0.04);
}
.dsh-input:invalid:not(:placeholder-shown) {
  border-color: var(--dsh-error);
}
.dsh-input:-webkit-autofill,
.dsh-input:-webkit-autofill:hover,
.dsh-input:-webkit-autofill:focus {
  -webkit-box-shadow: 0 0 0 1000px var(--dsh-surface) inset !important;
  box-shadow: 0 0 0 1000px var(--dsh-surface) inset !important;
  -webkit-text-fill-color: var(--dsh-text-1) !important;
}

/* Input wrapper for password toggle */
.dsh-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}
.dsh-input-wrapper .dsh-input {
  padding-right: 48px;
}

/* Password visibility toggle */
.dsh-pwd-toggle {
  position: absolute;
  right: 10px;
  width: 36px; height: 36px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: var(--dsh-text-3);
  border-radius: 6px;
  transition: color var(--dsh-speed-fast) var(--dsh-ease), background var(--dsh-speed-fast) var(--dsh-ease);
}
.dsh-pwd-toggle:hover {
  color: var(--dsh-text-2);
  background: var(--dsh-surface-hover);
}
.dsh-pwd-toggle:active {
  background: var(--dsh-surface);
}
.dsh-pwd-toggle:focus-visible {
  outline: 2px solid var(--dsh-accent);
  outline-offset: 2px;
}
.dsh-pwd-toggle-icon {
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
}
.dsh-pwd-toggle-icon svg {
  width: 100%; height: 100%;
  stroke: currentColor;
  stroke-width: 1.5;
  fill: none;
}

/* Field hint (Caps Lock) */
.dsh-field-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: var(--dsh-radius);
  background: var(--dsh-accent-soft);
  border: 1px solid rgba(212,165,116,0.25);
  font-size: 12px;
  color: var(--dsh-accent-bright);
  line-height: 1.3;
}
.dsh-field-hint svg {
  flex-shrink: 0;
}

/* Field error */
.dsh-field-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--dsh-error);
  line-height: 1.4;
  min-height: 16px;
}

/* Form transition animation */
.dsh-form {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 360px;
  align-self: center;
  transition: opacity var(--dsh-speed) var(--dsh-ease),
    transform var(--dsh-speed) var(--dsh-ease),
    visibility var(--dsh-speed) var(--dsh-ease);
}
.dsh-form--hidden {
  opacity: 0;
  transform: translateX(16px);
  pointer-events: none;
  position: absolute;
  width: 100%;
  max-width: 360px;
  visibility: hidden;
}
.dsh-form:not(.dsh-form--hidden) {
  opacity: 1;
  transform: translateX(0);
  pointer-events: auto;
  position: relative;
  visibility: visible;
}

/* Label focus lift — warm gold accent */
.dsh-field:focus-within .dsh-label {
  color: var(--dsh-accent-bright);
  transform: translateY(-1px);
  transition: color var(--dsh-speed-fast) var(--dsh-ease), transform var(--dsh-speed-fast) var(--dsh-ease);
}

/* Floating label behavior: when input has value, shift label up */
.dsh-field { position: relative; }
.dsh-input:not(:placeholder-shown) ~ .dsh-float-label,
.dsh-input:focus ~ .dsh-float-label {
  transform: translateY(-1.4em) scale(0.85);
  color: var(--dsh-accent-bright);
}

/* Primary button — warm amber gradient */
.dsh-btn-primary {
  width: 100%;
  padding: 12px 16px;
  border: none;
  border-radius: var(--dsh-radius);
  background: linear-gradient(180deg, var(--dsh-accent-bright), var(--dsh-accent) 60%, var(--dsh-accent-deep));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 1px 2px rgba(0,0,0,0.35);
  color: #ffffff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: filter var(--dsh-speed) var(--dsh-ease),
    box-shadow var(--dsh-speed) var(--dsh-ease),
    transform var(--dsh-speed) var(--dsh-ease);
  margin-top: 6px;
  letter-spacing: -0.01em;
}
.dsh-btn-primary:hover:not(:disabled) {
  filter: brightness(1.07);
  box-shadow: 0 4px 20px rgba(212,165,116,0.22), inset 0 1px 0 rgba(255,255,255,0.22);
}
.dsh-btn-primary:active:not(:disabled) {
  transform: translateY(1px);
  filter: brightness(0.95);
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.2);
}
.dsh-btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
.dsh-btn-primary:focus-visible {
  outline: 2px solid var(--dsh-accent);
  outline-offset: 2px;
}
.dsh-btn-primary::after {
  content: '';
  position: absolute;
  top: 0; left: -100%;
  width: 100%; height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent);
  transform: skewX(-20deg);
  transition: left var(--dsh-speed) var(--dsh-ease);
  pointer-events: none;
}
.dsh-btn-primary:hover:not(:disabled)::after {
  left: 200%;
}
.dsh-btn-loader { display: flex; align-items: center; }
.dsh-spin {
  width: 16px; height: 16px;
  animation: dsh-spin 0.8s linear infinite;
  color: rgba(255,255,255,0.85);
}
@keyframes dsh-spin { to { transform: rotate(360deg); } }

/* Success state for button */
.dsh-btn-primary.dsh-btn--success {
  background: linear-gradient(180deg, var(--dsh-success), var(--dsh-success) 60%, #16a34a);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 1px 2px rgba(0,0,0,0.35);
}
.dsh-btn-primary.dsh-btn--success:hover:not(:disabled) {
  filter: brightness(1.07);
  box-shadow: 0 4px 20px rgba(34,197,94,0.28), inset 0 1px 0 rgba(255,255,255,0.22);
}
.dsh-btn-primary.dsh-btn--success .dsh-btn-text { display: none; }
.dsh-btn-primary.dsh-btn--success .dsh-btn-loader { display: flex; }
.dsh-btn-primary.dsh-btn--success .dsh-spin {
  animation: none;
  stroke-dasharray: 50;
  stroke-dashoffset: 0;
}

/* ── WeChat QR section ───────────────────────────────────────────────────── */
.dsh-qr-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 22px;
}
.dsh-qr-container {
  width: 300px;
  max-width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: var(--dsh-radius-lg);
  border: 1px solid rgba(255,255,255,0.10);
  background: #fff;
  box-shadow: 0 4px 32px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.06);
  overflow: hidden;
  transition: transform var(--dsh-speed) var(--dsh-ease),
    box-shadow var(--dsh-speed) var(--dsh-ease),
    border-color var(--dsh-speed) var(--dsh-ease);
}
.dsh-qr-container:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08);
  border-color: rgba(212,165,116,0.3);
}
.dsh-qr-container iframe {
  width: 100%; height: 100%;
  border: 0;
  display: block;
}
.dsh-qr-placeholder {
  width: 300px;
  max-width: 100%;
  aspect-ratio: 3 / 4;
  border: 1px dashed rgba(255,255,255,0.14);
  border-radius: var(--dsh-radius-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--dsh-text-4);
  font-size: 13px;
  background: var(--dsh-surface);
  position: relative;
  overflow: hidden;
}
.dsh-qr-placeholder::before {
  content: '';
  position: absolute;
  top: 0; left: -100%;
  width: 100%; height: 100%;
  background: linear-gradient(90deg, transparent, rgba(212,165,116,0.12), transparent);
  animation: dsh-shimmer 1.8s var(--dsh-ease) infinite;
  pointer-events: none;
}
@keyframes dsh-shimmer {
  0% { left: -100%; }
  100% { left: 200%; }
}
.dsh-qr-icon {
  width: 32px; height: 32px;
  color: rgba(255,255,255,0.35);
  animation: dsh-pulse 2s ease-in-out infinite;
}
@keyframes dsh-pulse {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.04); }
}
.dsh-qr-status {
  font-size: 14px;
  color: var(--dsh-text-2);
  text-align: center;
  margin: 0 0 6px;
  font-weight: 500;
  min-height: 20px;
}
.dsh-qr-hint {
  font-size: 12px;
  color: var(--dsh-text-4);
  text-align: center;
  margin: 0;
  line-height: 1.6;
}

/* ── Footer ──────────────────────────────────────────────────────────────── */
.dsh-footer {
  margin-top: 32px;
  font-size: 12px;
  color: var(--dsh-text-4);
  text-align: center;
  letter-spacing: 0.02em;
  width: 100%;
  max-width: 360px;
  align-self: center;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-footer-copyright {
  font-weight: 400;
}
.dsh-footer-version {
  font-size: 11px;
  color: var(--dsh-text-4);
  opacity: 0.6;
}

/* ── Sidebar user badge (injected into the "设定" trigger row) ───────────── */
#dsh-sidebar-user {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 500;
  color: rgba(255,255,255,0.88);
  cursor: pointer;
  user-select: none;
}
#dsh-sidebar-user:hover {
  color: var(--dsh-accent);
}
#dsh-sidebar-user.dsh-sidebar-user--hidden {
  display: none;
}

/* ── Responsive ──────────────────────────────────────────────────────────── */
@media (max-width: 1024px) {
  .dsh-brand { flex: 0 0 58%; }
  .dsh-brand-content { padding: 48px 40px; max-width: 360px; }
  .dsh-brand-title { font-size: 28px; }
  .dsh-form-panel { padding: 48px 40px; }
}
@media (max-width: 767px) {
  #dsh-oauth-overlay { flex-direction: column; }
  .dsh-brand { flex: 0 0 160px; }
  .dsh-form-panel { padding: 40px 24px; border-left: none; border-top: 1px solid var(--dsh-border); }
  .dsh-brand-content { padding: 24px; }
  .dsh-brand-title { font-size: 22px; }
  .dsh-eyebrow { display: none; }
}
@media (max-width: 480px) {
  .dsh-form-panel { padding: 32px 16px; padding-bottom: calc(32px + env(safe-area-inset-bottom)); }
  .dsh-brand-content { padding: 20px; padding-top: calc(20px + env(safe-area-inset-top)); }
  .dsh-title { font-size: 22px; }
  .dsh-input { padding: 13px 14px; font-size: 16px; } /* 16px prevents iOS zoom on focus */
  .dsh-btn-primary { padding: 14px 16px; font-size: 16px; }
  .dsh-qr-container { width: 100%; aspect-ratio: 1 / 1; }
  .dsh-qr-placeholder { width: 100%; aspect-ratio: 1 / 1; }
}

/* ── Reduced motion ──────────────────────────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  #dsh-oauth-overlay *, #dsh-oauth-overlay *::before, #dsh-oauth-overlay *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  /* The spinner conveys submission progress; keep it turning. */
  #dsh-oauth-overlay .dsh-spin {
    animation: dsh-spin 0.8s linear infinite !important;
  }
  /* Disable mesh parallax transform */
  #dsh-oauth-overlay .dsh-mesh {
    transform: none !important;
  }
  /* Disable shimmer animations */
  #dsh-oauth-overlay .dsh-qr-placeholder::before,
  #dsh-oauth-overlay .dsh-btn-primary::after {
    animation: none !important;
    display: none !important;
  }
  /* Disable title gradient animation */
  #dsh-oauth-overlay .dsh-brand-title {
    animation: none !important;
    -webkit-text-fill-color: var(--dsh-text-1) !important;
    background: none !important;
  }
}
`
