/**
 * The scripted model adapter: answers each request from the JSONL script in
 * the latest user message (README.md).
 */
import { createHash } from 'node:crypto'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import {
  checkExpectation, chunk, ERROR_KINDS, FINISHED_REPLY, isScript, newContext, parseScript, plainReply, recordTool, resume,
  ScriptExpectationError, ScriptValueError,
} from '@deepsea/script'

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

/**
 * A script's hash. The prompt's own message id goes into it, so the same script sent again (a later turn) gets
 * tool-call ids of its own: the client keys a call's row by its id, and a repeated id hides the later row.
 */
const scriptHash = (message, text) => createHash('sha256').update(`${message?.id ?? ''}\n${text}`).digest('hex').slice(0, 12)
const callId = (hash, response, key) => `scripted-${hash}-${response}-${key}`

/** How many scripted tool calls' structured results are kept (oldest dropped first). */
const KEPT_CALLS = 1000

/** A script failing as it runs becomes an API error: a value that cannot be evaluated, or a failed expect. */
function scriptError(error) {
  if (error instanceof ScriptValueError) return new LlmError(error.message, 'SCRIPT_VALUE', { status: 400 })
  if (error instanceof ScriptExpectationError) return new LlmError(error.message, 'SCRIPT_EXPECTATION', { status: 400 })
  return error
}

export class ScriptedAdapter extends LlmAdapter {
  constructor() {
    super()
    /** Session → the title its script set. */
    this.titles = new Map()
    /** `<script hash>:<action key>` → how many times an `error` with `times` has fired. */
    this.errorCounts = new Map()
    /** Scripted tool call id → `{ started }`, then `{ result, error, ok, duration }` once it finished. */
    this.calls = new Map()
  }

  /** Whether a tool execution is one a script asked for (not a nested call). */
  static isScripted(exec) {
    return exec.parent === undefined && typeof exec.callId === 'string' && exec.callId.startsWith('scripted-')
  }

  /** A scripted tool call starts running (the `tools/execute` event). */
  callStarted(exec) {
    if (ScriptedAdapter.isScripted(exec)) this.keep(exec.callId, { started: performance.now() })
  }

  /** A scripted tool call finished (the `tools/result` event): keep its structured value, error and duration. */
  callFinished(exec, result) {
    if (!ScriptedAdapter.isScripted(exec)) return
    const started = this.calls.get(exec.callId)?.started
    this.keep(exec.callId, {
      result: result.isError ? null : result.value ?? null,
      error: result.isError ? result.error ?? null : null,
      ok: !result.isError,
      duration: started === undefined ? null : (performance.now() - started) / 1000,
    })
  }

  keep(id, entry) {
    this.calls.delete(id)
    this.calls.set(id, entry)
    if (this.calls.size > KEPT_CALLS) this.calls.delete(this.calls.keys().next().value)
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

    // The context is rebuilt from the transcript on every request, so a retry sees what the first attempt saw:
    // the globals the earlier scripts saved, then this script's earlier responses replayed.
    const after = messages.slice(userIndex + 1)
    const position = after.filter(m => m.role === 'assistant').length
    const hash = scriptHash(messages[userIndex], text)
    const context = newContext(this.globalsBefore(messages, userIndex))
    let run
    try { run = resume(commands, context, position, this.recorder(context, after, hash)) } catch (error) { throw scriptError(error) }
    if (run === undefined) { yield* this.reply(options, FINISHED_REPLY); return }
    yield* this.play(run, { options, hash, position, context })
  }

  /** The globals the scripts before the one at `userIndex` saved, each replayed through the responses it got. */
  globalsBefore(messages, userIndex) {
    const globals = {}
    const prompts = messages.flatMap((m, i) => i < userIndex && isPrompt(m) ? [i] : [])
    prompts.forEach((start, n) => {
      const text = textOf(messages[start])
      if (!isScript(text)) return
      const { commands, errors } = parseScript(text)
      if (errors.length > 0) return
      const after = messages.slice(start + 1, prompts[n + 1] ?? userIndex)
      const context = newContext(globals)
      // A script that failed on a value stopped there; what it saved before that stands.
      try { resume(commands, context, after.filter(m => m.role === 'assistant').length, this.recorder(context, after, scriptHash(messages[start], text))) } catch (error) {
        if (!(error instanceof ScriptValueError)) throw error
      }
    })
    return globals
  }

  /** Records response `n`'s tool calls, with the results that came back, into `context.tools`. */
  recorder(context, after, hash) {
    const responses = after.filter(m => m.role === 'assistant')
    return (n, calls) => {
      const blocks = (responses[n]?.content ?? []).filter(b => b.type === 'tool-call')
      for (const call of calls) {
        const id = callId(hash, n, call.key)
        const block = blocks.find(b => b.id === id)
        const result = after.find(m => m.role === 'tool' && m.toolCallId === id)
        if (block !== undefined && result !== undefined) recordTool(context, this.descriptor(block, result), call.command.id)
      }
    }
  }

  /**
   * A finished tool call as the context holds it. The structured result,
   * error and duration come from the call's `tools/result` event; a call this
   * process did not see run (a restart since) has only its result text.
   */
  descriptor(block, message) {
    const text = textOf(message)
    let args
    try { args = JSON.parse(block.arguments) } catch { args = block.arguments }
    const seen = this.calls.get(block.id)
    if (seen?.ok === undefined) {
      const ok = !message.isError
      return { name: block.name, args, result: null, text, duration: null, error: ok ? null : { message: text }, ok }
    }
    return { name: block.name, args, result: seen.result, text, duration: seen.duration, error: seen.error, ok: seen.ok }
  }

  /** A one-block text reply with a stop finish. */
  async *reply(options, text) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: tokens(JSON.stringify(options.messages ?? []).length), outputTokens: tokens(text.length) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** Stream one response: the run's actions up to the next suspend (tool calls) or the end, then usage and the finish. */
  async *play(run, { options, hash, position, context }) {
    const { signal } = options
    let index = 0
    let emitted = 0
    let usage
    let finish = { kind: 'stop' }
    for (;;) {
      if (signal?.aborted) throw aborted()
      let next
      try { next = run.next() } catch (error) { throw scriptError(error) }
      if (next.done) break
      const action = next.value
      if (action.op === 'suspend') { finish = { kind: 'tool-calls' }; break }
      let step
      try { step = action.evaluate() } catch (error) { throw scriptError(error) }
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
          const id = callId(hash, position, action.key)
          const args = JSON.stringify(step.args ?? {})
          yield { type: 'block-start', index, blockType: 'tool-call' }
          // The arguments stream in `chunks` pieces `chunkDelay` apart, as a model streams a long write.
          for (const [i, piece] of chunk(args, step.chunks ?? 1).entries()) {
            if (i > 0 && step.chunkDelay) await sleep(step.chunkDelay, signal)
            yield { type: 'tool-call-delta', index, id, name: step.name, argumentsDelta: piece }
          }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: step.name, arguments: args } }
          emitted += args.length
          index++
          break
        }
        case 'expect':
          try { checkExpectation(step, context) } catch (error) { throw scriptError(error) }
          break
        case 'sleep': await sleep(step.time, signal); break
        case 'usage': usage = step; break
        case 'error': this.fail(step, `${hash}:${action.key}`); break
        case 'end': finish = { kind: step.reason ?? 'stop' }; break
      }
    }
    // A response with nothing to show (only saves or checks after the last tool calls) says the script is done.
    if (index === 0 && finish.kind === 'stop') {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: FINISHED_REPLY }
      yield { type: 'block-end', index, block: { type: 'text', text: FINISHED_REPLY } }
      emitted += FINISHED_REPLY.length
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

  /** Raise a scripted provider error, unless its `times` are used up. */
  fail(step, key) {
    const count = this.errorCounts.get(key) ?? 0
    if (step.times !== undefined && count >= step.times) return
    this.errorCounts.set(key, count + 1)
    const kind = ERROR_KINDS[step.kind]
    const status = step.status ?? kind.status
    const where = step.at ? `line ${step.line}, ${step.at}` : `line ${step.line}`
    throw new LlmError(step.message ?? `Scripted ${step.kind} error (${where})`, kind.code, {
      ...status === undefined ? {} : { status },
      ...step.retryAfter === undefined ? {} : { providerRetryAfterMs: step.retryAfter * 1000 },
    })
  }
}
