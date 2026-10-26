/**
 * Named variants (LAYOUT.md §1, §6, §7):
 *
 *   dsd new <v> [--source <ref>] [--color <hex>] [--plugins <names|all>] [--no-serve | --serve-path <path>]
 *           [--ports <first>[-<last>]] [--tailscale-socket <path>] [--after <unit>[,<unit>…]]
 *   dsd build <v> [--install [--dock]] [--self]
 *   dsd remove <v> [--home] [--self]
 *
 * `new` writes the home, its variant.yml (port block, Serve path, source,
 * and the account's own tailscaled and the units its relay needs, when
 * given) and its links. `build` makes the immutable build of its source commit, writes
 * its plugins into its profile as bundles, and on macOS builds its app; with `--install` it installs the
 * app (~/Applications), the server host and relay link (Application
 * Support) and the relay LaunchAgent, and with `--dock` a Dock tile. On
 * Linux there is no app: `--install` installs the relay link (the XDG data
 * directory) and the relay as a systemd user unit.
 * `remove` uninstalls all of that and, with `--home`, deletes the home.
 * `dsd run <v>` / `dsd stop <v>` start and stop an installed variant.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OFFSETS, addDockTile, appPathOf, chooseServePath, choosePortBlock, installApp, parsePorts,
  linkRelayNode, listening, relayService, removeApp, removeDockTile, removeServePath, serverHostNameOf, supportDirOf, tailnetFacts,
} from '../lib/install.mjs'
import { buildsDir, homeOf, logDirOf, variantName } from '../lib/paths.mjs'
import { installBundles, selectPlugins } from '../lib/plugins.mjs'
import { linuxLeftovers, macosLeftovers, refuseOwnHome } from '../lib/remove.mjs'
import { lingering, UNIT_NAME } from '../lib/systemd.mjs'
import { ensureSourceBuild, resolveSourceCommit } from '../lib/source.mjs'
import { DsdError, isoLocal, note, onlyFlags, parseArgs, printJson, sleep, usage } from '../lib/util.mjs'
import { checkNamedId, displayName, listVariants, readVariant, writeVariant } from '../lib/variants.mjs'

/** Plugins only throwaways get: a named variant loads them only when named in its list. */
const TEST_ONLY = new Set(['test-driver', 'scripted-model'])

function namedConfig(id) {
  checkNamedId(id)
  const config = readVariant(id)
  if (!config) throw new DsdError(`no variant ${id} (dsd new ${id})`)
  return config
}

const DARWIN = process.platform === 'darwin'

/** A variant's `after` list (variant.yml holds it comma-separated). */
const afterUnits = config => String(config.after ?? '').split(',').map(s => s.trim()).filter(Boolean)

const ports = config => ({ dsh: Number(config.ports) + OFFSETS.dsh, relay: Number(config.ports) + OFFSETS.relay, proxy: Number(config.ports) + OFFSETS.proxy })

function relink(link, target) {
  try { unlinkSync(link) } catch { /* none */ }
  symlinkSync(target, link)
}

/** dsd new <v> */
export async function newVariant(argv) {
  const args = parseArgs(argv, ['source', 'color', 'plugins', 'serve-path', 'ports', 'tailscale-socket', 'after'])
  onlyFlags(args, ['source', 'color', 'plugins', 'no-serve', 'serve-path', 'ports', 'tailscale-socket', 'after'])
  const id = args._[0]
  if (id === undefined || args._.length > 1) usage('dsd new <v> [--source <ref>] [--color <hex>] [--plugins <names|all>] [--no-serve | --serve-path <path>] [--ports <first>[-<last>]] [--tailscale-socket <path>] [--after <unit>[,<unit>…]]')
  if (args['no-serve'] && (args['serve-path'] || args['tailscale-socket'])) usage('--no-serve and --serve-path or --tailscale-socket are alternatives')
  printJson(await createVariant(id, {
    source: args.source, color: args.color, plugins: args.plugins, noServe: args['no-serve'], servePath: args['serve-path'],
    ports: args.ports, tailscaleSocket: args['tailscale-socket'], after: args.after,
  }))
}

/**
 * Create a named variant (dsd new; dsd adopt for a variant that does not exist yet).
 * - `servePath` names the Serve path instead of choosing one (on a machine shared by several
 *   accounts, a path of the person's own, such as `/deepsea-<user>`); one that another target
 *   holds is refused.
 * - `ports` (default: DEEPSEA_PORTS, else from 3200) is the range the port block is chosen in, or
 *   with a single port the block that starts there: a machine that gives each account a range of
 *   ports only it may connect to.
 * - `tailscaleSocket` is a tailscaled of the account's own (a userspace one, on a machine whose
 *   own tailscaled is not the account's): its node serves the variant, through `--socket`.
 * - `after` lists systemd user units the relay needs running first (Linux): such a tailscaled,
 *   when nothing else starts it.
 */
export async function createVariant(id, { source = 'integration/base', color, plugins = 'all', noServe = false, servePath: wanted, ports: portsText, tailscaleSocket, after } = {}) {
  checkNamedId(id)
  if (existsSync(homeOf(id))) throw new DsdError(`${homeOf(id)} exists already`)
  if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) usage('--color takes #rrggbb')
  if (wanted !== undefined && !/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(wanted)) usage('--serve-path takes a path such as /deepsea-lab (lowercase letters, digits and single dashes)')
  if (tailscaleSocket !== undefined && (typeof tailscaleSocket !== 'string' || !tailscaleSocket.startsWith('/'))) usage('--tailscale-socket takes the absolute path of a tailscaled socket')
  const units = typeof after === 'string' ? after.split(',').map(s => s.trim()).filter(Boolean) : []
  if (after !== undefined && (typeof after !== 'string' || units.length === 0)) usage('--after takes systemd unit names, comma-separated')
  for (const unit of units) if (!UNIT_NAME.test(unit)) usage(`--after: "${unit}" is not a systemd unit name (such as name.service)`)
  if (units.length && DARWIN) usage('--after is for Linux, where the relay is a systemd user unit')
  const range = portsText !== undefined ? parsePorts(portsText) : process.env.DEEPSEA_PORTS ? parsePorts(process.env.DEEPSEA_PORTS, 'DEEPSEA_PORTS') : undefined
  resolveSourceCommit(source)
  const recorded = new Set(listVariants().filter(v => !v.throwaway && v.config?.ports).map(v => Number(v.config.ports)))
  const block = await choosePortBlock(recorded, range)
  const facts = noServe ? undefined : tailnetFacts(tailscaleSocket)
  const serve = Boolean(facts?.dnsName)
  if (tailscaleSocket !== undefined && !serve) throw new DsdError(`--tailscale-socket: no Tailscale node answers at ${tailscaleSocket} (is that tailscaled running and logged in?)`)
  if (wanted !== undefined && !serve) throw new DsdError('--serve-path: Tailscale is not available here')
  const servePath = !serve ? undefined : wanted === undefined ? chooseServePath(id, block, facts) : chooseServePath(id, block, facts, undefined, wanted)
  const home = homeOf(id)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeVariant(id, {
    id, display: displayName(id), ...(color ? { color } : {}), ports: block, source,
    plugins, serve, ...(servePath ? { servePath } : {}), ...(tailscaleSocket ? { tailscaleSocket } : {}),
    ...(units.length ? { after: units.join(',') } : {}), created: isoLocal(),
  })
  mkdirSync(logDirOf(id), { recursive: true, mode: 0o700 })
  relink(join(home, 'logs'), logDirOf(id))
  relink(join(home, 'support'), supportDirOf(id))
  if (!serve && !noServe) note('Tailscale is not available: the variant is local only (its app talks to the relay on this machine)')
  return {
    id, name: variantName(id), display: displayName(id), home, ports: { block, ...ports({ ports: block }) }, source, serve, servePath,
    ...(serve ? { url: `https://${facts.dnsName}${servePath}/` } : {}), ...(tailscaleSocket ? { tailscaleSocket } : {}), ...(units.length ? { after: units } : {}),
  }
}

/**
 * The plugins a named variant loads, from its build: its list, or all of them (machine-wide ones too:
 * the rule that leaves those out is for throwaways) except the test-only ones. server-log comes first.
 */
function variantPlugins(config, dir) {
  const value = config.plugins ?? 'all'
  const picked = value === 'all'
    ? selectPlugins('all', dir, { machineWide: true }).filter(p => !TEST_ONLY.has(p.name))
    : selectPlugins(value, dir)
  const log = picked.findIndex(p => p.name === 'server-log')
  if (log >= 0) picked.unshift(...picked.splice(log, 1))
  else picked.unshift(...selectPlugins('server-log', dir))
  return picked
}

/** dsd build <v> [--install [--dock]] */
export async function build(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['install', 'dock', 'self', 'throwaway'])
  const id = args._[0]
  if (id === undefined || args._.length > 1) usage('dsd build <v> [--install [--dock]] [--self]')
  if (args.throwaway) usage('throwaway apps are built by dsd run --throwaway-app')
  if (args.dock && !args.install) usage('--dock goes with --install')
  if (args.dock && !DARWIN) usage('--dock is for macOS')
  const config = namedConfig(id)
  if (args.install && !args.self) refuseOwnHome(id)
  const home = homeOf(id)
  const commit = resolveSourceCommit(config.source)
  const dir = await ensureSourceBuild(commit)
  const harnessBuild = readlinkSync(join(dir, 'harness'))
  const plugins = variantPlugins(config, dir)
  const port = ports(config)
  const facts = config.serve ? tailnetFacts(config.tailscaleSocket) : undefined
  const url = config.serve && facts?.dnsName ? `https://${facts.dnsName}${config.servePath}/` : `http://127.0.0.1:${port.relay}/`
  // The app (apps/macos) exists only for macOS; on Linux a variant is its relay and server.
  const out = DARWIN ? mkdtempSync(join(tmpdir(), `deepsea-build-${id}-`)) : undefined
  const version = (() => { try { return JSON.parse(readFileSync(join(harnessBuild, 'package.json'), 'utf8')).version } catch { return '0.0.0' } })()
  const builtApp = DARWIN ? JSON.parse(execFileSync(process.execPath, [join(dir, 'apps', 'macos', 'build.mjs'),
    '--out', out, '--name', displayName(id), '--bundle-id', variantName(id), '--glyph', join(harnessBuild, 'apps', 'web', 'public', 'favicon.svg'),
    '--glyph-color', config.color ?? '#000000', '--url', url, '--fallback-url', `http://127.0.0.1:${port.relay}/`,
    '--token-file', join(home, 'relay', 'state.json'), '--version', version, '--build', commit.slice(0, 10), '--cache', buildsDir()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) : undefined
  const result = { id, source: `${config.source} (${commit.slice(0, 10)})`, build: dir, plugins: plugins.map(p => p.name), ...(builtApp ? { app: builtApp.app } : {}), url }
  if (!args.install) { printJson(result); return }

  // Only an install touches the home: the running server reads its profile's bundles.
  installBundles(plugins, home, harnessBuild)
  const supportDir = supportDirOf(id)
  const app = builtApp ? installApp(id, builtApp.app) : undefined
  if (out) rmSync(out, { recursive: true, force: true })
  // The server host (macOS only) makes the relay and everything below it ask for privacy grants as the variant.
  const host = DARWIN ? JSON.parse(execFileSync(process.execPath, [join(dir, 'apps', 'macos', 'build.mjs'), 'server-host',
    '--dir', supportDir, '--name', serverHostNameOf(id), '--bundle-id', `${variantName(id)}.server`,
    '--icon', join(app, 'Contents', 'Resources', 'AppIcon.icns'), '--cache', buildsDir()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) : undefined
  const { link, node } = linkRelayNode(supportDir, harnessBuild)
  mkdirSync(join(logDirOf(id), 'relay'), { recursive: true, mode: 0o700 })
  const proxy = plugins.some(p => p.name === 'tailscale')
  const programArguments = [...(host ? [host.executable] : []), link, join(dir, 'apps', 'relay', 'relay.mjs'),
    '--variant', id, '--home', home, '--listen', `127.0.0.1:${port.relay}`, '--dsh', `127.0.0.1:${port.dsh}`,
    ...(proxy ? ['--proxy', `127.0.0.1:${port.proxy}`] : []), '--log-dir', logDirOf(id), '--cwd', harnessBuild,
    '--', node, '--import', 'tsx/esm', join(harnessBuild, 'apps', 'cli', 'src', 'bin.ts'), '--profile', 'web',
    '--no-open', '--port', String(port.dsh)]
  const job = await relayService.install(id, programArguments, { after: afterUnits(config) })
  relink(join(home, 'source'), dir)
  const dock = args.dock ? addDockTile(app) : undefined
  writeVariant(id, { ...config, build: commit.slice(0, 10), installed: isoLocal() })
  if (!DARWIN && lingering() === false) note('this account does not linger (loginctl enable-linger): the relay stops at the last logout and starts again at the next login')
  printJson({
    ...result, ...(app ? { app } : {}), ...(host ? { serverHost: host.bundle, serverHostChanged: host.changed } : {}),
    relay: `http://127.0.0.1:${port.relay}/`, [DARWIN ? 'launchAgent' : 'unit']: job.file, label: job.label, ...(dock !== undefined ? { dock } : {}),
  })
}

/** The state of a named variant: installed, relay and server listening. */
export async function namedStatus(id, config) {
  const port = ports(config)
  const [relay, server] = await Promise.all([listening(port.relay), listening(port.dsh)])
  const installed = relayService.installed(id)
  return { installed, job: installed && relayService.status(id).loaded, relay, server, port: port.dsh }
}

/** dsd run <v> for a named variant: load and start its relay, then open its app (macOS). */
export async function runNamed(id, args) {
  const config = namedConfig(id)
  if (!relayService.installed(id)) throw new DsdError(`${id} is not installed (dsd build ${id} --install)`)
  await relayService.start(id)
  const port = ports(config)
  for (let i = 0; i < 50 && !(await listening(port.relay)); i++) await sleep(200)
  const openApp = DARWIN && !args['no-app']
  if (openApp) execFileSync('/usr/bin/open', [appPathOf(id)])
  printJson({ id, ...(await namedStatus(id, config)), relayUrl: `http://127.0.0.1:${port.relay}/`, app: openApp ? appPathOf(id) : undefined })
}

/** dsd stop <v> for a named variant: stop its relay job, which stops the relay and its server. */
export async function stopNamed(id, args) {
  namedConfig(id)
  if (!args.self) refuseOwnHome(id)
  const stopped = await relayService.stop(id)
  printJson({ id, stopped, note: `the ${DARWIN ? 'LaunchAgent' : 'systemd unit'} stays installed: it starts again at login or with dsd run` })
}

/** dsd remove <v> [--home] */
export async function remove(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['home', 'self'])
  const id = args._[0]
  if (id === undefined || args._.length > 1) usage('dsd remove <v> [--home] [--self]')
  const config = namedConfig(id)
  if (!args.self) refuseOwnHome(id)
  const removed = []
  const job = await relayService.remove(id)
  if (job.file) removed.push(job.file)
  if (config.serve && config.servePath) {
    try { if (removeServePath(config.servePath, ports(config).relay, config.tailscaleSocket)) removed.push(`Serve path ${config.servePath}`) } catch (error) {
      note(`Serve path ${config.servePath} stays: ${String(error.stderr || error.message).trim().split('\n')[0]}`)
    }
  }
  if (DARWIN) {
    if (removeDockTile(appPathOf(id))) removed.push('Dock tile')
    const app = removeApp(id)
    if (app) removed.push(app)
    try { execFileSync('/usr/bin/defaults', ['delete', variantName(id)], { stdio: 'ignore' }) } catch { /* no preferences */ }
  }
  for (const path of [...macosLeftovers(variantName(id)), ...linuxLeftovers(variantName(id))]) { rmSync(path, { recursive: true, force: true }); removed.push(path) }
  if (args.home) { rmSync(homeOf(id), { recursive: true, force: true }); removed.push(homeOf(id)) }
  printJson({ id, removed, home: args.home ? 'removed' : `kept: ${homeOf(id)}` })
}

