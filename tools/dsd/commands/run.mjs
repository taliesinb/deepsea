/**
 * dsd run <v> --throwaway | --throwaway-app | --throwaway-server [--visible] [--detach] [--scripted]
 *   [--plugins <names|all>] [--app <checkout | ref>] [--source <ref>] [--harness <ref>]
 *   [--patch <file>[,<file>…]] [--ttl <minutes>] [--keep] [--timeout <s>]
 *
 * Creates `<parent>-<hex>` with an empty home, starts `dsh web` from the
 * shared build of the harness commit, waits until it answers, and with
 * --throwaway-app also builds the app (lib/app.mjs) and opens it on the
 * server: hidden and focus-free unless --visible, with its automation socket.
 * --throwaway runs it as an installed variant runs, as child processes: the
 * relay (apps/relay, lib/components.mjs) on a free port, which starts `dsh
 * web` on the first connection and again after every exit, and the app with
 * the relay built in as its entry point and the relay's standing token as its
 * token file; its first connection is the cold start. dsd then treats the
 * relay as the throwaway's process (the server's pid changes on every
 * restart).
 * Prints the facts as JSON. `--plugins` loads this checkout's plugins in
 * place (lib/plugins.mjs), or with `--source <ref>` those of an immutable
 * build of that commit (lib/source.mjs), which also gives the harness pin
 * and the app; `--scripted` adds the scripted model and makes it
 * the default model; `--patch` adds patch files of the caller's own after
 * the plugins' (config overrides, fixture rows).
 *
 * In the foreground (the default) it stops and removes everything on Ctrl-C,
 * SIGTERM, or when the app quits (with no app: when the server exits; an
 * app outlives its server, so the page after a /reboot can be seen). With
 * --detach it returns; a throwaway app is then watched by a small supervisor
 * (`dsd __supervise`) that removes everything when the app quits, and
 * `dsd stop` ends either kind.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { appSocketOf, appSource, buildThrowawayApp, launchApp, waitAppReady } from '../lib/app.mjs'
import { appRequest } from '../lib/appsocket.mjs'
import { componentSource } from '../lib/components.mjs'
import { harnessRefuses, parsePorts, PORT_BLOCK } from '../lib/install.mjs'
import { ensureSourceBuild, resolveSourceCommit } from '../lib/source.mjs'
import { runNamed } from './variant.mjs'
import { credentialsDocument, ensureSim, provisionAccounts } from '../lib/sim.mjs'
import { buildPaths, ensureBuild, harnessRepo, linkHarness, readLock, resolveHarnessCommit } from '../lib/harness.mjs'
import { openRunLog } from '../lib/logs.mjs'
import { installBundles, preparePlugin, selectPlugins } from '../lib/plugins.mjs'
import { homeOf, logDirOf, REPO, variantName } from '../lib/paths.mjs'
import { alive, freePort, listenerPids } from '../lib/processes.mjs'
import { removeVariant, SERVER_ENTRY } from '../lib/remove.mjs'
import { DsdError, isoLocal, note, onlyFlags, parseArgs, printJson, sleep, usage } from '../lib/util.mjs'
import { checkNamedId, currentOwner, displayName, listVariants, parseThrowaway, writeState, writeVariant } from '../lib/variants.mjs'

/**
 * Rows every throwaway's web profile gets: no telemetry leaves the machine,
 * the first-run "Add an API key" dialog does not cover the page (the Models
 * page still offers every key), and the default workspace is made inside the
 * home (`<home>/documents/…`) instead of the user's Documents folder.
 */
const profilePatch = home => `# written by dsd for throwaway variants
- id: session-log-deepseek
  config:
    enabled: false
- id: session-telemetry-otel
  disabled: true
- id: ui-settings-models
  config:
    credentialOnboarding: false
- id: workspace-controller
  config:
    documentsDirectory: ${JSON.stringify(join(home, 'documents'))}
`

/** Rows for --scripted: the scripted model is the default model. */
const SCRIPTED_PATCH = `- id: agent-default-model
  config:
    provider: scripted
    model: script
`

/** Deep-merge plain objects (later wins). */
const merge = (a, b) => {
  const out = { ...a }
  for (const [k, v] of Object.entries(b ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? merge(out[k], v) : v
  return out
}

/**
 * Point a throwaway at the provider simulator: start it if needed, provision
 * its accounts (default: `standard`, one per provider route), and write the settings
 * those routes need and the sign-ins of Plan accounts (the grant pi-ai would
 * have stored after a browser sign-in). Returns the environment for its server.
 */
async function simulate(id, home, build, spec = 'standard') {
  const sim = await ensureSim(build)
  const accounts = await provisionAccounts(sim, spec === true ? 'standard' : spec, parseThrowaway(id)?.hex ?? id)
  const env = { DSH_PROVIDER_SIMULATOR: sim.url }
  for (const account of accounts) if (account.env) env[account.env] = account.credential
  // The rows the accounts' routes need (`settings` in the fixture: row id → config), appended
  // to the throwaway's profile patch; JSON is YAML.
  const rows = accounts.reduce((all, account) => merge(all, account.settings), {})
  const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
  for (const [row, config] of Object.entries(rows)) appendFileSync(patch, `- id: ${row}\n  config: ${JSON.stringify(config)}\n`)
  const credentials = credentialsDocument(accounts)
  if (credentials) writeFileSync(join(home, '.credentials.yaml'), credentials, { mode: 0o600, flag: 'wx' })
  return { url: sim.url, accounts, env }
}

/** A fresh id `<parent>-<hex>` with no home and no logs yet. */
function newThrowawayId(parent) {
  for (;;) {
    const id = `${parent}-${randomBytes(3).toString('hex')}`
    if (!existsSync(homeOf(id)) && !existsSync(logDirOf(id))) return id
  }
}

/** Create the throwaway's home: configuration, profile patch, links. */
function makeHome(id, { parent, commit, build, expires, scripted, mode, source }) {
  const home = homeOf(id)
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true, mode: 0o700 })
  const owner = currentOwner()
  writeVariant(id, { id, parent, throwaway: true, mode, harness: commit, ...(source ? { source: `${source.ref} (${source.commit.slice(0, 10)})` } : {}), created: isoLocal(),
    ownerSession: owner.session, ownerCheckout: owner.checkout, expires })
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), profilePatch(home) + (scripted ? SCRIPTED_PATCH : ''), { mode: 0o600 })
  mkdirSync(logDirOf(id), { recursive: true, mode: 0o700 })
  symlinkSync(logDirOf(id), join(home, 'logs'))
  symlinkSync(source?.dir ?? build, join(home, 'source'))
  return home
}

/** Wait until the log shows the launch URL and the server answers HTTP. */
async function waitReady(child, logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let launch
  while (Date.now() < deadline) {
    if (child.exitCode !== null || !alive(child.pid)) {
      throw new DsdError(`the server exited before it was ready; log: ${logPath}\n${tail(logPath, 25)}`)
    }
    launch ??= /dsh web: (http:\/\/127\.0\.0\.1:\d+\/)\?token=(\S+)/.exec(readFileSync(logPath, 'utf8')) ?? undefined
    if (launch) {
      try {
        await fetch(launch[1], { redirect: 'manual', signal: AbortSignal.timeout(2000) })
        return { url: launch[1], token: launch[2] }
      } catch { /* not answering yet */ }
    }
    await sleep(500)
  }
  throw new DsdError(`no ready server within ${Math.round(timeoutMs / 1000)} s; log: ${logPath}\n${tail(logPath, 25)}`)
}

function tail(path, lines) {
  try { return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).join('\n') } catch { return '' }
}

/**
 * The tailscale plugin's proxy port, when a patch gives its row one (`proxyPort: <n>` in the
 * `deepsea-tailscale` row): the relay then hands tailnet clients to it. A throwaway has no port
 * block, so the plugin runs a proxy only when configured.
 */
export function proxyPortOf(patchTexts) {
  let port
  for (const text of patchTexts) {
    for (const row of String(text).split(/^\s*-\s+(?=id:)/m)) {
      if (!/^id:\s*['"]?deepsea-tailscale['"]?\s*$/m.test(row)) continue
      const m = /^\s*proxyPort:\s*(\d+)\s*$/m.exec(row)
      if (m) port = Number(m[1])
    }
  }
  return port
}

/** Wait until the relay listens and has written its standing token; returns the token. Asks lsof, since any connection to the relay starts the server, and the app's should be the first. */
async function waitRelay(child, { port, tokenFile, consoleLog }, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || !alive(child.pid)) throw new DsdError(`the relay exited before it listened; ${consoleLog}:\n${tail(consoleLog, 25)}`)
    let token
    try { token = JSON.parse(readFileSync(tokenFile, 'utf8')).token } catch { /* not yet */ }
    if (token && listenerPids(port).includes(child.pid)) return token
    await sleep(200)
  }
  throw new DsdError(`the relay did not listen within ${Math.round(timeoutMs / 1000)} s; ${consoleLog}:\n${tail(consoleLog, 25)}`)
}

/**
 * Wait until the server answers through the relay: anything but the relay's own 503. Asking
 * starts it, as any connection does. `failed` (a streak of failed starts) ends the wait.
 */
async function waitServerThroughRelay(child, { url, serverLog }, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || !alive(child.pid)) throw new DsdError(`the relay exited; server log: ${serverLog}\n${tail(serverLog, 25)}`)
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
      const kind = response.headers.get('x-deepsea-relay')
      if (kind === 'failed') throw new DsdError(`the relay could not start the server; log: ${serverLog}\n${tail(serverLog, 25)}`)
      if (kind === null) return response.status
    } catch (error) { if (error instanceof DsdError) throw error }
    await sleep(500)
  }
  throw new DsdError(`no server through the relay within ${Math.round(timeoutMs / 1000)} s; log: ${serverLog}\n${tail(serverLog, 25)}`)
}

/**
 * Distinct free ports: any, or with DEEPSEA_PORTS (a range the machine gives this account) inside
 * that range, clear of the blocks named variants record there.
 */
async function freePorts(count) {
  const range = process.env.DEEPSEA_PORTS ? parsePorts(process.env.DEEPSEA_PORTS, 'DEEPSEA_PORTS') : undefined
  const ports = new Set()
  const exclude = new Set()
  if (range) {
    for (const v of listVariants()) {
      if (v.throwaway || !v.config?.ports) continue
      for (let p = Number(v.config.ports); p < Number(v.config.ports) + PORT_BLOCK; p++) exclude.add(p)
    }
  }
  while (ports.size < count) ports.add(await freePort({ range, exclude: new Set([...exclude, ...ports]) }))
  return [...ports]
}

/**
 * @param {string[]} argv
 * @param {object} [hooks] - for commands built on run (dsd adopt): `prepareHome({ id, home, build, source, plugins })`
 *   runs once the home exists, before plugins are installed and anything starts; `output()` adds to the printed facts.
 */
export async function run(argv, hooks = {}) {
  const args = parseArgs(argv, ['source', 'harness', 'timeout', 'plugins', 'ttl', 'app', 'patch', 'accounts'])
  onlyFlags(args, ['throwaway', 'throwaway-app', 'throwaway-server', 'detach', 'source', 'harness', 'keep', 'timeout', 'plugins', 'ttl', 'scripted', 'visible', 'app', 'patch', 'no-app', 'simulated', 'accounts'])
  const extraPatches = typeof args.patch === 'string' ? args.patch.split(',').filter(Boolean).map(f => resolve(f)) : []
  for (const file of extraPatches) if (!existsSync(file)) usage(`--patch: no file ${file}`)
  const parent = args._[0]
  if (parent === undefined || args._.length > 1) usage('dsd run <variant> [--throwaway | --throwaway-app | --throwaway-server] [--visible] [--detach]')
  checkNamedId(parent)
  const kinds = ['throwaway', 'throwaway-app', 'throwaway-server'].filter(flag => args[flag])
  if (kinds.length > 1) usage('--throwaway, --throwaway-app and --throwaway-server are alternatives')
  // full: relay, server and app, as an installed variant runs; app: server and app; server: server only.
  const mode = { throwaway: 'full', 'throwaway-app': 'app', 'throwaway-server': 'server' }[kinds[0]]
  if (mode === undefined) return runNamed(parent, args)
  if (mode === 'server' && (args.visible || args.app)) usage('--visible and --app are for --throwaway and --throwaway-app')
  // The app is the macOS app: elsewhere --throwaway is the relay and server, as an installed variant there runs.
  const withApp = mode === 'app' || (mode === 'full' && process.platform === 'darwin')
  if (mode === 'app' && process.platform !== 'darwin') usage('--throwaway-app needs macOS (apps/macos); --throwaway runs the relay and server without an app here')
  if (mode === 'full' && !withApp && (args.visible || args.app)) usage('--visible and --app need the macOS app')
  const timeoutMs = Number(args.timeout ?? 180) * 1000

  // Which code: with --source, an immutable build of that commit of this repository (its plugins,
  // its harness pin, its app); otherwise this checkout in place. Which harness: --harness, else the
  // pin of the source, else this checkout's pin.
  if (typeof args.source === 'string' && args.app) usage('--source gives the app too; --app is for running this checkout')
  const source = typeof args.source === 'string' ? { ref: args.source, commit: resolveSourceCommit(args.source) } : undefined
  if (source) source.dir = await ensureSourceBuild(source.commit)
  const lock = readLock(undefined, source?.dir)
  const repo = harnessRepo(lock)
  const commit = resolveHarnessCommit(args.harness ?? lock.commit, repo)
  const app = withApp ? appSource(source ? source.dir : typeof args.app === 'string' ? args.app : undefined) : undefined
  // The relay: the source build's, else this checkout's, else topic/relay's (lib/components.mjs).
  const relaySource = mode === 'full'
    ? (source && existsSync(join(source.dir, 'apps', 'relay', 'relay.mjs')) ? componentSource('relay', source.dir) : componentSource('relay'))
    : undefined
  const build = await ensureBuild(commit, repo)
  const refused = harnessRefuses(process.execPath, build)
  if (refused !== undefined) throw new DsdError(`${process.execPath} (running dsd, and the throwaway's server) cannot run the harness: ${refused}. Run dsd with an official Node build (nodejs.org)`)
  const plugins = selectPlugins(args.plugins, source?.dir)
  // Every throwaway gets the test driver (dsd drive; it arms only in a throwaway home) and the
  // server log (plugin log messages into the server's log), first in order (rows still load
  // concurrently, so a message logged during startup can precede it).
  for (const always of ['test-driver', ...(args.scripted ? ['scripted-model'] : [])]) {
    if (!plugins.some(p => p.name === always)) plugins.push(...selectPlugins(always, source?.dir))
  }
  const serverLog = plugins.findIndex(p => p.name === 'server-log')
  plugins.unshift(...(serverLog >= 0 ? plugins.splice(serverLog, 1) : selectPlugins('server-log', source?.dir)))
  // A build's plugins are installed and built already; this checkout's are prepared on demand.
  if (plugins.length > 0 && !source) {
    await linkHarness()
    for (const plugin of plugins) preparePlugin(plugin)
  }

  // A detached throwaway lives until `dsd stop`, or `dsd gc` after its time limit (--ttl minutes;
  // default 120, none for a visible app: a person's window does not vanish under them).
  const ttl = args.ttl !== undefined ? Number(args.ttl) : args.detach && !args.visible ? 120 : undefined
  if (ttl !== undefined && !(ttl > 0)) usage('--ttl takes a number of minutes')
  const expires = ttl === undefined ? undefined : isoLocal(new Date(Date.now() + ttl * 60_000))
  const id = newThrowawayId(parent)
  if (args.accounts !== undefined && !args.simulated) usage('--accounts goes with --simulated')
  const home = makeHome(id, { parent, commit, build, expires, scripted: Boolean(args.scripted), mode, source })
  // Simulated providers: the machine's simulator, this throwaway's own test accounts, their keys
  // in the server's environment and the routes they need in its settings.
  const simulation = args.simulated ? await simulate(id, home, build, args.accounts) : undefined
  // The Anthropic SDK falls back to a credentials file in ~/.config/anthropic for a client
  // given no key (pi-ai's Kimi Code route is one): a throwaway reads its own, empty directory.
  const anthropicConfig = join(home, 'anthropic-config')
  mkdirSync(anthropicConfig, { recursive: true, mode: 0o700 })
  const simEnv = { ANTHROPIC_CONFIG_DIR: anthropicConfig, ...simulation?.env }
  const cleanup = async () => removeVariant(id, { keep: Boolean(args.keep) })
  if (hooks.prepareHome) {
    try { await hooks.prepareHome({ id, home, build, source, plugins: plugins.map(p => p.name) }) } catch (error) { await cleanup(); throw error }
  }
  const [port, relayPort] = await freePorts(2)
  const relay = mode === 'full'
    ? { port: relayPort, url: `http://127.0.0.1:${relayPort}/`, tokenFile: join(home, 'relay', 'state.json'), log: join(logDirOf(id), 'relay', 'latest.log'), consoleLog: join(logDirOf(id), 'relay', 'console.log') }
    : undefined
  let bundle
  if (app) {
    // With a relay, the app is built as an installed variant's is: the relay as its entry point and
    // fallback, the relay's standing token as its token file.
    const entry = relay ? { url: relay.url, fallbackUrl: relay.url, tokenFile: relay.tokenFile } : undefined
    try { bundle = buildThrowawayApp(id, { source: app, harnessBuild: build, entry }) } catch (error) { await cleanup(); throw error }
  }

  // The plugins as bundles of the profile (each loads from its own bundle patch), then the
  // caller's patches, which come after every bundle layer: a later layer replaces a row's whole config.
  installBundles(plugins, home, build)
  const patches = extraPatches
  const serverArgs = ['--import', 'tsx/esm', relay ? join(build, SERVER_ENTRY) : SERVER_ENTRY, '--profile', 'web', ...patches.flatMap(p => ['--patch', p]), '--no-open', '--port', String(port)]
  const pluginNote = plugins.length ? ` plugins ${plugins.map(p => p.name).join(',')}` : ''
  let child
  let facts
  if (relay) {
    const proxyPort = plugins.some(p => p.name === 'tailscale') ? proxyPortOf([...plugins.map(p => readFileSync(join(p.dir, 'cordis.patch.yml'), 'utf8')), ...patches.map(p => readFileSync(p, 'utf8'))]) : undefined
    const relayArgs = [relaySource.entry, '--variant', id, '--home', home, '--listen', `127.0.0.1:${relay.port}`, '--dsh', `127.0.0.1:${port}`,
      ...(proxyPort ? ['--proxy', `127.0.0.1:${proxyPort}`] : []), '--log-dir', logDirOf(id), '--cwd', build, '--', process.execPath, ...serverArgs]
    mkdirSync(join(logDirOf(id), 'relay'), { recursive: true, mode: 0o700 })
    const consoleFd = openSync(relay.consoleLog, 'a', 0o600)
    // The relay sets DSH_HOME (and DSH_LAUNCH_TOKEN, DEEPSEA_VARIANT, DEEPSEA_RELAY) for the server it starts.
    const env = { ...process.env, ...simEnv }
    delete env.DSH_HOME
    child = spawn(process.execPath, relayArgs, { cwd: build, env, detached: true, stdio: ['ignore', consoleFd, consoleFd] })
    closeSync(consoleFd)
    facts = {
      pid: child.pid, signature: [relaySource.entry, `--listen 127.0.0.1:${relay.port}`], port, log: join(logDirOf(id), 'server', 'latest.log'),
      started: isoLocal(), harness: commit, build, ...(source ? { source: source.dir } : {}),
      relay: { port: relay.port, url: relay.url, log: relay.log, source: relaySource.describe, dir: relaySource.dir, ...(proxyPort ? { proxy: proxyPort } : {}) },
    }
    writeState(id, facts)
    try {
      const token = await waitRelay(child, relay, Math.min(timeoutMs, 30_000))
      Object.assign(facts, { url: relay.url, token })
      writeState(id, facts)
    } catch (error) {
      await cleanup()
      throw error
    }
  } else {
    const log = openRunLog(join(logDirOf(id), 'server'), { tag: 'pending' })
    child = spawn(process.execPath, serverArgs, { cwd: build, env: { ...process.env, ...simEnv, DSH_HOME: home }, detached: true, stdio: ['ignore', log.fd, log.fd] })
    log.identify(`${variantName(id)} server pid ${child.pid} dsh web --port ${port} harness ${commit.slice(0, 10)}${pluginNote}`)
    log.rename(child.pid)
    log.close()
    facts = { pid: child.pid, signature: [SERVER_ENTRY, `--no-open --port ${port}`], port, log: log.path, started: isoLocal(), harness: commit, build, ...(source ? { source: source.dir } : {}) }
    writeState(id, facts)
    try {
      const ready = await waitReady(child, log.path, timeoutMs)
      Object.assign(facts, { url: ready.url, token: ready.token })
      writeState(id, facts)
    } catch (error) {
      await cleanup()
      throw error
    }
  }
  // With a relay and no app (Linux), dsd makes the first connection itself: the cold start.
  if (relay && !app) {
    try { await waitServerThroughRelay(child, { url: relay.url, serverLog: facts.log }, timeoutMs) } catch (error) { await cleanup(); throw error }
  }
  const login = `${facts.url}?token=${facts.token}`

  let appChild
  let hello
  if (bundle) {
    // With a relay the app makes the first connection, so it sees the cold start: the relay's page,
    // then the GUI once the server answers.
    const launched = launchApp(id, { executable: bundle.executable, url: relay ? undefined : login, visible: Boolean(args.visible) })
    appChild = launched.child
    facts.app = { pid: appChild.pid, signature: launched.signature, socket: launched.socket, dir: bundle.dir, path: bundle.app, visible: Boolean(args.visible) }
    writeState(id, facts)
    try {
      if (relay) await waitServerThroughRelay(child, { url: relay.url, serverLog: facts.log }, timeoutMs)
      hello = await waitAppReady(appChild, launched.socket, timeoutMs)
      // The relay's page counts as loaded; wait for the GUI it reloads into.
      if (relay) await appRequest(launched.socket, 'wait-page', { expression: 'return Boolean(globalThis.__DSH_BOOT__)', timeoutMs }, { timeoutMs: timeoutMs + 10_000 })
    } catch (error) {
      await cleanup()
      throw error
    }
    facts.app.log = hello.log
    writeState(id, facts)
  }

  if (args.detach && bundle) {
    // Watch the app, so quitting it removes everything (commands/supervise.mjs).
    const supervisorLog = openRunLog(join(logDirOf(id), 'dsd'), { tag: 'pending' })
    const supervisor = spawn(process.execPath, [join(REPO, 'tools', 'dsd', 'bin', 'dsd.mjs'), '__supervise', id], {
      detached: true, stdio: ['ignore', supervisorLog.fd, supervisorLog.fd], env: process.env,
    })
    supervisorLog.identify(`${variantName(id)} dsd supervisor pid ${supervisor.pid}`)
    supervisorLog.rename(supervisor.pid)
    supervisorLog.close()
    facts.supervisor = { pid: supervisor.pid, signature: ['__supervise', id] }
    writeState(id, facts)
    supervisor.unref()
  }

  printJson({
    ...(simulation ? { simulated: { url: simulation.url, accounts: simulation.accounts.map(a => ({ name: a.name, provider: a.provider, credential: a.credential, ...(a.route ? { signedIn: a.route } : {}) })) } } : {}),
    id, name: variantName(id), display: displayName(id), home, mode,
    url: facts.url, login, token: facts.token,
    pid: child.pid, port, log: facts.log, harness: commit.slice(0, 10), ...(source ? { source: `${source.ref} (${source.commit.slice(0, 10)})` } : {}), plugins: plugins.map(p => p.name), detached: Boolean(args.detach), expires,
    ...(relay ? { relay: { pid: child.pid, ...facts.relay } } : {}),
    ...(bundle ? { app: { path: bundle.app, pid: appChild.pid, socket: appSocketOf(id), log: hello.log, visible: Boolean(args.visible), source: app.describe } } : {}),
    ...(hooks.output?.() ?? {}),
  })

  if (args.detach) { child.unref(); appChild?.unref(); return }
  note(`${id} running; Ctrl-C${bundle ? ', quitting the app' : ''} or \`dsd stop ${id}\` stops it${args.keep ? '' : ' and removes it'}`)
  await new Promise((resolve) => {
    let stopping = false
    let watch
    const stop = async () => {
      if (stopping) return
      stopping = true
      clearInterval(watch)
      await cleanup()
      resolve()
    }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop)
    // With an app, the app decides: after a /reboot or /restore its page shows what happened, so
    // the throwaway stays until the app quits. Without one, the server's exit ends it. With a relay
    // the relay is the process watched: it restarts the server.
    let serverGone = false
    const what = relay ? 'relay' : 'server'
    watch = setInterval(() => {
      if (appChild && !alive(appChild.pid)) { note(`${id}: the app quit`); void stop() }
      else if (!serverGone && !alive(child.pid)) {
        serverGone = true
        if (appChild) note(`${id}: the ${what} exited; the app stays until it quits, Ctrl-C or \`dsd stop ${id}\``)
        else { note(`${id}: the ${what} exited`); void stop() }
      }
    }, 1000)
  })
  // `dsd stop` from elsewhere may already have removed the home; nothing else to do.
  if (existsSync(home) && !args.keep) rmSync(home, { recursive: true, force: true })
  process.exit(0)
}

/**
 * dsd play [--plugins <names|all>] [--accounts <names|standard|none>] [--source <ref>] [--harness <ref>] [--patch <file>,…] [--real]
 *
 * A throwaway to try things in: the macOS app, visible, behind a relay, built
 * from the integration (`--source integration/base`) with every plugin, its
 * default model the scripted one, and every model provider simulated with
 * the standard test accounts (`--real`: the real providers and no accounts).
 * Quitting the app throws it away.
 */
export async function play(argv) {
  const args = parseArgs(argv, ['plugins', 'accounts', 'source', 'harness', 'patch'])
  onlyFlags(args, ['plugins', 'accounts', 'source', 'harness', 'patch', 'real'])
  if (args._.length > 0) usage('dsd play [--plugins <names|all>] [--accounts <names|standard|none>] [--source <ref>] [--harness <ref>] [--patch <file>,…] [--real]')
  if (args.real && args.accounts !== undefined) usage('--accounts goes with simulated providers, not --real')
  if (process.platform !== 'darwin') usage('dsd play opens the macOS app; here use dsd run release --throwaway --scripted --source integration/base --plugins all --simulated, and open its URL')
  return run([
    'release', '--throwaway', '--visible', '--detach', '--scripted',
    ...(args.harness ? ['--harness', args.harness] : ['--source', args.source ?? 'integration/base']),
    '--plugins', args.plugins ?? 'all',
    ...(args.real ? [] : ['--simulated', '--accounts', args.accounts ?? 'standard']),
    ...(args.patch ? ['--patch', args.patch] : []),
  ])
}
