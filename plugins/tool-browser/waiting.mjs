/**
 * One host-side wait engine for both browsers.
 *
 * Left alone, agents wait inside an evaluate expression (`await new
 * Promise(r => setTimeout(r, N))`), where anything near the MCP request
 * timeout fails, or poll by repeating the same call. Here the page is polled
 * in short in-page slices (each well under the MCP timeout) from a host loop
 * that owns the overall deadline, so a 60 s wait is fine.
 *
 * A wait spec:
 *   text        string | string[] — any of these appears in document.body.innerText
 *   selector    CSS selector matches at least one element
 *   expression  JS function body (await allowed) whose return value is truthy
 *   settleMs    plain pause (after the condition, or alone)
 *   timeout     overall budget in ms (default 30 000; 0 = only settle)
 *
 * text / selector / expression are alternatives: the wait ends when ANY holds.
 * The result names what matched (or that it timed out) and the elapsed time;
 * a timeout is a fact for the caller to report, never an exception here.
 */

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_SLICE_MS = 5_000
const POLL_MS = 100

/** Parameter fragment shared by every tool that accepts `wait`. */
export const WAIT_PARAM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'array', items: { type: 'string' }, description: 'Wait until any of these texts appears on the page.' },
    selector: { type: 'string', description: 'Wait until this CSS selector matches at least one element.' },
    expression: { type: 'string', description: 'Wait until this JS function body (await allowed) returns a truthy value; the value is reported.' },
    settleMs: { type: 'number', description: 'Extra pause in ms after the condition holds (or alone, when no condition is given).' },
    timeout: { type: 'number', description: `Overall budget in ms (default ${DEFAULT_TIMEOUT_MS}). A timeout is reported, not thrown; the main action still runs.` },
  },
  description: 'Wait BEFORE acting: for text / a selector / a truthy expression (any of them), and/or a settle pause. Replaces `await new Promise(r => setTimeout(r, N))` inside expressions and repeated polling calls.',
}

/** Normalise a wait spec from tool args; undefined when nothing to wait for. */
export function parseWait(spec) {
  if (spec === undefined || spec === null) return undefined
  if (typeof spec !== 'object') throw new Error('wait must be an object { text?, selector?, expression?, settleMs?, timeout? }')
  const text = spec.text === undefined ? undefined : (Array.isArray(spec.text) ? spec.text : [spec.text]).map(String).filter(s => s !== '')
  const out = {
    text: text && text.length ? text : undefined,
    selector: typeof spec.selector === 'string' && spec.selector.trim() !== '' ? spec.selector : undefined,
    expression: typeof spec.expression === 'string' && spec.expression.trim() !== '' ? spec.expression : undefined,
    settleMs: Math.max(0, Number(spec.settleMs) || 0),
    timeout: spec.timeout === undefined ? DEFAULT_TIMEOUT_MS : Math.max(0, Number(spec.timeout) || 0),
  }
  if (!out.text && !out.selector && !out.expression && out.settleMs === 0) return undefined
  return out
}

/** The condition part of a spec, for messages. */
export function describeCondition(spec) {
  const parts = []
  if (spec.text) parts.push(`text ${spec.text.map(t => JSON.stringify(t)).join(' / ')}`)
  if (spec.selector) parts.push(`selector ${JSON.stringify(spec.selector)}`)
  if (spec.expression) parts.push(`expression ${JSON.stringify(spec.expression.length > 80 ? `${spec.expression.slice(0, 79)}…` : spec.expression)}`)
  return parts.join(' or ')
}

/**
 * The in-page polling slice: a function BODY (await allowed) that returns
 * `{ found: { kind, value } | null }` within `sliceMs`.
 */
export function pollBody(spec, sliceMs) {
  return `const spec = ${JSON.stringify({ text: spec.text ?? null, selector: spec.selector ?? null, expression: spec.expression ?? null })};
const deadline = Date.now() + ${Math.max(50, Math.floor(sliceMs))};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const probe = spec.expression ? new AsyncFunction(spec.expression) : null;
const check = async () => {
  if (spec.text) { const t = document.body ? document.body.innerText : ''; const hit = spec.text.find(x => t.includes(x)); if (hit !== undefined) return { kind: 'text', value: hit }; }
  if (spec.selector) { const n = document.querySelectorAll(spec.selector).length; if (n > 0) return { kind: 'selector', value: n }; }
  if (probe) { const v = await probe(); if (v) return { kind: 'expression', value: v }; }
  return null;
};
while (true) {
  const r = await check();
  if (r) return { found: r };
  if (Date.now() >= deadline) return { found: null };
  await new Promise(res => setTimeout(res, ${POLL_MS}));
}`
}

/**
 * Run a wait against a page.
 * @param {(body: string) => Promise<unknown>} evaluate - runs a JS function body in the page and returns its parsed value
 * @param {ReturnType<typeof parseWait>} spec
 * @param {{ maxSliceMs?: number, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<{ found: { kind: string, value: unknown } | null, timedOut: boolean, elapsedMs: number, settledMs: number, summary: string }>}
 */
export async function runWait(evaluate, spec, opts = {}) {
  const sleep = opts.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
  const maxSlice = opts.maxSliceMs ?? MAX_SLICE_MS
  const started = Date.now()
  let found = null
  let timedOut = false
  const hasCondition = Boolean(spec.text || spec.selector || spec.expression)
  if (hasCondition) {
    const deadline = started + spec.timeout
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) { timedOut = true; break }
      const slice = Math.min(maxSlice, remaining)
      const result = await evaluate(pollBody(spec, slice))
      const hit = result && typeof result === 'object' ? result.found : null
      if (hit) { found = hit; break }
    }
  }
  if (spec.settleMs > 0) await sleep(spec.settleMs)
  const elapsedMs = Date.now() - started
  const secs = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  let summary
  if (!hasCondition) summary = `settled ${spec.settleMs} ms`
  else if (timedOut) summary = `wait timed out after ${secs(spec.timeout)} for ${describeCondition(spec)}${spec.settleMs ? `, then settled ${spec.settleMs} ms` : ''}`
  else {
    const what = found.kind === 'text' ? `text ${JSON.stringify(found.value)} appeared`
      : found.kind === 'selector' ? `selector ${JSON.stringify(spec.selector)} matched ${found.value} element${found.value === 1 ? '' : 's'}`
        : `expression returned ${clipJson(found.value)}`
    summary = `waited ${secs(elapsedMs - spec.settleMs)}: ${what}${spec.settleMs ? `, then settled ${spec.settleMs} ms` : ''}`
  }
  return { found, timedOut, elapsedMs, settledMs: spec.settleMs, summary }
}

function clipJson(value, max = 200) {
  let s
  try { s = JSON.stringify(value) } catch { s = String(value) }
  if (s === undefined) s = String(value)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
