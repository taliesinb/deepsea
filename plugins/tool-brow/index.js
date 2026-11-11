/**
 * @deepsea/tool-brow: per-chat browser windows for agents, served
 * by the standalone brow daemon (Safari Technology Preview and
 * Chrome for Testing behind nine `browser_*` tools). This plugin drives no
 * browser itself: it is a client of the daemon's Unix socket (JSON-RPC,
 * daemon-client.mjs).
 *
 * Two rows, one package. This module is the package root, row
 * `deepsea-tool-brow` ("Brow"), global: the connection
 * to the daemon (started when none runs), one daemon session per agent, the
 * idle notices the daemon sends, inline screenshots through the attachment
 * store, the DeepSea app's window relay and the browser half; it provides
 * the `deepseaBrow` service once the daemon has listed its tools.
 * The subpath `@deepsea/tool-brow/tools` (tools-row.js, row
 * `deepsea-tool-brow-tools`, "Brow tools") registers
 * those tools, under the daemon's names and JSON Schemas, once per mount:
 * dsd puts it into the agent presets that have tool-web.
 *
 * SESSIONS. Each agent (a chat's, or a subagent's) is one daemon session:
 * `session.open { key: agent id, label: the chat title, cwd: the session's
 * working directory, lease: connection }`, opened at the agent's first tool
 * call, re-opened after a reconnect (all at once: `session.resume`),
 * updated when the title or directory
 * changes, closed on `agent/disposed` and at unload. With a `connection`
 * lease the daemon also ends the session (closing its windows) some seconds
 * after this server's connection goes away.
 *
 * Only one browser plugin should run in a variant (this one,
 * @deepsea/tool-browser-unified or @deepsea/tool-browser): they register the
 * same tool names or drive the same browsers.
 *
 * The daemon's own names (command, app, LaunchAgent, default home, environment variables) are in
 * daemon-names.mjs; the names below are today's.
 *
 * Config (all optional; `subagents` is on the tools row):
 *
 *   brow:
 *     socket: ''                # '' = <home>/run/daemon.sock, else the daemon's default
 *                               #      ($BROW_SOCKET, else ~/Library/Application Support/io.github.taliesinb.brow/run/daemon.sock)
 *     home: ''                  # the daemon's home (BROW_HOME for a daemon this plugin starts)
 *     command: brow   # `<command> start` starts the daemon: a name on PATH, or a checkout's bin/brow.mjs
 *     autostart: true           # start the daemon when none answers (at startup and on a tool call): for the
 *                               # default socket and configuration, its LaunchAgent, else Brow.app,
 *                               # else the command; otherwise the command only (usesDefaultDaemon)
 *     env: {}                   # extra environment for a daemon this plugin starts (e.g. BROW_CONFIG)
 *     startTimeoutMs: 15000
 *   trace: false
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createTrace } from '@deepsea/logs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { assertSupportedJsonSchema, ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { createAppRelay, registerAppRelayRoutes } from './app-relay.mjs'
import { CONNECTION_CLOSED, ERRORS, socketPathOf } from './daemon-client.mjs'
import { APP_NAME, DAEMON_COMMAND, ENV_CONFIG, ENV_HOME, ENV_SOCKET } from './daemon-names.mjs'
import { createLink } from './link.mjs'
import { createBrowsersView, registerBrowsersRoutes } from './browsers-view.mjs'

export const name = 'deepsea-tool-brow'

/** The service this row provides and the tools row reads (tools-row.js). */
export const SERVICE = 'deepseaBrow'
/** Services of the in-process browser plugins, which must not run beside this one. */
const OTHER_BROWSER_SERVICES = ['deepseaBrowserUnified', 'deepseaBrowser']

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/** Retries of the first connection (tools come from the daemon, so none are registered until one succeeds). */
const STARTUP_RETRY_MS = [5_000, 15_000, 60_000, 300_000]

export const Config = Schema.object({
  brow: Schema.object({
    socket: Schema.string().default(''),
    home: Schema.string().default(''),
    command: Schema.string().default(DAEMON_COMMAND),
    autostart: Schema.boolean().default(true),
    env: Schema.dict(Schema.string()).default({}),
    startTimeoutMs: Schema.number().min(1000).default(15_000),
  }).default({}),
  trace: Schema.boolean().default(false),
})

/** The source of this plugin's notices (session format v4 refuses a message without one). */
const NOTICE_SOURCE = { kind: name }

/** Prefix of screenshots saved to a file when they cannot be shown inline. */
const SCREENSHOT_SCRATCH = 'deepsea-tool-brow-screenshot-'

/**
 * A complete user-role message for `agent.inject` (`UserMessage.content` is a `ContentBlock[]`; a bare
 * string would be persisted as is and break every later turn of the session).
 * @param {string} text
 */
export function pluginNotice(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: NOTICE_SOURCE }
}

/**
 * Environment of a daemon this plugin starts: the server's, the configured home (and socket, when it is
 * not the home's), then `brow.env`.
 */
export function daemonEnv(config, env = process.env) {
  const own = config.brow
  return {
    ...env,
    ...(own.home !== '' ? { [ENV_HOME]: own.home } : {}),
    ...(own.socket !== '' ? { [ENV_SOCKET]: own.socket } : {}),
    ...own.env,
  }
}

/**
 * Is the daemon to reach the person's own (the default home's socket, the default configuration)? Then a
 * missing daemon is started the way it is installed (LaunchAgent, then Brow.app) before the
 * command. A configured socket or home, BROW_HOME / _SOCKET in the server's environment, or a
 * BROW_CONFIG (the server's or `brow.env`'s) can only be served by a daemon this
 * plugin spawns itself.
 */
export function usesDefaultDaemon(config, env = process.env) {
  const own = config.brow
  const merged = { ...env, ...own.env }
  return own.socket === '' && own.home === '' && !merged[ENV_HOME] && !merged[ENV_SOCKET] && !merged[ENV_CONFIG]
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 * @param {ReturnType<typeof Config>} config
 * @param {{ trace?: (event: object) => void, connect?: Function, start?: { run?: Function, platform?: string, uid?: number }, scratch?: string, env?: NodeJS.ProcessEnv, startupRetryMs?: number[], reconnectDelaysMs?: number[] }} [seams] - test seams (`start`: daemon-client.mjs startDaemon's).
 */
export function apply(ctx, config, seams = {}) {
  const trace = seams.trace ?? createTrace({ enabled: config.trace, name: 'tool-brow', plugin: `${pkg.name}@${pkg.version}`, home: resolveDshHome() })
  const scratch = seams.scratch ?? tmpdir()
  const env = seams.env ?? process.env
  const own = config.brow
  const socket = socketPathOf(own, { ...env, ...own.env })
  const preferInstalled = usesDefaultDaemon(config, env)
  for (const other of OTHER_BROWSER_SERVICES) {
    ctx.inject([other], () => {
      ctx.logger.warn(`tool-brow: ${other} (another browser plugin) is also loaded; run only one browser plugin in a variant (they register the same tools or drive the same browsers)`)
    })
  }

  const link = createLink({
    socket,
    autostart: own.autostart ? { command: own.command, env: daemonEnv(config, env), timeoutMs: own.startTimeoutMs, preferInstalled, ...seams.start } : false,
    name: name,
    version: pkg.version,
    logger: ctx.logger,
    trace,
    ...(seams.connect ? { connect: seams.connect } : {}),
    ...(seams.reconnectDelaysMs ? { reconnectDelaysMs: seams.reconnectDelaysMs } : {}),
  })

  // ------------------------------------------------------------ sessions: one per agent

  /**
   * agent id → { agent, key, label, cwd, client (the connection it was opened on), opening, pid, used, note }
   * @type {Map<string, any>}
   */
  const sessions = new Map()
  const browsers = createBrowsersView({ link, sessions })

  function labelOf(agent) {
    let title
    try {
      title = ctx.get('sessionTitle')?.get(agent.session)?.title
    } catch {
      // No title service, or no title for this session shape; the id serves.
    }
    const text = typeof title === 'string' && title.trim() !== '' ? title.trim() : `chat ${String(agent.id).slice(-8)}`
    return text.replace(/\s+/g, ' ').slice(0, 70)
  }

  const cwdOf = (agent) => agent.session?.header?.cwd

  /** session.open's params for an entry on `client` (its label and directory read now). */
  function specOf(entry, client) {
    entry.client = client
    entry.label = labelOf(entry.agent)
    entry.cwd = cwdOf(entry.agent)
    return { key: entry.key, label: entry.label, ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}), lease: 'connection' }
  }

  /** An opened (or resumed) session: the restart note when its windows are gone. */
  function opened(entry, client, result, via) {
    if (entry.used && !result.resumed) {
      entry.note = entry.pid !== undefined && entry.pid !== client.hello.pid
        ? `NOTE: the brow daemon restarted (pid ${entry.pid} → ${client.hello.pid}); this chat's earlier browser windows are gone. `
        : 'NOTE: the brow daemon had ended this chat\'s session (its lease lapsed); its earlier browser windows are gone. '
    }
    entry.pid = client.hello.pid
    void browsers.watch(client)
    trace({ event: 'session-open', key: entry.key, label: entry.label, resumed: result.resumed, windows: result.windows, via })
    return result
  }

  /** `entry.opening` is the promise every call of that agent waits for; a failure lets the next call open again. */
  function track(entry, client, opening) {
    entry.opening = opening
    entry.opening.catch(() => { if (entry.client === client) entry.client = undefined })
    return entry.opening
  }

  function open(entry, client) {
    const spec = specOf(entry, client)
    return track(entry, client, client.request('session.open', spec).then(result => opened(entry, client, result, 'session.open')))
  }

  /**
   * Re-open many sessions on a new connection in one request (`session.resume`: a daemon restart with
   * several chats). An entry that fails is left unbound, so its next call opens it with `session.open`.
   */
  function resume(entries, client) {
    const batch = client.request('session.resume', { sessions: entries.map(entry => specOf(entry, client)) })
    entries.forEach((entry, i) => {
      track(entry, client, batch.then((answer) => {
        const result = answer.sessions[i]
        if (result.error !== undefined) throw new Error(`session.resume of "${entry.key}" failed: ${result.error}`)
        return opened(entry, client, result, 'session.resume')
      }))
    })
    return Promise.allSettled(entries.map(entry => entry.opening))
  }

  /** The agent's daemon session on the live connection (connecting, starting the daemon, opening as needed). */
  async function sessionOf(agent) {
    let client
    try {
      client = await link.ensure({ autostart: true })
    } catch (error) {
      throw new Error(`the brow daemon is not available: ${String(error?.message ?? error)}. ${own.autostart ? `Check that ${preferInstalled ? `${APP_NAME} is installed, or that ` : ''}"${own.command} start" works on this machine (brow.command)` : `Start it (${preferInstalled ? `open ${APP_NAME}, or ` : ''}${own.command} start), or turn on brow.autostart`}, then retry.`, { cause: error })
    }
    let entry = sessions.get(agent.id)
    if (entry === undefined) {
      entry = { agent, key: String(agent.id), used: false, note: '' }
      sessions.set(agent.id, entry)
    }
    entry.agent = agent
    if (entry.client !== client) open(entry, client)
    await entry.opening
    // The title (and the directory) may change during a chat: the daemon labels the windows it opens later.
    const label = labelOf(agent)
    const cwd = cwdOf(agent)
    if (label !== entry.label || cwd !== entry.cwd) {
      entry.label = label
      entry.cwd = cwd
      void client.request('session.update', { session: entry.key, label, ...(cwd !== undefined ? { cwd } : {}) }).catch(() => {})
    }
    return { entry, client }
  }

  // A new connection (a restarted daemon, or the first after a drop): the sessions in use come back, in
  // one request. Every entry is bound to the new connection at once, so a call arriving meanwhile waits
  // for its session instead of opening it again.
  link.onConnected(async (client) => {
    const entries = [...sessions.values()].filter(entry => entry.client !== client && entry.used)
    if (entries.length > 0) await resume(entries, client)
  })

  link.on('session.notice', (params) => {
    const entry = sessions.get(String(params?.session ?? ''))
    if (entry === undefined || typeof params.text !== 'string') return
    trace({ event: 'notice', key: entry.key, text: params.text })
    try {
      entry.agent.inject(pluginNotice(params.text))
    } catch {
      // The agent may be disposed or not accepting injections; the daemon has acted either way.
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const entry = sessions.get(agent.id)
    if (entry === undefined) return
    sessions.delete(agent.id)
    void browsers.watch()
    const client = link.current()
    if (client === undefined || entry.client !== client) return
    void client.request('session.close', { session: entry.key }).then(
      ({ closed }) => trace({ event: 'session-close', key: entry.key, reason: 'agent-disposed', closed }),
      (error) => ctx.logger.warn(`tool-brow: closing the browser session of disposed agent "${agent.id}" failed: ${String(error?.message ?? error)}`),
    )
  })

  // ------------------------------------------------------------ images

  // Inline screenshots need the attachment store and the model's declared input modalities.
  let imaging
  ctx.inject(['attachments', 'llm'], (scoped) => {
    imaging = { attachments: scoped.attachments, llm: scoped.llm }
    scoped.effect(() => () => { imaging = undefined }, 'tool-brow: inline screenshots')
  })

  /** The same admission rule as the harness's MCP bridge: store the image only when the current model declares image input. */
  async function admitImage(exec, bytes, imageName, mediaType = 'image/png') {
    if (imaging === undefined) return { reason: 'no attachment store is mounted' }
    const routed = exec.agent?.session.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    if (provider === undefined || model === undefined) return { reason: 'the current model route could not be resolved' }
    let info
    try { info = await imaging.llm.resolveModelInfo(provider, model, exec.signal) } catch { return { reason: 'the current model route could not be verified' } }
    if (!info.inputModalities?.includes('image')) return { reason: `model "${model}" does not declare image input` }
    const [ref] = await imaging.attachments.saveImages([{ data: bytes, mediaType, name: imageName }])
    return { ref }
  }

  /** Image refs admitted by a running call, for its finalizeContent (exec → refs). */
  const inlineImages = new WeakMap()

  // ------------------------------------------------------------ tool calls

  /**
   * Run one daemon tool for the calling agent. Text blocks become the result value; image blocks are
   * admitted to the attachment store (or saved to a file, said in the text) and put in front of the
   * result by `finalize`. A failed tool throws its text, as the in-process tools did (`failureText`). A call
   * cancelled by its own signal returns, so the harness records its cancelled result (`ABORTED`, a stopped
   * row) rather than a failure; one the daemon cancelled for another reason (`error.aborted`: the session
   * ended, the daemon is stopping) throws, saying so.
   * @param {object} exec - the harness's ToolRunContext.
   * @param {string} toolName
   * @param {object} args
   */
  async function call(exec, toolName, args) {
    const agent = exec?.agent
    if (agent === undefined) throw new Error('this tool needs a calling agent (no exec.agent)')
    let { entry, client } = await sessionOf(agent)
    const request = () => client.request('tools.call', { session: entry.key, name: toolName, arguments: args ?? {}, images: 'inline' }, { signal: exec.signal })
    const cancelled = (answered) => {
      trace({ event: 'call', key: entry.key, tool: toolName, cancelled: true, answered })
      return `${toolName} cancelled`
    }
    let result
    try {
      result = await request()
    } catch (error) {
      // Cancelled (a daemon that did not answer the cancel in time included): the harness replaces this value.
      if (exec.signal?.aborted) return cancelled(false)
      if (error?.code === ERRORS.INVALID_PARAMS && /unknown session/i.test(String(error.message))) {
        // The session lapsed (the lease ended while this server was away): open it again, once.
        open(entry, client)
        await entry.opening
        result = await request()
      } else if (error?.message === CONNECTION_CLOSED) {
        throw new Error(`the brow daemon connection closed during ${toolName} (the daemon stopped or restarted); the call may or may not have run. Retry; windows may have to be opened again.`, { cause: error })
      } else {
        throw error
      }
    }
    entry.used = true
    browsers.recordCall(entry, toolName, args ?? {}, result)
    // Cancelled by its own signal: the harness records the cancelled result and drops this value (notes kept for the next).
    if (exec.signal?.aborted) return cancelled(true)
    const note = link.takeStartNote() + entry.note
    entry.note = ''
    const texts = []
    const images = []
    for (const block of Array.isArray(result?.content) ? result.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block?.type === 'image' && typeof block.data === 'string') images.push(block)
    }
    if (result?.isError) {
      const failure = result.error
      trace({ event: 'call', key: entry.key, tool: toolName, error: true, aborted: failure.aborted === true, handle: failure.handle })
      if (failure.aborted === true) {
        throw new Error(`${note}${toolName} was cancelled by the brow daemon (this chat's browser session ended, or the daemon is stopping): ${failureText(texts.join('\n'), failure, toolName)}. Retry if it is still needed.`)
      }
      throw new Error(note + failureText(texts.join('\n'), failure, toolName))
    }
    let text = note + texts.join('\n')
    const browser = /\[(safari|chrome):\d+:\d+\]/.exec(text)?.[1] ?? 'browser'
    const refs = []
    for (const image of images) {
      const mediaType = typeof image.mimeType === 'string' ? image.mimeType : 'image/png'
      const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'
      const bytes = new Uint8Array(Buffer.from(image.data, 'base64'))
      const admitted = await admitImage(exec, bytes, `${browser}-${Date.now()}.${ext}`, mediaType)
      if (admitted.ref !== undefined) { refs.push(admitted.ref); continue }
      const path = join(scratch, `${SCREENSHOT_SCRATCH}${Date.now()}-${process.pid}-${refs.length + 1}.${ext}`)
      await writeFile(path, bytes)
      text += `\nscreenshot not shown inline (${admitted.reason}); saved to ${path}, view it with read_image`
    }
    if (refs.length > 0) inlineImages.set(exec, refs)
    trace({ event: 'call', key: entry.key, tool: toolName, images: images.length, inline: refs.length })
    return text
  }

  /**
   * A failed result (`isError`) as the error the model sees: the daemon's text, unchanged (its `Hint:` line
   * included), with the window it used in front (`[chrome:0:1] `, from the structured `error.handle`) when the
   * text does not name it, as successful results do; the structured `message` and `hint` when there is no text.
   * @param {string} text
   * @param {{ message: string, hint?: string, handle?: string }} failure - the result's `error`.
   * @param {string} toolName
   */
  function failureText(text, failure, toolName) {
    const body = text !== '' ? text
      : failure.message !== '' ? `${failure.message}${failure.hint !== undefined ? `\nHint: ${failure.hint}` : ''}`
        : `${toolName} failed`
    return failure.handle !== undefined && !body.includes(`[${failure.handle}]`) ? `[${failure.handle}] ${body}` : body
  }

  /** finalizeContent: the admitted images in front of the text (only for a successful result). */
  function finalize(exec, result) {
    const refs = inlineImages.get(exec)
    if (refs === undefined) return undefined
    inlineImages.delete(exec)
    if (result.isError) return undefined
    return [...refs.map(ref => ({ type: 'image', attachment: ref })), ...result.content]
  }

  // ------------------------------------------------------------ the tools: provided once the daemon lists them

  let toolsJson
  let unprovide
  let providing = Promise.resolve()

  async function refreshTools(client) {
    const listed = await client.request('tools.list', {})
    const tools = []
    for (const tool of Array.isArray(listed?.tools) ? listed.tools : []) {
      if (typeof tool?.name !== 'string' || typeof tool.description !== 'string') continue
      try {
        assertSupportedJsonSchema(tool.inputSchema)
      } catch (error) {
        ctx.logger.warn(`tool-brow: tool ${tool.name} left out: its input schema is not one the harness takes (${String(error?.message ?? error)})`)
        continue
      }
      tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    }
    const json = JSON.stringify(tools)
    if (json === toolsJson) return
    const first = toolsJson === undefined
    toolsJson = json
    // Re-provided when the daemon's tools change (a newer daemon): the tools row registers them again.
    providing = providing.then(async () => {
      await unprovide?.()
      unprovide = ctx.provide(SERVICE, { tools, call, finalize, trace })
    })
    await providing
    trace({ event: 'tools', names: tools.map(t => t.name), changed: !first })
    if (!first) ctx.logger.info(`tool-brow: the brow daemon's tools changed; registered again (${tools.map(t => t.name).join(', ')})`)
  }
  link.onConnected((client) => refreshTools(client))
  // The daemon says when its list changes while it runs (`tools.changed {}`): read it again.
  link.on('tools.changed', () => {
    const client = link.current()
    if (client !== undefined) refreshTools(client).catch((error) => ctx.logger.warn(`tool-brow: re-reading the tools failed: ${String(error?.message ?? error)}`))
  })

  let startupTimer
  let unloading = false
  function startup(attempt) {
    link.ensure({ autostart: own.autostart }).catch((error) => {
      if (unloading || toolsJson !== undefined) return
      const retryMs = (seams.startupRetryMs ?? STARTUP_RETRY_MS)
      const delay = retryMs[Math.min(attempt, retryMs.length - 1)]
      ctx.logger.warn(`tool-brow: no brow daemon (${String(error?.message ?? error)}); the browser tools appear once one answers on ${socket} (next try in ${Math.round(delay / 1000)} s)`)
      trace({ event: 'startup-failed', attempt, error: String(error?.message ?? error) })
      startupTimer = setTimeout(() => { if (toolsJson === undefined && link.current() === undefined) startup(attempt + 1) }, delay)
      startupTimer.unref?.()
    })
  }
  startup(0)

  // ------------------------------------------------------------ the DeepSea app's window

  const relay = createAppRelay({ link, trace })
  ctx.inject(['connection'], (scoped) => {
    const paths = [...registerAppRelayRoutes(scoped, relay), ...registerBrowsersRoutes(scoped, browsers)]
    trace({ event: 'serving', paths })
  })

  // Unload: the sessions end now (not after the lease's grace), then the connection.
  ctx.effect(() => async () => {
    unloading = true
    clearTimeout(startupTimer)
    const client = link.current()
    if (client !== undefined) {
      await Promise.all([...sessions.values()].filter(entry => entry.client === client).map(entry =>
        client.request('session.close', { session: entry.key }).catch(() => {})))
    }
    sessions.clear()
    await link.dispose()
  }, 'tool-brow: daemon connection')

  trace({ event: 'applied', socket, command: own.command, autostart: own.autostart, preferInstalled })
}

/**
 * The `deepseaBrow` service: the daemon's tools and how to call them.
 * @typedef {object} BrowService
 * @property {{ name: string, description: string, inputSchema: object }[]} tools
 * @property {(exec: object, name: string, args: object) => Promise<string>} call
 * @property {(exec: object, result: object) => object[] | undefined} finalize
 * @property {(event: object) => void} trace
 */

const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }

/**
 * Harness tool definitions for one mount of the tools row: the daemon's names, descriptions and JSON
 * Schemas, arguments validated here (as `defineTool` does), each call forwarded to the daemon.
 * @param {BrowService} service
 */
export function toolsOf(service) {
  return service.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    output: textOutput,
    async execute(args, exec) {
      const violations = validateJsonSchemaValue(tool.inputSchema, args ?? {}, '')
      if (violations.length > 0) throw new ToolArgsError(violations)
      return service.call(exec, tool.name, args ?? {})
    },
    finalizeContent: (exec, result) => service.finalize(exec, result),
  }))
}
