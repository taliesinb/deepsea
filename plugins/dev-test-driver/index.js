/**
 * @deepsea/dev-test-driver: the server half of `dsd drive`. Plain JSON over HTTP
 * on the server's own port, calling the services the GUI calls, so an agent
 * can create sessions, run commands and prompts and read what happened from
 * a shell (README.md).
 *
 * It arms only in a throwaway home (`variant.yml` says `throwaway: true`),
 * and accepts only loopback requests without an `Origin` header carrying the
 * per-process bearer token it writes to `$DSH_HOME/run/test-driver.json`
 * (mode 0600).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { CHANNEL, rejectRequest, selectEvents, STATE_FILE, summarize } from './driver.mjs'

export const name = 'deepsea-dev-test-driver'
export const inject = ['webServer', 'sessionController', 'commands']

const MAX_BODY = 4 * 1024 * 1024
const DEFAULT_WAIT_MS = 120_000

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Whether a home belongs to a throwaway variant. */
export function isThrowawayHome(home) {
  try { return /^throwaway: true$/m.test(readFileSync(join(home, 'variant.yml'), 'utf8')) } catch { return false }
}

/** JSON-safe copy (events are frozen; brands are plain strings). */
const plain = value => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new HttpError(413, 'body-too-large', 'body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Resolve within `ms`: true when `promise` settled in time. */
async function within(promise, ms) {
  let timer
  const timeout = new Promise((r) => { timer = setTimeout(() => r(false), ms) })
  try { return await Promise.race([promise.then(() => true), timeout]) } finally { clearTimeout(timer) }
}

/** Cordis fiber states, as the plugin inventory names them. */
const FIBER_PHASE = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading']

/** Loader rows that should run and do not (pending, loading or failed). */
export function loaderProblems(loader) {
  if (loader === undefined || typeof loader.entries !== 'function') return { known: false }
  const problems = []
  const counts = {}
  for (const entry of loader.entries()) {
    if (entry?.options?.group) continue
    const phase = entry.disabled ? 'disabled' : entry.fiber === undefined ? 'none' : (FIBER_PHASE[entry.fiber.state] ?? String(entry.fiber.state))
    counts[phase] = (counts[phase] ?? 0) + 1
    if (phase === 'pending' || phase === 'loading' || phase === 'failed') problems.push({ id: entry.options.id, name: entry.options.name, phase })
  }
  return { known: true, counts, problems }
}

/** `provider/model[:effort]` → a model selection. */
export function parseModel(spec) {
  const [route, effort] = String(spec).split(':')
  const slash = route.indexOf('/')
  if (slash <= 0 || slash === route.length - 1) throw new HttpError(400, 'bad-model', `model "${spec}" is not provider/model[:effort]`)
  return { provider: route.slice(0, slash), model: route.slice(slash + 1), ...(effort ? { reasoningEffort: effort } : {}) }
}

export function apply(ctx) {
  const home = resolveDshHome()
  if (!isThrowawayHome(home)) {
    ctx.logger.warn(`dev-test-driver: not armed, ${home} is not a throwaway home`)
    return
  }
  const token = randomBytes(32).toString('hex')
  const file = join(home, STATE_FILE)
  const startedAt = new Date().toISOString()
  const baseUrl = () => `http://127.0.0.1:${String(ctx.webServer.port)}`

  ctx.effect(() => {
    void (async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(file, `${JSON.stringify({ pid: process.pid, port: ctx.webServer.port, baseUrl: baseUrl(), channel: CHANNEL, token, startedAt }, null, 2)}\n`, { mode: 0o600 })
    })().catch(error => ctx.logger.warn(`dev-test-driver: could not write ${file}: ${String(error)}`))
    // Remove only our own file: a restarted server may already have replaced it.
    return () => { readFile(file, 'utf8').then(t => (JSON.parse(t).token === token ? rm(file, { force: true }) : undefined)).catch(() => {}) }
  }, 'dev-test-driver: state file')

  const sc = ctx.sessionController
  const need = (args, key) => {
    if (typeof args[key] !== 'string' || args[key] === '') throw new HttpError(400, 'bad-request', `"${key}" (a string) is required`)
    return args[key]
  }
  const agentOf = async (sessionId) => {
    const result = await sc.resolveAgent(sessionId)
    if (result !== undefined && 'error' in result) {
      const code = result.error.code ?? 'session/error'
      throw new HttpError(code === 'session/not-found' ? 404 : 409, code, result.error.message ?? String(result.error))
    }
    return result.agent
  }
  // dsh-v0.2.2 split the Session Controller and dropped inspect(): the events are the Agent's Session's.
  const eventsOf = async (sessionId, signal) => typeof sc.inspect === 'function'
    ? (await sc.inspect(sessionId, signal))?.events ?? []
    : (await agentOf(sessionId))?.session?.snapshotEvents?.() ?? []
  const nextSeq = events => (events.length === 0 ? 0 : (events.at(-1).seq ?? events.length - 1) + 1)

  const ops = {
    health: async () => ({
      pid: process.pid,
      port: ctx.webServer.port,
      home,
      startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      loader: loaderProblems(ctx.get('loader')),
    }),

    'create-session': async (args, signal) => {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined) throw new HttpError(503, 'no-workspaces', 'the workspace registry is not mounted')
      let workspaceId
      if (args.cwd !== undefined) {
        const cwd = resolve(String(args.cwd))
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HttpError(400, 'bad-cwd', `${cwd} is not a directory`)
        workspaceId = (await registry.create(cwd)).id
      } else {
        // The default workspace, as the GUI would make it on first use (inside a throwaway's home:
        // dsd points its Documents directory there); else a workspace in the home.
        const made = await ctx.get('workspaceController')?.initializeDefault(signal)
        if (made?.workspace?.workspaceId !== undefined) workspaceId = made.workspace.workspaceId
        else {
          const dir = join(home, 'workspace')
          await mkdir(dir, { recursive: true })
          workspaceId = (await registry.create(dir)).id
        }
      }
      const created = await sc.create({
        workspaceId,
        ...(typeof args.preset === 'string' ? { agentPreset: args.preset } : {}),
      })
      const sessionId = created.sessionId
      // The request is the selection itself beside the session (provider, model, reasoningEffort?).
      if (args.model !== undefined) await sc.selectModel({ sessionId, ...parseModel(args.model) })
      if (typeof args.title === 'string' && args.title !== '') await sc.rename({ sessionId, title: args.title })
      return { ...plain(created), workspaceId }
    },

    command: async (args, signal) => {
      const sessionId = need(args, 'sessionId')
      const line = need(args, 'line')
      const agent = await agentOf(sessionId)
      const execution = await ctx.commands.execute(agent, line.startsWith('/') ? line : `/${line}`, [], signal)
      if (execution === undefined) throw new HttpError(404, 'unknown-command', `no command matches "${line}" in ${sessionId}`)
      return plain(execution)
    },

    prompt: async (args, signal) => {
      const sessionId = need(args, 'sessionId')
      const text = need(args, 'text')
      await agentOf(sessionId)
      const since = nextSeq(await eventsOf(sessionId, signal))
      await sc.prompt({ requestId: randomUUID(), sessionId, mode: args.mode === 'steer' ? 'steer' : 'queue', content: [{ type: 'text', text }] }, signal)
      if (args.wait !== true) return { accepted: true, since }
      return { accepted: true, since, ...(await ops.wait({ sessionId, since, timeoutMs: args.timeoutMs }, signal)) }
    },

    wait: async (args, signal) => {
      const sessionId = need(args, 'sessionId')
      const agent = await agentOf(sessionId)
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_WAIT_MS
      // A prompt is accepted before its turn starts: give the turn a moment to begin.
      await new Promise(r => setTimeout(r, 50))
      const idle = await within(Promise.resolve(agent.whenIdle()), timeoutMs)
      const events = await eventsOf(sessionId, signal)
      const since = typeof args.since === 'number' ? args.since : 0
      return { idle, status: agent.status, seq: nextSeq(events), summary: summarize(events.filter(e => (e.seq ?? 0) >= since)) }
    },

    events: async (args, signal) => {
      const events = await eventsOf(need(args, 'sessionId'), signal)
      return { seq: nextSeq(events), events: plain(selectEvents(events, args)) }
    },

    cancel: async args => plain((await sc.cancel({ sessionId: need(args, 'sessionId') })) ?? { accepted: true }),

    sessions: async (_args, signal) => plain(await sc.list({}, signal)),

    invoke: async (args) => {
      const gateway = ctx.get('typertGateway')
      if (gateway === undefined) throw new HttpError(503, 'no-gateway', 'typertGateway is not mounted')
      const value = await gateway.invoke({ namespace: need(args, 'namespace'), method: need(args, 'method'), args: args.args ?? {} })
      return value === undefined ? null : plain(value)
    },
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`${JSON.stringify(body)}\n`)
  }

  ctx.logger.info('armed on %s%s', baseUrl(), CHANNEL)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const refusal = rejectRequest({ remoteAddress: req.socket.remoteAddress, headers: req.headers }, token)
      if (refusal !== undefined) { send(res, refusal.status, { ok: false, error: { code: 'auth', message: refusal.message } }); return }
      const op = new URL(req.url ?? '/', 'http://x').pathname.slice(CHANNEL.length + 1)
      const handler = Object.hasOwn(ops, op) ? ops[op] : undefined
      if (handler === undefined) { send(res, 404, { ok: false, error: { code: 'unknown-op', message: `unknown operation "${op}"`, ops: Object.keys(ops) } }); return }
      const controller = new AbortController()
      res.on('close', () => { if (!res.writableFinished) controller.abort() })
      try {
        if (req.method !== 'POST') throw new HttpError(405, 'method', 'POST with a JSON object body')
        const body = await readBody(req)
        const args = body.trim() === '' ? {} : JSON.parse(body)
        if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new HttpError(400, 'bad-request', 'the body must be a JSON object')
        send(res, 200, { ok: true, value: await handler(args, controller.signal) })
      } catch (error) {
        const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500
        send(res, status, { ok: false, error: { code: error?.code ?? (error instanceof SyntaxError ? 'bad-json' : 'internal'), message: String(error?.message ?? error) } })
      }
    },
  }), 'dev-test-driver: route')
}
