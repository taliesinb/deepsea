import { acquirePassiveFetch } from './passive-fetch.mjs'
import { parseTelemetryJSON, openRouterEvidence } from './providers.mjs'
export { requestKind } from './passive-fetch.mjs'

/** Bounded parser: at most 64K UTF-16 code units per SSE event or 256K for JSON.
 * Oversized SSE events are discarded through their blank line, not truncated into fake JSON.
 */
export function telemetryParser(format, publish, { eventLimit = 65536, jsonLimit = 262144 } = {}) {
  const decoder = new TextDecoder()
  let buffer = '', event = '', dropping = false, oversized = false, skipLF = false
  const parse = text => {
    try {
      const evidence = openRouterEvidence(parseTelemetryJSON(text))
      if (evidence) publish(evidence)
    } catch { /* malformed provider metadata never changes inference */ }
  }
  const line = text => {
    if (text.endsWith('\r')) text = text.slice(0, -1)
    if (!text) {
      if (!oversized && event) parse(event)
      event = ''; oversized = false
    } else if (!oversized && text.startsWith('data:')) {
      const piece = text.slice(5).replace(/^ /, '')
      if (event.length + piece.length + 1 > eventLimit) { event = ''; oversized = true }
      else event += (event ? '\n' : '') + piece
    }
  }
  const feed = text => {
    if (format === 'json') {
      if (oversized) return
      if (buffer.length + text.length > jsonLimit) { buffer = ''; oversized = true }
      else buffer += text
      return
    }
    // Process small decoded slices so a single giant upstream chunk cannot allocate
    // an unbounded concatenated line in observer-owned state.
    let start = 0
    if (skipLF && text.length) { if (text[0] === '\n') start = 1; skipLF = false }
    for (; start < text.length;) {
      const lf = text.indexOf('\n', start), cr = text.indexOf('\r', start)
      const newline = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr)
      const end = newline < 0 ? text.length : newline
      if (!dropping) {
        if (buffer.length + end - start > eventLimit) { buffer = ''; event = ''; oversized = true; dropping = true }
        else buffer += text.slice(start, end)
      }
      if (newline < 0) break
      if (!dropping) line(buffer)
      buffer = ''; dropping = false; start = newline + 1
      if (text[newline] === '\r') {
        if (text[start] === '\n') start++
        else if (start === text.length) skipLF = true
      }
    }
  }
  return {
    push(bytes) {
      for (let offset = 0; offset < bytes.length; offset += 4096) feed(decoder.decode(bytes.subarray(offset, offset + 4096), { stream: true }))
    },
    end() {
      feed(decoder.decode())
      if (format === 'json') { if (!oversized) parse(buffer) }
      else if (!dropping) { if (buffer) line(buffer); line('') }
      buffer = ''; event = ''
    },
    clear() { buffer = ''; event = ''; oversized = true },
  }
}

/** Demand-driven tap, not Response.clone()/tee(): zero eager reads, no second consumer.
 * Original chunk identities, read errors and cancellation reasons pass through unchanged.
 */
export function tapResponse(response, publish) {
  const contentType = response.headers.get('content-type') ?? ''
  const format = /^text\/event-stream(?:;|$)/i.test(contentType) ? 'sse'
    : /^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(contentType) ? 'json' : undefined
  if (!format || !response.body || response.bodyUsed || response.body.locked) return response
  const source = response.body
  const parser = telemetryParser(format, publish)
  let reader
  const body = new ReadableStream({
    async pull(controller) {
      // Acquire only when the native consumer asks; telemetry never advances independently.
      reader ??= source.getReader()
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          try { parser.end() } catch { /* observer failure */ }
          controller.close(); reader.releaseLock()
        } else {
          try { parser.push(chunk.value) } catch { parser.clear() }
          controller.enqueue(chunk.value)
        }
      } catch (error) { parser.clear(); controller.error(error); reader.releaseLock() }
    },
    async cancel(reason) {
      parser.clear()
      if (reader) { try { await reader.cancel(reason) } finally { reader.releaseLock() } }
      else await source.cancel(reason)
    },
  }, { highWaterMark: 0 })
  const tapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  for (const key of ['url', 'redirected', 'type']) Object.defineProperty(tapped, key, { value: response[key] })
  return tapped
}

/** Join the shared passive capture protocol used by audit observe mode as well.
 * Body parsing remains provider-specific; the shared broker selects one parser
 * and multicasts its sanitized evidence to interested billing subscribers.
 */
export function acquireBroker(target = globalThis) {
  const subscription = acquirePassiveFetch(target)
  const bodyTap = Object.freeze({ key: 'openrouter-cost-v1', apply: tapResponse })
  return {
    run: (state, callback) => subscription.run(state ? { ...state, bodyTap } : undefined, callback),
    release: subscription.release,
  }
}
