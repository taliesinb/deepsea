/**
 * Installing a named variant on Linux (LAYOUT.md §6): its relay as a systemd
 * user unit, `<variant name>.relay.service` in
 * `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`, enabled (started with the
 * person's user manager: at login, or at boot with lingering) and restarted
 * whenever it exits, as the macOS LaunchAgent's RunAtLoad and KeepAlive do.
 * Pure parts (the unit text, quoting) are exported for tests; everything that
 * acts goes through `systemctl --user` here.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { DsdError, sleep } from './util.mjs'

/** Where user units live. */
export const unitDir = (env = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user')

/**
 * One argument of `ExecStart=`, quoted as systemd reads it: double quotes, `\` and `"` escaped,
 * `%` doubled (specifiers) and `$` doubled (variable expansion, which `Environment=` lacks:
 * `dollars: false`).
 */
export function systemdQuote(arg, { dollars = true } = {}) {
  const text = String(arg)
  if (/[\n\r]/.test(text)) throw new DsdError(`a unit argument cannot hold a line break: ${JSON.stringify(text)}`)
  const quoted = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `"${dollars ? quoted.replace(/\$/g, '$$$$') : quoted}"`
}

/** A systemd unit name (`name.service`, a template's instance, …), as `dsd new --after` takes it. */
export const UNIT_NAME = /^[A-Za-z0-9:_.@\\-]+\.(?:service|socket|target|mount|path|timer)$/

/**
 * The relay unit: started with the user manager, restarted when it exits, its own stdout/stderr
 * file. `after`: units it needs running first (Wants= and After=), such as a daemon of the account's
 * that nothing else starts.
 */
export function relayUnit({ description, programArguments, log, environment = {}, after = [] }) {
  for (const unit of after) if (!UNIT_NAME.test(unit)) throw new DsdError(`not a systemd unit name: ${JSON.stringify(unit)}`)
  const env = Object.entries(environment).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`, { dollars: false })}\n`).join('')
  const needs = after.length ? `Wants=${after.join(' ')}\nAfter=${after.join(' ')}\n` : ''
  return `# written by dsd (tools/dsd/lib/systemd.mjs)
[Unit]
Description=${description.replace(/[\n\r]/g, ' ')}
${needs}
[Service]
Type=simple
ExecStart=${programArguments.map(systemdQuote).join(' ')}
${env}Restart=always
RestartSec=2
# The relay stops its server's process group on SIGTERM and allows it 15 s.
KillMode=mixed
TimeoutStopSec=20
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`
}

const systemctl = args => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' })

/** A unit's state: whether its file is loaded, whether it is running (or starting), and its main pid. */
export function unitStatus(unit) {
  const result = systemctl(['show', unit, '--property=LoadState,ActiveState,MainPID'])
  if (result.error) throw new DsdError(`systemctl is not available: ${result.error.message}`)
  const props = Object.fromEntries(result.stdout.split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const pid = Number(props.MainPID)
  return {
    loaded: props.LoadState === 'loaded',
    active: ['active', 'activating', 'reloading'].includes(props.ActiveState),
    pid: pid > 0 ? pid : undefined,
  }
}

function check(result, what) {
  if (result.status !== 0) throw new DsdError(`systemctl --user ${what} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`)
}

/** Stop a unit (its relay and, with it, the server) and wait until it is down. Returns whether it ran. */
export async function stopUnit(unit) {
  if (!unitStatus(unit).active) return false
  systemctl(['stop', unit])
  for (let i = 0; i < 100 && unitStatus(unit).active; i++) await sleep(100)
  return true
}

/** Start a unit unless it runs. */
export function startUnit(unit) {
  check(systemctl(['start', unit]), `start ${unit}`)
}

/** Write a unit file, enable it and (re)start it. */
export async function installUnit(unit, text) {
  const dir = unitDir()
  mkdirSync(dir, { recursive: true })
  await stopUnit(unit)
  writeFileSync(join(dir, unit), text)
  check(systemctl(['daemon-reload']), 'daemon-reload')
  check(systemctl(['enable', unit]), `enable ${unit}`)
  startUnit(unit)
  return join(dir, unit)
}

/** Stop, disable and delete a unit. */
export async function removeUnit(unit) {
  const file = join(unitDir(), unit)
  const existed = existsSync(file)
  const stopped = existed ? await stopUnit(unit) : false
  if (existed) systemctl(['disable', unit])
  rmSync(file, { force: true })
  if (existed) systemctl(['daemon-reload'])
  return { stopped, file: existed ? file : undefined }
}

/**
 * Whether this account's user manager outlives its sessions (`loginctl enable-linger`); without it
 * the relay stops at the last logout and starts again at the next login. undefined when unknown.
 */
export function lingering(user = userInfo().username) {
  const result = spawnSync('loginctl', ['show-user', user, '--property=Linger'], { encoding: 'utf8' })
  if (result.status !== 0) return undefined
  return /^Linger=yes$/m.test(result.stdout)
}
