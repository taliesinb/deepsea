/**
 * @deepsea/ask: side questions about a session, answered from its context
 * without interrupting a running turn and without entering the conversation
 * the model sees. `/ask <question>` (or the panel's input) asks one; the
 * browser half shows the session's side thread in a right-sidebar tab and
 * marks each question in the chat at the turn it was asked during.
 *
 * Host half:
 *   - the `/ask` command: starts the answer and returns at once (the composer
 *     clears), recording `command/run` + `command/done` like any command;
 *   - the side thread store (thread.mjs), one JSON file per session;
 *   - the runner (ask.mjs): one request rebased on the main conversation as
 *     it is now, then rounds of read-only tool calls;
 *   - a watch on the main agent's model requests: a question asked while a
 *     main request is still reading its input waits for that request's first
 *     output, so it reuses the cache entry that request is writing instead of
 *     writing the whole prefix a second time;
 *   - control routes `POST /deepsea-ask/<endpoint>` for the panel: `thread`,
 *     `cancel`, `clear`, `export` (the thread as Markdown,
 *     `asks-<session id>-<date>.md` in the session's directory), behind DSH's
 *     own request gate. The panel asks through
 *     the `/ask` command, so every question has the same log record.
 */
import { writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SIDE_MARK, buildMessages, exportMarkdown, exportName, mainPosition, resolveRoute, runSideQuestion } from './ask.mjs'
import { ThreadStore } from './thread.mjs'

export const name = 'deepsea-ask'
export const inject = ['commands', 'llm', 'agents', 'webServer', 'connection']

export const Config = Schema.object({
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  maxAnswerTokens: Schema.natural().min(64).default(8192),
  maxQuestionChars: Schema.natural().min(1).default(4000),
  timeoutSeconds: Schema.natural().min(1).default(300),
  tools: Schema.array(Schema.string()).default(['read', 'read_many', 'read_image', 'list_dir', 'glob', 'grep', 'search']),
  maxToolRounds: Schema.natural().default(8),
  historyExchanges: Schema.natural().default(20),
  waitForMainSeconds: Schema.natural().default(60),
})

/** The control routes' prefix (document-relative in the browser). */
export const CHANNEL = '/deepsea-ask'
const MAX_BODY = 64 * 1024
/** Streaming text is published to pollers at most this often (the file is written at the end). */
const PUBLISH_MS = 80

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Whether a request is one of ours: its side thread opens with the side-conversation note. */
function isSideRequest(options) {
  const messages = Array.isArray(options.messages) ? options.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    if (message.content.some(block => block.type === 'text' && block.text.startsWith(SIDE_MARK))) return true
  }
  return false
}

/**
 * In-flight main-conversation requests, per session, until each produces its
 * first chunk (when its cache entry becomes readable) or ends.
 */
class MainWatch {
  constructor() {
    /** @type {Map<string, Set<Promise<void>>>} */
    this.pending = new Map()
    /** Requests this plugin made, which the watch ignores. */
    this.own = new WeakSet()
  }

  /** Wrap one `llm/stream` call. */
  observe(options, next) {
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined
    if (sessionId === undefined || options.purpose !== undefined || this.own.has(options) || isSideRequest(options)) return next()
    const watch = this
    return (async function* () {
      let release
      const first = new Promise((resolve) => { release = resolve })
      let set = watch.pending.get(sessionId)
      if (set === undefined) { set = new Set(); watch.pending.set(sessionId, set) }
      set.add(first)
      const done = () => {
        release()
        set.delete(first)
        if (set.size === 0 && watch.pending.get(sessionId) === set) watch.pending.delete(sessionId)
      }
      try {
        for await (const chunk of next()) {
          done()
          yield chunk
        }
      } finally {
        done()
      }
    })()
  }

  /** Resolve once no main request of this session is waiting for its first chunk (or after `ms`). */
  async settled(sessionId, ms, signal) {
    const set = this.pending.get(sessionId)
    if (set === undefined || set.size === 0 || ms === 0) return false
    let timer
    await Promise.race([
      Promise.all([...set]),
      new Promise((resolve) => { timer = setTimeout(resolve, ms) }),
      new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) }),
    ])
    clearTimeout(timer)
    return true
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  if ((config.provider === '') !== (config.model === '')) {
    throw new Error('deepsea-ask: set both provider and model, or neither')
  }
  const store = new ThreadStore(join(resolveDshHome(), 'plugins', 'ask', 'sessions'), { warn: message => ctx.logger.warn(message) })
  const watch = new MainWatch()
  /** @type {Map<string, AbortController>} exchange id → its run */
  const running = new Map()

  ctx.effect(() => ctx.on('llm/stream', (options, next) => watch.observe(options, next), { global: true }), 'deepsea-ask: main request watch')
  ctx.effect(() => () => { for (const controller of running.values()) controller.abort() }, 'deepsea-ask: runs')

  /** Ask one side question for `agent`; returns once the exchange exists (the answer streams on). */
  function ask(agent, rawQuestion) {
    const question = rawQuestion.trim()
    if (question === '') return { error: 'Empty question.' }
    if (question.length > config.maxQuestionChars) return { error: `Question too long (limit ${String(config.maxQuestionChars)} characters).` }
    const session = agent.session
    const route = resolveRoute(config, session, agent)
    if (route === undefined) return { error: 'No model to answer with: this session has not used one yet.' }
    const position = mainPosition(session.snapshotEvents())
    const earlier = store.get(session.id).exchanges
      .filter(exchange => exchange.status === 'done')
      .slice(-config.historyExchanges)
    const exchange = store.add(session.id, {
      question,
      askedAt: new Date().toISOString(),
      turn: position.turn,
      step: position.step,
      running: position.running,
      seq: position.seq,
      provider: route.provider,
      model: route.model,
    })
    const controller = new AbortController()
    running.set(exchange.id, controller)
    void answer(agent, exchange, earlier, route, controller).finally(() => running.delete(exchange.id))
    return { exchange }
  }

  async function answer(agent, exchange, earlier, route, controller) {
    const session = agent.session
    const tools = ctx.get('tools')
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutSeconds * 1000)])
    const started = Date.now()
    let lastPublish = 0
    try {
      const waited = await watch.settled(session.id, config.waitForMainSeconds * 1000, signal)
      // Built after the wait: the main request that was in flight is now part of the prefix.
      const { messages, replayed, prompt } = buildMessages(session.deriveMessages(), earlier, exchange, { tools: config.tools, route })
      store.update(session.id, exchange.id, { prompt })
      const header = session.requestHeader()
      const result = await runSideQuestion({
        llm: ctx.llm,
        runTool: async (call) => {
          if (tools === undefined) throw new Error('no tool registry')
          const outcome = await tools.execute({ callId: `deepsea-ask:${call.id}`, name: call.name, arguments: call.args, agent, signal })
          return { content: outcome.content, isError: outcome.isError }
        },
        route,
        messages,
        ...header?.tools === undefined ? {} : { tools: header.tools, toolHistory: session.toolHistory() },
        allowedTools: tools === undefined ? [] : config.tools,
        maxAnswerTokens: config.maxAnswerTokens,
        maxToolRounds: config.maxToolRounds,
        sessionId: session.id,
        signal,
        onRequest: request => watch.own.add(request),
        onUpdate: (state) => {
          const now = Date.now()
          if (now - lastPublish < PUBLISH_MS) return
          lastPublish = now
          store.update(session.id, exchange.id, { answer: state.answer, tools: state.tools, usage: state.usage })
        },
      })
      const status = result.kind === 'cancelled' && !controller.signal.aborted ? 'error' : result.kind
      const error = result.kind === 'cancelled' && !controller.signal.aborted ? `No answer within ${String(config.timeoutSeconds)} s.` : result.error
      store.update(session.id, exchange.id, {
        status, answer: result.answer, tools: result.tools, usage: result.usage,
        ...error === undefined ? {} : { error },
        durationMs: Date.now() - started,
      }, true)
      ctx.logger.info('ask: %s %s/%s, %d replayed + %d side messages, %d tool calls, cache read %d / write %d%s, %d ms',
        status, route.provider, route.model, replayed, messages.length - replayed, result.tools.length,
        result.usage.cacheReadTokens ?? 0, result.usage.cacheWriteTokens ?? 0, waited ? ' (waited for main)' : '', Date.now() - started)
    } catch (error) {
      const cancelled = controller.signal.aborted
      const timedOut = !cancelled && signal.aborted
      if (!cancelled && !timedOut) ctx.logger.warn('ask: side call failed: %s', error instanceof Error ? error.stack ?? error.message : String(error))
      store.update(session.id, exchange.id, {
        status: cancelled ? 'cancelled' : 'error',
        ...cancelled ? {} : { error: timedOut ? `No answer within ${String(config.timeoutSeconds)} s.` : `Model error: ${error instanceof Error ? error.message : String(error)}` },
        durationMs: Date.now() - started,
      }, true)
    }
  }

  // ---- the host command ----------------------------------------------------------
  ctx.effect(() => ctx.commands.register({
    name: 'ask',
    description: 'Ask a side question about this session without interrupting it',
    input: { hint: '<question>' },
    handler: (invocation) => {
      // A bare `/ask` (no question) only opens the panel, which the browser half does.
      if (invocation.rawInput.trim() === '') return { kind: 'success', text: 'Side questions' }
      const asked = ask(invocation.agent, invocation.rawInput)
      if (asked.error !== undefined) return { kind: 'error', text: asked.error }
      return { kind: 'success', text: `Side question ${asked.exchange.id}` }
    },
  }), 'deepsea-ask: /ask')

  // ---- control routes for the browser half -----------------------------------------
  const ok = value => ({ ok: true, value })
  const fail = (code, message) => ({ ok: false, error: { code: `deepsea-ask/${code}`, message, details: {} } })
  const dispatch = (endpoint, args) => {
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined
    if (sessionId === undefined) return fail('session', 'sessionId is required')
    switch (endpoint) {
      case 'thread': {
        // Where the main conversation is now: the panel marks where a new question would start a new context.
        const session = ctx.agents.get(sessionId)?.session
        const main = session === undefined ? undefined : mainPosition(session.snapshotEvents())
        return ok({ ...store.snapshot(sessionId), ...main === undefined ? {} : { main: { turn: main.turn, running: main.running } } })
      }
      case 'cancel': {
        running.get(String(args.id))?.abort()
        return ok(store.snapshot(sessionId))
      }
      case 'clear': {
        store.clear(sessionId)
        return ok(store.snapshot(sessionId))
      }
      case 'export': {
        const session = ctx.agents.get(sessionId)?.session
        const cwd = session?.header.cwd
        if (cwd === undefined || !isAbsolute(cwd)) return fail('export', 'This session has no workspace directory.')
        const exchanges = store.snapshot(sessionId).exchanges
        if (exchanges.length === 0) return fail('export', 'No side questions to export.')
        const now = new Date()
        const path = join(cwd, exportName(sessionId, now))
        writeFileSync(path, exportMarkdown(sessionId, exchanges, now))
        return ok({ path })
      }
      default: return fail('unknown-endpoint', `unknown endpoint ${endpoint}`)
    }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = new URL(req.url ?? '/', 'http://x').pathname.slice(CHANNEL.length + 1)
      if (req.method !== 'POST' || endpoint === '' || endpoint.includes('/')) { res.writeHead(404); res.end('not found'); return }
      let message
      try { message = JSON.parse(await readBody(req, MAX_BODY)) } catch { res.writeHead(400); res.end('body is not JSON'); return }
      if (typeof message !== 'object' || message === null || message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) {
        res.writeHead(400); res.end('invalid client-request envelope'); return
      }
      const args = typeof message.payload?.args === 'object' && message.payload.args !== null ? message.payload.args : {}
      let result
      try {
        result = dispatch(endpoint, args)
      } catch (error) {
        result = fail('internal', String(error?.message ?? error))
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
    },
  }), 'deepsea-ask: control routes')
}
