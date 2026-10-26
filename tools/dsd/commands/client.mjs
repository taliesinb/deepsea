/**
 * dsd client <v> [<server>] [--source <ref>] [--color <hex>] [--dock]
 *
 * A thin client: the DeepSea macOS app (apps/macos) for a server elsewhere,
 * with no server of its own here. It is a variant like any other (LAYOUT.md
 * §1): its home `~/.deepsea/<v>/` holds only `variant.yml` (`client: true`,
 * the server's URL, the source its app is built from) and the `logs` link;
 * its app is `~/Applications/DeepSea <V>.app`, bundle id the variant name,
 * so it has its own cookies, window and logs, and no id names both a client
 * and a server. The first run names the server; a later run rebuilds the app
 * from its source (`--source` moves it), and a new server or `--color`
 * replaces the old. `dsd run <v>` opens it, `dsd remove <v> [--home]`
 * uninstalls it, `dsd list` shows it.
 *
 * The server: a URL, or the short forms remote-workspaces takes (`host` →
 * `https://host.<magic-dns-suffix>/deepsea/`, `user@host` → `/deepsea-<user>/`,
 * `host/<path>`, `host:<port>`; loopback is http). The app is admitted the way
 * any device is: by its Tailscale identity, as the server's own login or an
 * allowed one. macOS only: on Linux the thin client is apps/linux.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addDockTile, appPathOf, appRunning, installApp, tailnetFacts } from '../lib/install.mjs'
import { buildsDir, homeOf, logDirOf, variantName } from '../lib/paths.mjs'
import { ensureSourceBuild, resolveSourceCommit } from '../lib/source.mjs'
import { DsdError, isoLocal, note, onlyFlags, parseArgs, printJson, usage } from '../lib/util.mjs'
import { checkNamedId, displayName, readVariant, writeVariant } from '../lib/variants.mjs'

const USAGE = 'dsd client <v> [<server>] [--source <ref>] [--color <hex>] [--dock]'
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

/**
 * A server as typed → its mount URL, with a trailing slash. `suffix()` gives this tailnet's MagicDNS
 * suffix, asked only for a dot-less name (the Serve certificate names the full one).
 */
export function resolveServer(input, suffix) {
  const text = String(input ?? '').trim()
  const full = (host) => {
    if (host.includes('.') || LOOPBACK.test(host)) return host
    const known = suffix()
    if (!known) throw new DsdError(`"${host}" is a short name and this tailnet's MagicDNS suffix is unknown (is Tailscale running?); give the full name`)
    return `${host}.${known}`
  }
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text)
    if (url.search || url.hash || url.username || url.password) usage('the server URL takes no query, fragment or credentials')
    url.hostname = full(url.hostname)
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    return url.toString()
  }
  const m = /^(?:([a-z0-9][a-z0-9_-]*)@)?([a-z0-9][a-z0-9.-]*|\[::1\])(?::(\d{1,5}))?(\/[\w./-]*)?$/i.exec(text)
  if (!m) usage(`"${text}" is not a server: a URL, host, user@host, host/<path> or host:<port>`)
  const [, user, host, port, path] = m
  if (user && path) usage('user@host takes no path')
  const mount = path ? `${path.replace(/\/+$/, '')}/` : user ? `/deepsea-${user.toLowerCase()}/` : port ? '/' : '/deepsea/'
  return `${LOOPBACK.test(host) ? 'http' : 'https'}://${full(host)}${port ? `:${port}` : ''}${mount}`
}

/** Whether the server answers now (any HTTP answer but 421, as the app's own probe decides). */
async function answers(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) })
    return response.status === 421 ? `it answers 421: something serves that name, but not this server` : undefined
  } catch (error) {
    return `it does not answer now (${error.cause?.code ?? error.message})`
  }
}

function relink(link, target) {
  try { unlinkSync(link) } catch { /* none */ }
  symlinkSync(target, link)
}

export async function client(argv) {
  const args = parseArgs(argv, ['source', 'color'])
  onlyFlags(args, ['source', 'color', 'dock'])
  const [id, server, ...rest] = args._
  if (id === undefined || rest.length > 0) usage(USAGE)
  checkNamedId(id)
  if (process.platform !== 'darwin') usage('dsd client builds the macOS app; on Linux the thin client is apps/linux (nix run \'github:taliesinb/deepsea?dir=apps/linux\' -- <server>, or electron apps/linux <server>)')
  if (args.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(args.color)) usage('--color takes #rrggbb')
  const existing = readVariant(id)
  if (existing !== undefined && !existing.client) throw new DsdError(`${id} is a variant with a server of its own, not a thin client`)
  if (existing === undefined && existsSync(homeOf(id))) throw new DsdError(`${homeOf(id)} exists already`)
  if (existing === undefined && server === undefined) usage(`${id} is new: name its server (${USAGE})`)
  let facts
  const url = server !== undefined ? resolveServer(server, () => (facts ??= tailnetFacts())?.suffix) : existing.url
  const source = args.source ?? existing?.source ?? 'integration/base'
  const color = args.color ?? existing?.color
  const commit = resolveSourceCommit(source)
  const unreachable = await answers(url)
  if (unreachable !== undefined) note(`${url}: ${unreachable}; building the app anyway`)

  const dir = await ensureSourceBuild(commit)
  const builder = join(dir, 'apps', 'macos', 'build.mjs')
  if (!existsSync(builder)) throw new DsdError(`${source} has no apps/macos (the app is topic/macos-app's; build from an integration)`)
  const harnessBuild = readlinkSync(join(dir, 'harness'))
  const home = homeOf(id)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const config = { id, display: displayName(id), client: true, url, ...(color ? { color } : {}), source, created: existing?.created ?? isoLocal() }
  writeVariant(id, { ...existing, ...config })
  mkdirSync(logDirOf(id), { recursive: true, mode: 0o700 })
  relink(join(home, 'logs'), logDirOf(id))

  const version = (() => { try { return JSON.parse(readFileSync(join(harnessBuild, 'package.json'), 'utf8')).version } catch { return '0.0.0' } })()
  const out = mkdtempSync(join(tmpdir(), `deepsea-client-${id}-`))
  let app
  try {
    const built = JSON.parse(execFileSync(process.execPath, [builder,
      '--out', out, '--name', displayName(id), '--bundle-id', variantName(id), '--glyph', join(harnessBuild, 'apps', 'web', 'public', 'favicon.svg'),
      '--glyph-color', color ?? '#000000', '--url', url, '--version', version, '--build', commit.slice(0, 10), '--cache', buildsDir()],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    app = installApp(id, built.app)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
  const dock = args.dock ? addDockTile(app) : undefined
  writeVariant(id, { ...existing, ...config, build: commit.slice(0, 10), installed: isoLocal() })
  if (appRunning(app)) note(`${displayName(id)} is running its previous build: quit and reopen it`)
  printJson({
    id, name: variantName(id), display: displayName(id), url, source: `${source} (${commit.slice(0, 10)})`, app, home,
    ...(unreachable !== undefined ? { warning: unreachable } : {}), ...(dock !== undefined ? { dock } : {}),
  })
}

/** dsd run <v> for a thin client: open its app. */
export function openClient(id, config) {
  const app = appPathOf(id)
  if (!existsSync(app)) throw new DsdError(`${id}'s app is not installed (dsd client ${id})`)
  execFileSync('/usr/bin/open', [app])
  printJson({ id, url: config.url, app })
}
