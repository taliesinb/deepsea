/**
 * The scripted model adapter: answers each request from the JSONL script in
 * the latest user message (README.md).
 */
import { createHash } from 'node:crypto'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { chunk, ERROR_KINDS, FINISHED_REPLY, isScript, parseScript, plainReply, segments } from '@deepsea/script'

export const MODEL_ID = 'script'
const DEFAULT_TITLE = 'scripted session'
const COMPACTION_SUMMARY = 'Summary: a scripted session.'

const textOf = message => (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')

/**
 * Whether a message is something a person typed. The harness also sends
 * user-role messages of its own after the prompt (runtime and time context,
 * source kinds other than `user`); a one-shot request's input has no source.
 */
const isPrompt = message => message.role === 'user' && (message.source === undefined || message.source.kind === 'user')

/** Sleep that ends early, with an ABORTED error, when the request is cancelled. */
function sleep(seconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, seconds * 1000)
    const onAbort = () => { clearTimeout(timer); reject(aborted()) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
const aborted = () => new LlmError('The scripted response was cancelled.', 'ABORTED')

/** Rough, deterministic token counts: four characters per token. */
const tokens = chars => Math.ceil(chars / 4)

export class ScriptedAdapter extends LlmAdapter {
  constructor() {
    super()
    /** Session → the title its script set. */
    this.titles = new Map()
    /** `<script hash>:<line>` → how many times an `error` with `times` has fired. */
    this.errorCounts = new Map()
  }

  providerInfo(provider) {
    return { id: provider, name: 'Scripted', auth: 'local' }
  }

  listModels(provider) {
    return Promise.resolve([{ provider, id: MODEL_ID, name: 'Script', description: 'Deterministic replies from a JSONL script in the prompt' }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model === MODEL_ID ? 'Script' : model, context: { contextWindow: 1_000_000 } })
  }

  async *stream(options) {
    if (options.purpose === 'session-title') { yield* this.reply(options, this.titles.get(options.sessionId) ?? DEFAULT_TITLE); return }
    if (options.purpose === 'compaction') { yield* this.reply(options, COMPACTION_SUMMARY); return }
    const messages = options.messages ?? []
    const userIndex = messages.findLastIndex(isPrompt)
    const text = textOf(messages[userIndex])
    if (!isScript(text)) { yield* this.reply(options, plainReply(text)); return }

    const { commands, errors } = parseScript(text)
    if (errors.length > 0) {
      throw new LlmError(`The script is invalid:\n${errors.join('\n')}`, 'SCRIPT_INVALID', { status: 400 })
    }
    const title = commands.find(c => c.cmd === 'title')
    if (title && options.sessionId) this.titles.set(options.sessionId, title.text)

    const after = messages.slice(userIndex + 1)
    const position = after.filter(m => m.role === 'assistant').length
    const parts = segments(commands)
    if (position >= parts.length) { yield* this.reply(options, FINISHED_REPLY); return }
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 12)
    yield* this.play(parts[position], { options, after, hash, position })
  }

  /** A one-block text reply with a stop finish. */
  async *reply(options, text) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: tokens(JSON.stringify(options.messages ?? []).length), outputTokens: tokens(text.length) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** Stream one response: its commands in order, then usage and the finish. */
  async *play(steps, { options, after, hash, position }) {
    const { signal } = options
    let index = 0
    let emitted = 0
    let usage
    let finish = { kind: 'stop' }
    const calls = []
    for (const step of steps) {
      if (signal?.aborted) throw aborted()
      switch (step.cmd) {
        case 'say':
        case 'think': {
          const blockType = step.cmd === 'say' ? 'text' : 'reasoning'
          const delta = step.cmd === 'say' ? 'text-delta' : 'reasoning-delta'
          yield { type: 'block-start', index, blockType }
          const pieces = chunk(step.text, step.chunks ?? 1)
          for (const [i, piece] of pieces.entries()) {
            if (i > 0 && step.chunkDelay) await sleep(step.chunkDelay, signal)
            yield { type: delta, index, text: piece }
          }
          yield { type: 'block-end', index, block: { type: blockType, text: step.text } }
          emitted += step.text.length
          index++
          break
        }
        case 'tool': {
          const id = `scripted-${hash}-${position}-${step.id ?? step.line}`
          const args = JSON.stringify(step.args ?? {})
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: step.name, argumentsDelta: args }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: step.name, arguments: args } }
          calls.push(id)
          emitted += args.length
          finish = { kind: 'tool-calls' }
          index++
          break
        }
        case 'expect': this.expect(step, { after, hash, position }); break
        case 'sleep': await sleep(step.time, signal); break
        case 'usage': usage = step; break
        case 'error': this.fail(step, hash); break
        case 'end': finish = { kind: step.reason ?? 'stop' }; break
      }
    }
    yield {
      type: 'usage',
      usage: usage
        ? {
          inputTokens: usage.input, outputTokens: usage.output,
          ...usage.cacheRead === undefined ? {} : { cacheReadTokens: usage.cacheRead },
          ...usage.cacheWrite === undefined ? {} : { cacheWriteTokens: usage.cacheWrite },
          ...usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning },
        }
        : { inputTokens: tokens(JSON.stringify(options.messages ?? []).length), outputTokens: tokens(emitted) },
    }
    yield { type: 'finish', reason: finish }
  }

  /** Check a tool result the previous response asked for. */
  expect(step, { after, hash, position }) {
    const results = after.filter(m => m.role === 'tool')
    const wanted = step.tool === undefined ? undefined : `scripted-${hash}-${position - 1}-${step.tool}`
    const prefix = `scripted-${hash}-${position - 1}-`
    const mine = results.filter(m => typeof m.toolCallId === 'string' && m.toolCallId.startsWith(prefix))
    const result = wanted === undefined ? mine.at(-1) : mine.find(m => m.toolCallId === wanted)
    const fail = detail => { throw new LlmError(`line ${step.line}: ${detail}`, 'SCRIPT_EXPECTATION', { status: 400 }) }
    if (result === undefined) fail(`no result for ${step.tool === undefined ? 'the last tool call' : `tool "${step.tool}"`}`)
    const text = textOf(result)
    const shown = JSON.stringify(text.length > 300 ? `${text.slice(0, 300)}…` : text)
    if (step.isError !== undefined && Boolean(result.isError) !== step.isError) fail(`expected the tool to ${step.isError ? 'fail' : 'succeed'}; got ${shown}`)
    if (step.contains !== undefined && !text.includes(step.contains)) fail(`expected the tool result to contain ${JSON.stringify(step.contains)}; got ${shown}`)
    if (step.equals !== undefined && text !== step.equals) fail(`expected the tool result to equal ${JSON.stringify(step.equals)}; got ${shown}`)
  }

  /** Raise a scripted provider error, unless its `times` are used up. */
  fail(step, hash) {
    const key = `${hash}:${step.line}`
    const count = this.errorCounts.get(key) ?? 0
    if (step.times !== undefined && count >= step.times) return
    this.errorCounts.set(key, count + 1)
    const kind = ERROR_KINDS[step.kind]
    const status = step.status ?? kind.status
    throw new LlmError(step.message ?? `Scripted ${step.kind} error (line ${step.line})`, kind.code, {
      ...status === undefined ? {} : { status },
      ...step.retryAfter === undefined ? {} : { providerRetryAfterMs: step.retryAfter * 1000 },
    })
  }
}
