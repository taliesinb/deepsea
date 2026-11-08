/**
 * Model scripts: the JSONL language a prompt uses to dictate a model's exact
 * reply (text, reasoning, tool calls, checks, loops, usage, errors). Shared
 * by the scripted model (plugins/llm-scripted) and the provider simulator
 * (tools/provider-sim), which plays the same scripts in each provider's wire
 * protocol. Pure: no dependencies.
 *
 *   grammar.mjs  the commands, parsing and validation, `help`
 *   values.mjs   value expressions and the JSON context
 *   run.mjs      the interpreter: replay to a response, then its actions
 */
import { helpText } from './grammar.mjs'

export * from './grammar.mjs'
export * from './values.mjs'
export * from './run.mjs'

/** The reply to a prompt that is not a script and not a plain command. */
export const ORDERS_REPLY = "Awaiting orders, m'lord"

/** The reply of a response with nothing else to show: the script ended, or its last response only saves or checks. */
export const FINISHED_REPLY = 'Script finished.'

/**
 * The reply to a prompt that is not a script: `say <text>` (one line) answers `<text>`, `help` the
 * command table, anything else the standing reply.
 */
export function plainReply(text) {
  const trimmed = text.trim()
  if (/^help$/i.test(trimmed)) return helpText()
  const say = /^say\s+(.+)$/i.exec(trimmed)
  if (say && !/[\r\n]/.test(say[1])) return say[1].trim()
  return ORDERS_REPLY
}

/** Whether a prompt is meant as a script: its text starts with `{` (leading whitespace ignored). */
export function isScript(text) {
  return text.trimStart().startsWith('{')
}

/** Split `text` into `n` nearly equal pieces (for chunked streaming). */
export function chunk(text, n = 1) {
  if (n <= 1 || text.length <= 1) return [text]
  const size = Math.ceil(text.length / Math.min(n, text.length))
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}
