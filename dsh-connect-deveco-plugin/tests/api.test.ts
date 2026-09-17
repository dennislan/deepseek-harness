/**
 * Behaviour tests for the DevEco Code wire protocol and stream decoding.
 *
 * The SSE fixtures are the exact frame layout the gateway emits, including the
 * `id:` line that precedes each `data:` line, because a parser that only works
 * on hand-simplified frames would fail against the real service.
 */

import { describe, expect, it } from 'vitest'
import {
  CHAT_PATH,
  DEFAULT_BASE_URL,
  MODEL_CONFIG_PATH,
  DevecoApiError,
  fetchModelCatalog,
  iterateSseData,
  parseChunkPayload,
  parseModelCatalog,
  streamChat,
} from '../src/api.ts'

/**
 * Build a readable stream from raw SSE text.
 * @param text - the SSE payload.
 * @returns a byte stream over that text.
 */
function sseStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Build a stream that emits the text in fixed-size chunks, exercising frame
 * reassembly across read boundaries.
 * @param text - the SSE payload.
 * @param size - bytes per read.
 * @returns a byte stream over that text.
 */
function chunkedStream(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
  })
}

/**
 * Collect a stream's values.
 * @param source - the stream to drain.
 * @returns every yielded value.
 */
async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

describe('parseModelCatalog', () => {
  it('flattens groups into one deduplicated model list', () => {
    const models = parseModelCatalog({
      code: 200,
      body: {
        version: 15,
        inner_models: [
          {
            protocol: 'openai',
            group_name: 'mep',
            model_configs: [
              { id: 0, output: 32000, model_id: 'GLM-5.3', thinking_mode: 'on', context_window: 170000, tool_call_mode: 'tool_calls', input_modalities: ['text'] },
              { id: 2, output: 8192, model_id: 'Qwen3_VL_235B_A22B_Instruct', thinking_mode: 'configurable', context_window: 32768, tool_call_mode: 'none', input_modalities: ['text', 'image'] },
            ],
          },
        ],
      },
    })
    expect(models.map(model => model.id)).toEqual(['GLM-5.3', 'Qwen3_VL_235B_A22B_Instruct'])
    expect(models[0]).toMatchObject({ contextWindow: 170000, maxTokens: 32000, reasoning: true, toolCall: true, groupName: 'mep' })
    expect(models[1]).toMatchObject({ inputModalities: ['text', 'image'], toolCall: false, reasoning: true })
  })

  it('treats a configurable thinking mode as reasoning-capable', () => {
    const models = parseModelCatalog({
      body: { inner_models: [{ model_configs: [{ model_id: 'm', thinking_mode: 'configurable' }] }] },
    })
    expect(models[0]?.reasoning).toBe(true)
  })

  it('decodes reasoning_effort, which the gateway sends as a JSON string', () => {
    const models = parseModelCatalog({
      body: {
        inner_models: [{
          model_configs: [{
            model_id: 'GLM-5.3',
            reasoning_effort: JSON.stringify({ level: ['low', 'high', 'max'], default: 'high' }),
          }],
        }],
      },
    })
    expect(models[0]?.reasoningEffort).toEqual({ levels: ['low', 'high', 'max'], defaultLevel: 'high' })
  })

  it('drops the reasoning selector but keeps the model when the declaration is malformed', () => {
    const models = parseModelCatalog({
      body: { inner_models: [{ model_configs: [{ model_id: 'm', reasoning_effort: '{not json' }] }] },
    })
    expect(models).toHaveLength(1)
    expect(models[0]?.reasoningEffort).toBeUndefined()
  })

  it('accepts numeric strings for capacity fields', () => {
    const models = parseModelCatalog({
      body: { inner_models: [{ model_configs: [{ model_id: 'm', context_window: '65536', output: '4096' }] }] },
    })
    expect(models[0]).toMatchObject({ contextWindow: 65536, maxTokens: 4096 })
  })

  it('keeps only the first entry for a repeated model id', () => {
    const models = parseModelCatalog({
      body: {
        inner_models: [
          { group_name: 'a', model_configs: [{ model_id: 'dup', context_window: 111 }] },
          { group_name: 'b', model_configs: [{ model_id: 'dup', context_window: 222 }] },
        ],
      },
    })
    expect(models).toHaveLength(1)
    expect(models[0]?.contextWindow).toBe(111)
  })

  it('returns nothing for envelopes missing the model container', () => {
    expect(parseModelCatalog({ code: 200 })).toEqual([])
    expect(parseModelCatalog({ body: {} })).toEqual([])
    expect(parseModelCatalog(null)).toEqual([])
    expect(parseModelCatalog('nonsense')).toEqual([])
  })

  it('skips entries with no usable id', () => {
    const models = parseModelCatalog({ body: { inner_models: [{ model_configs: [{}, { id: 7 }, { model_id: 'ok' }] }] } })
    expect(models.map(model => model.id)).toEqual(['ok'])
  })
})

describe('iterateSseData', () => {
  it('yields one payload per frame and ignores the id lines', async () => {
    const payloads = await drain(iterateSseData(sseStream('id: 0\ndata: {"a":1}\n\nid: 1\ndata: {"b":2}\n\n')))
    expect(payloads).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('reassembles frames split across read boundaries', async () => {
    const text = 'id: 0\ndata: {"a":1}\n\nid: 1\ndata: {"b":2}\n\n'
    for (const size of [1, 3, 7, 64]) {
      const payloads = await drain(iterateSseData(chunkedStream(text, size)))
      expect(payloads, `chunk size ${size}`).toEqual(['{"a":1}', '{"b":2}'])
    }
  })

  it('emits a final frame that lacks its trailing blank line', async () => {
    expect(await drain(iterateSseData(sseStream('id: 0\ndata: {"a":1}')))).toEqual(['{"a":1}'])
  })

  it('skips keepalive and comment frames', async () => {
    expect(await drain(iterateSseData(sseStream(': keepalive\n\nid: 2\ndata: {"c":3}\n\n')))).toEqual(['{"c":3}'])
  })
})

describe('parseChunkPayload', () => {
  it('extracts content, usage, and the response id', () => {
    const chunk = parseChunkPayload(JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ index: 0, delta: { content: 'Hello', role: 'assistant' } }],
      usage: { prompt_tokens: 14, completion_tokens: 1 },
    }))
    expect(chunk).toMatchObject({ content: 'Hello', id: 'chatcmpl-1' })
    expect(chunk?.usage).toEqual({ promptTokens: 14, completionTokens: 1 })
  })

  it('separates reasoning from visible text', () => {
    expect(parseChunkPayload(JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] }))?.reasoning).toBe('thinking')
    expect(parseChunkPayload(JSON.stringify({ choices: [{ delta: { reasoning: 'thinking' } }] }))?.reasoning).toBe('thinking')
  })

  it('extracts streaming tool-call fragments', () => {
    const chunk = parseChunkPayload(JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"p"' } }] } }],
    }))
    expect(chunk?.toolCalls).toEqual([{ index: 0, id: 'call_1', name: 'read', arguments: '{"p"' }])
  })

  it('reports the stop reason', () => {
    expect(parseChunkPayload(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }))?.finishReason).toBe('stop')
  })

  it('returns nothing for the DONE sentinel and for empty payloads', () => {
    expect(parseChunkPayload('[DONE]')).toBeUndefined()
    expect(parseChunkPayload('   ')).toBeUndefined()
  })

  it('drops an unparsable frame instead of failing the request', () => {
    expect(parseChunkPayload('not json')).toBeUndefined()
  })

  it('does not report an empty content delta, so no empty block is opened', () => {
    expect(parseChunkPayload(JSON.stringify({ choices: [{ delta: { content: '', role: 'assistant' } }] }))?.content).toBeUndefined()
  })
})

describe('fetchModelCatalog', () => {
  const catalogBody = { code: 200, body: { inner_models: [{ group_name: 'mep', model_configs: [{ model_id: 'GLM-5.3' }] }] } }

  it('requests the catalog route with the bearer token and a JSON accept header', async () => {
    let seenUrl = ''
    let seenHeaders: Record<string, string> = {}
    const models = await fetchModelCatalog({
      accessToken: 'tok',
      fetchImpl: async (input, init) => {
        seenUrl = String(input)
        seenHeaders = (init?.headers ?? {}) as Record<string, string>
        return new Response(JSON.stringify(catalogBody), { status: 200 })
      },
    })
    expect(seenUrl).toBe(`${DEFAULT_BASE_URL}${MODEL_CONFIG_PATH}?localVersion=0&pluginVersion=CLI.unknown`)
    expect(seenHeaders.authorization).toBe('Bearer tok')
    // The gateway answers 406 when the catalog route is asked for an event stream.
    expect(seenHeaders.accept).toBe('application/json')
    expect(seenHeaders['Chat-Id']).toBeTruthy()
    expect(models.map(model => model.id)).toEqual(['GLM-5.3'])
  })

  it('names a rejected token and tells the operator to re-login', async () => {
    await expect(fetchModelCatalog({
      accessToken: 'stale',
      fetchImpl: async () => new Response(JSON.stringify({ errorCode: 4016, errorMsg: 'invalid accessToken.' }), { status: 200 }),
    })).rejects.toThrow(/Re-run `deveco providers login`/)
  })

  it('detects an authentication failure delivered inside an HTTP 200', async () => {
    // The gateway does not use status codes for its own errors: an
    // unauthenticated catalog call answers 200 with an errorCode body. This is
    // the exact response the live service returns, so a client that only
    // checked response.ok would silently report an empty catalog.
    await expect(fetchModelCatalog({
      accessToken: 'absent',
      fetchImpl: async () => new Response(
        JSON.stringify({ errorCode: 5002, errorMsg: 'Request parameter error. authorization is null.' }),
        { status: 200 },
      ),
    })).rejects.toMatchObject({ status: 401, errorCode: 5002 })
  })

  it('surfaces an unclassified application error with its code', async () => {
    const error = await fetchModelCatalog({
      accessToken: 'tok',
      fetchImpl: async () => new Response(JSON.stringify({ errorCode: 7777, errorMsg: 'quota exceeded' }), { status: 200 }),
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DevecoApiError)
    expect((error as DevecoApiError).errorCode).toBe(7777)
  })

  it('does not mistake the success channel `code` field for an error', async () => {
    const models = await fetchModelCatalog({
      accessToken: 'tok',
      fetchImpl: async () => new Response(JSON.stringify(catalogBody), { status: 200 }),
    })
    expect(models).toHaveLength(1)
  })

  it('reports an unreachable gateway with the origin it tried', async () => {
    await expect(fetchModelCatalog({
      accessToken: 'tok',
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED') },
    })).rejects.toThrow(/Could not reach the DevEco Code gateway/)
  })

  it('surfaces the gateway status for an unclassified failure', async () => {
    const error = await fetchModelCatalog({
      accessToken: 'tok',
      baseUrl: 'https://example.test',
      fetchImpl: async () => new Response('boom', { status: 503 }),
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DevecoApiError)
    expect((error as DevecoApiError).status).toBe(503)
  })
})

describe('streamChat', () => {
  /**
   * Drive streamChat against a canned SSE body.
   * @param body - the SSE text to serve.
   * @param init - captured request details.
   * @returns the decoded chunks.
   */
  async function run(body: string, captured: { body?: string; headers?: Record<string, string> } = {}) {
    return drain(streamChat({
      accessToken: 'tok',
      model: 'GLM-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async (_input, init) => {
        captured.body = String(init?.body ?? '')
        captured.headers = (init?.headers ?? {}) as Record<string, string>
        return new Response(sseStream(body), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    }))
  }

  it('always requests a stream and asks for an event stream', async () => {
    const captured: { body?: string; headers?: Record<string, string> } = {}
    await run('id: 0\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\n', captured)
    const body = JSON.parse(captured.body ?? '{}') as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.model).toBe('GLM-5.3')
    // The gateway rejects the non-streaming sibling route outright, so this
    // request must never be sent with stream:false.
    expect(captured.headers?.accept).toBe('text/event-stream')
  })

  it('sends tools and generation bounds when supplied', async () => {
    const captured: { body?: string } = {}
    await drain(streamChat({
      accessToken: 'tok',
      model: 'GLM-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 256,
      temperature: 0.2,
      tools: [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object' } } }],
      fetchImpl: async (_input, init) => {
        captured.body = String(init?.body ?? '')
        return new Response(sseStream('data: [DONE]\n\n'), { status: 200 })
      },
    }))
    const body = JSON.parse(captured.body ?? '{}') as Record<string, unknown>
    expect(body.max_tokens).toBe(256)
    expect(body.temperature).toBe(0.2)
    expect(body.tools).toHaveLength(1)
  })

  it('streams decoded chunks in arrival order', async () => {
    const chunks = await run(
      'id: 0\ndata: {"id":"c1","choices":[{"delta":{"content":"Hel"}}]}\n\n'
      + 'id: 1\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
      + 'id: 2\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    )
    expect(chunks.map(chunk => chunk.content).filter(Boolean)).toEqual(['Hel', 'lo'])
    expect(chunks.at(-1)?.finishReason).toBe('stop')
  })

  it('posts to the chat route', async () => {
    let url = ''
    await drain(streamChat({
      accessToken: 'tok',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async (input) => {
        url = String(input)
        return new Response(sseStream(''), { status: 200 })
      },
    }))
    expect(url).toBe(`${DEFAULT_BASE_URL}${CHAT_PATH}`)
  })
})
