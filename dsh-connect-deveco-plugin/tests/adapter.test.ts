/**
 * Behaviour tests for the DevEco Code adapter translation in both directions.
 *
 * These assert the properties the harness depends on and that a wire-format
 * mistake would break: distinct reasoning and text blocks, atomic tool calls
 * whose arguments are complete at `block-end`, and a credential failure that
 * surfaces as a named `LlmError` rather than an opaque throw.
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DevecoAdapter } from '../src/adapter.ts'
import type { DevecoModel } from '../src/api.ts'

/** Catalog the adapter advertises in tests. */
const CATALOG: DevecoModel[] = [
  {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    reasoning: true,
    toolCall: true,
    contextWindow: 170000,
    maxTokens: 32000,
    inputModalities: ['text'],
    reasoningEffort: { levels: ['low', 'high', 'max'], defaultLevel: 'high' },
    groupName: 'mep',
  },
  {
    id: 'Qwen3-VL',
    name: 'Qwen3-VL',
    reasoning: false,
    toolCall: false,
    contextWindow: 32768,
    maxTokens: 8192,
    inputModalities: ['text', 'image'],
  },
]

/**
 * Build an adapter whose gateway returns a canned SSE body.
 * @param body - the SSE payload.
 * @param capture - receives the parsed request body.
 * @param token - token resolution result; a string resolves, an Error rejects.
 * @returns the adapter.
 */
function adapterFor(
  body: string,
  capture: { request?: Record<string, unknown> } = {},
  token: string | Error = 'tok',
): DevecoAdapter {
  return new DevecoAdapter({
    registryKey: 'deveco',
    displayName: 'DevEco Code',
    resolveToken: async () => {
      if (token instanceof Error) throw token
      return token
    },
    listCatalog: async () => CATALOG,
    fetchImpl: async (_input, init) => {
      capture.request = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body))
            controller.close()
          },
        }),
        { status: 200 },
      )
    },
  })
}

/**
 * Build a minimal user message.
 * @param text - message text.
 * @returns the harness message.
 */
function user(text: string): Message {
  return {
    id: 'm1' as Message['id'],
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as Message
}

/**
 * Build request options for one adapter call.
 * @param overrides - option fields to replace.
 * @returns the assembled options.
 */
function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'deveco', model: 'GLM-5.3', messages: [user('hi')], ...overrides }
}

/**
 * Collect the adapter's chunks.
 * @param adapter - the adapter under test.
 * @param opts - request options.
 * @returns every emitted chunk.
 */
async function collect(adapter: DevecoAdapter, opts: GenerateOptions = options()): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(opts)) chunks.push(chunk)
  return chunks
}

/**
 * Wrap chunk data as one SSE frame.
 * @param payload - the JSON payload.
 * @param id - frame id.
 * @returns the frame text.
 */
function frame(payload: unknown, id: number): string {
  return `id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** A minimal successful turn, so request-translation tests need no real content. */
const OK_FRAME = frame({ choices: [{ delta: { content: 'thinking</think>ok' } }] }, 0)

describe('providerInfo and listModels', () => {
  it('reports the configured display name', () => {
    expect(adapterFor(OK_FRAME).providerInfo('deveco')).toEqual({ id: 'deveco', name: 'DevEco Code' })
  })

  it('advertises the catalog under the registered route key', async () => {
    const models = await adapterFor(OK_FRAME).listModels('deveco')
    expect(models.map(model => model.id)).toEqual(['GLM-5.3', 'Qwen3-VL'])
    expect(models[0]?.provider).toBe('deveco')
  })

  it('declares image input only for the model that accepts it', async () => {
    const models = await adapterFor(OK_FRAME).listModels('deveco')
    expect(models[0]?.inputModalities).toEqual(['text'])
    expect(models[1]?.inputModalities).toEqual(['text', 'image'])
  })
})

describe('resolveModel', () => {
  it('reports catalog capacity and reasoning efforts', async () => {
    const info = await adapterFor(OK_FRAME).resolveModel('deveco', 'GLM-5.3')
    expect(info.context?.contextWindow).toBe(170000)
    expect(info.defaultMaxTokens).toBe(32000)
    expect(info.reasoning?.efforts.map(effort => effort.name)).toEqual(['low', 'high', 'max'])
  })

  it('omits reasoning for a model that declares no levels', async () => {
    expect((await adapterFor(OK_FRAME).resolveModel('deveco', 'Qwen3-VL')).reasoning).toBeUndefined()
  })

  it('does not reject an unlisted model, because the catalog is advisory', async () => {
    const info = await adapterFor(OK_FRAME).resolveModel('deveco', 'hot-swapped-model')
    expect(info.id).toBe('hot-swapped-model')
    expect(info.context?.contextWindow).toBeGreaterThan(0)
  })
})

describe('request translation', () => {
  it('sends the system prompt ahead of the conversation', async () => {
    const capture: { request?: Record<string, unknown> } = {}
    await collect(adapterFor(OK_FRAME, capture), options({ system: 'be terse' }))
    const messages = capture.request?.messages as { role: string; content: string }[]
    expect(messages[0]).toEqual({ role: 'system', content: 'be terse' })
  })

  it('projects tool schemas onto the wire format', async () => {
    const capture: { request?: Record<string, unknown> } = {}
    await collect(adapterFor(OK_FRAME, capture), options({
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    }))
    expect(capture.request?.tools).toEqual([
      { type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object' } } },
    ])
  })

  it('omits the tools field entirely when there are none', async () => {
    const capture: { request?: Record<string, unknown> } = {}
    await collect(adapterFor(OK_FRAME, capture))
    expect('tools' in (capture.request ?? {})).toBe(false)
  })

  it('sends an assistant tool call and its result as separate wire messages', async () => {
    const capture: { request?: Record<string, unknown> } = {}
    const assistant = {
      id: 'a1' as Message['id'],
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_1' as never, name: 'read', arguments: '{"path":"/x"}' }],
      source: { kind: 'model' },
    } as unknown as Message
    const result = {
      id: 't1' as Message['id'],
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call_1' as never, content: [{ type: 'text', text: 'contents' }] }],
      source: { kind: 'user' },
    } as unknown as Message
    await collect(adapterFor(OK_FRAME, capture), options({ messages: [user('go'), assistant, result] }))
    const messages = capture.request?.messages as Record<string, unknown>[]
    const assistantMessage = messages.find(message => message.role === 'assistant')
    const toolMessage = messages.find(message => message.role === 'tool')
    expect(assistantMessage?.tool_calls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"/x"}' } }])
    expect(toolMessage).toMatchObject({ tool_call_id: 'call_1', content: 'contents' })
  })

  it('does not replay prior reasoning into the next request', async () => {
    const capture: { request?: Record<string, unknown> } = {}
    const assistant = {
      id: 'a1' as Message['id'],
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'secret thinking' }, { type: 'text', text: 'answer' }],
      source: { kind: 'model' },
    } as unknown as Message
    await collect(adapterFor(OK_FRAME, capture), options({ messages: [user('q'), assistant] }))
    const messages = capture.request?.messages as Record<string, unknown>[]
    expect(JSON.stringify(messages)).not.toContain('secret thinking')
  })
})

describe('stream translation', () => {
  it('splits inline thinking out of the content stream', async () => {
    // GLM on this gateway puts the chain of thought inside `content`, ended by
    // a bare `</think>`. Left alone it would be shown to the user as the answer.
    const chunks = await collect(adapterFor(
      frame({ choices: [{ delta: { content: 'thinking</think>' } }] }, 0)
      + frame({ choices: [{ delta: { content: 'answer' } }] }, 1)
      + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }, 2),
    ))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: null }, blocks: [] } },
    ])
  })

  it('emits reasoning and text as separate blocks', async () => {
    // `reasoning_content` is the separate-field path; the answer still carries
    // the inline terminator, because that is the only boundary marker the
    // gateway sends before visible text.
    const chunks = await collect(adapterFor(
      frame({ choices: [{ delta: { reasoning_content: 'think' } }] }, 0)
      + frame({ choices: [{ delta: { content: 'stray</think>answer' } }] }, 1)
      + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }, 2),
    ))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'think' },
      { type: 'reasoning-delta', index: 0, text: 'stray' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinkstray' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: null }, blocks: [] } },
    ])
  })

  it('closes each block with the full accumulated body', async () => {
    const chunks = await collect(adapterFor(
      frame({ choices: [{ delta: { content: 'Hel' } }] }, 0)
      + frame({ choices: [{ delta: { content: 'lo</think>World' } }] }, 1),
    ))
    const ends = chunks.filter(chunk => chunk.type === 'block-end')
    expect(ends[0]).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Hello' } })
    expect(ends[1]).toEqual({ type: 'block-end', index: 1, block: { type: 'text', text: 'World' } })
  })

  it('does not open a text block when the turn carries only reasoning', async () => {
    const chunks = await collect(adapterFor(frame({ choices: [{ delta: { reasoning_content: 'only thinking' } }] }, 0)))
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(false)
  })

  it('assembles a streamed tool call into one complete block', async () => {
    const chunks = await collect(adapterFor(
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] } }] }, 0)
      + frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/x"}' } }] } }] }, 1)
      + frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, 2),
    ))
    const block = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(block).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"/x"}' },
    })
    // The harness is told the turn ended because of tool calls, so the loop
    // executes them instead of treating the turn as a finished answer.
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('emits a delta per tool-call fragment so the UI can show the call forming', async () => {
    const chunks = await collect(adapterFor(
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read', arguments: '{"a"' } }] } }] }, 0)
      + frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }, 1),
    ))
    const deltas = chunks.filter(chunk => chunk.type === 'tool-call-delta')
    expect(deltas).toHaveLength(2)
    expect(deltas.map(delta => delta.type === 'tool-call-delta' ? delta.argumentsDelta : '')).toEqual(['{"a"', ':1}'])
  })

  it('distinguishes separate tool calls by index', async () => {
    const chunks = await collect(adapterFor(
      frame({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'c0', function: { name: 'a', arguments: '{}' } },
        { index: 1, id: 'c1', function: { name: 'b', arguments: '{}' } },
      ] } }] }, 0),
    ))
    const blocks = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(blocks).toHaveLength(2)
    expect(blocks.map(block => block.type === 'block-end' && block.block.type === 'tool-call' ? block.block.name : '')).toEqual(['a', 'b'])
  })

  it('gives a tool call with no arguments an empty JSON object', async () => {
    const chunks = await collect(adapterFor(
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'now' } }] } }] }, 0),
    ))
    const block = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(block?.type === 'block-end' && block.block.type === 'tool-call' ? block.block.arguments : '').toBe('{}')
  })

  it('reports usage and totals it', async () => {
    const chunks = await collect(adapterFor(
      frame({ choices: [{ delta: { content: 'x' } }], usage: { prompt_tokens: 14, completion_tokens: 3 } }, 0),
    ))
    expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 14, outputTokens: 3, totalTokens: 17 },
    })
  })

  it('maps a length stop to max-tokens', async () => {
    const chunks = await collect(adapterFor(
      frame({ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }, 0),
    ))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('fails rather than returning an empty successful turn', async () => {
    // An empty body means the gateway answered successfully with nothing in it;
    // silently finishing would look to the harness like an empty reply.
    await expect(collect(adapterFor(''))).rejects.toThrow(LlmError)
  })
})

describe('credential failures', () => {
  it('reports a missing login as MISSING_CREDENTIAL', async () => {
    const failure = await collect(adapterFor('', {}, new Error('not logged in'))).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('MISSING_CREDENTIAL')
  })

  it('reports a decrypt failure as INVALID_CREDENTIAL', async () => {
    const error = Object.assign(new Error('could not decrypt'), { code: 'DECRYPT_FAILED' })
    const failure = await collect(adapterFor('', {}, error)).catch((caught: unknown) => caught)
    expect((failure as LlmError).code).toBe('INVALID_CREDENTIAL')
  })
})
