/**
 * @deepsea/browser: per-chat Safari Technology Preview and Chrome windows for agents.
 *
 * The plugin owns the MCP forwarding: it holds private MCP connections to
 * Apple's Safari MCP server (`safaridriver --mcp`, Safari Technology Preview)
 * and Google's `chrome-devtools-mcp`, and registers exactly the tools of
 * tools.mjs (`safari_*`, `chrome_*`) into each eligible agent's scope. No raw
 * server tool reaches the model. The tool set is static; every call reads
 * `exec.agent` to find the caller's windows (windows.mjs).
 *
 * WINDOWS. `safari_open` / `chrome_open` return ids like `s:0:2` / `c:0:0`
 * (session index, then window index within that session). Every window tool
 * takes an optional `windowId`. A Safari window is its own `safaridriver
 * --mcp` process (its own STP window, its banner naming the chat and the id);
 * Chrome windows are pages of one Chrome instance per session, with a
 * throwaway profile. Ids are validated against the caller's session.
 *
 * LIFECYCLE. Nothing is spawned until a tool needs it. A per-session idle
 * timer (`idleMinutes`, reset by every tool call) closes a session's windows
 * and tells the agent; agent disposal and plugin unload close everything.
 *
 * READERS. `safari_get_page_content` with a url (and no windowId) and
 * `safari_get_youtube_notes` read in a pool of isolated Safari readers
 * (reader-pool.mjs), never in a chat's own window.
 *
 * COVERED WINDOWS. A Safari window that opaque windows cover completely stops
 * running its page's animations; `safari.hiddenWindows` picks the remedy:
 * park (placement.mjs, through DeepSea Window Helper and the DeepSea app's
 * window cooperation, app-windows.mjs), activate (foreground.mjs) or off.
 *
 * Config (all optional):
 *
 *   safari:
 *     enabled: true
 *     driver: /Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver
 *     labelPrefix: 'DeepSea: '   # STP banner: "This window is controlled by DeepSea: <chat title> · s:0:0."
 *     hiddenWindows: park        # park | activate | off
 *     park:
 *       helper: ~/Library/Application Support/io.github.taliesinb.deepsea/DeepSea Window Helper.app
 *       sliver: 48               # visible width of a parked window (pt)
 *       step: 32                 # each further window parks this much lower
 *       makeRoom: true           # trim the frontmost window out of the strip when it covers the page
 *       minWidth: 480            # never trim a window below this width
 *       largeScreenWidth: 1920   # a screen at least this wide (visible pt) counts as large
 *       besideMaxFraction: 0.72  # this server's DeepSea app in front on a large screen, ending within this
 *                                # fraction of its width: agent windows open beside it
 *       gap: 12                  # space between that window and the agent's windows or the strip
 *       overhang: 8              # windows placed beside it stick out this far past the screen's right edge
 *     reader:
 *       enabled: true
 *       maxIdle: 1               # readers kept warm after a read
 *       idleMinutes: 30          # close warm readers after this long unused (0 = never)
 *       maxChars: 120000         # page reads beyond this are cut (full text in a scratch file)
 *   chrome:
 *     enabled: true
 *     command: ''                # '' = the chrome-devtools-mcp pinned in package.json, run with the server's
 *                                # node; a path runs that executable instead
 *     headless: false            # no visible windows (tests, machines without a GUI session)
 *     hideAutomationBanner: true # no "controlled by automated test software" bar
 *     keepFocus: true            # open pages in the background, give focus back when Chrome takes it
 *     quietStderr: true          # drop chrome-devtools-mcp's launch boilerplate from stderr
 *     args: []                   # extra chrome-devtools-mcp flags
 *   subagents: true              # delegated child agents get the tools too (each its own session)
 *   skipPresets: [minimal, minimal-no-tools]   # agent presets that never get these tools
 *   idleMinutes: 30              # close a session's windows after this long without a tool call (0 = never)
 *   toolCallTimeoutMs: 60000     # per MCP call
 *   trace: false                 # JSONL lifecycle trace in the variant's log directory (@deepsea/logs)
 */

import { CHROME_INSTALL_REMEDY, STP_INSTALL_REMEDY, checkSafariTechnologyPreview, findChrome } from './environment.mjs'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createTrace } from '@deepsea/logs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createNotes, createTools } from './tools.mjs'
import { appBundleOf, createForeground } from './foreground.mjs'
import { createPlacement, WINDOW_HELPER_PATH } from './placement.mjs'
import { createAppWindows, registerAppWindowRoutes } from './app-windows.mjs'
import { createReaderPool } from './reader-pool.mjs'
import { CHROME_STDERR_NOISE, safariInstance } from './servers.mjs'
import { BrowserSessions } from './windows.mjs'

export const name = 'deepsea-browser'

// `attachments` and `llm` (inline screenshots) and `connection` (the DeepSea app's window routes) are
// optional: injected below, so a composition without them still gets the tools.
export const inject = ['agents', 'tools', 'sessionProjections']

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export const Config = Schema.object({
  safari: Schema.object({
    enabled: Schema.boolean().default(true),
    driver: Schema.string().default('/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver'),
    labelPrefix: Schema.string().default('DeepSea: '),
    hiddenWindows: Schema.union(['park', 'activate', 'off']).default('park'),
    park: Schema.object({
      helper: Schema.string().default(WINDOW_HELPER_PATH),
      sliver: Schema.number().min(8).default(48),
      step: Schema.number().min(8).default(32),
      makeRoom: Schema.boolean().default(true),
      minWidth: Schema.number().default(480),
      largeScreenWidth: Schema.number().default(1920),
      besideMaxFraction: Schema.number().min(0.1).max(1).default(0.72),
      gap: Schema.number().min(0).default(12),
      overhang: Schema.number().min(2).default(8),
    }).default({}),
    reader: Schema.object({
      enabled: Schema.boolean().default(true),
      maxIdle: Schema.number().min(0).default(1),
      idleMinutes: Schema.number().min(0).default(30),
      maxChars: Schema.number().min(1000).default(120_000),
    }).default({}),
  }).default({}),
  chrome: Schema.object({
    enabled: Schema.boolean().default(true),
    command: Schema.string().default(''),
    headless: Schema.boolean().default(false),
    hideAutomationBanner: Schema.boolean().default(true),
    keepFocus: Schema.boolean().default(true),
    quietStderr: Schema.boolean().default(true),
    args: Schema.array(String).default([]),
  }).default({}),
  subagents: Schema.boolean().default(true),
  skipPresets: Schema.array(Schema.string()).default(['minimal', 'minimal-no-tools']),
  idleMinutes: Schema.number().min(0).default(30),
  toolCallTimeoutMs: Schema.number().default(60_000),
  trace: Schema.boolean().default(false),
})

/**
 * The source of this plugin's notices: its own kind, as harness producers name theirs. Session
 * format v4 refuses a message without one, or with the retired `{ kind: 'plugin', plugin }`
 * wrapper, and a refused message stops every later write of the session's log.
 */
const NOTICE_SOURCE = { kind: name }

/** Prefix of every Chrome instance's scratch directory: `<tmp>/deepsea-browser-profile-<pid>-<session>-<random>/`. */
const CHROME_SCRATCH = 'deepsea-browser-profile-'

/**
 * A complete user-role message for `agent.inject`. The harness's
 * `UserMessage.content` is a `ContentBlock[]`; a bare string would be
 * persisted as is and break every later turn of the session ("content.some is
 * not a function").
 * @param {string} text - the notice text.
 */
export function pluginNotice(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: NOTICE_SOURCE }
}

/**
 * The chrome-devtools-mcp to run: `{ command, args }` for the spawn, plus a
 * description for messages. Default (`chrome.command: ''`): the version pinned
 * in this plugin's package.json, its bin script run by the server's own node
 * (`process.execPath`), so no global install, PATH or shebang is involved and
 * `pnpm install` in the plugin directory is the whole upgrade. A non-empty
 * `chrome.command` is an executable path used verbatim.
 * @returns {{ command: string, args: string[], describe: string, missing?: string }}
 */
export function chromeServer(config) {
  if (config.chrome.command !== '') {
    return existsSync(config.chrome.command)
      ? { command: config.chrome.command, args: [], describe: config.chrome.command }
      : { command: config.chrome.command, args: [], describe: config.chrome.command, missing: `no chrome-devtools-mcp at "${config.chrome.command}" (chrome.command); set chrome.command to '' to use the version installed with the plugin` }
  }
  let packageJson
  try {
    packageJson = createRequire(import.meta.url).resolve('chrome-devtools-mcp/package.json')
  } catch {
    return { command: process.execPath, args: [], describe: 'chrome-devtools-mcp', missing: 'the plugin\'s chrome-devtools-mcp is not installed: run `pnpm install` in the plugin directory' }
  }
  const bin = join(dirname(packageJson), 'build/src/bin/chrome-devtools-mcp.js')
  const version = (() => { try { return JSON.parse(readFileSync(packageJson, 'utf8')).version } catch { return '?' } })()
  return { command: process.execPath, args: [bin], describe: `chrome-devtools-mcp ${version}`, ...(existsSync(bin) ? {} : { missing: `chrome-devtools-mcp ${version} has no bin at ${bin}` }) }
}

/**
 * chrome-devtools-mcp arguments for one Chrome instance. `--userDataDir`: a
 * throwaway profile in the instance's scratch directory (removed when the
 * instance ends), so each chat's Chrome starts clean and nothing outside the
 * temporary directory is written. `--no-performance-crux`: the plugin exposes
 * no performance tools, and the flag also silences the CrUX notice.
 * @param {ReturnType<typeof Config>} config
 * @param {string} profileDir
 */
export function chromeArgs(config, profileDir) {
  return [
    ...chromeServer(config).args,
    `--userDataDir=${profileDir}`,
    '--no-usage-statistics',
    '--no-performance-crux',
    ...(config.chrome.headless ? ['--headless'] : []),
    ...(config.chrome.hideAutomationBanner ? ['--ignoreDefaultChromeArg=--enable-automation'] : []),
    ...config.chrome.args,
  ]
}

/**
 * Environment of a chrome-devtools-mcp child (merged over the MCP SDK's safe
 * default set, which leaves out TMPDIR).
 * - TMPDIR: the server's own temporary files (screenshots of 2 MB or more)
 *   go to this machine's temporary directory, not `/tmp`.
 * - CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: no "Update available" notice and no
 *   daily `npm view`; the version is pinned.
 * - NODE_OPTIONS --localstorage-file: the server touches `localStorage`, and
 *   Node prints an ExperimentalWarning per launch unless a backing file is
 *   named; it lives in the instance's scratch directory.
 * @param {string} scratchDir - the instance's scratch directory.
 */
export function chromeEnv(scratchDir) {
  return {
    TMPDIR: tmpdir(),
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    NODE_OPTIONS: `--localstorage-file=${join(scratchDir, 'localstorage.json')}`,
  }
}

/**
 * Remove Chrome scratch directories that outlived their server (a server
 * killed before its instances ended): those whose pid is not running.
 * @param {string} [dir] - where to look (default: the temporary directory).
 */
export async function sweepChromeScratch(dir = tmpdir()) {
  let names = []
  try { names = readdirSync(dir) } catch { return [] }
  const removed = []
  for (const entry of names) {
    const match = new RegExp(`^${CHROME_SCRATCH}(\\d+)-`).exec(entry)
    if (match === null) continue
    const pid = Number(match[1])
    if (pid === process.pid) continue
    let alive = true
    try { process.kill(pid, 0) } catch (error) { alive = error.code === 'EPERM' }
    if (alive) continue
    await rm(join(dir, entry), { recursive: true, force: true }).catch(() => {})
    removed.push(entry)
  }
  return removed
}

/**
 * Reject before spawning when a server executable is absent, with the exact
 * remedy. Classic Safari cannot substitute for STP: stable Safari's
 * /usr/bin/safaridriver has no --mcp mode, so there is no server to fall back to.
 */
export function preflightFor(config) {
  return (browser) => {
    if (browser === 'safari') {
      if (!config.safari.enabled) throw new Error('Safari automation is disabled on this server (safari.enabled: false).')
      if (checkSafariTechnologyPreview(config.safari.driver) === 'missing') {
        throw new Error(`Safari automation is unavailable: no safaridriver at "${config.safari.driver}" (Safari Technology Preview is not installed). ${STP_INSTALL_REMEDY}`)
      }
      return
    }
    if (!config.chrome.enabled) throw new Error('Chrome automation is disabled on this server (chrome.enabled: false).')
    const server = chromeServer(config)
    if (server.missing !== undefined) {
      throw new Error(`Chrome automation is unavailable: ${server.missing}. Google Chrome must also be installed. Or use the safari_* tools.`)
    }
    // The browser itself, not just the MCP server: a missing Chrome otherwise
    // surfaces as a launch-time "Target closed" that reads like a page error.
    if (config.chrome.args.every(arg => !arg.startsWith('--executablePath') && !arg.startsWith('--browserUrl') && !arg.startsWith('--wsEndpoint') && arg !== '--autoConnect') && findChrome() === undefined) {
      throw new Error(`Chrome automation is unavailable: Google Chrome is not installed on this machine. ${CHROME_INSTALL_REMEDY}`)
    }
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 * @param {ReturnType<typeof Config>} config - validated plugin config.
 * @param {{ trace?: (event: object) => void, connect?: Function, scratch?: string }} [seams] - test seams.
 */
export function apply(ctx, config, seams = {}) {
  if (!config.safari.enabled && !config.chrome.enabled) {
    ctx.logger.warn('browser: no browser enabled; the plugin registers nothing')
    return
  }
  const trace = seams.trace ?? createTrace({ enabled: config.trace, name: 'browser', plugin: `${pkg.name}@${pkg.version}`, home: resolveDshHome() })
  const scratch = seams.scratch ?? tmpdir()
  const preflight = preflightFor(config)
  if (config.chrome.enabled) {
    void sweepChromeScratch(scratch).then((removed) => { if (removed.length > 0) trace({ event: 'chrome-scratch-swept', removed }) })
  }

  /** Banner label for one chat: prefix + session title (when known) or a short id. */
  function chatLabel(agent) {
    let title
    try {
      title = ctx.sessionProjections.stateOf(agent.session, 'title')
    } catch {
      // No title projection for this session shape; the id serves.
    }
    const text = typeof title === 'string' && title.trim() !== '' ? title.trim() : `chat ${agent.id.slice(-8)}`
    return `${config.safari.labelPrefix}${text}`.replace(/\s+/g, ' ').slice(0, 70)
  }

  /** placement.mjs instance when safari.hiddenWindows is park (assigned below; closed windows release their slot). */
  let placement
  const sessions = new BrowserSessions({
    connect: seams.connect,
    safariSpec: (session, windowIndex) => ({
      command: config.safari.driver,
      args: ['--mcp'],
      clientName: `${chatLabel(session.agent)} · s:${session.index}:${windowIndex}`,
      cwd: session.agent.session.header?.cwd,
    }),
    chromeSpec: (session) => {
      const cwd = session.agent.session.header?.cwd
      const label = `chrome-devtools-mcp c:${session.index}`
      // The instance's scratch directory: its profile and Node's localStorage file; removed when it ends.
      const dir = join(scratch, `${CHROME_SCRATCH}${process.pid}-${session.index}-${randomUUID().slice(0, 8)}`)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      return {
        command: chromeServer(config).command,
        args: chromeArgs(config, join(dir, 'profile')),
        clientName: `${chatLabel(session.agent)} · c:${session.index}`,
        cwd,
        env: chromeEnv(dir),
        roots: cwd !== undefined ? [cwd] : [],
        // Launch boilerplate is dropped (CHROME_STDERR_NOISE); anything else the server says is worth a line.
        ...(config.chrome.quietStderr ? { stderrNoise: CHROME_STDERR_NOISE } : {}),
        onStderr: (line) => {
          ctx.logger.warn(`browser: ${label}: ${line}`)
          trace({ event: 'chrome-stderr', session: session.index, line })
        },
        dispose: () => removeScratch(dir),
      }
    },
    timeoutMs: config.toolCallTimeoutMs,
    idleMs: config.idleMinutes * 60_000,
    onIdleClose: (agent, closed) => {
      try {
        agent.inject(pluginNotice(
          `[browser] Closed idle browser window(s) ${closed.join(', ')} after ${config.idleMinutes} min without use. Any safari_*/chrome_* call opens a fresh window.`,
        ))
      } catch {
        // The agent may be disposed or not accepting injections; the windows are closed either way.
      }
    },
    trace,
    logger: ctx.logger,
    onSafariGone: (windowId) => { void placement?.release(windowId) },
    chromeKeepFocus: config.chrome.keepFocus && !config.chrome.headless,
  })

  const readerPool = config.safari.enabled && config.safari.reader.enabled
    ? createReaderPool({
      driver: config.safari.driver,
      labelPrefix: config.safari.labelPrefix,
      maxIdle: config.safari.reader.maxIdle,
      idleMs: config.safari.reader.idleMinutes * 60_000,
      readTimeoutMs: config.toolCallTimeoutMs,
      trace,
      logger: ctx.logger,
      connect: seams.connect,
    })
    : undefined

  // Inline screenshots need the attachment store and the model's declared input modalities.
  let imaging
  ctx.inject(['attachments', 'llm'], (scoped) => {
    imaging = { attachments: scoped.attachments, llm: scoped.llm }
    scoped.effect(() => () => { imaging = undefined }, 'browser: inline screenshots')
  })

  /** The same admission rule as the harness's MCP bridge: store the image only when the current model declares image input. */
  async function admitImage(exec, bytes, name, mediaType = 'image/png') {
    if (imaging === undefined) return { reason: 'no attachment store is mounted' }
    const routed = exec.agent?.session.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    if (provider === undefined || model === undefined) return { reason: 'the current model route could not be resolved' }
    let info
    try { info = await imaging.llm.resolveModelInfo(provider, model, exec.signal) } catch { return { reason: 'the current model route could not be verified' } }
    if (!info.inputModalities?.includes('image')) return { reason: `model "${model}" does not declare image input` }
    const [ref] = await imaging.attachments.saveImages([{ data: bytes, mediaType, name }])
    return { ref }
  }

  // Covered Safari pages: park the window (placement.mjs, default), bring STP forward (foreground.mjs), or nothing.
  let ensureRunning
  if (config.safari.enabled && config.safari.hiddenWindows === 'park') {
    const appWindows = createAppWindows({ trace })
    ctx.effect(() => () => appWindows.dispose(), 'browser: app windows')
    // The routes need the Connection service (absent in headless compositions); without it no app reports.
    ctx.inject(['connection'], (scoped) => {
      const paths = registerAppWindowRoutes(scoped, appWindows)
      trace({ event: 'serving', paths })
    })
    placement = createPlacement({
      appWindows,
      largeScreenWidth: config.safari.park.largeScreenWidth,
      besideMaxFraction: config.safari.park.besideMaxFraction,
      gap: config.safari.park.gap,
      overhang: config.safari.park.overhang,
      stpApp: appBundleOf(config.safari.driver) ?? '/Applications/Safari Technology Preview.app',
      helper: config.safari.park.helper,
      sliver: config.safari.park.sliver,
      step: config.safari.park.step,
      makeRoom: config.safari.park.makeRoom,
      minWidth: config.safari.park.minWidth,
      trace,
    })
    ensureRunning = placement.ensureRunning
  } else if (config.safari.enabled && config.safari.hiddenWindows === 'activate') {
    ensureRunning = createForeground({ driver: config.safari.driver, trace })
  }
  const deps = {
    sessions,
    readerPool,
    admitImage,
    inlineImages: new WeakMap(),
    preflight,
    ensureRunning,
    notes: createNotes(),
    scratch,
    limits: { maxChars: config.safari.reader.maxChars, timeoutMs: config.toolCallTimeoutMs },
  }

  /** Disposers of each attached agent's scoped tool registrations. */
  const attached = new Map()

  /**
   * The preset a session composes under: the live projection (a blank
   * session's preset may be switched after `agent/created`, and recompose
   * keeps the same Agent, so the scoped registrations would otherwise survive
   * the switch), else the creation-time header.
   */
  function presetOf(agent) {
    try { const live = ctx.sessionProjections.stateOf(agent.session, 'agentPreset'); if (typeof live === 'string' && live !== '') return live } catch { /* no projection */ }
    return agent.session.header?.agentPreset ?? ''
  }

  /**
   * Register the tools into one agent's scope. Owned by both lifetimes: they
   * unwind with the agent's scope, and this plugin's effect removes them on
   * unload (effect disposers are idempotent).
   */
  function attach(agent) {
    if (attached.has(agent)) return
    const depth = agent.session.header?.delegationDepth ?? 0
    if (depth > 0 && !config.subagents) return
    const preset = presetOf(agent)
    if (config.skipPresets.includes(preset)) { trace({ event: 'skip', id: agent.id, preset }); return }
    const dispose = ctx.effect(() => {
      const disposers = createTools(deps, agent)
        .filter(tool => (tool.name.startsWith('safari_') ? config.safari.enabled : config.chrome.enabled))
        .map(tool => agent.ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'browser: tools')
    attached.set(agent, dispose)
    trace({ event: 'attach', id: agent.id, depth })
  }

  function detach(agent, reason) {
    const dispose = attached.get(agent)
    if (dispose === undefined) return
    attached.delete(agent)
    void dispose()
    trace({ event: 'detach', id: agent.id, reason })
  }

  // Chat-only presets (very small local models) must not see these tools; `tools.restrict()` exempts
  // scoped registrations, so the gate lives here.
  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) return
    if (config.skipPresets.includes(agentPreset)) detach(agent, `preset ${agentPreset}`)
    else attach(agent)
  })
  for (const agent of ctx.agents.list()) attach(agent)
  ctx.on('agent/created', ({ agent }) => { attach(agent) })

  ctx.on('agent/disposed', ({ agent }) => {
    detach(agent, 'disposed')
    void sessions.forget(agent, 'agent-disposed').catch((error) => {
      ctx.logger.warn(`browser: closing the windows of disposed agent "${agent.id}" failed: ${String(error)}`)
    })
  })

  // Plugin unload: every session's windows and the reader pool.
  ctx.effect(() => async () => {
    await sessions.dispose()
    await readerPool?.dispose()
    await safariInstance.dispose()
  }, 'browser: windows')

  trace({ event: 'applied', safari: config.safari.enabled, chrome: config.chrome.enabled, headless: config.chrome.headless, hiddenWindows: config.safari.hiddenWindows })
  ctx.logger.info(`browser: ${[config.safari.enabled ? 'safari_*' : '', config.chrome.enabled ? `chrome_*${config.chrome.headless ? ' (headless)' : ''}` : ''].filter(Boolean).join(' and ')} tools for every ${config.subagents ? 'agent' : 'top-level agent'}`)
}

/** Remove an instance's scratch directory; once more a moment later, in case Chrome was still writing. */
async function removeScratch(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  setTimeout(() => { void rm(dir, { recursive: true, force: true }).catch(() => {}) }, 2000).unref?.()
}
