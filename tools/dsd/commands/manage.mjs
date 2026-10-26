/**
 * dsd stop | list | gc | builds | link
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { buildPaths, buildReady, buildRecord, ensureBuild, harnessRepo, linkExtras, linkHarness, readLock, resolveHarnessCommit } from '../lib/harness.mjs'
import { buildsDir, homeOf, mainCheckout, REPO } from '../lib/paths.mjs'
import { appPathOf, appRunning, listening } from '../lib/install.mjs'
import { runningAs } from '../lib/processes.mjs'
import { namedStatus, stopNamed } from './variant.mjs'
import { removeVariant } from '../lib/remove.mjs'
import { git, onlyFlags, parseArgs, printJson, usage } from '../lib/util.mjs'
import { lastActivity, listVariants, ownedByCaller, resolveRef } from '../lib/variants.mjs'

/** dsd stop [<ref>] [--keep] */
export async function stop(argv) {
  const args = parseArgs(argv)
  // `-v <ref>`, as dsd drive takes it, works here too.
  const v = args._.indexOf('-v')
  if (v >= 0) args._.splice(v, 1)
  onlyFlags(args, ['keep', 'self'])
  if (args._.length > 1) usage('dsd stop [<variant>] [--keep]')
  const variant = resolveRef(args._[0])
  if (!variant.throwaway) return stopNamed(variant.id, args)
  printJson(await removeVariant(variant.id, { keep: Boolean(args.keep) }))
}

/** Whether a throwaway's app is still the process dsd started (its server may be gone). */
function appAlive(state) {
  return Boolean(state?.app?.pid && runningAs(state.app.pid, state.app.signature))
}

/** dsd list [--builds] [--json] */
export async function list(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['builds', 'json'])
  const named = new Map()
  // A throwaway with a relay is running while its relay is; its server comes and goes.
  const relayOnly = new Set()
  if (!args.builds) {
    for (const v of listVariants()) {
      if (!v.throwaway && v.config?.ports) named.set(v.id, await namedStatus(v.id, v.config))
      else if (v.running && v.state?.relay && !(await listening(v.state.port))) relayOnly.add(v.id)
    }
  }
  const namedLabel = s => !s.installed ? 'not installed' : s.server ? 'running' : s.relay ? 'relay only' : s.job ? 'starting' : 'stopped'
  // A thin client is its app: running, installed, or not (yet).
  const clientLabel = id => !existsSync(appPathOf(id)) ? 'not installed' : appRunning(appPathOf(id)) ? 'app running' : 'installed'
  const rows = args.builds ? builds() : listVariants().map(v => v.config?.client && !v.throwaway ? {
    id: v.id, kind: 'client', status: clientLabel(v.id), url: v.config.url,
  } : ({
    id: v.id,
    kind: v.throwaway ? 'throwaway' : 'named',
    status: named.has(v.id) ? namedLabel(named.get(v.id)) : relayOnly.has(v.id) ? 'relay only' : v.running ? 'running' : appAlive(v.state) ? 'app only' : 'stopped',
    port: named.has(v.id) ? named.get(v.id).port : v.running ? v.state.port : undefined,
    harness: (v.state?.harness ?? v.config?.harness)?.slice(0, 10),
    owner: v.throwaway ? (ownedByCaller(v.config) ? 'me' : (v.config?.ownerSession ?? v.config?.ownerCheckout ?? '?').replace(/^session-/, '').slice(0, 13)) : undefined,
    expires: v.config?.expires,
    url: named.has(v.id) ? (v.config.servePath ? `${v.config.servePath}/` : `http://127.0.0.1:${Number(v.config.ports) + 3}/`) : v.running ? v.state.url : undefined,
  }))
  if (args.json) return printJson(rows)
  if (rows.length === 0) return void process.stdout.write(args.builds ? 'no builds\n' : 'no variants\n')
  const columns = args.builds ? Object.keys(rows[0]) : ['id', 'kind', 'status', 'port', 'harness', 'owner', 'expires', 'url']
  const cell = (row, c) => String(row[c] ?? '-')
  const width = columns.map(c => Math.max(c.length, ...rows.map(r => cell(r, c).length)))
  const line = values => values.map((v, i) => v.padEnd(width[i])).join('  ').trimEnd()
  process.stdout.write(`${[line(columns.map(c => c.toUpperCase())), ...rows.map(r => line(columns.map(c => cell(r, c))))].join('\n')}\n`)
}

/** Every harness build: commit, status, and what uses it. */
function builds() {
  const dir = buildsDir()
  if (!existsSync(dir)) return []
  const users = buildUsers()
  return readdirSync(dir).map(f => /^(harness|deepsea)-([0-9a-f]{12})\.json$/.exec(f)).filter(Boolean).map(([, kind, short]) => {
    const record = buildRecord(short, kind) ?? {}
    const commit = record.commit ?? short
    return {
      kind,
      commit: commit.slice(0, 10),
      status: record.status ?? 'unknown',
      seconds: record.seconds,
      users: (users.get(buildPaths(commit, kind).dir) ?? []).join(',') || undefined,
    }
  })
}

/**
 * What uses each build: variants (configured or running; an installed named
 * variant through its home's `source` link), `harness` links in this checkout
 * and its worktrees, and the harness build each deepsea build links (unless
 * that deepsea build is itself going: `going`). A build in use is never
 * collected.
 * @param {Set<string>} [going] - deepsea build names (`deepsea-<hash>`) being collected.
 */
export function buildUsers(going = new Set()) {
  const users = new Map()
  const add = (dir, who) => users.set(dir, [...(users.get(dir) ?? []), who])
  for (const v of listVariants()) {
    if (v.state?.build) add(v.state.build, v.id)
    else if (v.config?.harness) add(buildPaths(v.config.harness).dir, v.id)
    if (v.state?.source) add(v.state.source, v.id)
    try { add(readlinkSync(join(homeOf(v.id), 'source')), `${v.id} (installed)`) } catch { /* not installed */ }
  }
  for (const f of existsSync(buildsDir()) ? readdirSync(buildsDir()) : []) {
    if (!/^deepsea-[0-9a-f]{12}$/.test(f) || going.has(f)) continue
    try { add(readlinkSync(join(buildsDir(), f, 'harness')), f) } catch { /* no link */ }
  }
  const checkouts = git(REPO, ['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
  for (const checkout of checkouts) {
    // A deepsea build is a worktree too: one being collected no longer holds its harness build.
    if (going.has(basename(checkout)) && dirname(checkout) === buildsDir()) continue
    const link = join(checkout, 'harness')
    try { if (lstatSync(link).isSymbolicLink()) add(readlinkSync(link), checkout === REPO ? 'harness link' : `harness link (${checkout})`) } catch { /* none */ }
  }
  try { add(buildPaths(readLock().commit).dir, 'pin') } catch { /* no lock readable */ }
  return users
}

/** How long another agent's stopped throwaway is kept for inspection. */
const FOREIGN_GRACE_MS = 60 * 60_000

/**
 * Which throwaways gc removes, and why: the caller's own once stopped;
 * anyone's once stopped for an hour; anyone's, running or not, past its
 * time limit.
 */
export function gcReason(v, now = Date.now()) {
  if (!v.throwaway) return undefined
  const expires = v.config?.expires ? Date.parse(v.config.expires) : NaN
  if (expires < now) return 'expired'
  // An app still open on a stopped server is in use (the page after a /reboot); its quit removes it.
  if (v.running || appAlive(v.state)) return undefined
  if (ownedByCaller(v.config)) return 'stopped'
  return now - lastActivity(v.id) > FOREIGN_GRACE_MS ? 'stopped over an hour ago' : undefined
}

/** dsd gc [--builds] [--dry-run] */
export async function gc(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['builds', 'dry-run'])
  const dry = Boolean(args['dry-run'])
  const result = { throwaways: [], kept: [], builds: [] }
  for (const v of listVariants()) {
    if (!v.throwaway) continue
    const reason = gcReason(v)
    if (reason === undefined) { if (!v.running) result.kept.push({ id: v.id, reason: 'another agent stopped it under an hour ago' }); continue }
    result.throwaways.push({ id: v.id, reason })
    if (!dry) await removeVariant(v.id)
  }
  if (args.builds) result.builds = collectBuilds({ dry })
  printJson({ ...result, dryRun: dry })
}

/**
 * Remove the builds nothing uses (buildUsers): deepsea and harness builds, and app compiles and
 * extracted app and relay sources not used for an hour. `dsd gc --builds`, and after every
 * integration (`dsd topics integrate`), which leaves the previous integration's builds unused.
 * @param {{ dry?: boolean }} options - `dry`: only report.
 * @returns {string[]} the builds removed (or that would be).
 */
export function collectBuilds({ dry = false } = {}) {
  const result = { builds: [] }
  {
    // Builds of this repository first: each links a harness build, which stays in use until it goes.
    for (const [kind, repo] of [['deepsea', mainCheckout()], ['harness', harnessRepo()]]) {
      const users = buildUsers(new Set(result.builds))
      for (const f of existsSync(buildsDir()) ? readdirSync(buildsDir()) : []) {
        const m = new RegExp(`^(${kind}-[0-9a-f]{12})\\.json$`).exec(f)
        if (!m) continue
        const dir = join(buildsDir(), m[1])
        if (users.has(dir) || existsSync(`${dir}.lock`)) continue
        result.builds.push(m[1])
        if (dry) continue
        if (existsSync(dir)) git(repo, ['worktree', 'remove', '--force', dir])
        rmSync(join(buildsDir(), f), { force: true })
      }
      if (!dry) git(repo, ['worktree', 'prune'])
    }
    // App compiles and extracted app and relay sources: rebuilt on demand in seconds, so any not
    // used in the last hour (and not an unfinished build beside them) can go.
    const hour = Date.now() - 60 * 60_000
    const inUse = listVariants().filter(v => v.running).map(v => v.state?.relay?.dir).filter(Boolean)
    for (const f of existsSync(buildsDir()) ? readdirSync(buildsDir()) : []) {
      if (!/^(?:macos-(?:src-)?|relay-src-)[0-9a-f]{12}$/.test(f)) continue
      if (inUse.some(dir => dir.startsWith(`${join(buildsDir(), f)}/`))) continue
      const dir = join(buildsDir(), f)
      if (statSync(dir).atimeMs > hour || statSync(dir).mtimeMs > hour) continue
      result.builds.push(f)
      if (!dry) rmSync(dir, { recursive: true, force: true })
    }
  }
  return result.builds
}

/** dsd builds [make [<harness ref>]] */
export async function buildsCommand(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, [])
  if (args._[0] === undefined || args._[0] === 'list') return list(['--builds'])
  if (args._[0] !== 'make' || args._.length > 2) usage('dsd builds [list | make [<harness commit or ref>]]')
  const lock = readLock()
  const repo = harnessRepo(lock)
  const commit = resolveHarnessCommit(args._[1] ?? lock.commit, repo)
  const dir = buildReady(commit) ? buildPaths(commit).dir : await ensureBuild(commit, repo)
  printJson({ commit, dir, ...buildRecord(commit) })
}

/** dsd link — point this checkout's `harness` at the build of its pinned commit. */
export async function link(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, [])
  if (args._.length > 0) usage('dsd link')
  const linked = await linkHarness()
  // The main checkout's pin is the one the extras' plugins build against.
  const extras = REPO === mainCheckout() ? linkExtras(linked.build) : undefined
  printJson({ ...linked, ...(extras ? { extras } : {}) })
}
