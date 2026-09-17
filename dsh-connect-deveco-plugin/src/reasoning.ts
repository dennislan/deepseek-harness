/**
 * Split model output that carries its thinking inline in the content stream.
 *
 * GLM models on the DevEco Code gateway stream their chain of thought inside the
 * ordinary content field, terminated by a bare `</think>` with no opening tag:
 *
 *     "17 * 23 = 391</think>**391**"
 *
 * Nothing in the wire format marks where the reasoning starts, so the whole
 * prefix before the terminator is reasoning and everything after it is the
 * answer. Passing the prefix through as visible text would show the user the
 * model's private working.
 *
 * The terminator can straddle two network chunks, so a chunk ending in `<`, `</`,
 * `</t`, and so on must not be classified until enough of it has arrived. Text
 * that could still become a terminator is therefore held back, and released as
 * answer text once the buffer proves it is something else.
 *
 * @module dsh-connect-deveco/reasoning
 */

/** One classified span of the content stream. */
export interface ReasoningSpan {
  /** Whether this span is the model's thinking or its answer. */
  kind: 'reasoning' | 'text'
  /** The span's text. */
  text: string
}

/** The terminator the gateway emits at the reasoning/answer boundary. */
const TERMINATOR = '</think>'

/**
 * Length of the longest proper prefix of the terminator, which is the most text
 * that can be withheld while still being able to complete the terminator.
 */
const MAX_HOLDBACK = TERMINATOR.length - 1

/** Stateful content splitter for one response stream. */
export interface ReasoningSplitter {
  /**
   * Classify one arriving content chunk.
   *
   * Returns nothing when the chunk is entirely a candidate terminator prefix and
   * must be withheld; a later call then carries it.
   *
   * @param input - the content fragment that just arrived.
   * @returns the classified spans, in order.
   */
  push: (input: string) => ReasoningSpan[]
  /**
   * Flush anything still held back at end of stream.
   *
   * Any withheld text that never completed a terminator was ordinary answer
   * text, so it is returned as such rather than dropped.
   *
   * @returns the final classified spans.
   */
  flush: () => ReasoningSpan[]
}

/**
 * Create a splitter for one response stream.
 * @returns a stateful splitter.
 */
export function createReasoningSplitter(): ReasoningSplitter {
  let buffer = ''
  // Once the terminator is seen, the stream never returns to reasoning.
  let inAnswer = false

  const push = (input: string): ReasoningSpan[] => {
    if (inAnswer) return input.length > 0 ? [{ kind: 'text', text: input }] : []
    buffer += input
    const boundary = buffer.indexOf(TERMINATOR)
    if (boundary !== -1) {
      inAnswer = true
      const reasoning = buffer.slice(0, boundary)
      const answer = buffer.slice(boundary + TERMINATOR.length)
      buffer = ''
      const spans: ReasoningSpan[] = []
      if (reasoning.length > 0) spans.push({ kind: 'reasoning', text: reasoning })
      if (answer.length > 0) spans.push({ kind: 'text', text: answer })
      return spans
    }
    // Emit everything that can no longer be part of a terminator, and hold the
    // rest back until the next chunk decides whether it completes one.
    const holdback = Math.min(MAX_HOLDBACK, buffer.length)
    let cut = buffer.length - holdback
    // A shorter holdback suffices when the buffer's tail cannot be a prefix;
    // trimming to the longest suffix that is one keeps latency minimal.
    while (cut < buffer.length && !TERMINATOR.startsWith(buffer.slice(cut))) cut += 1
    const ready = buffer.slice(0, cut)
    buffer = buffer.slice(cut)
    return ready.length > 0 ? [{ kind: 'reasoning', text: ready }] : []
  }

  const flush = (): ReasoningSpan[] => {
    const held = buffer
    buffer = ''
    if (held.length === 0) return []
    return [{ kind: inAnswer ? 'text' : 'reasoning', text: held }]
  }

  return { push, flush }
}
