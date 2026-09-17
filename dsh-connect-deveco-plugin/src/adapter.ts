/**
 * The DevEco Code adapter: translates the harness model-call vocabulary into
 * the CodeGenie OpenAI-compatible wire format and back.
 *
 * Translation is deliberately explicit in both directions rather than shared
 * with the pi-ai adapter: this route talks to one gateway whose quirks are
 * known, and the harness's `GenerateOptions` and `StreamChunk` types are the
 * whole contract on the other side.
 *
 * Two behaviours are worth stating because they are not obvious from the types:
 *
 * - Tool calls arrive as fragments. The gateway streams a call's name on the
 *   first fragment and its JSON arguments in pieces, so this adapter
 *   accumulates per-index state and emits a complete `tool-call` block only
 *   once the fragment stream for that index ends. A `tool-call-delta` chunk is
 *   also emitted for each fragment, which is what lets the UI show a call
 *   forming while it streams.
 * - Reasoning is separated from text. The gateway interleaves thinking output
 *   under `reasoning_content`; sending it as ordinary assistant text would
 *   corrupt both the transcript and the next turn's context, so it becomes
 *   `reasoning` blocks.
 *
 * @module dsh-connect-deveco/adapter
 */

import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { streamChat } from './api.ts'
import { createReasoningSplitter } from './reasoning.ts'
import type { ReasoningSplitter } from './reasoning.ts'
import type { ChatRequest, DevecoMessage, DevecoModel, DevecoToolDefinition } from './api.ts'
import type { DevecoCredentialError } from './credentials.ts'

/** Constructor inputs the plugin owns. */
export interface DevecoAdapterOptions {
  /** Provider route key this adapter serves. */
  registryKey: string
  /** Display name shown by provider selectors. */
  displayName: string
  /** Resolve the bearer token; called once per request so a rotated login is picked up without a restart. */
  resolveToken: () => Promise<string>
  /**
   * Models to advertise, fetching the catalog when it is not already cached.
   *
   * `resolveModel` may call this on every request, and a model id the harness
   * already knows must not pay for a gateway round trip, so the implementation
   * is expected to answer from cache when it can.
   */
  listCatalog: () => Promise<readonly DevecoModel[]>
  /** Gateway origin, when overridden by configuration. */
  baseUrl?: string
  /** Fetch implementation override, used by tests. */
  fetchImpl?: typeof fetch
  /** Reports a failure the operator should see without failing the current request. */
  onWarning?: (message: string) => void
}

/** Accumulated state for one in-flight assistant turn. */
interface TurnState {
  /** Next block index to allocate. */
  nextIndex: number
  /** Index of the open text block, when one is being streamed. */
  textIndex?: number
  /** Text accumulated for the open block, needed to close it with its full body. */
  text: string
  /** Index of the open reasoning block, when one is being streamed. */
  reasoningIndex: number | undefined
  /** Reasoning accumulated for the open block. */
  reasoningText: string
  /** Splits inline `</think>`-terminated reasoning out of the content stream. */
  splitter: ReasoningSplitter
  /** Per-position tool-call accumulation, keyed by the gateway's call index. */
  toolCalls: Map<number, { index: number; id: string; name: string; arguments: string }>
  /** Cumulative usage counters, kept because the gateway reports them per event. */
  inputTokens: number
  outputTokens: number
  /** Model-reported stop reason. */
  finishReason?: string
  /** Response id reported by the gateway, retained for replay metadata. */
  lastResponseId?: string
  /** Whether anything was emitted, so an empty response can fail loudly. */
  emitted: boolean
}

/**
 * Map a gateway input-modality list onto the harness vocabulary.
 * @param modalities - gateway modality names.
 * @returns the declared harness modalities.
 */
function toModalities(modalities: readonly string[]): ModelModality[] {
  const result: ModelModality[] = []
  for (const modality of modalities) {
    if (modality === 'text' || modality === 'image') result.push(modality)
  }
  // A model always accepts text; an empty list would otherwise read as
  // "declares nothing", which selectors treat as no declared input at all.
  return result.length > 0 ? result : ['text']
}

/**
 * Render one harness message into wire messages.
 *
 * A single harness message can require more than one wire message: assistant
 * tool calls and their results are separate `assistant` and `tool` messages on
 * the OpenAI wire format even though the harness keeps them as blocks.
 *
 * @param message - the harness message.
 * @returns the wire messages it projects to.
 */
function toWireMessages(message: GenerateOptions['messages'][number]): DevecoMessage[] {
  const role = message.role
  if (role === 'system') {
    const text = message.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .filter(text => text.length > 0)
      .join('\n')
    return text.length > 0 ? [{ role: 'system', content: text }] : []
  }

  if (role === 'user') {
    const parts: { type: 'text' | 'image_url'; text?: string; url?: string }[] = []
    const toolResults: DevecoMessage[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
          break
        case 'image':
          // Images are sent as data-URL-free placeholders: this route's models
          // are catalogued text-only, and the harness already substitutes
          // placeholder text for offloaded images before the adapter runs.
          parts.push({ type: 'text', text: '[image omitted: this route accepts text only]' })
          break
        case 'tool-result': {
          const text = block.content
            .map(inner => (inner.type === 'text' ? inner.text : `[${inner.type}]`))
            .join('\n')
          toolResults.push({ role: 'tool', tool_call_id: String(block.toolCallId), content: text })
          break
        }
        default:
          // Unknown merge-extensible block types carry no wire projection.
          break
      }
    }
    const wire: DevecoMessage[] = []
    // Tool results must precede the text that follows them, so the model reads
    // the observation before the user's next instruction.
    wire.push(...toolResults)
    if (parts.length > 0) {
      const onlyText = parts.every(part => part.type === 'text')
      const content = onlyText
        ? parts.map(part => part.text ?? '').join('')
        : parts.map(part => (part.type === 'text'
          ? { type: 'text' as const, text: part.text ?? '' }
          : { type: 'image_url' as const, image_url: { url: part.url ?? '' } }))
      wire.push({ role: 'user', content })
    }
    return wire
  }

  // Assistant turn: reasoning is intentionally dropped. The gateway produced
  // it, but replaying a prior turn's thinking back as context is not part of
  // its request profile and would inflate every subsequent request.
  const text = message.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(text => text.length > 0)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: String(block.id),
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))
  if (text.length === 0 && toolCalls.length === 0) return []
  return [{
    role: 'assistant',
    content: text.length > 0 ? text : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }]
}

/**
 * Project the harness tool schemas onto wire tool definitions.
 * @param tools - harness tool schemas.
 * @returns the wire definitions.
 */
function toWireTools(tools: readonly ToolSchema[] | undefined): DevecoToolDefinition[] {
  if (tools === undefined) return []
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/** The DevEco Code provider adapter. */
export class DevecoAdapter extends LlmAdapter {
  private readonly options: DevecoAdapterOptions

  /**
   * @param options - the resolution hooks and catalog source this adapter owns.
   */
  constructor(options: DevecoAdapterOptions) {
    super()
    this.options = options
  }

  /**
   * Describe this adapter's single route.
   * @param provider - the registered route key.
   * @returns detached provider metadata.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.displayName }
  }

  /**
   * Advertise the models the gateway reports for the signed-in account.
   * @param _provider - the registered route key.
   * @returns the catalog in gateway order.
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // The catalog is fetched on demand: the harness renders the model picker
    // before any request is routed, so this is the first place the models are
    // genuinely needed.
    const catalog = await this.options.listCatalog()
    return catalog.map(model => ({
      provider: this.options.registryKey,
      id: model.id,
      name: model.name,
      ...(model.groupName !== undefined ? { description: `DevEco Code · ${model.groupName}` } : {}),
      inputModalities: toModalities(model.inputModalities),
    }))
  }

  /**
   * Resolve capacity and reasoning metadata for one exact model.
   *
   * An unknown model id still resolves: this adapter reports the harness's own
   * conservative floor rather than rejecting the request, because the registry
   * treats a catalog as advisory and the gateway is the real authority on which
   * model ids it serves.
   *
   * @param provider - the registered route key.
   * @param model - the exact model id.
   * @returns model metadata for this route.
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const known = (await this.options.listCatalog()).find(entry => entry.id === model)
    if (known === undefined) {
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 32768 },
        defaultMaxTokens: 8192,
      }
    }
    return {
      provider,
      id: known.id,
      name: known.name,
      inputModalities: toModalities(known.inputModalities),
      context: { contextWindow: known.contextWindow },
      defaultMaxTokens: known.maxTokens,
      ...(known.reasoningEffort !== undefined && known.reasoningEffort.levels.length > 0
        ? {
          reasoning: {
            efforts: known.reasoningEffort.levels.map(level => ({
              id: level as never,
              name: level,
            })),
            ...(known.reasoningEffort.defaultLevel !== undefined
              ? { defaultEffort: known.reasoningEffort.defaultLevel as never }
              : {}),
          },
        }
        : {}),
    }
  }

  /**
   * Stream one model call from the DevEco Code gateway.
   * @param options - the assembled request; `options.signal` is honored.
   * @returns harness stream chunks.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let accessToken: string
    try {
      accessToken = await this.options.resolveToken()
    } catch (error) {
      const failure = error as Partial<DevecoCredentialError>
      // The distinction is actionable: MISSING_CREDENTIAL tells the operator to
      // sign in, while INVALID_CREDENTIAL means a credential is present and
      // unusable. A plain ENOENT carries no code of its own, so anything that
      // is not an identified decrypt/format failure is treated as absent —
      // which is the common case for a machine that never ran the CLI.
      const unusable = failure.code === 'DECRYPT_FAILED' || failure.code === 'UNREADABLE' || failure.code === 'EMPTY_TOKEN'
      throw new LlmError(
        failure.message ?? 'Could not resolve a DevEco Code credential',
        unusable ? 'INVALID_CREDENTIAL' : 'MISSING_CREDENTIAL',
      )
    }

    const messages: DevecoMessage[] = []
    // A one-shot caller passes `system` beside `messages`; loop-built requests
    // already carry it as the leading system-role message.
    if (options.system !== undefined && options.system.length > 0) {
      messages.push({ role: 'system', content: options.system })
    }
    for (const message of options.messages) messages.push(...toWireMessages(message))

    const request: ChatRequest = {
      model: options.model,
      messages,
      accessToken,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(this.options.baseUrl !== undefined ? { baseUrl: this.options.baseUrl } : {}),
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(toWireTools(options.tools).length > 0 ? { tools: toWireTools(options.tools) } : {}),
    }

    const state: TurnState = {
      nextIndex: 0,
      text: '',
      reasoningText: '',
      reasoningIndex: undefined,
      splitter: createReasoningSplitter(),
      toolCalls: new Map(),
      inputTokens: 0,
      outputTokens: 0,
      emitted: false,
    }

    for await (const chunk of streamChat(request)) {
      if (chunk.id !== undefined) state.lastResponseId = chunk.id

      if (chunk.reasoning !== undefined) {
        if (state.reasoningIndex === undefined) {
          state.reasoningIndex = state.nextIndex++
          yield { type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' }
        }
        state.reasoningText += chunk.reasoning
        state.emitted = true
        yield { type: 'reasoning-delta', index: state.reasoningIndex, text: chunk.reasoning }
      }

      if (chunk.content !== undefined) {
        // GLM models stream their thinking inside `content`, terminated by a
        // bare `</think>`, rather than using the separate `reasoning_content`
        // field. Splitting it here keeps reasoning out of the visible answer.
        for (const part of state.splitter.push(chunk.content)) {
          if (part.kind === 'reasoning') {
            if (state.reasoningIndex === undefined) {
              state.reasoningIndex = state.nextIndex++
              yield { type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' }
            }
            state.reasoningText += part.text
            state.emitted = true
            yield { type: 'reasoning-delta', index: state.reasoningIndex, text: part.text }
            continue
          }
          // Text closes any open reasoning block: the gateway emits thinking
          // first, and interleaving the two would produce one incoherent block.
          if (state.reasoningIndex !== undefined) {
            yield { type: 'block-end', index: state.reasoningIndex, block: { type: 'reasoning', text: state.reasoningText } }
            state.reasoningIndex = undefined
          }
          if (state.textIndex === undefined) {
            state.textIndex = state.nextIndex++
            yield { type: 'block-start', index: state.textIndex, blockType: 'text' }
          }
          state.text += part.text
          state.emitted = true
          yield { type: 'text-delta', index: state.textIndex, text: part.text }
        }
      }

      if (chunk.toolCalls !== undefined) {
        for (const delta of chunk.toolCalls) {
          let call = state.toolCalls.get(delta.index)
          if (call === undefined) {
            call = {
              index: delta.index,
              id: delta.id ?? `call_${delta.index}`,
              name: delta.name ?? '',
              arguments: '',
            }
            state.toolCalls.set(delta.index, call)
          } else {
            if (delta.id !== undefined) call.id = delta.id
            if (delta.name !== undefined) call.name = delta.name
          }
          if (delta.arguments !== undefined) call.arguments += delta.arguments
          state.emitted = true
          yield {
            type: 'tool-call-delta',
            // Tool-call blocks are allocated after text and reasoning, so the
            // announced index reserves ahead for each pending call.
            index: state.nextIndex + delta.index,
            id: call.id as ToolCallId,
            ...(call.name.length > 0 ? { name: call.name } : {}),
            argumentsDelta: delta.arguments ?? '',
          }
        }
      }

      if (chunk.usage !== undefined) {
        if (chunk.usage.promptTokens !== undefined) state.inputTokens = chunk.usage.promptTokens
        if (chunk.usage.completionTokens !== undefined) state.outputTokens = chunk.usage.completionTokens
      }

      if (chunk.finishReason !== undefined) state.finishReason = chunk.finishReason
    }

    // A chunk may end mid-terminator, leaving a few characters withheld. They
    // can never complete a terminator now, so they are ordinary text of whichever
    // kind the stream ended in — dropping them would truncate the answer.
    for (const part of state.splitter.flush()) {
      if (part.kind === 'reasoning') {
        if (state.reasoningIndex === undefined) {
          state.reasoningIndex = state.nextIndex++
          yield { type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' }
        }
        state.reasoningText += part.text
        state.emitted = true
        yield { type: 'reasoning-delta', index: state.reasoningIndex, text: part.text }
        continue
      }
      if (state.reasoningIndex !== undefined) {
        yield { type: 'block-end', index: state.reasoningIndex, block: { type: 'reasoning', text: state.reasoningText } }
        state.reasoningIndex = undefined
      }
      if (state.textIndex === undefined) {
        state.textIndex = state.nextIndex++
        yield { type: 'block-start', index: state.textIndex, blockType: 'text' }
      }
      state.text += part.text
      state.emitted = true
      yield { type: 'text-delta', index: state.textIndex, text: part.text }
    }

    // Close whatever remained open, then emit complete blocks for the tool
    // calls. Deferring these to the end is what makes a tool call atomic: the
    // harness must never see a block-end whose arguments are still truncated.
    if (state.reasoningIndex !== undefined) {
      yield { type: 'block-end', index: state.reasoningIndex, block: { type: 'reasoning', text: state.reasoningText } }
    }
    if (state.textIndex !== undefined) {
      yield { type: 'block-end', index: state.textIndex, block: { type: 'text', text: state.text } }
    }

    let toolIndex = state.nextIndex
    for (const call of [...state.toolCalls.values()].sort((left, right) => left.index - right.index)) {
      const index = toolIndex++
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: call.id as ToolCallId,
          name: call.name,
          // A call the model never gave arguments for is still a call with an
          // empty argument object, which is what the tool executor expects.
          arguments: call.arguments.length > 0 ? call.arguments : '{}',
        },
      }
    }

    if (state.inputTokens > 0 || state.outputTokens > 0) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          totalTokens: state.inputTokens + state.outputTokens,
        },
      }
    }

    if (!state.emitted) {
      throw new LlmError('DevEco Code returned no content for this request', 'INVALID_RESPONSE')
    }

    yield {
      type: 'finish',
      reason: toFinishReason(state.finishReason, state.toolCalls.size > 0),
      replayState: { response: { id: state.lastResponseId ?? null }, blocks: [] },
    }
  }
}

/**
 * Map the gateway stop reason onto the harness vocabulary.
 * @param reason - the gateway's `finish_reason`.
 * @param sawToolCalls - whether this turn produced tool calls.
 * @returns the harness finish reason.
 */
function toFinishReason(reason: string | undefined, sawToolCalls: boolean): { kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' } {
  if (sawToolCalls) return { kind: 'tool-calls' }
  switch (reason) {
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    default:
      return { kind: 'stop' }
  }
}

/** Re-exported so the plugin module can build attribution headers without a second import site. */
export { attributionHeaders }
