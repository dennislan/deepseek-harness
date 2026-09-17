/**
 * Behaviour tests for the inline reasoning splitter.
 *
 * The splitter exists because GLM models on this gateway put their thinking in
 * the ordinary content stream, terminated by a bare `</think>`. The property
 * that matters is that no fragment of the terminator is ever shown to the user
 * as an answer, including when it is split across chunks at any offset.
 */

import { describe, expect, it } from 'vitest'
import { createReasoningSplitter } from '../src/reasoning.ts'
import type { ReasoningSpan } from '../src/reasoning.ts'

/**
 * Feed chunks through a splitter and collect every emitted span.
 * @param chunks - the content fragments, in arrival order.
 * @returns all spans, including the flush.
 */
function run(chunks: readonly string[]): ReasoningSpan[] {
  const splitter = createReasoningSplitter()
  const spans: ReasoningSpan[] = []
  for (const chunk of chunks) spans.push(...splitter.push(chunk))
  spans.push(...splitter.flush())
  return spans
}

/**
 * Join spans of one kind.
 * @param spans - the spans to search.
 * @param kind - which kind to collect.
 * @returns the concatenated text of that kind.
 */
function join(spans: readonly ReasoningSpan[], kind: ReasoningSpan['kind']): string {
  return spans.filter(span => span.kind === kind).map(span => span.text).join('')
}

describe('createReasoningSplitter', () => {
  it('splits a whole response in one chunk', () => {
    const spans = run(['thinking hard</think>the answer'])
    expect(join(spans, 'reasoning')).toBe('thinking hard')
    expect(join(spans, 'text')).toBe('the answer')
  })

  it('treats a response with no terminator as all reasoning', () => {
    // The model always emits the terminator before an answer on this gateway,
    // so its absence means the stream is still inside the reasoning prefix.
    const spans = run(['still thinking about it'])
    expect(join(spans, 'reasoning')).toBe('still thinking about it')
    expect(join(spans, 'text')).toBe('')
  })

  it('handles an immediate terminator with no reasoning', () => {
    const spans = run(['</think>answer'])
    expect(join(spans, 'reasoning')).toBe('')
    expect(join(spans, 'text')).toBe('answer')
  })

  it('handles a terminator with nothing after it', () => {
    const spans = run(['thinking</think>'])
    expect(join(spans, 'reasoning')).toBe('thinking')
    expect(join(spans, 'text')).toBe('')
  })

  it('never emits terminator characters as answer text, at any split offset', () => {
    const full = 'reasoning part</think>the visible answer'
    const terminator = '</think>'
    const boundary = full.indexOf(terminator)
    // Splitting at every offset is the case that a naive buffer would corrupt.
    for (let cut = 0; cut <= full.length; cut += 1) {
      const spans = run([full.slice(0, cut), full.slice(cut)])
      expect(join(spans, 'reasoning'), `cut ${cut}`).toBe('reasoning part')
      expect(join(spans, 'text'), `cut ${cut}`).toBe('the visible answer')
      expect(join(spans, 'text'), `cut ${cut} leaked tag`).not.toContain('<')
      void boundary
    }
  })

  it('reassembles a terminator delivered one character at a time', () => {
    const spans = run([...'think</think>answer'])
    expect(join(spans, 'reasoning')).toBe('think')
    expect(join(spans, 'text')).toBe('answer')
  })

  it('keeps answer text free of a partial tag held across chunks', () => {
    const spans = run(['secret</thi', 'nk>', 'public'])
    expect(join(spans, 'reasoning')).toBe('secret')
    expect(join(spans, 'text')).toBe('public')
  })

  it('does not split on a lookalike tag that is not the terminator', () => {
    const spans = run(['uses <thinking> markup and finishes</think>done'])
    expect(join(spans, 'reasoning')).toBe('uses <thinking> markup and finishes')
    expect(join(spans, 'text')).toBe('done')
  })

  it('passes text through untouched once the terminator is seen', () => {
    const spans = run(['a</think>', 'b<', '/think>', 'c'])
    // A second terminator is ordinary answer text, not another boundary.
    expect(join(spans, 'text')).toBe('b</think>c')
  })

  it('emits reasoning incrementally instead of buffering the whole prefix', () => {
    const splitter = createReasoningSplitter()
    const first = splitter.push('a long stretch of thinking that cannot be a tag')
    // A caller renders reasoning as it arrives; withholding it all until the
    // terminator would stall the display for the entire prefix.
    expect(join(first, 'reasoning').length).toBeGreaterThan(0)
  })

  it('returns spans that never mix kinds in one call', () => {
    const splitter = createReasoningSplitter()
    for (const span of [...splitter.push('thinking</think>answer'), ...splitter.flush()]) {
      expect(['reasoning', 'text']).toContain(span.kind)
      expect(span.text.length).toBeGreaterThan(0)
    }
  })

  it('reports nothing for an empty chunk', () => {
    expect(run([''])).toEqual([])
  })
})
