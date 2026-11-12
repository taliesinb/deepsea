/**
 * The side call behind `/ask`, kept free of Cordis so tests drive it with
 * plain objects.
 *
 * Every question is "rebased" on the main conversation as it is now: the
 * request is the session's derived history (system prompt, developer
 * messages, the conversation, up to the last point where every tool call has
 * its result) with the header's tool schemas and tool history, then the side
 * thread (earlier side questions and answers, each marked with when it was
 * asked), then the new question. The first part is a prefix of the main
 * conversation's own last request, so the provider's prompt cache, which the
 * running main turn keeps warm, is reused; only the side thread is new input.
 *
 * Tools: the side model is sent the main conversation's full tool list (a
 * different list would break the cached prefix), but only the configured
 * read-only tools run; any other call gets an error result. Nothing is
 * appended to the session.
 */
import { BlockAssembler, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'

/** Per-item caps for the in-progress description. */
const PROGRESS_TEXT_CHARS = 2000
const PROGRESS_ARGS_CHARS = 400
const PROGRESS_RESULT_CHARS = 600

/** The first line of the note that opens every side thread; also how the plugin recognises its own requests. */
export const SIDE_MARK = '[Side conversation]'

/**
 * The note that opens the side thread (model-facing).
 * @param {readonly string[]} tools - tools the side model may run; empty for none.
 */
export function sideIntro(tools) {
  return [
    SIDE_MARK,
    'The user is asking side questions about the conversation above, in a separate panel, while the main work goes on.',
    'Answer from the conversation above. These questions and your answers are never seen by the main agent and change nothing in it: do not continue or resume the main task, and do not describe next steps you will take.',
    tools.length === 0
      ? 'You cannot use tools here: do not call any.'
      : `You may use only these read-only tools here: ${tools.join(', ')}. Any other tool call fails. Use them only when the conversation does not already answer the question.`,
    'Earlier side questions and their answers follow, each marked with when it was asked. The main conversation may have moved on since; where they disagree, the conversation above is current.',
    'Be concise. If the conversation does not contain enough to answer, say so.',
  ].join('\n')
}

/**
 * The header line of one side question (model-facing). The same text is sent
 * when the question is asked and when it is replayed, so a follow-up's request
 * repeats the previous one byte for byte up to its question (prefix cache).
 * @param {{ askedAt: string, turn: number, running: boolean }} where
 */
export function questionHeader(where) {
  const time = new Date(where.askedAt).toTimeString().slice(0, 5)
  const state = where.turn === 0 ? 'before the first turn'
    : where.running ? `while turn ${String(where.turn)} was running` : `after turn ${String(where.turn)}`
  return `[Side question, asked at ${time}, ${state}]`
}

function clip(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\u2026`
}

function textOf(content) {
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
}

/**
 * The longest prefix of `messages` in which every tool call has its result.
 * Asked mid-turn, the history can end with an assistant message whose tool
 * calls are still running; providers reject a call without its result, so the
 * replay stops before it (`describeProgress` covers the rest).
 * @param {readonly any[]} messages - derived history, in order.
 * @returns {any[]} the answered prefix.
 */
export function answeredPrefix(messages) {
  const pending = new Set()
  let cut = 0
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') pending.add(block.id)
      }
    } else if (message.role === 'tool') {
      pending.delete(message.toolCallId)
    }
    if (pending.size === 0) cut = index + 1
  }
  return messages.slice(0, cut)
}

/**
 * Plain-text account of the history after the answered prefix: what the
 * assistant said and which tool calls are running (with any results already
 * in). Sent inside the question, so no provider sees a tool call without its
 * result.
 * @param {readonly any[]} tail - the messages `answeredPrefix` left out.
 * @returns {string} the account, or '' when the tail is empty.
 */
export function describeProgress(tail) {
  if (tail.length === 0) return ''
  const names = new Map()
  const lines = ['Work in progress in the main conversation when this was asked (tool calls without a result were still running):']
  for (const message of tail) {
    if (message.role === 'assistant') {
      const text = textOf(message.content)
      if (text !== '') lines.push(`- assistant: ${clip(text, PROGRESS_TEXT_CHARS)}`)
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        names.set(block.id, block.name)
        lines.push(`- tool call ${block.name}: ${clip(block.arguments, PROGRESS_ARGS_CHARS)}`)
      }
    } else if (message.role === 'tool') {
      lines.push(`- result of ${names.get(message.toolCallId) ?? 'a tool call'}: ${clip(textOf(message.content), PROGRESS_RESULT_CHARS)}`)
    } else if (message.role === 'user') {
      const text = textOf(message.content)
      if (text !== '') lines.push(`- user: ${clip(text, PROGRESS_TEXT_CHARS)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Which provider and model answer: the configured override, else the
 * session's latest request header (keeping its reasoning effort and
 * temperature, which the cached prefix was built with), else the agent's
 * configured model.
 * @param {{ provider: string, model: string }} config - resolved plugin config.
 * @param {any} session - the asking agent's session.
 * @param {any} agent - the asking agent.
 * @returns {{ provider: string, model: string, reasoningEffort?: string, temperature?: number } | undefined}
 */
export function resolveRoute(config, session, agent) {
  if (config.provider !== '') return { provider: config.provider, model: config.model }
  const header = session.requestHeader()?.config
  if (header !== undefined && header.provider !== '' && header.model !== '') {
    return {
      provider: header.provider,
      model: header.model,
      ...header.reasoningEffort === undefined ? {} : { reasoningEffort: header.reasoningEffort },
      ...header.temperature === undefined ? {} : { temperature: header.temperature },
    }
  }
  const { provider, model } = agent.options ?? {}
  if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
    return { provider, model }
  }
  return undefined
}

/**
 * Where the main conversation is: the open turn (with its latest step), else
 * the last completed turn; turn 0 before any turn.
 * @param {readonly any[]} events - the session's events, in order.
 * @returns {{ turn: number, step: number, running: boolean, seq: number }}
 */
export function mainPosition(events) {
  let step = 0
  const seq = events.length === 0 ? -1 : events[events.length - 1].seq
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'step/start' && step === 0) step = event.data.step
    if (event.type === 'turn/end') return { turn: event.data.turn, step: 0, running: false, seq }
    if (event.type === 'turn/start') return { turn: event.data.turn, step, running: true, seq }
  }
  return { turn: 0, step: 0, running: false, seq }
}

/**
 * The text of one side question as sent: the side-conversation note when it
 * opens the thread, the work-in-progress account when the main turn had
 * calls running, the header, the question.
 */
function promptText(intro, progress, exchange) {
  return [
    ...intro === '' ? [] : [intro, ''],
    ...progress === '' ? [] : [progress, ''],
    questionHeader(exchange),
    exchange.question,
  ].join('\n')
}

/**
 * The messages of one side request: main prefix, side thread, question.
 * Earlier questions are replayed exactly as they were sent (`prompt`), so the
 * request repeats the previous side request up to its question; one that
 * opens the replayed thread without the note (older ones dropped out of the
 * window) gets the note in front.
 * @param {readonly any[]} history - the session's derived messages now.
 * @param {readonly any[]} earlier - earlier finished exchanges to replay, oldest first.
 * @param {{ question: string, askedAt: string, turn: number, running: boolean }} current
 * @param {{ tools: readonly string[], route: { provider: string, model: string } }} options
 * @returns {{ messages: any[], replayed: number, prompt: string }} the messages, how many came from the
 *   main conversation, and the text the new question was sent as (to replay it the same way).
 */
export function buildMessages(history, earlier, current, options) {
  const prefix = answeredPrefix(history)
  const progress = describeProgress(history.slice(prefix.length))
  const side = []
  const intro = sideIntro(options.tools)
  earlier.forEach((exchange, index) => {
    let text = typeof exchange.prompt === 'string' ? exchange.prompt : promptText(index === 0 ? intro : '', '', exchange)
    if (index === 0 && !text.startsWith(SIDE_MARK)) text = `${intro}\n\n${text}`
    side.push({ role: 'user', content: [{ type: 'text', text }] })
    side.push(createAssistantMessage({
      content: [{ type: 'text', text: exchange.answer === '' ? '(no answer)' : exchange.answer }],
      source: { provider: exchange.provider ?? options.route.provider, model: exchange.model ?? options.route.model },
    }))
  })
  const prompt = promptText(earlier.length === 0 ? intro : '', progress, current)
  side.push({ role: 'user', content: [{ type: 'text', text: prompt }] })
  return { messages: [...prefix, ...side], replayed: prefix.length, prompt }
}

/** Local `YYYY-MM-DD`. */
function localDate(date) {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Local `HH:MM`. */
function localTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * The export's file name: `asks-<session id>-<date>.md` (one per session and
 * day; exporting again that day replaces it with the fuller thread).
 * @param {string} sessionId
 * @param {Date} now
 */
export function exportName(sessionId, now) {
  return `asks-${sessionId}-${localDate(now)}.md`
}

/** Where the main conversation was when a question was asked, as the panel words it. */
function position(exchange) {
  if (exchange.turn === 0) return 'before turn 1'
  return exchange.running ? `turn ${String(exchange.turn)}, step ${String(exchange.step)}` : `after turn ${String(exchange.turn)}`
}

/**
 * The side thread as Markdown: one section per question (where the main
 * conversation was, time, model), the tool calls behind it, the answer.
 * @param {string} sessionId
 * @param {readonly any[]} exchanges
 * @param {Date} now
 */
export function exportMarkdown(sessionId, exchanges, now) {
  const lines = ['# Side questions', '', `Session \`${sessionId}\`, exported ${localDate(now)} ${localTime(now)}.`, '']
  for (const exchange of exchanges) {
    const asked = new Date(exchange.askedAt)
    lines.push('---', '', `## ${exchange.question.split('\n')[0]}`, '')
    lines.push(`*${position(exchange)} · ${localDate(asked)} ${localTime(asked)}${exchange.model === undefined ? '' : ` · ${exchange.model}`}*`, '')
    if (exchange.question.includes('\n')) lines.push(...exchange.question.split('\n').map(line => `> ${line}`), '')
    if (exchange.tools.length > 0) {
      lines.push(...exchange.tools.map(tool => `- \`${tool.name}\` ${tool.summary}${tool.state === 'ok' ? '' : ` (${tool.state})`}`), '')
    }
    if (exchange.answer !== '') lines.push(exchange.answer, '')
    if (exchange.status === 'error') lines.push(`*Failed: ${exchange.error ?? 'error'}*`, '')
    if (exchange.status === 'cancelled') lines.push('*Cancelled*', '')
    if (exchange.status === 'answering') lines.push('*Still answering when exported*', '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * A short, single-line description of one tool call's arguments, for the panel.
 * @param {unknown} args - the parsed arguments.
 */
export function toolSummary(args) {
  if (args !== null && typeof args === 'object') {
    for (const key of ['path', 'file_path', 'pattern', 'query', 'paths', 'files', 'regex', 'text']) {
      const value = args[key]
      if (typeof value === 'string' && value !== '') return clip(value, 120)
      if (Array.isArray(value) && value.length > 0) {
        return clip(value.map(item => typeof item === 'string' ? item : item?.path ?? JSON.stringify(item)).join(', '), 120)
      }
    }
  }
  return clip(JSON.stringify(args ?? {}), 120)
}

function addUsage(total, usage) {
  if (usage === undefined) return total
  const next = { ...total }
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (typeof usage[key] === 'number') next[key] = (next[key] ?? 0) + usage[key]
  }
  return next
}

function joinParts(...parts) {
  return parts.filter(part => part !== '').join('\n\n')
}

/**
 * Run one side question to its answer: the request, then up to
 * `maxToolRounds` rounds of read-only tool calls. `onUpdate` sees the answer
 * grow as text streams in and each tool call as it runs.
 * @param {{
 *   llm: { stream(options: any): AsyncIterable<any> },
 *   runTool: (call: { id: string, name: string, args: unknown }) => Promise<{ content: any[], isError: boolean }>,
 *   route: { provider: string, model: string },
 *   messages: any[],
 *   tools?: any[],
 *   toolHistory?: any,
 *   allowedTools: readonly string[],
 *   maxAnswerTokens: number,
 *   maxToolRounds: number,
 *   sessionId: string,
 *   signal: AbortSignal,
 *   onRequest?: (request: any) => void,
 *   onUpdate: (state: { answer: string, tools: any[], usage: any }) => void,
 * }} run
 * @returns {Promise<{ kind: 'done' | 'error' | 'cancelled', answer: string, error?: string, tools: any[], usage: any }>}
 */
export async function runSideQuestion(run) {
  const messages = [...run.messages]
  const allowed = new Set(run.allowedTools)
  let done = ''
  let usage = {}
  const tools = []
  const state = live => ({ answer: joinParts(done, live), tools: tools.map(tool => ({ ...tool })), usage })
  for (let round = 0; ; round += 1) {
    const assembler = new BlockAssembler()
    let live = ''
    const request = {
      ...run.route,
      messages: [...messages],
      ...run.tools === undefined ? {} : { tools: [...run.tools], ...run.toolHistory === undefined ? {} : { toolHistory: run.toolHistory } },
      maxTokens: run.maxAnswerTokens,
      sessionId: run.sessionId,
      signal: run.signal,
    }
    run.onRequest?.(request)
    for await (const chunk of run.llm.stream(request)) {
      assembler.push(chunk)
      if (chunk.type === 'text-delta') {
        live += chunk.text
        run.onUpdate(state(live.trim()))
      }
    }
    usage = addUsage(usage, assembler.usage)
    const finish = assembler.finish
    if (finish.kind === 'aborted') return { kind: 'cancelled', ...state(live.trim()) }
    if (finish.kind === 'error') return { kind: 'error', error: finish.failure?.message ?? 'model error', ...state(live.trim()) }
    const blocks = assembler.blocks()
    const text = textOf(blocks)
    const calls = blocks.filter(block => block.type === 'tool-call')
    if (finish.kind === 'max-tokens') {
      done = joinParts(done, text, '[truncated]')
      return { kind: 'done', ...state('') }
    }
    done = joinParts(done, text)
    if (calls.length === 0) {
      return done === ''
        ? { kind: 'error', error: 'The model returned no answer.', ...state('') }
        : { kind: 'done', ...state('') }
    }
    if (round >= run.maxToolRounds) {
      done = joinParts(done, `[Stopped after ${String(run.maxToolRounds)} rounds of tool calls.]`)
      return { kind: 'done', ...state('') }
    }
    messages.push(createAssistantMessage({
      content: blocks,
      source: { provider: run.route.provider, model: run.route.model, ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState } },
    }))
    for (const call of calls) {
      let args
      try { args = JSON.parse(call.arguments === '' ? '{}' : call.arguments) } catch { args = undefined }
      const entry = { name: call.name, summary: toolSummary(args), state: 'running' }
      tools.push(entry)
      run.onUpdate(state(''))
      let result
      if (!allowed.has(call.name)) {
        result = { content: [{ type: 'text', text: `${call.name} is not available in side questions. Available: ${[...allowed].join(', ') || 'none'}.` }], isError: true }
        entry.state = 'refused'
      } else if (args === undefined) {
        result = { content: [{ type: 'text', text: 'The tool call arguments are not valid JSON.' }], isError: true }
        entry.state = 'error'
      } else {
        try {
          result = await run.runTool({ id: call.id, name: call.name, args })
          entry.state = result.isError ? 'error' : 'ok'
        } catch (error) {
          if (run.signal.aborted) return { kind: 'cancelled', ...state('') }
          result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
          entry.state = 'error'
        }
      }
      messages.push(createToolResultMessage({ callId: call.id, content: result.content, isError: result.isError }))
      run.onUpdate(state(''))
    }
  }
}
