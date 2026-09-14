/**
 * Client plugin: an "MCP 服务器" page on the DSH settings screen, plus a
 * compact MCP server picker that sits on `conversation.composer.dock` — the
 * ambient row below the composer card. The picker lists the managed servers
 * and lets the user prefer one for the current session; the host half then
 * adds a per-assembly `mcp-server-preference` prompt context so sent requests
 * steer toward that server's `mcp__<serverName>__*` tools. All data flows to
 * the host half over the same-origin `/api/mcp/*` webserver routes (the
 * standalone-plugin bridge, mirroring dsh-oauth's `/api/auth/*`).
 *
 * React is resolved through the web shell's frozen module table
 * (`require('react')` / `require('react/jsx-runtime')`), so this bundle stays
 * React-version-agnostic.
 *
 * @module dsh-mcp-plugin/client
 */

import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/**
 * The subset of the client-runtime context this panel drives. The base
 * `Context` type predates the client services, so the typed accessor is applied
 * at the entry boundary (`apply`).
 */
interface McpClientContext {
  slots: {
    inject(key: string, callback: () => unknown): void
    register(options: unknown, component: unknown): unknown
  }
  timer: {
    interval(callback: () => void, delay: number): () => void
  }
}

// ─── Wire types (mirror the host `/api/mcp/*` payloads) ─────────────────────

/** One managed server as returned by `/api/mcp/list`. */
interface McpRecord {
  serverName: string
  connected: boolean
  toolCount: number
  spec: {
    serverName?: string
    transport?: 'stdio' | 'streamable-http'
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    url?: string
    headers?: Record<string, string>
    toolCallTimeoutMs?: number
    failOnStartupError?: boolean
  }
}

/** The transport the user picks in the form; "SSE" is a UI alias for
 *  streamable-http (the mcp-client remote transport, which is SSE-based). */
type FormTransport = 'stdio' | 'sse' | 'streamable-http'

/** The add/modify form model (all flat text so the form is one shape). */
interface McpForm {
  serverName: string
  transport: FormTransport
  /** stdio: the full command line, split into command + args on submit. */
  commandLine: string
  /** stdio: extra env as a JSON object (optional). */
  env: string
  /** stdio: working directory (optional). */
  cwd: string
  /** http/sse: MCP endpoint URL. */
  url: string
  /** http/sse: request headers as a JSON object (optional). */
  headers: string
  /** Per-tool-call timeout in ms (optional). */
  toolCallTimeoutMs: string
  /** Fail fast when the first connect fails (optional). */
  failOnStartupError: 'true' | 'false'
}

function emptyForm(): McpForm {
  return {
    serverName: '', transport: 'stdio', commandLine: '', env: '', cwd: '',
    url: '', headers: '', toolCallTimeoutMs: '', failOnStartupError: 'false',
  }
}

/** Seed the form from a stored server (for editing). */
function specToForm(record: McpRecord): McpForm {
  const spec = record.spec
  return {
    serverName: spec.serverName ?? record.serverName,
    transport: spec.transport === 'streamable-http' ? 'sse' : 'stdio',
    commandLine: [spec.command ?? '', ...(spec.args ?? [])].filter(Boolean).join(' '),
    env: spec.env && Object.keys(spec.env).length > 0 ? JSON.stringify(spec.env) : '',
    cwd: spec.cwd ?? '',
    url: spec.url ?? '',
    headers: spec.headers && Object.keys(spec.headers).length > 0 ? JSON.stringify(spec.headers) : '',
    toolCallTimeoutMs: spec.toolCallTimeoutMs !== undefined ? String(spec.toolCallTimeoutMs) : '',
    failOnStartupError: spec.failOnStartupError ? 'true' : 'false',
  }
}

/**
 * Split a command line into tokens, honoring single/double quotes so that
 * `npx -y @foo/bar --flag="a b"` yields `npx`, `-y`, `@foo/bar`, `a b`.
 * The first token is the executable, the rest are args.
 */
function splitCommandLine(input: string): { command: string; args: string[] } {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === ' ' || char === '\t') {
      if (current.length > 0) { tokens.push(current); current = '' }
    } else current += char
  }
  if (current.length > 0) tokens.push(current)
  return { command: tokens[0] ?? '', args: tokens.slice(1) }
}

/** Parse a `{...}` JSON object from a text field; empty → undefined. */
function parseJsonMap(raw: string, field: string): Record<string, string> | undefined {
  const text = raw.trim()
  if (text.length === 0) return undefined
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${field} 必须是 JSON 对象`)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = String(v)
  return out
}

/**
 * Flatten the form into the host's `McpServerInput`. For a full-spec update we
 * always send `transport` (the host patch keeps unchanged fields when it is
 * present), so an edit saves what is on screen.
 */
function formToBody(f: McpForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    serverName: f.serverName.trim(),
    // "sse" is a UI alias for streamable-http (the remote, SSE-based transport).
    transport: f.transport === 'stdio' ? 'stdio' : 'streamable-http',
  }
  if (f.transport === 'stdio') {
    const { command, args } = splitCommandLine(f.commandLine)
    if (command.length === 0) throw new Error('请填写命令行（例如 npx -y @modelcontextprotocol/server-filesystem）')
    body.command = command
    if (args.length > 0) body.args = args
    const env = parseJsonMap(f.env, '环境变量')
    if (env !== undefined) body.env = env
    if (f.cwd.trim().length > 0) body.cwd = f.cwd.trim()
  } else {
    const url = f.url.trim()
    if (url.length === 0) throw new Error('请填写 MCP 端点 URL（例如 https://host/mcp）')
    body.url = url
    const headers = parseJsonMap(f.headers, '请求头')
    if (headers !== undefined) body.headers = headers
  }
  if (f.toolCallTimeoutMs.trim().length > 0) {
    const n = Number(f.toolCallTimeoutMs)
    if (!Number.isFinite(n) || n <= 0) throw new Error('超时时间必须是正整数（毫秒）')
    body.toolCallTimeoutMs = n
  }
  if (f.failOnStartupError === 'true') body.failOnStartupError = true
  return body
}

// ─── Minimal same-origin API helpers (host `/api/mcp/*` routes) ──────────────

interface ApiError {
  error?: string
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`无法连接 MCP 服务（HTTP ${res.status}）`)
  return (await res.json()) as T
}

async function apiPost<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data: ApiError = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `保存失败（HTTP ${res.status}）`)
  return data as unknown as T
}

// ─── The settings-section panel ──────────────────────────────────────────────

const POLL_MS = 4000

interface PanelProps {
  /** The client timer service (polled status refresh). */
  timer: { interval(callback: () => void, delay: number): () => void }
}

function McpPanel({ timer }: PanelProps) {
  const [servers, setServers] = useState<McpRecord[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<McpRecord | null>(null)
  const [form, setForm] = useState<McpForm>(emptyForm)

  async function reload(): Promise<void> {
    try {
      const data = await apiGet<{ servers: McpRecord[] }>('/api/mcp/list')
      setServers(data.servers ?? [])
      setListError(null)
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void reload()
    const dispose = timer.interval(() => { void reload() }, POLL_MS)
    return () => { dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timer])

  const patch = (next: Partial<McpForm>): void => setForm(cur => ({ ...cur, ...next }))

  function startAdd(): void {
    setEditing(null); setForm(emptyForm()); setShowForm(true); setMessage(null)
  }
  function startEdit(record: McpRecord): void {
    setEditing(record); setForm(specToForm(record)); setShowForm(true); setMessage(null)
  }
  function cancelForm(): void {
    setShowForm(false); setEditing(null)
  }

  async function submit(): Promise<void> {
    setBusy(true); setMessage(null)
    try {
      const body = formToBody(form)
      const name = String(body.serverName)
      if (editing !== null) {
        await apiPost('/api/mcp/modify', body)
        setMessage(`MCP 服务器「${name}」已更新，连接状态稍后刷新。`)
      } else {
        await apiPost('/api/mcp/add', body)
        setMessage(`MCP 服务器「${name}」已添加，连接状态稍后刷新。`)
      }
      setShowForm(false); setEditing(null)
      await reload()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(record: McpRecord): Promise<void> {
    setBusy(true); setMessage(null)
    try {
      await apiPost('/api/mcp/remove', { serverName: record.serverName })
      setMessage(`MCP 服务器「${record.serverName}」已删除。`)
      await reload()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const isHttp = form.transport !== 'stdio'

  return (
    <div className="dsh-mcp">
      <style>{CSS}</style>
      <div className="dsh-mcp-head">
        <h2>MCP 服务器</h2>
        <button type="button" className="dsh-mcp-add" onClick={startAdd}>＋ 添加</button>
      </div>
      <p className="dsh-mcp-hint">
        这些是本工具可实时调用的 MCP 服务器。连接在重启时重新建立，
        定义持久化保存于 <code>~/.dsh/mcp-servers.json</code>。
      </p>

      {listError !== null && (
        <div className="dsh-mcp-err">
          {listError}
          {listError.includes('404') && (
            <div className="dsh-mcp-err-hint">
              MCP 宿主服务未在本进程启用：请到设置 → 插件中重新安装 / 启用「dsh-mcp-plugin」，或重启 dsh web 后再试。
            </div>
          )}
        </div>
      )}
      {message !== null && (
        <div className={editing !== null || showForm ? 'dsh-mcp-err' : 'dsh-mcp-ok'}>{message}</div>
      )}

      <ul className="dsh-mcp-list">
        {servers.length === 0 && <li className="dsh-mcp-empty">暂无 MCP 服务器。</li>}
        {servers.map((s) => (
          <li key={s.serverName} className="dsh-mcp-row">
            <span className={`dsh-mcp-dot${s.connected ? ' on' : ''}`} title={s.connected ? '已连接' : '连接中'} />
            <span className="dsh-mcp-name">{s.serverName}</span>
            <span className="dsh-mcp-tag">
              {s.spec?.transport === 'streamable-http' ? 'SSE' : s.spec?.transport ?? '未知'}
            </span>
            <span className="dsh-mcp-tools">{s.toolCount} 个工具</span>
            <span className="dsh-mcp-actions">
              <button type="button" onClick={() => startEdit(s)}>编辑</button>
              <button type="button" className="danger" onClick={() => remove(s)}>删除</button>
            </span>
          </li>
        ))}
      </ul>

      {showForm && (
        <div className="dsh-mcp-form">
          <h3>{editing !== null ? `编辑「${editing.serverName}」` : '添加 MCP 服务器'}</h3>
          <label>
            名称
            <input value={form.serverName} onChange={e => patch({ serverName: e.target.value })} disabled={editing !== null}
              placeholder="字母 / 数字 / 下划线 / 连字符，1–32 位" />
          </label>
          <label>
            传输协议
            <select value={form.transport} onChange={e => patch({ transport: e.target.value as FormTransport })}>
              <option value="stdio">stdio（本地进程）</option>
              <option value="sse">SSE（流式 / 远程）</option>
              <option value="streamable-http">Streamable HTTP（远程）</option>
            </select>
          </label>
          {isHttp ? (
            <>
              <label>端点 URL<input value={form.url} onChange={e => patch({ url: e.target.value })} placeholder="https://host/mcp" /></label>
              <label>请求头（JSON 对象，可选）<input value={form.headers} onChange={e => patch({ headers: e.target.value })} placeholder='{"Authorization":"Bearer …"}' /></label>
            </>
          ) : (
            <>
              <label>命令行<input value={form.commandLine} onChange={e => patch({ commandLine: e.target.value })}
                placeholder="npx -y @modelcontextprotocol/server-filesystem /path" /></label>
              <label>环境变量（JSON 对象，可选）<input value={form.env} onChange={e => patch({ env: e.target.value })} placeholder='{"API_KEY":"…"}' /></label>
              <label>工作目录（可选）<input value={form.cwd} onChange={e => patch({ cwd: e.target.value })} placeholder="/path" /></label>
            </>
          )}
          <label>工具调用超时（毫秒，可选）<input value={form.toolCallTimeoutMs} onChange={e => patch({ toolCallTimeoutMs: e.target.value })} placeholder="60000" /></label>
          <label className="dsh-mcp-chk">
            <input type="checkbox" checked={form.failOnStartupError === 'true'} onChange={e => patch({ failOnStartupError: e.target.checked ? 'true' : 'false' })} />
            首次连接失败时立即报错
          </label>
          <div className="dsh-mcp-form-actions">
            <button type="button" onClick={() => void submit()} disabled={busy}>{editing !== null ? '保存修改' : '添加'}</button>
            <button type="button" onClick={cancelForm}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Self-contained styles (adaptive to light/dark via `color-scheme`) ───────

const CSS = [
  '.dsh-mcp{color-scheme:light dark;font:inherit;display:flex;flex-direction:column;gap:12px;padding:4px}',
  '.dsh-mcp h2{margin:0;font-size:16px;font-weight:600}',
  '.dsh-mcp-head{display:flex;align-items:center;justify-content:space-between}',
  '.dsh-mcp-hint{margin:0;font-size:12px;opacity:.65;line-height:1.5}',
  '.dsh-mcp-hint code{font-family:ui-monospace,Menlo,monospace;font-size:11px}',
  '.dsh-mcp-add{font:inherit;font-size:13px;padding:4px 10px;border:1px solid rgba(128,128,128,.35);border-radius:6px;background:transparent;color:inherit;cursor:pointer}',
  '.dsh-mcp-add:hover{background:rgba(128,128,128,.12)}',
  '.dsh-mcp-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
  '.dsh-mcp-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid rgba(128,128,128,.2);border-radius:8px}',
  '.dsh-mcp-dot{width:9px;height:9px;border-radius:50%;background:#888;flex:none}',
  '.dsh-mcp-dot.on{background:#3aa76d}',
  '.dsh-mcp-name{font-weight:600}',
  '.dsh-mcp-tag{font-size:11px;padding:1px 6px;border-radius:4px;background:rgba(128,128,128,.15)}',
  '.dsh-mcp-tools{font-size:12px;opacity:.7}',
  '.dsh-mcp-actions{margin-left:auto;display:flex;gap:6px}',
  '.dsh-mcp-actions button{font:inherit;font-size:12px;padding:3px 8px;border:1px solid rgba(128,128,128,.3);border-radius:5px;background:transparent;color:inherit;cursor:pointer}',
  '.dsh-mcp-actions button.danger{color:#c05656;border-color:rgba(192,86,86,.4)}',
  '.dsh-mcp-empty{opacity:.6;font-size:13px;padding:8px 2px}',
  '.dsh-mcp-err{font-size:13px;color:#c05656}',
  '.dsh-mcp-err-hint{font-size:12px;opacity:.75;margin-top:4px;color:inherit}',
  '.dsh-mcp-ok{font-size:13px;color:#3aa76d}',
  '.dsh-mcp-form{border:1px solid rgba(128,128,128,.25);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}',
  '.dsh-mcp-form h3{margin:0;font-size:14px}',
  '.dsh-mcp-form label{font-size:12px;opacity:.85;display:flex;flex-direction:column;gap:3px}',
  '.dsh-mcp-form label.dsh-mcp-chk{flex-direction:row;align-items:center;gap:6px}',
  '.dsh-mcp-form input,.dsh-mcp-form select{font:inherit;padding:6px 8px;border:1px solid rgba(128,128,128,.35);border-radius:6px;background:transparent;color:inherit}',
  '.dsh-mcp-form-actions{display:flex;gap:8px;margin-top:4px}',
  '.dsh-mcp-form-actions button{font:inherit;padding:6px 14px;border:1px solid rgba(128,128,128,.35);border-radius:6px;background:transparent;color:inherit;cursor:pointer}',
  '.dsh-mcp-form-actions button:disabled{opacity:.5;cursor:default}',
].join('\n')

// ─── The composer-dock picker ──────────────────────────────────────────────

/** The session-scoped standard seat this dock reads; only the session id. */
interface DockProps {
  /** The owning session's id (session-scope standard seat). */
  sessionId: string
}

/** The host timer service the dock polls with. */
interface DockTimer {
  interval(callback: () => void, delay: number): () => void
}

/** Poll cadence for the server list and the session's stored preference. */
const PREFERENCE_SYNC_MS = 5000

/**
 * One compact row on `conversation.composer.dock` (below the composer card):
 * a「自动」chip plus one chip per managed server. Clicking a server chip
 * prefers it for this session (clicking again clears);「自动」clears. The
 * selection is persisted per session on the host and rendered nothing when
 * no server is managed.
 */
function McpPickerDock({ sessionId, timer }: DockProps & { timer: DockTimer }) {
  const [servers, setServers] = useState<McpRecord[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // The target value of the in-flight POST, or `undefined` while no pick is in
  // progress. A poll that resumes mid-write must not clobber the optimistic
  // selection with the (pre-commit) host value.
  const inFlightRef = useRef<string | null | undefined>(undefined)

  // A session-scoped dock only renders with a live session, but guard anyway:
  // an empty/undefined id would otherwise encode into the poll URL.
  const validSession = typeof sessionId === 'string' && sessionId.length > 0

  useEffect(() => {
    if (!validSession) return
    let disposed = false
    async function refresh(): Promise<void> {
      try {
        const [list, pref] = await Promise.all([
          apiGet<{ servers: McpRecord[] }>('/api/mcp/list'),
          apiGet<{ serverName: string | null }>(`/api/mcp/pref?sessionId=${encodeURIComponent(sessionId)}`),
        ])
        if (disposed) return
        setServers(list.servers ?? [])
        // While a pick is in flight, keep the optimistic selection.
        if (inFlightRef.current === undefined) setSelected(pref.serverName ?? null)
        setLoaded(true)
      } catch {
        // The API is unavailable (host row off) or a transient failure: keep
        // the last known state; the next poll retries.
      }
    }
    void refresh()
    const dispose = timer.interval(() => { void refresh() }, PREFERENCE_SYNC_MS)
    return () => { disposed = true; dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, timer, validSession])

  async function pick(serverName: string | null): Promise<void> {
    if (!validSession) return
    inFlightRef.current = serverName
    setSelected(serverName) // optimistic
    try {
      await apiPost('/api/mcp/pref', { sessionId, serverName })
    } catch {
      // The host refused (e.g. the server was just removed): resync from it.
      try {
        const pref = await apiGet<{ serverName: string | null }>(`/api/mcp/pref?sessionId=${encodeURIComponent(sessionId)}`)
        setSelected(pref.serverName ?? null)
      } catch {
        // Unreachable: keep the optimistic value; the poll resyncs.
      }
    } finally {
      inFlightRef.current = undefined
    }
  }

  if (!loaded || servers.length === 0) return null

  return (
    <div className="dsh-mcp-dock" title="选择要优先调用的 MCP 服务器；发出的请求会在需要时优先使用它的工具">
      <style>{DOCK_CSS}</style>
      <span className="dsh-mcp-dock-label">MCP</span>
      <button
        type="button"
        className={`dsh-mcp-chip${selected === null ? ' on' : ''}`}
        aria-pressed={selected === null}
        onClick={() => { void pick(null) }}
      >
        自动
      </button>
      {servers.map((server) => (
        <button
          key={server.serverName}
          type="button"
          className={`dsh-mcp-chip${selected === server.serverName ? ' on' : ''}`}
          aria-pressed={selected === server.serverName}
          onClick={() => { void pick(selected === server.serverName ? null : server.serverName) }}
        >
          <span className={`dot${server.connected ? ' on' : ''}`} title={server.connected ? '已连接' : '连接中'} />
          <span className="dsh-mcp-chip-name">{server.serverName}</span>
          <span className="dsh-mcp-chip-tools">{server.toolCount}</span>
        </button>
      ))}
      {selected !== null && (
        <span className="dsh-mcp-dock-note">请求将优先调用「{selected}」的工具</span>
      )}
    </div>
  )
}

/** Self-contained dock styles (adaptive to light/dark via `color-scheme`). */
const DOCK_CSS = [
  '.dsh-mcp-dock{color-scheme:light dark;display:flex;align-items:center;gap:6px;padding:2px 4px;font-size:12px;overflow-x:auto;scrollbar-width:none}',
  '.dsh-mcp-dock::-webkit-scrollbar{display:none}',
  '.dsh-mcp-dock-label{font-size:11px;font-weight:600;opacity:.55;flex:none}',
  '.dsh-mcp-chip{font:inherit;font-size:12px;display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border:1px solid rgba(128,128,128,.3);border-radius:999px;background:transparent;color:inherit;cursor:pointer;flex:none}',
  '.dsh-mcp-chip:hover{background:rgba(128,128,128,.1)}',
  '.dsh-mcp-chip.on{border-color:rgba(58,167,109,.7);background:rgba(58,167,109,.14)}',
  '.dsh-mcp-chip .dot{width:7px;height:7px;border-radius:50%;background:#888;flex:none}',
  '.dsh-mcp-chip .dot.on{background:#3aa76d}',
  '.dsh-mcp-chip-name{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-mcp-chip-tools{font-size:11px;opacity:.55}',
  '.dsh-mcp-dock-note{opacity:.6;flex:none}',
].join('\n')

// ─── Plugin entry ─────────────────────────────────────────────────────────────

/** Services required before the panel can register (slots + a poll timer). */
export const inject = ['slots', 'timer']

/**
 * Register the "MCP 服务器" settings page and the composer-dock server picker.
 * Both wrappers close over `ctx` to hand the timer service to their
 * components. `as never` keeps the register calls source-checkable without a
 * cross-package SlotMap type import.
 * @param ctx - the client root context.
 */
export function apply(ctx: Context): void {
  const c = ctx as unknown as McpClientContext
  const settings = () => (<McpPanel timer={c.timer} />)
  c.slots.inject('settings.section' as never, () => c.slots.register({
    name: 'settings.section',
    id: 'mcp',
    order: 60,
    label: 'MCP 服务器',
  } as never, settings))
  const dock = (props: DockProps) => (<McpPickerDock {...props} timer={c.timer} />)
  c.slots.inject('conversation.composer.dock' as never, () => c.slots.register({
    name: 'conversation.composer.dock',
    id: 'mcp',
    order: 100,
    label: 'MCP 服务器',
  } as never, dock))
}
