/**
 * Throwaway apps: where the app's source comes from, building a throwaway's
 * bundle, launching it, waiting until it answers, and quitting and
 * unregistering it.
 *
 * The app source is `apps/macos` of, in order: `--app <path>` (a checkout or
 * worktree, used as it is), this checkout when it has one, or a commit
 * (`--app <ref>`, default the branch topic/macos-app), extracted once into
 * `_builds/macos-src-<12 hex>/` (lib/components.mjs). Compiled executables
 * are cached by source hash in `_builds/macos-<12 hex>/` (apps/macos/build.mjs),
 * so a throwaway's bundle is assembled in well under a second once its source
 * has been built.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { appRequest } from './appsocket.mjs'
import { COMPONENTS, componentSource } from './components.mjs'
import { buildsDir, homeOf, variantName } from './paths.mjs'
import { alive, runningAs } from './processes.mjs'
import { DsdError, note, sleep, throwawayEnv } from './util.mjs'
import { displayName } from './variants.mjs'

/** The default app source when this checkout has none. */
export const APP_BRANCH = COMPONENTS.macos.branch
/** Throwaway apps' glyph colour, so they never look like an installed variant. */
export const THROWAWAY_COLOR = '#F76B15'
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
/** The longest Unix socket path macOS accepts. */
const SOCKET_PATH_MAX = 103

/** Where a throwaway's app bundle lives while it runs (LAYOUT.md: `$TMPDIR/deepsea-<component>-…`). */
export const appDirOf = id => join(tmpdir(), `deepsea-app-${id}`)
/** The automation socket of a throwaway's app. */
export const appSocketOf = id => join(homeOf(id), 'run', 'app.sock')

/**
 * The app source to build (lib/components.mjs): `{ dir, describe, build }`, where `build` is the
 * CFBundleVersion to stamp (a commit, `+` when the tree has uncommitted changes).
 */
export function appSource(choice) {
  return componentSource('macos', choice)
}

/** The harness version a build reports (its package.json), for the app's CFBundleShortVersionString. */
function harnessVersion(harnessBuild) {
  try { return JSON.parse(readFileSync(join(harnessBuild, 'package.json'), 'utf8')).version ?? '0.0.0' } catch { return '0.0.0' }
}

/**
 * Build a throwaway's `DeepSea <V> <hex>.app` into `$TMPDIR/deepsea-app-<id>/`. With `entry` (`{ url,
 * fallbackUrl, tokenFile }`) its entry points are built in, as an installed variant's are, and it is
 * launched without `--url`. `name` overrides only the visible bundle name; the id and directory
 * remain those of the isolated throwaway. Returns `{ app, executable, dir, compiled }`.
 */
export function buildThrowawayApp(id, { source, harnessBuild, entry, name = displayName(id) }) {
  if (process.platform !== 'darwin') throw new DsdError('throwaway apps need macOS (apps/macos)')
  const glyph = join(harnessBuild, 'apps', 'web', 'public', 'favicon.svg')
  if (!existsSync(glyph)) throw new DsdError(`the harness build has no ${glyph}`)
  const dir = appDirOf(id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  note(`building the app from ${source.describe}`)
  let out
  try {
    out = execFileSync(process.execPath, [join(source.dir, 'build.mjs'),
      '--out', dir, '--name', name, '--bundle-id', variantName(id), '--glyph', glyph,
      '--glyph-color', THROWAWAY_COLOR, '--version', harnessVersion(harnessBuild), '--build', source.build,
      ...(entry ? ['--url', entry.url, '--fallback-url', entry.fallbackUrl, '--token-file', entry.tokenFile] : []),
      '--cache', buildsDir()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw new DsdError(`the app build failed:\n${String(error.stderr || error.message).trim()}`)
  }
  return { ...JSON.parse(out), dir }
}

/** Start the app's executable (against `url`, else its built-in entry points), with its automation socket. Returns the child process. */
export function launchApp(id, { executable, url, visible }) {
  const socket = appSocketOf(id)
  if (socket.length > SOCKET_PATH_MAX) throw new DsdError(`the automation socket path is too long for macOS (${socket.length} > ${SOCKET_PATH_MAX} bytes): ${socket}; use a shorter DEEPSEA_ROOT`)
  // Downloads stay inside the throwaway, so a test never writes into ~/Downloads.
  const args = [...(url ? ['--url', url] : []), '--ephemeral', '--automation', socket, '--downloads', join(homeOf(id), 'downloads'), ...(visible ? [] : ['--hidden'])]
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', env: throwawayEnv() })
  return { child, socket, signature: [executable, '--automation'] }
}

/** Wait until the app answers and its page has loaded. Returns its `hello`. */
export async function waitAppReady(child, socket, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer yet'
  while (Date.now() < deadline) {
    if (child.exitCode !== null || !alive(child.pid)) throw new DsdError('the app exited before it was ready (see its log)')
    try {
      const hello = await appRequest(socket, 'hello', {}, { timeoutMs: 2000 })
      if (hello.loaded) return hello
      last = hello.offline ? 'the app shows its offline page: the server does not answer' : 'the page is still loading'
    } catch (error) { last = error.message }
    await sleep(250)
  }
  throw new DsdError(`the app was not ready within ${Math.round(timeoutMs / 1000)} s: ${last}`)
}

/**
 * Quit a throwaway's app if it is still the process dsd started: ask it to quit over its socket,
 * then SIGTERM, then SIGKILL. Returns whether it was running.
 */
export async function quitApp(app) {
  if (!app?.pid || !alive(app.pid) || !runningAs(app.pid, app.signature)) return false
  try { await appRequest(app.socket, 'quit', {}, { timeoutMs: 2000 }) } catch { try { process.kill(app.pid, 'SIGTERM') } catch { /* gone */ } }
  for (let i = 0; i < 50 && alive(app.pid); i++) await sleep(100)
  if (alive(app.pid)) try { process.kill(app.pid, 'SIGKILL') } catch { /* gone */ }
  return true
}

/** Forget a throwaway's app bundle in LaunchServices (running its executable registered it), then delete it. */
export function removeAppBundle(dir) {
  if (!dir || !isAbsolute(dir) || !existsSync(dir)) return false
  if (existsSync(LSREGISTER)) {
    for (const entry of (() => { try { return execFileSync('/bin/ls', [dir], { encoding: 'utf8' }).split('\n').filter(n => n.endsWith('.app')) } catch { return [] } })()) {
      try { execFileSync(LSREGISTER, ['-u', join(dir, entry)], { stdio: 'ignore' }) } catch { /* not registered */ }
    }
  }
  rmSync(dir, { recursive: true, force: true })
  return true
}
