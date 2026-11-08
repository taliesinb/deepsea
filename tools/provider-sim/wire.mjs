/**
 * What a simulated model says, and how it is put on the wire.
 *
 * A provider request carries the whole conversation. The person's prompt is
 * the latest user message whose text starts a turn (the conversation's first
 * message, or one after an assistant reply without tool calls); its first text
 * part is the prompt, so context the harness appends after it is ignored. The
 * prompt plays like the scripted model's (packages/script): a script's
 * responses in order, one per request of the turn (counted by the assistant
 * messages since the prompt), or a plain prompt's single reply.
 *
 * Two wire formats: OpenAI chat completions and Anthropic messages, each
 * streamed (server-sent events) or whole.
 */
import { createHash } from 'node:crypto'
import {
  checkExpectation, chunk, ERROR_KINDS, FINISHED_REPLY, isScript, newContext, parseScript, plainReply, recordTool, resume,
  ScriptExpectationError, ScriptValueError,
} from '../../packages/script/index.mjs'

/** Rough token count of a text: four characters per token, at least one for non-empty text. */
export const tokens = text => text ? Math.max(1, Math.ceil(String(text).length / 4)) : 0

// ---- reading a conversation ------------------------------------------------------

const textParts = (content) => {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text)
}

/** A conversation in a neutral shape: `{ role, texts, toolCalls, toolResults }` per message. */
export function normalize(format, messages) {
  return (messages ?? []).map((m) => {
    if (format === 'openai') {
      if (m.role === 'tool') return { role: 'tool', texts: [], toolCalls: 0, toolResults: [{ id: m.tool_call_id, text: textParts(m.content).join('') || String(m.content ?? '') }] }
      return { role: m.role, texts: textParts(m.content), toolCalls: (m.tool_calls ?? []).length, toolResults: [] }
    }
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? [])
    const results = blocks.filter(b => b.type === 'tool_result').map(b => ({
      id: b.tool_use_id,
      text: typeof b.content === 'string' ? b.content : textParts(b.content).join(''),
      isError: b.is_error === true,
    }))
    return { role: m.role, texts: blocks.filter(b => b.type === 'text').map(b => b.text), toolCalls: blocks.filter(b => b.type === 'tool_use').length, toolResults: results }
  })
}

/**
 * The prompt and how far its turn has got: the responses since it (one per
 * assistant message), each with the tool results that answered it.
 * @returns {{ prompt: string, position: number, responses: { results: object[] }[] }}
 */
export function promptOf(conversation) {
  let index = -1
  let prompt = ''
  for (let i = 0; i < conversation.length; i++) {
    const m = conversation[i]
    if (m.role !== 'user' || m.texts.length === 0) continue
    // A turn starts the conversation or follows a final reply; user messages
    // right after the prompt (context the harness adds) do not start one.
    const previous = conversation.slice(0, i).filter(x => x.role !== 'system').at(-1)
    const startsTurn = previous === undefined || (previous.role === 'assistant' && previous.toolCalls === 0)
    if (startsTurn && m.toolResults.length === 0) { index = i; prompt = m.texts[0]; continue }
    // A failed turn leaves no reply: the next prompt follows the failed one
    // (or, after a tool call, shares the message carrying its results). A
    // script or a plain command there starts a new turn; harness context is
    // neither.
    const next = m.texts.find(looksLikePrompt)
    if (next !== undefined && (previous?.role === 'user' || m.toolResults.length > 0)) { index = i; prompt = next }
  }
  if (index === -1) return { prompt: '', position: 0, responses: [] }
  const responses = []
  for (const m of conversation.slice(index + 1)) {
    if (m.role === 'assistant') responses.push({ results: [] })
    else responses.at(-1)?.results.push(...m.toolResults)
  }
  return { prompt, position: responses.length, responses }
}

/** Whether a text is a prompt the simulator acts on: a script, or `say …` / `help`. */
const looksLikePrompt = text => isScript(text) || /^\s*(?:say\s+\S|help\s*$)/i.test(text)

// ---- what to say -------------------------------------------------------------------

/** How the harness's session titler frames its request (session-title-llm). */
export const TITLE_REQUEST = 'Generate the session title from this JSON array of human messages:'
/** How the harness's compaction asks for a checkpoint (compaction-basic). */
export const COMPACTION_REQUEST = 'acting as a compaction engine'
/** The reply to a compaction request, as the scripted model's. */
export const COMPACTION_SUMMARY = 'Summary: a simulated session.'
/** The title when the session's scripts set none, as the scripted model's. */
export const DEFAULT_TITLE = 'scripted session'

/** The `title` command of the first script among the titler's framed messages. */
function scriptTitle(framed) {
  let messages
  try { messages = JSON.parse(framed.slice(TITLE_REQUEST.length)) } catch { return undefined }
  const texts = JSON.stringify(messages).match(/"(?:[^"\\]|\\.)*"/g)?.map(t => JSON.parse(t)) ?? []
  for (const text of texts) {
    if (!isScript(text)) continue
    const title = parseScript(text).commands.find(c => c.cmd === 'title')
    if (title) return title.text
  }
  return undefined
}

/** Responses an `error` command with `times` has failed so far: `<script hash>:<line>` → count. */
const failures = new Map()

/**
 * The response to play: `{ steps }` (script commands for this response),
 * `{ invalid }` (an unparsable script) or `{ failure }` (an `error` command or
 * a failed `expect`).
 */
export function respond(conversation, system = '') {
  // The harness's own side requests answer as the scripted model answers them, never by
  // replaying the session's script (which would play, and charge, its turn again).
  const texts = [system, ...conversation.flatMap(m => m.texts)]
  if (texts.some(t => t.includes(COMPACTION_REQUEST))) return { steps: [{ cmd: 'say', text: COMPACTION_SUMMARY }] }
  const first = conversation.find(m => m.role === 'user')?.texts[0] ?? ''
  if (first.startsWith(TITLE_REQUEST)) return { steps: [{ cmd: 'say', text: scriptTitle(first) ?? DEFAULT_TITLE }] }
  const { prompt, position, responses } = promptOf(conversation)
  if (!isScript(prompt)) return { steps: position === 0 ? [{ cmd: 'say', text: plainReply(prompt) }] : [{ cmd: 'say', text: FINISHED_REPLY }] }
  const { commands, errors } = parseScript(prompt)
  if (errors.length > 0) return { invalid: `The script is invalid:\n${errors.join('\n')}` }
  const hash = createHash('sha256').update(prompt).digest('hex').slice(0, 12)
  // The script's earlier responses are replayed into a fresh context; the simulator sees only the text of
  // tool results, so `result` is null. Globals do not carry over from earlier scripts, and the conversation's
  // calls (`session.tools`) are this script's own.
  const context = newContext()
  context.session.tools = context.tools
  const steps = []
  try {
    const run = resume(commands, context, position, (n, calls) => recordResults(context, calls, responses[n]?.results ?? []))
    if (run === undefined) return { steps: [{ cmd: 'say', text: FINISHED_REPLY }] }
    for (;;) {
      const { value: action, done } = run.next()
      if (done || action.op === 'suspend') break
      const step = action.evaluate()
      if (step.cmd === 'expect') checkExpectation(step, context)
      else if (step.cmd === 'error') {
        const key = `${hash}:${action.key}`
        const count = (failures.get(key) ?? 0) + 1
        failures.set(key, count)
        if (step.times === undefined || count <= step.times) {
          const kind = ERROR_KINDS[step.kind]
          return { failure: { status: step.status ?? kind.status ?? 500, kind: step.kind, message: step.message ?? `simulated ${step.kind}`, retryAfter: step.retryAfter } }
        }
      } else steps.push(step.cmd === 'tool' ? { ...step, id: wireId(action) } : step)
    }
  } catch (error) {
    if (error instanceof ScriptValueError || error instanceof ScriptExpectationError) return { failure: { status: 400, kind: 'invalid-request', message: error.message } }
    throw error
  }
  // A response with nothing to show (only saves or checks after the last tool calls) says the script is done.
  if (!steps.some(s => s.cmd === 'say' || s.cmd === 'think' || s.cmd === 'tool')) steps.unshift({ cmd: 'say', text: FINISHED_REPLY })
  return { steps, hash }
}

/** A scripted tool call's id on the wire: its run key when the script named it (`id`, with loop indices), else the wire's own. */
const wireId = action => action.command.id === undefined ? undefined : action.key

/**
 * Record a response's tool calls with the results that answered them: by
 * id, then (results without a usable id, as Gemini before 3 sends them) by
 * tool name in order, then in order.
 */
function recordResults(context, calls, results) {
  const pool = [...results]
  const matched = new Map()
  const take = (call, i) => { if (i >= 0) matched.set(call, pool.splice(i, 1)[0]) }
  for (const call of calls) if (wireId(call) !== undefined) take(call, pool.findIndex(r => r.id === wireId(call)))
  for (const call of calls) {
    if (matched.has(call)) continue
    const name = call.replayed?.name ?? call.command.name
    const byName = pool.findIndex(r => r.name === name)
    take(call, byName >= 0 ? byName : pool.findIndex(r => r.name === undefined))
  }
  for (const call of calls) {
    const result = matched.get(call)
    if (result === undefined) continue
    const ok = result.isError !== true
    recordTool(context, {
      name: call.replayed?.name ?? call.command.name, args: call.replayed?.args ?? {}, result: null, text: result.text, duration: null,
      error: ok ? null : { message: result.text }, ok,
    }, call.command.id)
  }
}

/** The blocks a response's steps produce, its usage override and finish. */
export function blocksOf(steps) {
  const blocks = []
  let usage
  let finish
  for (const step of steps) {
    if (step.cmd === 'say' || step.cmd === 'think') blocks.push({ type: step.cmd === 'say' ? 'text' : 'thinking', text: step.text, chunks: step.chunks, chunkDelay: step.chunkDelay })
    else if (step.cmd === 'tool') blocks.push({ type: 'tool', id: step.id, name: step.name, args: step.args ?? {} })
    else if (step.cmd === 'sleep') blocks.push({ type: 'sleep', time: step.time })
    else if (step.cmd === 'usage') usage = step
    else if (step.cmd === 'end') finish = step.reason ?? 'stop'
  }
  const hasTool = blocks.some(b => b.type === 'tool')
  return { blocks, usage, finish: finish ?? (hasTool ? 'tool' : 'stop') }
}

/** Token usage of a response: the script's `usage`, else an estimate. */
export function usageOf(steps, requestText) {
  const { blocks, usage } = blocksOf(steps)
  const output = blocks.reduce((sum, b) => sum + (b.type === 'tool' ? tokens(JSON.stringify(b.args)) + tokens(b.name) : tokens(b.text)), 0)
  return {
    input: usage?.input ?? tokens(requestText),
    output: usage?.output ?? output,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
  }
}

// ---- putting it on the wire --------------------------------------------------------

const sleep = (seconds, signal) => new Promise((resolve) => {
  if (!seconds || signal?.aborted) { resolve(); return }
  const timer = setTimeout(resolve, seconds * 1000)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

let toolCounter = 0
const toolId = (prefix, given) => given ?? `${prefix}${Date.now().toString(36)}${(++toolCounter).toString(36)}`

/**
 * Stream a response as OpenAI chat-completion chunks (`res` is a Node response).
 * @param {{ id: string, model: string, steps: object[], usage: object, reasoningField?: string, cost?: number, signal?: AbortSignal }} r
 */
export async function openaiStream(res, r) {
  const { blocks, finish } = blocksOf(r.steps)
  const created = Math.floor(Date.now() / 1000)
  const send = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id: r.id, object: 'chat.completion.chunk', created, model: r.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  send({ role: 'assistant', content: '' })
  let toolIndex = 0
  for (const b of blocks) {
    if (r.signal?.aborted) break
    if (b.type === 'sleep') { await sleep(b.time, r.signal); continue }
    if (b.type === 'tool') {
      const index = toolIndex++
      send({ tool_calls: [{ index, id: toolId('call_', b.id), type: 'function', function: { name: b.name, arguments: '' } }] })
      for (const piece of chunk(JSON.stringify(b.args), 3)) send({ tool_calls: [{ index, function: { arguments: piece } }] })
      continue
    }
    const field = b.type === 'text' ? 'content' : (r.reasoningField ?? 'reasoning')
    for (const [i, piece] of chunk(b.text, b.chunks ?? 1).entries()) {
      if (i > 0) await sleep(b.chunkDelay, r.signal)
      send({ [field]: piece })
    }
  }
  const reason = finish === 'tool' ? 'tool_calls' : finish === 'max-tokens' ? 'length' : 'stop'
  res.write(`data: ${JSON.stringify({ id: r.id, object: 'chat.completion.chunk', created, model: r.model, choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output,
      prompt_tokens_details: { cached_tokens: r.usage.cacheRead }, ...(r.cost === undefined ? {} : { cost: r.cost }) } })}\n\n`)
  res.end('data: [DONE]\n\n')
}

/** A whole (non-streamed) OpenAI chat completion. */
export function openaiMessage(r) {
  const { blocks, finish } = blocksOf(r.steps)
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
  const reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.text).join('')
  const calls = blocks.filter(b => b.type === 'tool').map(b => ({ id: toolId('call_', b.id), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.args) } }))
  return {
    id: r.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: r.model,
    choices: [{ index: 0, finish_reason: finish === 'tool' ? 'tool_calls' : finish === 'max-tokens' ? 'length' : 'stop',
      message: { role: 'assistant', content: text, ...(reasoning ? { [r.reasoningField ?? 'reasoning']: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) } }],
    usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output, prompt_tokens_details: { cached_tokens: r.usage.cacheRead }, ...(r.cost === undefined ? {} : { cost: r.cost }) },
  }
}

/** Stream a response as Anthropic message events. */
export async function anthropicStream(res, r) {
  const { blocks, finish } = blocksOf(r.steps)
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  event('message_start', { message: { id: r.id, type: 'message', role: 'assistant', model: r.model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: r.usage.input, output_tokens: 1, cache_read_input_tokens: r.usage.cacheRead, cache_creation_input_tokens: r.usage.cacheWrite } } })
  let index = 0
  for (const b of blocks) {
    if (r.signal?.aborted) break
    if (b.type === 'sleep') { await sleep(b.time, r.signal); continue }
    if (b.type === 'tool') {
      event('content_block_start', { index, content_block: { type: 'tool_use', id: toolId('toolu_', b.id), name: b.name, input: {} } })
      for (const piece of chunk(JSON.stringify(b.args), 3)) event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } })
      event('content_block_stop', { index: index++ })
      continue
    }
    const thinking = b.type === 'thinking'
    event('content_block_start', { index, content_block: thinking ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' } })
    for (const [i, piece] of chunk(b.text, b.chunks ?? 1).entries()) {
      if (i > 0) await sleep(b.chunkDelay, r.signal)
      event('content_block_delta', { index, delta: thinking ? { type: 'thinking_delta', thinking: piece } : { type: 'text_delta', text: piece } })
    }
    if (thinking) event('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'simulated' } })
    event('content_block_stop', { index: index++ })
  }
  event('message_delta', { delta: { stop_reason: finish === 'tool' ? 'tool_use' : finish === 'max-tokens' ? 'max_tokens' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: r.usage.output } })
  event('message_stop', {})
  res.end()
}

/** A whole (non-streamed) Anthropic message. */
export function anthropicMessage(r) {
  const { blocks, finish } = blocksOf(r.steps)
  const content = blocks.filter(b => b.type !== 'sleep').map(b => b.type === 'tool'
    ? { type: 'tool_use', id: toolId('toolu_', b.id), name: b.name, input: b.args }
    : b.type === 'thinking' ? { type: 'thinking', thinking: b.text, signature: 'simulated' } : { type: 'text', text: b.text })
  return { id: r.id, type: 'message', role: 'assistant', model: r.model, content,
    stop_reason: finish === 'tool' ? 'tool_use' : finish === 'max-tokens' ? 'max_tokens' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: r.usage.input, output_tokens: r.usage.output, cache_read_input_tokens: r.usage.cacheRead, cache_creation_input_tokens: r.usage.cacheWrite } }
}
