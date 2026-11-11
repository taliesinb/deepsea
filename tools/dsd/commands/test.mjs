/**
 * dsd test plugins <name>… [--server | --relay] [--keep] [--shots <dir>] [--source <ref>] [--harness <ref> | --harness-worktree <path | topic>] [--simulated [--accounts <names>]] [--patch <file>,…] [--app <checkout | ref>]
 * dsd test harness <topic | base> [<scenario | test file>…] [--web] [--refresh] [--build]
 *
 * `plugins`: start a scripted throwaway with those plugins (the app, hidden;
 * --server without it, --relay behind a relay as installed), run every drive
 * script in their tests/ directories (`plugins/<name>/tests/*.drive`, by name;
 * tools/dsd/README.md → Drive scripts), and stop it (--keep leaves it running
 * for a look). Exit 1 when a script failed.
 *
 * `harness`: the harness's own recorded-session lanes in the topic's harness
 * worktree (`<worktrees>/harness-<topic>`; `base`: the harness repository's
 * main checkout), with the caller's DSH_* environment left out. A scenario is
 * a directory name under the harness's snapshots/ (session, sdk, acp: the
 * snapshot lane; web: the browser lane, through the test files that use it);
 * none runs the whole lane (--web: the browser lane). --refresh rewrites the
 * expected output from the committed replay input (DSH_SNAPSHOT=refresh) and
 * lists the files it changed, for review. --build rebuilds the harness first
 * (the browser lane serves its built web app). Recording against a real model
 * stays with the person (`pnpm run test:snapshot:record` there, with a key).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { driveScriptFiles, loadDriveScript, runDriveScript, shotBook } from './drive.mjs'
import { harnessCheckout } from '../lib/harness-worktree.mjs'
import { extrasDir, REPO } from '../lib/paths.mjs'
import { DsdError, git, note, onlyFlags, parseArgs, printJson, throwawayEnv, usage } from '../lib/util.mjs'
import { resolveRef } from '../lib/variants.mjs'

const USAGE = 'dsd test plugins <name>… [--server | --relay] [--keep] [run options] | dsd test harness <topic | base> [<scenario>…] [--web] [--refresh] [--build]'
const DSD = join(REPO, 'tools', 'dsd', 'bin', 'dsd.mjs')

export async function test(argv) {
  const [kind, ...rest] = argv
  if (kind === 'plugins') return testPlugins(rest)
  if (kind === 'harness') return testHarness(rest)
  usage(USAGE)
}

/** A plugin's drive scripts: `plugins/<name>/tests/*.drive` in this checkout, else in the extras. */
export function pluginScripts(name, roots = [REPO, extrasDir()]) {
  for (const root of roots) {
    const dir = join(root, 'plugins', name)
    if (!existsSync(join(dir, 'package.json'))) continue
    const tests = join(dir, 'tests')
    const has = existsSync(tests) && readdirSync(tests).some(f => f.endsWith('.drive'))
    return has ? driveScriptFiles([tests]) : []
  }
  throw new DsdError(`no plugin "${name}" in ${join(REPO, 'plugins')} (or the extras)`, 2)
}

/** Run `dsd <args>` (this checkout's) and parse its JSON output; its stderr passes through. */
function dsd(args) {
  const result = spawnSync(process.execPath, [DSD, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new DsdError(`dsd ${args.join(' ')} failed (exit ${result.status})`)
  try { return JSON.parse(result.stdout) } catch { throw new DsdError(`dsd ${args.join(' ')} printed no JSON: ${result.stdout.slice(0, 200)}`) }
}

async function testPlugins(argv) {
  const valued = ['source', 'harness', 'harness-worktree', 'accounts', 'patch', 'app']
  const args = parseArgs(argv, [...valued, 'shots'])
  onlyFlags(args, [...valued, 'shots', 'server', 'relay', 'keep', 'simulated'])
  const names = args._.flatMap(n => String(n).split(',')).map(s => s.trim()).filter(Boolean)
  if (names.length === 0) usage(USAGE)
  if (args.server && args.relay) usage('--server or --relay, not both')
  // Every script is read before the throwaway starts: a typo costs no start.
  const scripts = names.flatMap((name) => {
    const files = pluginScripts(name)
    if (files.length === 0) note(`plugins/${name} has no tests/*.drive`)
    return files.map(file => ({ plugin: name, file, steps: loadDriveScript(file) }))
  })
  if (scripts.length === 0) throw new DsdError(`no drive scripts in ${names.map(n => `plugins/${n}/tests/`).join(', ')}`, 2)
  const mode = args.server ? '--throwaway-server' : args.relay ? '--throwaway' : '--throwaway-app'
  const passed = valued.flatMap(name => args[name] === undefined ? [] : [`--${name}`, String(args[name])])
  const started = dsd(['run', 'release', mode, '--detach', '--scripted', '--plugins', names.join(','), ...passed, ...(args.simulated ? ['--simulated'] : [])])
  note(`started ${started.id}; ${scripts.length} script${scripts.length === 1 ? '' : 's'}`)
  const reports = []
  const shots = args.shots === undefined ? undefined : shotBook(String(args.shots))
  try {
    const variant = resolveRef(started.id)
    for (const { plugin, file, steps } of scripts) {
      note(`${relative(REPO, file)}`)
      reports.push({ plugin, ...await runDriveScript(variant, relative(REPO, file), steps, { label: true, shots }) })
    }
  } finally {
    shots?.finish()
    if (args.keep) note(`kept ${started.id} running (dsd stop ${started.id})`)
    else dsd(['stop', started.id])
  }
  const ok = reports.every(r => r.ok)
  printJson({ id: started.id, kept: Boolean(args.keep), ok, passed: reports.filter(r => r.ok).length, failed: reports.filter(r => !r.ok).map(r => r.script), scripts: reports })
  if (!ok) process.exitCode = 1
}

const SNAPSHOT_KINDS = { session: 'snapshots/session/headless.snapshot.ts', sdk: 'snapshots/sdk/sdk.snapshot.ts', acp: 'snapshots/acp/acp.snapshot.ts' }
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export { harnessCheckout }

/**
 * What a list of scenarios runs: the snapshot lane's files and test-name pattern, and the browser
 * lane's test files (those that name `snapshots/web/<scenario>`). A path to a test file runs as it is.
 */
export function planLanes(dir, scenarios, { web = false } = {}) {
  const snapshot = { files: new Set(), names: [] }
  const browser = new Set()
  if (scenarios.length === 0) return web ? { browser: { files: [] } } : { snapshot: { files: [], pattern: undefined } }
  let webTests
  const webTestsUsing = (name) => {
    webTests ??= readdirSync(join(dir, 'apps', 'web', 'tests')).filter(f => /\.(e2e|snapshot)\.ts$/.test(f))
      .map(f => ({ file: `apps/web/tests/${f}`, text: readFileSync(join(dir, 'apps', 'web', 'tests', f), 'utf8') }))
    const used = new RegExp(`snapshots/web/${escape(name)}(['"/\`]|$)`, 'm')
    return webTests.filter(t => used.test(t.text)).map(t => t.file)
  }
  for (const scenario of scenarios) {
    if (/\.ts$/.test(scenario)) {
      const file = relative(dir, resolve(dir, scenario))
      if (!existsSync(join(dir, file))) throw new DsdError(`no test file ${file} in ${dir}`, 2)
      if (file.startsWith('snapshots/')) snapshot.files.add(file)
      else browser.add(file)
      continue
    }
    let found = false
    for (const [kind, file] of Object.entries(SNAPSHOT_KINDS)) {
      if (!existsSync(join(dir, 'snapshots', kind, scenario))) continue
      snapshot.files.add(file)
      snapshot.names.push(scenario)
      found = true
    }
    if (existsSync(join(dir, 'snapshots', 'web', scenario))) {
      const files = webTestsUsing(scenario)
      if (files.length === 0) throw new DsdError(`snapshots/web/${scenario} is used by no test in apps/web/tests`, 2)
      for (const f of files) browser.add(f)
      found = true
    }
    if (!found) throw new DsdError(`no scenario ${scenario} under ${join(dir, 'snapshots')} (session, sdk, acp or web)`, 2)
  }
  const plan = {}
  if (snapshot.files.size) plan.snapshot = { files: [...snapshot.files], pattern: snapshot.names.length ? `(^|[^\\w-])(${snapshot.names.map(escape).join('|')})([^\\w-]|$)` : undefined }
  if (browser.size) plan.browser = { files: [...browser] }
  return plan
}

/** Files that differ from HEAD under the paths a lane writes, each with a hash of its content now. */
function changedFiles(dir) {
  const files = git(dir, ['status', '--porcelain', '--untracked-files=all', '--', 'snapshots', 'apps/web/tests', 'scripts/snapshots']).split('\n').filter(Boolean).map(l => l.slice(3))
  return new Map(files.map((f) => {
    try { return [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')] } catch { return [f, 'gone'] }
  }))
}

function step(label, command, args, cwd, env) {
  note(`${label}: ${command} ${args.join(' ')}`)
  const started = Date.now()
  // The lanes' own output goes to stderr, so stdout stays this command's JSON.
  const result = spawnSync(command, args, { cwd, env, stdio: ['ignore', 2, 2] })
  if (result.error) throw new DsdError(`${command}: ${result.error.message}`)
  return { lane: label, command: [command, ...args].join(' '), exit: result.status ?? 1, seconds: Math.round((Date.now() - started) / 100) / 10 }
}

async function testHarness(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['web', 'refresh', 'build'])
  const [topic, ...scenarios] = args._
  if (topic === undefined) usage(USAGE)
  const dir = harnessCheckout(topic)
  const plan = planLanes(dir, scenarios, { web: Boolean(args.web) })
  const env = throwawayEnv({ DSH_SNAPSHOT: args.refresh ? 'refresh' : 'replay' })
  if (!existsSync(join(dir, 'node_modules'))) {
    const install = step('install', 'pnpm', ['install', '--frozen-lockfile'], dir, env)
    if (install.exit !== 0) throw new DsdError(`pnpm install failed in ${dir}`)
  }
  if (plan.browser) {
    const dist = join(dir, 'apps', 'web', 'dist')
    const built = existsSync(dist) ? statSync(dist).mtimeMs : 0
    if (args.build || built === 0) {
      const build = step('build', 'pnpm', ['run', 'build'], dir, env)
      if (build.exit !== 0) throw new DsdError(`pnpm run build failed in ${dir}`)
    } else {
      const committed = Number(git(dir, ['log', '-1', '--format=%ct'])) * 1000
      if (committed > built) note(`apps/web/dist is older than the last commit; the browser lane serves it as built (--build rebuilds)`)
    }
  }
  const before = args.refresh ? changedFiles(dir) : undefined
  const lanes = []
  if (plan.snapshot) lanes.push(step('snapshot', 'pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.snapshot.config.ts', ...plan.snapshot.files, ...(plan.snapshot.pattern ? ['-t', plan.snapshot.pattern] : [])], dir, env))
  if (plan.browser) lanes.push(step('web', 'pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.web.config.ts', ...plan.browser.files], dir, env))
  const ok = lanes.every(l => l.exit === 0)
  const out = { topic, checkout: dir, mode: args.refresh ? 'refresh' : 'replay', ok, lanes }
  // What this refresh wrote: files that changed since it started (edits already there are not listed).
  if (before) out.changed = [...changedFiles(dir)].filter(([f, hash]) => before.get(f) !== hash).map(([f]) => f).sort()
  printJson(out)
  if (!ok) process.exitCode = 1
}
