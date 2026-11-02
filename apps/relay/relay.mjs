#!/usr/bin/env node
/**
 * deepsea-relay — the always-listening front door of an installed variant
 * (LAYOUT.md §6). Its LaunchAgent starts it through the variant's server host;
 * it starts `dsh web` on the first connection and keeps answering while the
 * server is down, so opening the app (or a tailnet URL) is all it takes to
 * bring a variant up.
 *
 * Per connection, from the first request's head:
 *   - a tailnet client (Tailscale Serve: an `x-forwarded-for` whose last hop is
 *     a tailnet address, or a `tailscale-user-login`) is spliced to the
 *     tailscale plugin's proxy (`--proxy`), which admits it; with no proxy
 *     configured it is refused;
 *   - any other client (this machine: the app's fallback URL) is spliced to
 *     `dsh web` itself (`--dsh`), whose own login admits it: the relay starts
 *     the server with the variant's standing token as its launch token
 *     (`DSH_LAUNCH_TOKEN`), so `/?token=<standing token>` always works and
 *     DSH's cookie then admits the client across restarts. The standing token
 *     is in `<home>/relay/state.json` (0600), the app's token file;
 *   - while the target is down the relay starts `dsh web` (once; a failure
 *     streak stops retrying) and answers 503 with `x-deepsea-relay: starting`
 *     or `failed` and, for a page load, a page that reloads itself once the
 *     header is gone.
 *
 * `dsh web` runs through the person's login shell (`$SHELL -lc 'exec "$@"'`,
 * so agents get their PATH; a non-POSIX `$SHELL` such as nu or fish gives way
 * to zsh, bash or sh: `loginShell`), detached in its own process group, with
 * `DSH_HOME`, `DSH_LAUNCH_TOKEN`, `DEEPSEA_VARIANT` and `DEEPSEA_RELAY` (this
 * relay's URL) set. `--log-dir` is the variant's log directory (LAYOUT.md
 * §5): the relay's run log goes to `relay/`, each server start's to
 * `server/`. Routing is per connection, by its first request. SIGTERM stops
 * the relay and the server.
 *
 *   node relay.mjs --variant <v> --home <dir> --listen 127.0.0.1:<+3> --dsh 127.0.0.1:<+0>
 *                  [--proxy 127.0.0.1:<+4>] --log-dir <variant log dir> [--cwd <dir>] -- <dsh web argv…>
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { connect, createServer, isIP } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isoLocal, openRunLog } from '../../packages/logs/index.mjs'

const HEAD_LIMIT = 64 * 1024
const HEAD_TIMEOUT_MS = 5000
const CONNECT_TIMEOUT_MS = 1500
/** A server that exits sooner than this without its port ever answering counts as a failed start. */
const FAST_EXIT_MS = 30_000

/** Try to open a TCP connection; resolves the socket or undefined (never throws). */
export function tryConnect(endpoint, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    const done = (value) => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
      clearTimeout(timer)
      resolve(value)
    }
    const onConnect = () => done(socket)
    const onError = () => { socket.destroy(); done(undefined) }
    const timer = setTimeout(() => { socket.destroy(); done(undefined) }, timeoutMs)
    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

/** Parse the first HTTP/1.x request head; undefined while incomplete. */
export function parseRequestHead(buffer) {
  const end = buffer.indexOf('\r\n\r\n')
  if (end === -1) return undefined
  const lines = buffer.subarray(0, end).toString('latin1').split('\r\n')
  const [method = '', target = '', version = ''] = lines[0].split(' ')
  const headers = {}
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':')
    if (at === -1) continue
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return { method, target, version, headers }
}

/** Whether an address is in Tailscale's ranges (100.64.0.0/10, fd7a:115c:a1e0::/48). */
export function isTailnetAddress(address) {
  const text = String(address).trim().replace(/^\[|\]$/g, '')
  if (isIP(text) === 4) {
    const [a, b] = text.split('.').map(Number)
    return a === 100 && b >= 64 && b <= 127
  }
  return isIP(text) === 6 && /^fd7a:115c:a1e0:/i.test(text)
}

/** Whether a request came through Tailscale Serve (so it belongs to the tailscale proxy). */
export function isTailnetRequest(head) {
  if (head?.headers['tailscale-user-login'] !== undefined) return true
  const forwarded = head?.headers['x-forwarded-for']
  if (forwarded === undefined) return false
  const hops = forwarded.split(',')
  return isTailnetAddress(hops[hops.length - 1])
}

/** The standing token in `<home>/relay/state.json`, created (0600) when missing. */
export function standingToken(home) {
  const dir = join(home, 'relay')
  const file = join(dir, 'state.json')
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof state.token === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(state.token)) return state.token
  } catch { /* none yet */ }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const token = randomBytes(24).toString('base64url')
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ version: 1, token }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, file)
  return token
}

const TITLES = { starting: 'Starting DeepSea…', failed: 'DeepSea could not start', 'no-proxy': 'DeepSea is not on the tailnet' }

/** The relay's own page: a spinner and the time waited; reloads once the server answers in its place. */
export function relayPage(kind, detail = '') {
  const title = TITLES[kind] ?? TITLES.starting
  const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#fafafa;color:#222}
@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#e5e5e7}}
main{max-width:34em;padding:2em;text-align:center}
h1{font-size:1.25em;font-weight:600;margin:1em 0 .5em}
p{margin:.5em 0;color:#888;font-size:.9em}
code{font:.92em ui-monospace,Menlo,monospace}
.spinner{width:28px;height:28px;margin:auto;border:3px solid rgba(127,127,127,.25);border-top-color:#3b82f6;border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#t{font-variant-numeric:tabular-nums}
</style></head><body><main>
${kind === 'starting' ? '<div class="spinner" role="progressbar" aria-label="waiting"></div>' : ''}
<h1>${title}</h1>
${detail ? `<p>${escape(detail)}</p>` : ''}
<p><span id="t">0</span> s</p>
</main>
<script>
(function(){var t0=Date.now(),el=document.getElementById('t');
setInterval(function(){el.textContent=String(Math.round((Date.now()-t0)/1000))},1000);
function poll(){fetch(location.href,{method:'HEAD',cache:'no-store',credentials:'same-origin'}).then(function(r){
  if(!r.headers.get('x-deepsea-relay')){location.reload();return}
  setTimeout(poll,1000)}).catch(function(){setTimeout(poll,1500)})}
setTimeout(poll,1000)})();
</script></body></html>
`
}

/**
 * The relay. `start()` spawns the server (detached, its own process group) and
 * returns the child; injectable for tests.
 * @param {{ listen: {host: string, port: number}, dsh: {host: string, port: number}, proxy?: {host: string, port: number},
 *   start: () => import('node:child_process').ChildProcess,
 *   log: (line: string) => void, logPath?: () => string | undefined, minSpawnIntervalMs?: number, maxFailures?: number }} options
 */
export function createRelay(options) {
  const minSpawnInterval = options.minSpawnIntervalMs ?? 5000
  const maxFailures = options.maxFailures ?? 5
  const state = { child: undefined, spawnedAt: 0, spawns: 0, failures: 0, serverSeen: false, lastKind: undefined }
  const sockets = new Set()

  const ensureStarted = () => {
    if (state.child !== undefined) return 'starting'
    if (state.failures >= maxFailures) return 'failed'
    if (Date.now() - state.spawnedAt < minSpawnInterval) return 'starting'
    let child
    try { child = options.start() } catch (error) {
      options.log(`start failed: ${error?.message ?? error}`)
      state.failures += 1
      state.spawnedAt = Date.now()
      return state.failures >= maxFailures ? 'failed' : 'starting'
    }
    state.spawnedAt = Date.now()
    state.spawns += 1
    state.child = child
    state.serverSeen = false
    options.log(`started dsh web (pid ${child.pid ?? '?'})`)
    child.once('exit', (code, signal) => {
      const uptime = Date.now() - state.spawnedAt
      state.child = undefined
      if (uptime < FAST_EXIT_MS && !state.serverSeen) state.failures += 1
      else state.failures = 0
      options.log(`dsh web exited (code ${code}, signal ${signal}) after ${Math.round(uptime / 1000)} s; failures ${state.failures}`)
    })
    child.once('error', error => options.log(`dsh web: ${error?.message ?? error}`))
    return 'starting'
  }

  /** Answer one request here: the relay's 503, or a plain status for a refusal. */
  const answer = (socket, head, status, kind, extraHeaders = []) => {
    const method = head?.method ?? 'GET'
    const page = (method === 'GET' || method === 'HEAD') && String(head?.headers.accept ?? '').includes('text/html')
    const detail = kind === 'failed' && options.logPath?.() ? `Log: ${options.logPath()}` : ''
    const body = page ? relayPage(kind, detail) : `${TITLES[kind] ?? kind}\n`
    const reason = { 503: 'Service Unavailable', 403: 'Forbidden' }[status] ?? 'Error'
    const lines = [`HTTP/1.1 ${status} ${reason}`, `Content-Type: ${page ? 'text/html' : 'text/plain'}; charset=utf-8`, `Content-Length: ${Buffer.byteLength(body)}`,
      'Cache-Control: no-store', ...(status === 503 ? ['Retry-After: 2'] : []), `X-DeepSea-Relay: ${kind}`, ...extraHeaders, 'Connection: close', '', '']
    socket.end(lines.join('\r\n') + (method === 'HEAD' ? '' : body))
  }

  const splice = (socket, upstream, buffered) => {
    sockets.add(upstream)
    upstream.once('close', () => { sockets.delete(upstream); socket.destroy() })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.once('close', () => upstream.destroy())
    if (buffered.length > 0) upstream.write(buffered)
    socket.pipe(upstream)
    upstream.pipe(socket)
  }

  const route = async (socket, buffered, head) => {
    const tailnet = isTailnetRequest(head)
    if (tailnet && options.proxy === undefined) { answer(socket, head, 403, 'no-proxy'); return }
    const target = tailnet ? options.proxy : options.dsh
    const upstream = await tryConnect(target)
    if (socket.destroyed) { upstream?.destroy(); return }
    if (upstream !== undefined) {
      if (state.lastKind !== undefined) { options.log('server is back'); state.lastKind = undefined }
      state.failures = 0
      state.serverSeen = true
      splice(socket, upstream, buffered)
      return
    }
    // The proxy can be down while dsh is up (the plugin is off): never start a second server.
    if (tailnet && await tryConnect(options.dsh).then(s => (s?.destroy(), s !== undefined))) { answer(socket, head, 503, 'no-proxy'); return }
    const kind = ensureStarted()
    if (kind !== state.lastKind) { state.lastKind = kind; options.log(`server down; answering ${kind}`) }
    if (!socket.destroyed) answer(socket, head, 503, kind)
  }

  const onConnection = (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffered = Buffer.alloc(0)
    let settled = false
    const finish = (head) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.pause()
      void route(socket, buffered, head)
    }
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      const head = parseRequestHead(buffered)
      if (head !== undefined) finish(head)
      else if (buffered.length > HEAD_LIMIT) socket.destroy()
    }
    const timer = setTimeout(() => finish(parseRequestHead(buffered)), HEAD_TIMEOUT_MS)
    // A client that closes before sending a request (a port probe) starts nothing.
    socket.once('close', () => { if (!settled) { settled = true; clearTimeout(timer) } })
    socket.on('data', onData)
  }

  const server = createServer({ allowHalfOpen: false }, onConnection)
  return {
    state,
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.listen.port, options.listen.host, () => {
        server.off('error', reject)
        resolve(server.address().port)
      })
    }),
    close: async ({ stopChild = false, graceMs = 15_000 } = {}) => {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(() => resolve()))
      const child = state.child
      if (stopChild && child !== undefined && child.exitCode === null) {
        options.log(`stopping dsh web (pid ${child.pid ?? '?'})`)
        killGroup(child, 'SIGTERM')
        await new Promise((resolve) => {
          const timer = setTimeout(() => { killGroup(child, 'SIGKILL'); resolve() }, graceMs)
          child.once('exit', () => { clearTimeout(timer); resolve() })
        })
      }
    },
  }
}

/** Shells that run `-lc 'exec "$@"'` as the relay means it. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ksh93', 'oksh', 'ash', 'yash'])

/**
 * The login shell `dsh web` runs through: `$SHELL` when it is a POSIX shell, else (unset, missing,
 * or one such as nu or fish, which reads `-lc` and `"$@"` its own way) the first that exists of
 * /bin/zsh, /bin/bash, then bash and zsh on PATH (NixOS has neither under /bin), else /bin/sh. `why`
 * says why `$SHELL` was not used.
 * @returns {{ shell: string, why?: string }}
 */
export function loginShell(env = process.env, exists = existsSync) {
  const own = env.SHELL
  const name = own ? own.split('/').pop() : ''
  if (own && POSIX_SHELLS.has(name) && exists(own)) return { shell: own }
  const why = !own ? 'SHELL is not set' : !POSIX_SHELLS.has(name) ? `${own} is not a POSIX shell` : `${own} does not exist`
  const onPath = String(env.PATH ?? '').split(':').filter(Boolean)
  for (const candidate of ['/bin/zsh', '/bin/bash', ...['bash', 'zsh'].flatMap(n => onPath.map(dir => `${dir}/${n}`)), '/bin/sh']) {
    if (exists(candidate)) return { shell: candidate, why }
  }
  return { shell: '/bin/sh', why }
}

/** Signal a detached child's whole process group (login shell and server). */
export function killGroup(child, signal) {
  if (child.exitCode !== null || child.pid === undefined) return
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* gone */ } }
}

// ---- command line ------------------------------------------------------------

function endpoint(text) {
  const at = String(text).lastIndexOf(':')
  return { host: String(text).slice(0, at) || '127.0.0.1', port: Number(String(text).slice(at + 1)) }
}

/** `--key value` options, then `--` and the server's argv. */
export function parseCommandLine(argv) {
  const split = argv.indexOf('--')
  const own = split === -1 ? argv : argv.slice(0, split)
  const command = split === -1 ? [] : argv.slice(split + 1)
  const out = {}
  for (let i = 0; i < own.length; i += 2) {
    const key = own[i]
    if (!/^--(variant|home|listen|dsh|proxy|log-dir|cwd)$/.test(key) || own[i + 1] === undefined) throw new Error(`unexpected argument ${key}`)
    out[key.slice(2)] = own[i + 1]
  }
  for (const key of ['variant', 'home', 'listen', 'dsh', 'log-dir']) if (!out[key]) throw new Error(`--${key} is required`)
  if (command.length === 0) throw new Error('the server command follows --')
  return { ...out, command }
}

async function main() {
  const args = parseCommandLine(process.argv.slice(2))
  const listen = endpoint(args.listen)
  const dsh = endpoint(args.dsh)
  const variant = `io.github.taliesinb.deepsea.${args.variant}`
  const serverLogs = join(args['log-dir'], 'server')
  const own = openRunLog(join(args['log-dir'], 'relay'), { identity: `${variant} relay pid ${process.pid} ${process.execPath}` })
  const say = (line) => {
    const text = `${isoLocal()} ${line}`
    try { own.write(text) } catch { /* the log is gone; stderr still has it */ }
    process.stderr.write(`${text}\n`)
  }
  let lastLog
  const { shell, why } = loginShell()
  const standing = standingToken(args.home)
  const relay = createRelay({
    listen, dsh, proxy: args.proxy ? endpoint(args.proxy) : undefined,
    log: say,
    logPath: () => lastLog,
    start: () => {
      const log = openRunLog(serverLogs, { tag: 'pending' })
      const child = spawn(shell, ['-lc', 'exec "$@"', shell, ...args.command], {
        cwd: args.cwd ?? process.cwd(), detached: true, stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, DSH_HOME: args.home, DSH_LAUNCH_TOKEN: standing, DEEPSEA_VARIANT: args.variant, DEEPSEA_RELAY: `http://${listen.host}:${listen.port}/` },
      })
      log.identify(`${variant} server pid ${child.pid} started by the relay (pid ${process.pid}): ${args.command.join(' ')}`)
      log.rename(child.pid)
      log.close()
      lastLog = log.path
      return child
    },
  })
  const port = await relay.listen()
  say(`listening on ${listen.host}:${port}; dsh ${dsh.host}:${dsh.port}${args.proxy ? `, proxy ${args.proxy}` : ''}; login shell ${shell}${why ? ` (${why})` : ''}`)
  const shutdown = (signal) => {
    say(`${signal}: stopping`)
    void relay.close({ stopChild: true }).then(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`deepsea-relay: ${error?.message ?? error}\n`)
    process.exit(1)
  })
}
