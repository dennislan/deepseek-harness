/**
 * DevEco Code (CodeGenie) upstream client: model catalog discovery and
 * OpenAI-compatible streaming chat completions.
 *
 * Both calls target the Huawei DevEco Code gateway. Its shape was read out of
 * the installed `deveco` binary and confirmed against the live service:
 *
 * - Catalog: `GET {base}/codeGenie/modelConfig?localVersion=0&pluginVersion=CLI.<v>`,
 *   authenticated with the same bearer token, answering
 *   `{code, body:{inner_models:[{protocol, group_name, model_configs:[...]}]}}`.
 *   The client unwraps that nesting into a flat model list, because the two
 *   group levels are presentation detail and carry no per-model meaning.
 * - Chat: `POST {base}/sse/codeGenie/maas/v2/chat/completions`, OpenAI-compatible,
 *   answering a Server-Sent Events stream of `chat.completion.chunk` objects.
 *   The non-streaming sibling `/no-stream/chat/completions` is deliberately not
 *   used: the gateway rejects it, observed live as `400 ... argument stream is
 *   false`. The harness adapter is streaming-only, so this costs nothing.
 *
 * Requests carry `lang` and a per-request `Chat-Id` correlation id, both of
 * which the CLI sends. Omitting them was not observed to fail, but sending them
 * keeps this client inside the request profile the gateway is built for.
 *
 * @module dsh-connect-deveco/api
 */

import { randomUUID } from 'node:crypto'
import { DevecoCredentialError } from './credentials.ts'

/** Default gateway origin. DevEco Code supports the China site only. */
export const DEFAULT_BASE_URL = 'https://cn.devecostudio.huawei.com'

/** Chat route path under the gateway origin. */
export const CHAT_PATH = '/sse/codeGenie/maas/v2/chat/completions'

/** Model catalog route path under the gateway origin. */
export const MODEL_CONFIG_PATH = '/codeGenie/modelConfig'

/** One model advertised by the DevEco Code catalog. */
export interface DevecoModel {
  /** Model id passed to the chat route and to the harness as the model name. */
  readonly id: string
  /** Display name; the catalog reports no separate label, so this equals {@link id}. */
  readonly name: string
  /** Whether the model exposes a thinking mode. */
  readonly reasoning: boolean
  /** Whether the model accepts tool definitions. */
  readonly toolCall: boolean
  /** Maximum combined request and response context in tokens. */
  readonly contextWindow: number
  /** Maximum output tokens. */
  readonly maxTokens: number
  /** Accepted input modalities; `image` means the model accepts image parts. */
  readonly inputModalities: readonly string[]
  /** Selectable reasoning levels and the default one, when the model declares them. */
  readonly reasoningEffort?: ReasoningEffortSpec
  /** Upstream protocol group the model was filed under, retained for diagnostics. */
  readonly groupName?: string
}

/**
 * Reasoning levels a model exposes.
 *
 * The gateway reports these as a JSON *string* in a field named
 * `reasoning_effort`, e.g. `{"level":["low","high","max"],"default":"high"}`.
 */
export interface ReasoningEffortSpec {
  /** Selectable levels in gateway order. */
  readonly levels: readonly string[]
  /** Level applied when the request names none. */
  readonly defaultLevel?: string
}

/** A message part accepted by the chat route. */
export type DevecoContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }

/** One chat message in the OpenAI-compatible wire format. */
export interface DevecoMessage {
  /** Conversation role. */
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  /** Text, or multimodal parts for a user turn. */
  readonly content: string | readonly DevecoContentPart[] | null
  /** Tool calls emitted by the assistant, echoed back on the next turn. */
  readonly tool_calls?: readonly DevecoToolCall[]
  /** Which assistant tool call this result answers. */
  readonly tool_call_id?: string
}

/** One tool call in the OpenAI-compatible wire format. */
export interface DevecoToolCall {
  /** Provider-assigned call id, echoed back with the tool result. */
  readonly id: string
  /** Always `function` on this wire format. */
  readonly type: 'function'
  /** Called function name and JSON-encoded arguments. */
  readonly function: { readonly name: string; readonly arguments: string }
}

/** One function tool definition. */
export interface DevecoToolDefinition {
  /** Always `function` on this wire format. */
  readonly type: 'function'
  /** Name, description, and JSON Schema for the parameters. */
  readonly function: {
    readonly name: string
    readonly description?: string
    readonly parameters?: unknown
  }
}

/** One request to the chat route. */
export interface ChatRequest {
  /** Model id from {@link DevecoModel.id}. */
  readonly model: string
  /** Full conversation in wire format. */
  readonly messages: readonly DevecoMessage[]
  /** Tool definitions the model may call. */
  readonly tools?: readonly DevecoToolDefinition[]
  /** Bearer token resolved from the local credential store. */
  readonly accessToken: string
  /** Cancellation for this request. */
  readonly signal?: AbortSignal
  /** Output-token cap. */
  readonly maxTokens?: number
  /** Sampling temperature. */
  readonly temperature?: number
  /** Gateway origin override. */
  readonly baseUrl?: string
  /** Fetch implementation override, used by tests. */
  readonly fetchImpl?: typeof fetch
}

/** One decoded SSE event carrying an incremental chunk. */
export interface ChatStreamChunk {
  /** Text delta for this event, when present. */
  readonly content?: string
  /** Reasoning/thinking delta for this event, when present. */
  readonly reasoning?: string
  /** Tool-call deltas, indexed by their position in the assistant turn. */
  readonly toolCalls?: readonly ToolCallDelta[]
  /** Model-reported stop reason, present on the final content event. */
  readonly finishReason?: string
  /** Cumulative or per-event usage counters, when the gateway reports them. */
  readonly usage?: { readonly promptTokens?: number; readonly completionTokens?: number }
  /** Provider-assigned response id, present on most events. */
  readonly id?: string
}

/** One incremental tool-call fragment. */
export interface ToolCallDelta {
  /** Position of the call in the assistant turn. */
  readonly index: number
  /** Provider-assigned id, present only on the fragment that opens the call. */
  readonly id?: string
  /** Function name, present only on the opening fragment. */
  readonly name?: string
  /** Partial JSON arguments, concatenated across fragments. */
  readonly arguments?: string
}

/** Raised for a non-successful gateway response. */
export class DevecoApiError extends Error {
  /** HTTP status of the failed response. */
  readonly status: number
  /** Gateway error code from the response envelope; absent when the body carried none. */
  readonly errorCode: string | number | undefined

  /**
   * @param status - HTTP status.
   * @param message - operator-facing explanation.
   * @param errorCode - gateway error code, when the body carried one.
   */
  constructor(status: number, message: string, errorCode?: string | number) {
    super(message)
    this.name = 'DevecoApiError'
    this.status = status
    this.errorCode = errorCode
  }
}

/**
 * Build the headers every gateway request carries.
 *
 * `accept` is deliberately not set here. The gateway validates it per route —
 * the catalog is JSON and rejects `text/event-stream` with 406, observed live —
 * so each caller declares the response type it actually expects.
 *
 * @param accessToken - resolved bearer token.
 * @param chatId - correlation id for this request.
 * @returns the shared request headers.
 */
function gatewayHeaders(accessToken: string, chatId: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    lang: 'en',
    'Chat-Id': chatId,
  }
}

/**
 * Recognise a gateway application-level failure carried inside an HTTP 200.
 *
 * The gateway does not use status codes for its own errors: an unauthenticated
 * catalog request answers `200` with `{"errorCode":5002,...}` and a rejected
 * token answers `200` with `{"errorCode":4016,...}`. A client that only checked
 * `response.ok` would treat both as a successful, empty catalog.
 *
 * @param payload - the decoded response body.
 * @returns the error to raise, or `undefined` when the payload is a success.
 */
function applicationError(payload: unknown): DevecoApiError | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const body = payload as Record<string, unknown>
  const raw = body.errorCode
  const errorCode: string | number | undefined = typeof raw === 'number' || typeof raw === 'string' ? raw : undefined
  const successFlag = body.success
  // `success:false` with no errorCode is still a failure; a `code` field is the
  // success channel (`code:200`) and must not be read as an error.
  if (errorCode === undefined && successFlag !== false) return undefined
  const message = typeof body.errorMsg === 'string' ? body.errorMsg : 'the gateway reported an unspecified error'
  if (errorCode === 4016 || /invalid accessToken/i.test(message)) {
    return new DevecoApiError(
      401,
      'DevEco Code rejected the access token. Re-run `deveco providers login` to refresh it.',
      errorCode,
    )
  }
  if (errorCode === 5002 || /authorization is null/i.test(message)) {
    return new DevecoApiError(
      401,
      'DevEco Code rejected the request as unauthenticated. Re-run `deveco providers login`.',
      errorCode,
    )
  }
  return new DevecoApiError(502, `DevEco Code gateway error ${String(errorCode)}: ${message}`, errorCode)
}

/**
 * Turn a non-successful response into a {@link DevecoApiError}, preferring the
 * gateway's own error code and message over the bare status.
 * @param response - the failed response.
 * @returns a promise of the error to throw.
 */
async function toApiError(response: Response): Promise<DevecoApiError> {
  const text = await response.text().catch(() => '')
  let detail = text.trim()
  let errorCode: string | number | undefined
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (typeof parsed.errorMsg === 'string') detail = parsed.errorMsg
    if (typeof parsed.code === 'number' || typeof parsed.code === 'string') errorCode = parsed.code
    if (typeof parsed.errorCode === 'number' || typeof parsed.errorCode === 'string') errorCode = parsed.errorCode
    // The streaming route reports failures inside the SSE-shaped body instead.
    const nested = parsed.error
    if (typeof nested === 'object' && nested !== null) {
      const message = (nested as Record<string, unknown>).message
      if (typeof message === 'string') detail = message
      const code = (nested as Record<string, unknown>).code
      if (typeof code === 'string' || typeof code === 'number') errorCode = code
    }
  } catch {
    // A non-JSON error body is still meaningful as raw text; the trimmed body
    // above already carries it.
  }
  if (errorCode === '4016' || /invalid accessToken/i.test(detail)) {
    return new DevecoApiError(
      401,
      'DevEco Code rejected the access token. Re-run `deveco providers login` to refresh it.',
      errorCode,
    )
  }
  return new DevecoApiError(response.status, `DevEco Code gateway responded ${response.status}: ${detail || response.statusText}`, errorCode)
}

/** Raw model config entry as the catalog reports it. */
interface RawModelConfig {
  readonly id?: unknown
  readonly model_id?: unknown
  readonly thinking_mode?: unknown
  readonly input_modalities?: unknown
  readonly context_window?: unknown
  readonly output?: unknown
  readonly tool_call_mode?: unknown
  readonly reasoning_effort?: unknown
}

/** Raw catalog group as the gateway reports it. */
interface RawModelGroup {
  readonly protocol?: unknown
  readonly group_name?: unknown
  readonly model_configs?: unknown
}

/**
 * Coerce one catalog field to a number, tolerating the numeric strings the
 * gateway mixes in with real numbers.
 * @param value - raw field value.
 * @returns the number, or `undefined` when it is not numeric.
 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

/**
 * Decode the `reasoning_effort` field, which the gateway sends as a JSON string
 * rather than a nested object.
 * @param value - raw catalog field.
 * @returns the declared levels, or `undefined` when the model declares none.
 */
function toReasoningEffort(value: unknown): ReasoningEffortSpec | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const levels = Array.isArray(parsed.level)
      ? parsed.level.filter((entry): entry is string => typeof entry === 'string')
      : []
    if (levels.length === 0) return undefined
    return {
      levels,
      ...(typeof parsed.default === 'string' ? { defaultLevel: parsed.default } : {}),
    }
  } catch {
    // A malformed effort declaration removes the reasoning selector for this
    // model but leaves the model itself usable at the gateway's own default.
    return undefined
  }
}

/**
 * Normalise one raw catalog entry.
 * @param raw - the catalog entry.
 * @param groupName - group the entry was filed under, retained for diagnostics.
 * @returns the model, or `undefined` when the entry carries no usable id.
 */
function toModel(raw: RawModelConfig, groupName: string | undefined): DevecoModel | undefined {
  const id = typeof raw.model_id === 'string' ? raw.model_id : typeof raw.id === 'string' ? raw.id : undefined
  if (id === undefined || id.length === 0) return undefined
  const modalities = Array.isArray(raw.input_modalities)
    ? raw.input_modalities.filter((value): value is string => typeof value === 'string')
    : []
  const reasoningEffort = toReasoningEffort(raw.reasoning_effort)
  return {
    id,
    name: id,
    // `configurable` means the model accepts a thinking toggle per request;
    // only an explicit `on` means thinking is always engaged.
    reasoning: raw.thinking_mode === 'on' || raw.thinking_mode === 'configurable',
    toolCall: raw.tool_call_mode === 'tool_calls',
    contextWindow: toNumber(raw.context_window) ?? 32768,
    maxTokens: toNumber(raw.output) ?? 8192,
    inputModalities: modalities.length > 0 ? modalities : ['text'],
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(groupName !== undefined ? { groupName } : {}),
  }
}

/**
 * Flatten the catalog envelope into the advertised model list.
 *
 * Exported separately from the fetch so the parsing rules are testable against
 * captured gateway payloads.
 *
 * @param payload - the decoded `codeGenie/modelConfig` response.
 * @returns every model the envelope advertises, in gateway order.
 */
export function parseModelCatalog(payload: unknown): DevecoModel[] {
  const models: DevecoModel[] = []
  if (typeof payload !== 'object' || payload === null) return models
  const body = (payload as Record<string, unknown>).body
  if (typeof body !== 'object' || body === null) return models
  const groups = (body as Record<string, unknown>).inner_models
  if (!Array.isArray(groups)) return models
  const seen = new Set<string>()
  for (const group of groups) {
    const typed = (typeof group === 'object' && group !== null ? group : {}) as RawModelGroup
    const groupName = typeof typed.group_name === 'string' ? typed.group_name : undefined
    const entries = Array.isArray(typed.model_configs) ? typed.model_configs : []
    for (const entry of entries) {
      const model = toModel((typeof entry === 'object' && entry !== null ? entry : {}) as RawModelConfig, groupName)
      // The same model id may appear under several protocol groups; the first
      // occurrence wins so the list has no duplicate selector entries.
      if (model === undefined || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
  }
  return models
}

/**
 * Fetch the model catalog from the gateway.
 * @param options - bearer token, endpoint overrides, and cancellation.
 * @returns every model the signed-in account may use.
 */
export async function fetchModelCatalog(options: {
  accessToken: string
  baseUrl?: string
  cliVersion?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<DevecoModel[]> {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const version = options.cliVersion ?? 'unknown'
  const url = `${base}${MODEL_CONFIG_PATH}?localVersion=0&pluginVersion=CLI.${encodeURIComponent(version)}`
  const doFetch = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { ...gatewayHeaders(options.accessToken, randomUUID().replace(/-/g, '')), accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new DevecoApiError(0, `Could not reach the DevEco Code gateway at ${base}: ${reason}`)
  }
  if (!response.ok) throw await toApiError(response)
  const payload = (await response.json()) as unknown
  // The gateway reports its own failures inside a 200 response body, so the
  // status check above is not sufficient on this route.
  const failure = applicationError(payload)
  if (failure !== undefined) throw failure
  return parseModelCatalog(payload)
}

/**
 * Split a Server-Sent Events byte stream into complete frames.
 *
 * The gateway frames each event with an `id: N` line and a `data: {...}` line,
 * and emits `event: error` with a JSON body on failure. Frames are separated by
 * a blank line; a trailing partial frame is discarded, which is correct for a
 * well-formed stream and harmless for a truncated one because the transport
 * surfaces truncation as its own error.
 *
 * Whole frames are yielded rather than only their payloads so a caller can see
 * the `event:` line, which is the only place a stream failure is announced.
 *
 * @param body - the response body stream.
 * @returns each complete frame's text, in arrival order.
 */
export async function* iterateSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separator = buffer.indexOf('\n\n')
      while (separator !== -1) {
        yield buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        separator = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim().length > 0) yield buffer
  } finally {
    reader.releaseLock()
  }
}

/**
 * Yield the `data:` payload of every frame that carries one.
 * @param body - the response body stream.
 * @returns each frame's payload text, in arrival order.
 */
export async function* iterateSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const frame of iterateSseFrames(body)) {
    const data = frameData(frame)
    if (data !== undefined) yield data
  }
}

/**
 * Extract the concatenated `data:` payload of one SSE frame.
 * @param frame - one raw frame without its terminating blank line.
 * @returns the payload, or `undefined` for a frame carrying only comments or ids.
 */
function frameData(frame: string): string | undefined {
  const parts: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    parts.push(line.slice(5).replace(/^ /, ''))
  }
  if (parts.length === 0) return undefined
  return parts.join('\n')
}

/**
 * Recognise a failure delivered as an SSE `event: error` frame.
 *
 * Chat failures arrive inside the stream with the response status still 200:
 * an unsupported request answered `400` in the body while the transport
 * reported success. Detecting the frame is what turns that into a real error
 * instead of a silent empty reply.
 *
 * @param frame - one raw frame including its `event:` line.
 * @returns the error to raise, or `undefined` for an ordinary chunk frame.
 */
function streamError(frame: string): DevecoApiError | undefined {
  if (!/^event:\s*error\s*$/m.test(frame)) return undefined
  const data = frameData(frame)
  if (data === undefined) return new DevecoApiError(502, 'DevEco Code reported a stream error with no detail')
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    const error = typeof parsed.error === 'object' && parsed.error !== null ? parsed.error as Record<string, unknown> : {}
    const message = typeof error.message === 'string' ? error.message : data
    const param = typeof error.param === 'object' && error.param !== null ? error.param as Record<string, unknown> : {}
    const original = typeof param.originalMessage === 'string' ? param.originalMessage : undefined
    const code = typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined
    return new DevecoApiError(
      502,
      `DevEco Code stream error: ${original ?? message}`,
      code,
    )
  } catch {
    return new DevecoApiError(502, `DevEco Code stream error: ${data}`)
  }
}

/**
 * Decode one gateway chunk payload.
 * @param data - the raw `data:` payload.
 * @returns the normalised chunk, or `undefined` for the `[DONE]` sentinel.
 */
export function parseChunkPayload(data: string): ChatStreamChunk | undefined {
  const trimmed = data.trim()
  if (trimmed.length === 0 || trimmed === '[DONE]') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    // An unparsable frame carries no model-visible content; dropping it keeps
    // the stream going rather than failing a request over a stray keepalive.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const chunk = parsed as Record<string, unknown>
  const choices = Array.isArray(chunk.choices) ? chunk.choices : []
  const first = (typeof choices[0] === 'object' && choices[0] !== null ? choices[0] : {}) as Record<string, unknown>
  const delta = (typeof first.delta === 'object' && first.delta !== null ? first.delta : {}) as Record<string, unknown>

  const result: {
    content?: string
    reasoning?: string
    toolCalls?: ToolCallDelta[]
    finishReason?: string
    usage?: { promptTokens?: number; completionTokens?: number }
    id?: string
  } = {}

  if (typeof chunk.id === 'string') result.id = chunk.id
  if (typeof delta.content === 'string' && delta.content.length > 0) result.content = delta.content
  // Thinking deltas arrive under the provider's own field name; both spellings
  // are accepted because the gateway has used each of them across models.
  const reasoning = delta.reasoning_content ?? delta.reasoning
  if (typeof reasoning === 'string' && reasoning.length > 0) result.reasoning = reasoning
  if (typeof first.finish_reason === 'string') result.finishReason = first.finish_reason

  if (Array.isArray(delta.tool_calls)) {
    const calls: ToolCallDelta[] = []
    for (const entry of delta.tool_calls) {
      if (typeof entry !== 'object' || entry === null) continue
      const call = entry as Record<string, unknown>
      const fn = (typeof call.function === 'object' && call.function !== null ? call.function : {}) as Record<string, unknown>
      const index = typeof call.index === 'number' ? call.index : 0
      calls.push({
        index,
        ...(typeof call.id === 'string' ? { id: call.id } : {}),
        ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
        ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}),
      })
    }
    if (calls.length > 0) result.toolCalls = calls
  }

  if (typeof chunk.usage === 'object' && chunk.usage !== null) {
    const usage = chunk.usage as Record<string, unknown>
    result.usage = {
      ...(typeof usage.prompt_tokens === 'number' ? { promptTokens: usage.prompt_tokens } : {}),
      ...(typeof usage.completion_tokens === 'number' ? { completionTokens: usage.completion_tokens } : {}),
    }
  }

  return result
}

/**
 * Stream one chat completion from the DevEco Code gateway.
 *
 * The request is always sent with `stream: true`; the gateway rejects the
 * non-streaming route, so there is no fallback to attempt.
 *
 * @param request - the assembled request.
 * @returns the decoded chunk stream.
 */
export async function* streamChat(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
  const base = (request.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const doFetch = request.fetchImpl ?? fetch

  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
  }
  if (request.tools !== undefined && request.tools.length > 0) body.tools = request.tools
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
  if (request.temperature !== undefined) body.temperature = request.temperature

  let response: Response
  try {
    response = await doFetch(`${base}${CHAT_PATH}`, {
      method: 'POST',
      headers: { ...gatewayHeaders(request.accessToken, randomUUID().replace(/-/g, '')), accept: 'text/event-stream' },
      body: JSON.stringify(body),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new DevecoApiError(0, `Could not reach the DevEco Code gateway at ${base}: ${reason}`)
  }

  if (!response.ok) throw await toApiError(response)
  if (response.body === null) {
    throw new DevecoCredentialError('UNREADABLE', 'DevEco Code gateway returned no response body for a streaming request')
  }

  for await (const frame of iterateSseFrames(response.body)) {
    // A failure arrives in-band with the status still 200, so every frame is
    // checked for the error event before it is decoded as content.
    const failure = streamError(frame)
    if (failure !== undefined) throw failure
    const data = frameData(frame)
    if (data === undefined) continue
    const chunk = parseChunkPayload(data)
    if (chunk !== undefined) yield chunk
  }
}
