/**
 * Integration branches, built in memory: `git merge-tree --write-tree` makes
 * each merge's tree and `git commit-tree` its commit, so no working tree is
 * touched and nothing moves when a merge conflicts.
 *
 * An integration is `base`, then one `Merge <topic>` commit per topic in
 * order (first parent: the integration so far; second: the topic's tip). A
 * merge whose two parents are those of a commit already on the branch reuses
 * that commit, so an unchanged integration keeps its commit ids (and a pin to
 * it stays valid).
 *
 * Generated files (catalogs, README translation records, the lockfile) are not
 * merged by hand: a merge that conflicts only in such files is kept with the
 * conflict in them, and `regenerate` then makes them again from the merged
 * sources in a worktree of its own, as one more commit on top.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DsdError, git } from './util.mjs'

/** The first-parent merges on `branch`, keyed by `<first parent> <second parent>`. */
function existingMerges(repo, branch) {
  const merges = new Map()
  let lines
  try { lines = git(repo, ['rev-list', '--first-parent', '--parents', `refs/heads/${branch}`]).split('\n') } catch { return merges }
  for (const line of lines) {
    const [commit, first, second, extra] = line.split(' ')
    if (second && !extra) merges.set(`${first} ${second}`, commit)
  }
  return merges
}

/** Merge `ours` and `theirs` in memory: `{ tree }`, or `{ tree, conflicts: [paths] }` (the tree then holds conflict markers). */
export function mergeTrees(repo, ours, theirs) {
  const result = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  if (result.status === 0) return { tree: lines[0] }
  if (result.status === 1) return { tree: lines[0], conflicts: [...new Set(lines.slice(1))] }
  throw new DsdError(`git merge-tree ${ours} ${theirs} (in ${repo}): ${result.stderr.trim().split('\n')[0]}`)
}

const isAncestor = (repo, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo }).status === 0

/**
 * The harness's generated files: whole files a script writes, and how they
 * are made again. A conflict anywhere else (a hand-written file, or a
 * generated region inside a hand-written README) stops the integration.
 */
export const HARNESS_GENERATED = {
  /**
   * Every catalog generator, run on every integration so a clean merge cannot leave a stale catalog either;
   * and the graph docs (`gen-doc-graphs`), whose generated tables cite source lines that topics shift. Those
   * docs are partly hand-written, so a conflict in them still stops the integration (not in `isGenerated`).
   */
  generators: ['gen-config-catalog', 'gen-tool-catalog', 'gen-cordis-catalog', 'gen-cordis-inspect-catalog', 'gen-client-catalog', 'gen-doc-graphs'],
  /** Whole generated files. */
  isGenerated: path => path === 'pnpm-lock.yaml'
    || /(^|\/)README\.i18n\.yaml$/.test(path)
    || /^docs\/(config|tool)-catalog(\.zh)?\.(md|i18n\.yaml)$/.test(path)
    || path === 'packages/extensions/tool-cordis/src/api-catalog.ts'
    || /^packages\/extensions\/cordis-client-runner\/src\/client\/(api|slot)-catalog\.ts$/.test(path),
}

/**
 * Plan the integration of `topics` (branch names, in order) onto `base`, as
 * branch `branch`. Writes commit objects but moves no ref. With `isGenerated`,
 * a merge conflicting only in generated files goes on (their paths are
 * returned in `regenerate`); `regenerate()` then makes them again.
 * @returns {{ tip: string, steps: Array<{ topic, tip, commit?, reused?, skipped?, regenerate? }>, conflict?: { topic: string, files: string[] }, regenerate: string[] }}
 */
export function planIntegration(repo, base, topics, branch, { isGenerated } = {}) {
  const existing = existingMerges(repo, branch)
  let current = git(repo, ['rev-parse', '--verify', `${base}^{commit}`])
  const steps = []
  const deferred = new Set()
  for (const topic of topics) {
    const tip = git(repo, ['rev-parse', '--verify', `refs/heads/${topic}^{commit}`])
    if (isAncestor(repo, tip, current)) { steps.push({ topic, tip, skipped: 'already in' }); continue }
    const merged = mergeTrees(repo, current, tip)
    if (merged.conflicts) {
      if (!isGenerated || !merged.conflicts.every(isGenerated)) return { tip: current, steps, conflict: { topic, files: merged.conflicts }, regenerate: [...deferred] }
      for (const path of merged.conflicts) deferred.add(path)
    }
    const regenerated = merged.conflicts ? { regenerate: merged.conflicts } : {}
    const reuse = existing.get(`${current} ${tip}`)
    if (reuse) { current = reuse; steps.push({ topic, tip, commit: reuse, reused: true, ...regenerated }); continue }
    current = git(repo, ['commit-tree', merged.tree, '-p', current, '-p', tip, '-m', `Merge ${topic}`])
    steps.push({ topic, tip, commit: current, reused: false, ...regenerated })
  }
  return { tip: current, steps, regenerate: [...deferred] }
}

const MARKER = /^(<<<<<<<|>>>>>>>) /m

/**
 * Make the generated files of integration `tip` again, in `worktree`
 * (detached; created on first use, its node_modules kept between runs): the
 * lockfile from `base`'s when it conflicted, then `pnpm install`, every
 * catalog generator, and the translation record of each README whose record
 * conflicted (only those: re-recording any other pair would confirm a
 * translation nobody brought along). Fails if a conflicted file still holds
 * conflict markers. Returns `tip` when nothing changed, else a commit on it
 * (the one `branch` already has when its tree is the same).
 * @param {object} o
 * @param {(cmd: string[], cwd: string) => void} [o.run] - runs one command (default: spawned with CI=true; output shown when it fails).
 */
export function regenerate({ repo, base, tip, branch, conflicted, worktree, generated = HARNESS_GENERATED, run = runCommand }) {
  if (!existsSync(join(worktree, '.git'))) git(repo, ['worktree', 'add', '--detach', '--quiet', worktree, tip])
  git(worktree, ['checkout', '--quiet', '--force', '--detach', tip])
  git(worktree, ['clean', '--quiet', '-fd'])
  if (conflicted.includes('pnpm-lock.yaml')) {
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), `${git(repo, ['show', `${base}:pnpm-lock.yaml`])}\n`)
    run(['pnpm', 'install', '--lockfile-only'], worktree)
  }
  run(['pnpm', 'install', '--frozen-lockfile'], worktree)
  for (const script of generated.generators) run(['pnpm', 'run', script], worktree)
  for (const record of conflicted.filter(p => p.endsWith('README.i18n.yaml'))) {
    // From base's record (or none), --write records the merged pair whole.
    let previous = ''
    try { previous = `${git(repo, ['show', `${base}:${record}`])}\n` } catch { /* new in a topic */ }
    writeFileSync(join(worktree, record), previous)
    run(['pnpm', 'run', 'verify-translation-pairing', '--write', record.replace(/\.i18n\.yaml$/, '.md')], worktree)
  }
  const left = conflicted.filter(p => existsSync(join(worktree, p)) && MARKER.test(readFileSync(join(worktree, p), 'utf8')))
  if (left.length) throw new DsdError(`regenerating did not resolve: ${left.join(', ')}`)
  git(worktree, ['add', '--all'])
  const tree = git(worktree, ['write-tree'])
  if (tree === git(repo, ['rev-parse', `${tip}^{tree}`])) return tip
  try {
    const existing = git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`])
    if (git(repo, ['rev-parse', `${existing}^1`]) === tip && git(repo, ['rev-parse', `${existing}^{tree}`]) === tree) return existing
  } catch { /* no such branch, or a root commit */ }
  return git(repo, ['commit-tree', tree, '-p', tip, '-m', 'Regenerate generated files'])
}

/** Run one command in `cwd` with CI=true (no git hooks installed, no prompts); its output is shown only when it fails. */
function runCommand(cmd, cwd) {
  const result = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' }, maxBuffer: 256 * 1024 * 1024 })
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`)
    throw new DsdError(`${cmd.join(' ')} failed in ${cwd} (exit ${result.status})`)
  }
}

/** The worktree that has `branch` checked out, or undefined. */
export function checkedOutAt(repo, branch) {
  let path
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9)
    else if (line === `branch refs/heads/${branch}`) return path
  }
  return undefined
}

/**
 * Point `branch` at `tip`. A branch checked out in a worktree is moved there
 * with `git reset --keep`, which refuses when that worktree has changes the
 * move would touch; anything else is a plain ref update. Returns the previous
 * tip, or undefined for a new branch.
 */
export function moveBranch(repo, branch, tip) {
  let previous
  try { previous = git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]) } catch { /* new branch */ }
  if (previous === tip) return previous
  const worktree = checkedOutAt(repo, branch)
  if (worktree) {
    if (git(worktree, ['status', '--porcelain', '--untracked-files=no'])) throw new DsdError(`${branch} is checked out in ${worktree} with uncommitted changes; commit or stash them first`)
    git(worktree, ['reset', '--keep', tip])
  } else {
    git(repo, ['update-ref', `refs/heads/${branch}`, tip, ...(previous ? [previous] : [])])
  }
  return previous
}
