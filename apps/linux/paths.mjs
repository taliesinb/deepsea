/**
 * Where the client keeps things. It is not a variant (it shows any
 * variant's server), so it lives under the bare root, as machine-wide things
 * do (LAYOUT.md §1), in a `client/` component directory beside the root's
 * `installer/` and `builds/`:
 *
 *   ${XDG_CONFIG_HOME:-~/.config}/io.github.taliesinb.deepsea/client/
 *     client.json                 the server, its identity overrides, the view (0600)
 *     Partitions/server-<hash>/   one persistent browser store per server URL (cookies)
 *   ${XDG_STATE_HOME:-~/.local/state}/io.github.taliesinb.deepsea/client/
 *     <ts>-<pid>.log, latest.log  one run log per launch (packages/logs)
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { machineLogDirectory, ROOT_NAME } from '../../packages/logs/index.mjs'

export { ROOT_NAME }
/** The component directory's name under the root. */
export const COMPONENT = 'client'

/** `${XDG_CONFIG_HOME:-~/.config}/io.github.taliesinb.deepsea/client` */
export function configDirectory(env = process.env) {
  const base = env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(homedir(), '.config')
  return join(base, ROOT_NAME, COMPONENT)
}

/** `${XDG_STATE_HOME:-~/.local/state}/io.github.taliesinb.deepsea/client` (DEEPSEA_LOG_ROOT replaces the state directory). */
export function logDirectory(env = process.env) {
  return join(machineLogDirectory(env), COMPONENT)
}

/** The persistent session partition of a server: one cookie store per mount URL. */
export function partitionOf(url) {
  return `persist:server-${createHash('sha256').update(String(url)).digest('hex').slice(0, 16)}`
}

const VIEWS = new Set(['desktop', 'mobile'])
const COLOUR = /^#[0-9a-f]{6}$/i

/**
 * The saved configuration, cleaned: `{ url?, name?, glyphColor?, view }`.
 * A missing or unreadable file is an empty configuration.
 */
export function readConfig(file) {
  let raw
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { raw = {} }
  return cleanConfig(raw)
}

export function cleanConfig(raw) {
  const config = { view: VIEWS.has(raw?.view) ? raw.view : 'desktop' }
  if (typeof raw?.url === 'string' && /^https?:\/\//.test(raw.url)) config.url = raw.url
  const name = cleanName(raw?.name)
  if (name) config.name = name
  if (typeof raw?.glyphColor === 'string' && COLOUR.test(raw.glyphColor)) config.glyphColor = raw.glyphColor.toUpperCase()
  return config
}

/** A display name as the page-side identity accepts it: letters, digits, space, `.`, `_`, `-`. */
export function cleanName(value) {
  return String(value ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 64)
}

/** Write the configuration atomically, 0600 in a 0700 directory. */
export function writeConfig(file, config) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(cleanConfig(config), null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}
