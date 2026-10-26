/**
 * Installing a named variant (LAYOUT.md §6). On macOS: its app in
 * ~/Applications, its server host and relay link in Application Support, its
 * relay LaunchAgent, an optional Dock tile. On Linux: its relay link in
 * `${XDG_DATA_HOME:-~/.local/share}/<variant name>/` and its relay as a
 * systemd user unit (lib/systemd.mjs); no app. Both: the choice of its port
 * block and Tailscale Serve path. `relayService` is the relay's job on either.
 * Pure parts (plist text, Dock entries, choices) are exported for tests;
 * everything that acts goes through `launchctl`, `lsregister`, `defaults`,
 * `systemctl` and the file system here.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { logDirOf, variantName } from './paths.mjs'
import { installUnit, relayUnit, removeUnit, startUnit, stopUnit, unitDir, unitStatus } from './systemd.mjs'
import { DsdError, note, onPath, sleep, usage } from './util.mjs'
import { displayName } from './variants.mjs'

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const TAILSCALE = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/run/current-system/sw/bin/tailscale', '/usr/bin/tailscale', '/usr/sbin/tailscale']
const DARWIN = process.platform === 'darwin'

export const PORT_BASE = 3200
export const PORT_BLOCK = 10
/** Offsets in a port block (LAYOUT.md §7). */
export const OFFSETS = { dsh: 0, relay: 3, proxy: 4 }

export const applicationsDir = () => join(homedir(), 'Applications')
export const appPathOf = id => join(applicationsDir(), `${displayName(id)}.app`)
/** The variant's support directory: Application Support on macOS, the XDG data directory elsewhere. */
export const supportDirOf = (id, platform = process.platform, env = process.env) => platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', variantName(id))
  : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), variantName(id))
export const relayLabelOf = id => `${variantName(id)}.relay`
export const launchAgentOf = id => join(homedir(), 'Library', 'LaunchAgents', `${relayLabelOf(id)}.plist`)
export const serverHostNameOf = id => `${displayName(id)} Server`
const domain = () => `gui/${userInfo().uid}`

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The relay LaunchAgent's plist: started at login and kept alive, its own stdout/stderr file. */
export function relayPlist({ label, programArguments, launchdLog, environment = {} }) {
  const env = Object.entries(environment)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map(arg => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(launchdLog)}</string>
  <key>StandardErrorPath</key><string>${xml(launchdLog)}</string>
${env.length ? `  <key>EnvironmentVariables</key>\n  <dict>\n${env.map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}\n  </dict>\n` : ''}</dict>
</plist>
`
}

const launchctl = args => spawnSync('/bin/launchctl', args, { encoding: 'utf8' })

/** Whether a job is loaded, and its pid when running. */
export function jobStatus(label) {
  const result = launchctl(['print', `${domain()}/${label}`])
  if (result.status !== 0) return { loaded: false }
  const pid = /\bpid = (\d+)/.exec(result.stdout)?.[1]
  return { loaded: true, pid: pid ? Number(pid) : undefined }
}

/** Unload a job (stops the relay and, with it, its server) and wait until it is gone. */
export async function bootout(label) {
  if (!jobStatus(label).loaded) return false
  launchctl(['bootout', `${domain()}/${label}`])
  for (let i = 0; i < 100 && jobStatus(label).loaded; i++) await sleep(100)
  return true
}

/** Load a plist (retrying launchd's transient EIO while a previous job of the label winds down). */
export async function bootstrap(plist, label) {
  let last
  for (let attempt = 0; attempt < 10; attempt++) {
    last = launchctl(['bootstrap', domain(), plist])
    if (last.status === 0 || jobStatus(label).loaded) return
    await sleep(500)
  }
  throw new DsdError(`launchctl bootstrap ${plist} failed: ${(last.stderr || last.stdout).trim()}`)
}

/** Start a loaded job if it is not running. */
export function kickstart(label) {
  const result = launchctl(['kickstart', `${domain()}/${label}`])
  if (result.status !== 0) throw new DsdError(`launchctl kickstart ${label} failed: ${(result.stderr || result.stdout).trim()}`)
}

/** Whether something accepts connections on 127.0.0.1:<port>. */
export function listening(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (ok) => { socket.destroy(); clearTimeout(timer); resolve(ok) }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * A port range as `dsd new --ports` and `DEEPSEA_PORTS` take it: `<first>-<last>`, or `<first>` for
 * the one block starting there. Returns `{ first, last }`.
 */
export function parsePorts(text, what = '--ports') {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(text).trim())
  const first = m ? Number(m[1]) : NaN
  const last = m?.[2] !== undefined ? Number(m[2]) : first + PORT_BLOCK - 1
  if (!m || first < 1024 || last > 65535 || last - first + 1 < PORT_BLOCK) {
    usage(`${what} takes <first>-<last> (at least ${PORT_BLOCK} ports, from 1024 to 65535) or the <first> port of one block; not "${text}"`)
  }
  return { first, last }
}

/**
 * The first port block of `range` (default: from 3200) that no other variant of this account
 * records and on which nothing listens (another account's variants show up as listeners).
 */
export async function choosePortBlock(recorded, range = { first: PORT_BASE, last: 65009 }) {
  for (let base = range.first; base + PORT_BLOCK - 1 <= range.last; base += PORT_BLOCK) {
    if (recorded.has(base)) continue
    let busy = false
    for (let port = base; port < base + PORT_BLOCK && !busy; port++) busy = await listening(port, 150)
    if (!busy) return base
  }
  throw new DsdError(`no free port block in ${range.first}-${range.last}`)
}

/** The tailscale CLI, or undefined. */
export function tailscaleCli() {
  for (const candidate of TAILSCALE) if (existsSync(candidate)) return candidate
  return onPath('tailscale')
}

/**
 * The tailscale command for a variant: the CLI, with `--socket=<path>` when the variant names a
 * daemon of its own (`tailscaleSocket` in variant.yml: a userspace tailscaled of the account, on a
 * machine whose own tailscaled is not the account's). undefined without a CLI.
 */
export function tailscaleCommand(socket) {
  const cli = tailscaleCli()
  return cli === undefined ? undefined : [cli, ...(socket ? [`--socket=${socket}`] : [])]
}

/**
 * The node's MagicDNS name and the Serve mappings (path → target), read-only; undefined without
 * Tailscale. `socket`: the variant's own daemon (tailscaleCommand).
 */
export function tailnetFacts(socket) {
  const command = tailscaleCommand(socket)
  if (!command) return undefined
  const [cli, ...pre] = command
  try {
    const status = JSON.parse(execFileSync(cli, [...pre, 'status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }))
    const dnsName = String(status?.Self?.DNSName ?? '').replace(/\.$/, '')
    let serve = {}
    try { serve = JSON.parse(execFileSync(cli, [...pre, 'serve', 'status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }) || '{}') } catch { /* nothing served */ }
    const mappings = {}
    for (const web of Object.values(serve?.Web ?? {})) {
      for (const [path, handler] of Object.entries(web?.Handlers ?? {})) mappings[path] = handler?.Proxy ?? handler?.Path ?? handler?.Text ?? '?'
    }
    const suffix = String(status?.MagicDNSSuffix ?? '').replace(/\.$/, '') || dnsName.split('.').slice(1).join('.') || undefined
    return { dnsName, suffix, running: status?.BackendState === 'Running', mappings }
  } catch {
    return undefined
  }
}

/**
 * The Serve path for a variant (LAYOUT.md §7): `/deepsea` for release, `/deepsea-<v>` otherwise; when another
 * target (another account's variant) already holds it, the same with `-<account>` appended. A
 * `wanted` path is taken as it is, unless another target holds it.
 */
export function chooseServePath(id, block, facts, account = userInfo().username, wanted = undefined) {
  const base = id === 'release' ? '/deepsea' : `/deepsea-${id}`
  const ours = target => new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${block + OFFSETS.relay}/?$`).test(String(target))
  const taken = path => facts?.mappings?.[path] !== undefined && !ours(facts.mappings[path])
  if (wanted !== undefined) {
    if (taken(wanted)) throw new DsdError(`the Serve path ${wanted} points at ${facts.mappings[wanted]}, not this variant's relay`)
    return wanted
  }
  if (!taken(base)) return base
  const own = `${base}-${account.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
  if (taken(own)) throw new DsdError(`the Serve paths ${base} and ${own} are both taken by others`)
  return own
}

/** Copy a built app into ~/Applications, replacing only this variant's own app; register it. */
export function installApp(id, builtApp) {
  const target = appPathOf(id)
  if (existsSync(target)) {
    const existing = spawnSync('/usr/bin/defaults', ['read', join(target, 'Contents', 'Info.plist'), 'CFBundleIdentifier'], { encoding: 'utf8' }).stdout.trim()
    if (existing !== variantName(id)) throw new DsdError(`${target} belongs to ${existing || 'something else'}, not ${variantName(id)}; move it away first`)
  }
  mkdirSync(applicationsDir(), { recursive: true })
  const staging = `${target}.staging-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  cpSync(builtApp, staging, { recursive: true, verbatimSymlinks: true })
  rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
  spawnSync(LSREGISTER, ['-f', target], { stdio: 'ignore' })
  return target
}

/** Whether an app bundle's executable is running. */
export function appRunning(appPath) {
  return spawnSync('/usr/bin/pgrep', ['-f', `${appPath}/Contents/MacOS/`], { stdio: 'ignore' }).status === 0
}

/** Unregister and delete this variant's app. */
export function removeApp(id) {
  const target = appPathOf(id)
  if (!existsSync(target)) return undefined
  spawnSync(LSREGISTER, ['-u', target], { stdio: 'ignore' })
  rmSync(target, { recursive: true, force: true })
  return target
}

/** Whether a node binary is one the harness runs on (^22.19.0 || >=24, its `engines`). */
export function nodeSupported(node) {
  const result = spawnSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' })
  if (result.status !== 0) return false
  const [major, minor] = result.stdout.trim().split('.').map(Number)
  return major >= 24 || (major === 22 && minor >= 19)
}

/**
 * Whether a node binary can boot the harness build: the harness reaches Node's internal module
 * loaders through `node-addon-require-builtin`, which reads them out of the node binary's machine
 * code and knows the official builds' (nodejs.org; Homebrew's too), not every distribution's (a
 * nixpkgs node fails it). Returns undefined when it can, else the reason.
 */
export function harnessRefuses(node, harnessBuild) {
  const cwd = join(harnessBuild, 'packages', 'boot', 'app-boot')
  if (!existsSync(cwd)) return undefined
  const probe = "require('node-addon-require-builtin').requireBuiltin('internal/modules/esm/loader')"
  const result = spawnSync(node, ['-e', probe], { cwd, encoding: 'utf8', timeout: 30_000 })
  if (result.status === 0) return undefined
  return (result.stderr || result.error?.message || `exit ${result.status}`).split('\n').find(l => /unsupported|Error/.test(l))?.trim() ?? 'it exits with an error'
}

/**
 * `<support>/deepsea-relay`: a link to node, so the relay shows by that name. Node is found on the
 * PATH (a stable link, not a versioned path) unless that one is too old to run the harness (a
 * login shell's PATH can hold an old /usr/local/bin/node) or cannot boot it (`harnessRefuses`):
 * then the node running dsd, which must.
 */
export function linkRelayNode(supportDir, harnessBuild) {
  const which = spawnSync('/bin/sh', ['-lc', 'command -v node'], { encoding: 'utf8' }).stdout.trim()
  const refused = node => !nodeSupported(node) ? 'too old for the harness' : harnessBuild ? harnessRefuses(node, harnessBuild) : undefined
  const onPathReason = which ? refused(which) : undefined
  const node = which && onPathReason === undefined ? which : process.execPath
  if (node !== which) {
    const own = refused(node)
    if (own !== undefined) throw new DsdError(`no node here can run the harness: ${which ? `${which}: ${onPathReason}; ` : ''}${node} (running dsd): ${own}. Run dsd with an official Node build (nodejs.org)`)
    if (which) note(`${which} cannot run the harness (${onPathReason}); the relay and server use ${node}`)
  }
  const link = join(supportDir, 'deepsea-relay')
  mkdirSync(supportDir, { recursive: true })
  try { if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === node) return { link, node } } catch { /* none */ }
  try { unlinkSync(link) } catch { /* none */ }
  symlinkSync(node, link)
  return { link, node }
}

/** Write the plist and (re)load the job. */
export async function installLaunchAgent(id, programArguments, launchdLog) {
  const label = relayLabelOf(id)
  const plist = launchAgentOf(id)
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  await bootout(label)
  writeFileSync(plist, relayPlist({ label, programArguments, launchdLog }))
  await bootstrap(plist, label)
  return { label, plist }
}

/** Unload and delete the job's plist. */
export async function removeLaunchAgent(id) {
  const stopped = await bootout(relayLabelOf(id))
  const plist = launchAgentOf(id)
  const existed = existsSync(plist)
  rmSync(plist, { force: true })
  return { stopped, plist: existed ? plist : undefined }
}

// ---- the relay's job, either platform -----------------------------------------

/** The relay's systemd unit (Linux). */
export const relayUnitOf = id => `${relayLabelOf(id)}.service`

/**
 * The relay's job as this platform runs it: a LaunchAgent on macOS, a systemd user unit on Linux.
 * `status` is `{ loaded, pid }`: loaded = bootstrapped (macOS) or running (Linux).
 */
export const relayService = {
  /** The job's file: the plist or the unit. */
  file: id => DARWIN ? launchAgentOf(id) : join(unitDir(), relayUnitOf(id)),
  installed: id => existsSync(relayService.file(id)),
  /** Where the job's own stdout and stderr go (the relay logs to its run log). */
  log: id => join(logDirOf(id), 'relay', DARWIN ? 'launchd.log' : 'systemd.log'),
  status(id) {
    if (DARWIN) return jobStatus(relayLabelOf(id))
    const unit = unitStatus(relayUnitOf(id))
    return { loaded: unit.active, pid: unit.pid }
  },
  /** Write the job and (re)start it. `after`: units the relay needs running first (Linux). */
  async install(id, programArguments, { after = [] } = {}) {
    if (DARWIN) {
      const { label, plist } = await installLaunchAgent(id, programArguments, relayService.log(id))
      return { label, file: plist }
    }
    const unit = relayUnitOf(id)
    const file = await installUnit(unit, relayUnit({ description: `${displayName(id)} relay (${variantName(id)})`, programArguments, log: relayService.log(id), after }))
    return { label: unit, file }
  },
  /** Start the installed job if it is not running. */
  async start(id) {
    if (!DARWIN) return startUnit(relayUnitOf(id))
    if (!jobStatus(relayLabelOf(id)).loaded) await bootstrap(launchAgentOf(id), relayLabelOf(id))
    kickstart(relayLabelOf(id))
  },
  /** Stop the job (relay and server); it stays installed. Returns whether it ran. */
  stop: id => DARWIN ? bootout(relayLabelOf(id)) : stopUnit(relayUnitOf(id)),
  /** Stop and delete the job. */
  async remove(id) {
    if (DARWIN) { const { stopped, plist } = await removeLaunchAgent(id); return { stopped, file: plist } }
    return removeUnit(relayUnitOf(id))
  },
}

// ---- the Dock (opt-in) --------------------------------------------------------

/** A persistent-apps entry for an app, as `defaults` takes it. */
export function dockTile(appPath) {
  return `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${xml(`file://${encodeURI(appPath)}/`)}</string><key>_CFURLStringType</key><integer>15</integer></dict></dict><key>tile-type</key><string>file-tile</string></dict>`
}

/** Whether the Dock's persistent apps (`defaults export com.apple.dock -` XML) include an app. */
export function dockHas(dockXml, appPath) {
  return String(dockXml).includes(xml(`file://${encodeURI(appPath)}/`))
}

const dockXml = () => spawnSync('/usr/bin/defaults', ['export', 'com.apple.dock', '-'], { encoding: 'utf8' }).stdout

/** Add a Dock tile for an app unless it has one. */
export function addDockTile(appPath) {
  if (dockHas(dockXml(), appPath)) return false
  // A Dock still restarting after an earlier tile writes its own list back over a new one: check, and add
  // again once it has settled.
  for (let attempt = 0; attempt < 3; attempt++) {
    execFileSync('/usr/bin/defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', dockTile(appPath)])
    spawnSync('/usr/bin/killall', ['Dock'], { stdio: 'ignore' })
    spawnSync('/bin/sleep', ['3'])
    if (dockHas(dockXml(), appPath)) return true
  }
  throw new DsdError(`the Dock did not keep the tile for ${appPath}; add it by hand`)
}

/** Remove an app's Dock tile, if any (through a plist round trip, leaving every other tile as it is). */
export function removeDockTile(appPath) {
  const exported = dockXml()
  if (!dockHas(exported, appPath)) return false
  const python = `import plistlib,sys
d=plistlib.loads(sys.stdin.buffer.read())
url=sys.argv[1]
d['persistent-apps']=[t for t in d.get('persistent-apps',[]) if t.get('tile-data',{}).get('file-data',{}).get('_CFURLString')!=url]
sys.stdout.buffer.write(plistlib.dumps(d))`
  const filtered = execFileSync('/usr/bin/python3', ['-c', python, `file://${encodeURI(appPath)}/`], { input: exported })
  execFileSync('/usr/bin/defaults', ['import', 'com.apple.dock', '-'], { input: filtered })
  spawnSync('/usr/bin/killall', ['Dock'], { stdio: 'ignore' })
  return true
}

/** Remove a Serve path, only when it points at this variant's relay. `socket`: the variant's own daemon. */
export function removeServePath(path, relayPort, socket) {
  const facts = tailnetFacts(socket)
  const target = facts?.mappings?.[path]
  if (target === undefined) return false
  if (!new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${relayPort}/?$`).test(String(target))) {
    note(`Serve path ${path} points at ${target}, not this variant's relay; left as it is`)
    return false
  }
  const [cli, ...pre] = tailscaleCommand(socket)
  execFileSync(cli, [...pre, 'serve', '--https=443', `--set-path=${path}`, 'off'], { stdio: 'ignore', timeout: 15000 })
  return true
}

