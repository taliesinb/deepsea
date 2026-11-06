/**
 * Pure helpers for the test driver: request checks, the turn summary over
 * session events, event selection. No harness imports.
 */
import { timingSafeEqual } from 'node:crypto'

/** The driver's route on the server, outside DSH's own `/api`. A wire name kept from the plugin's old name (test-driver): dsd drive calls it. */
export const CHANNEL = '/deepsea-test-driver'

/** The state file, relative to the home: `{ pid, port, baseUrl, token, … }`. A wire name kept from the plugin's old name (test-driver): dsd drive reads it. */
export const STATE_FILE = 'run/test-driver.json'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Whether a request may use the driver: a loopback peer, no `Origin` header
 * (no web page can reach it), and the process's bearer token.
 * @returns {undefined | { status: number, message: string }} the refusal, if any
 */
export function rejectRequest({ remoteAddress, headers }, token) {
  if (!LOOPBACK.has(remoteAddress ?? '')) return { status: 403, message: 'loopback only' }
  if (headers.origin !== undefined) return { status: 403, message: 'browser requests are not accepted' }
  const header = headers.authorization
  const presented = Buffer.from(typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(token)
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { status: 401, message: 'missing or wrong bearer token' }
  return undefined
}

/** Plain text of a content array. */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
}

const clip = (text, n = 400) => (text.length > n ? `${text.slice(0, n)}…` : text)

/**
 * What a run of events did: assistant text and reasoning, tool calls with
 * their outcomes, command results, and how the last turn ended.
 * @param {readonly any[]} events - session events, already sliced to the interval
 */
export function summarize(events) {
  const tools = []
  const byCall = new Map()
  const commands = []
  const commandNames = new Map()
  const texts = []
  let reasoning = 0
  let turns = 0
  let turnEnd
  for (const event of events) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start': turns += 1; break
      case 'turn/end': {
        const reason = data.reason ?? {}
        turnEnd = { kind: reason.kind ?? 'unknown', ...(reason.error ? { error: { code: reason.error.code, message: clip(String(reason.error.message ?? '')) } } : {}) }
        break
      }
      case 'assistant/message': {
        const content = data.message?.content ?? []
        const text = textOf(content)
        if (text.trim() !== '') texts.push(text)
        reasoning += content.filter(b => b?.type === 'reasoning').length
        break
      }
      case 'tool/call': {
        const row = { callId: String(data.callId ?? ''), name: String(data.name ?? '?') }
        tools.push(row)
        byCall.set(row.callId, row)
        break
      }
      case 'tool/result': {
        const message = data.message ?? {}
        const row = byCall.get(String(message.toolCallId ?? ''))
        if (row !== undefined) {
          row.ok = message.isError !== true && data.error === undefined
          row.output = clip(textOf(message.content))
          if (data.error?.code) row.errorCode = data.error.code
        }
        break
      }
      case 'command/run': commandNames.set(data.commandId, data.name); break
      case 'command/done':
        commands.push({ name: commandNames.get(data.commandId), kind: data.kind, ...(data.text === undefined ? {} : { text: data.text }) })
        break
      default: break
    }
  }
  return {
    turns,
    ...(turnEnd === undefined ? {} : { turnEnd }),
    ...(texts.length === 0 ? {} : { text: texts.at(-1), texts }),
    ...(reasoning === 0 ? {} : { reasoningBlocks: reasoning }),
    tools,
    commands,
  }
}

/**
 * Events from `since` on, optionally only some types (`tool/*` matches a
 * prefix), at most the last `limit`.
 */
export function selectEvents(events, { since = 0, types, limit = 200 } = {}) {
  const wanted = Array.isArray(types) && types.length > 0 ? types : undefined
  const match = type => wanted === undefined || wanted.some(t => (t.endsWith('/*') ? type.startsWith(t.slice(0, -1)) : type === t))
  const out = events.filter(e => (e.seq ?? 0) >= since && match(e.type))
  return out.length > limit ? out.slice(-limit) : out
}
