/** Explicit, already-built harness working trees for isolated throwaways only. */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { harnessRepo } from './harness.mjs'
import { worktreesDir } from './paths.mjs'
import { DsdError, git, note } from './util.mjs'

/** The checkout a harness topic is worked on in: `<worktrees>/harness-<topic>`; `base`, the harness repository. */
export function harnessCheckout(topic) {
  if (topic === 'base') return harnessRepo()
  const dir = join(worktreesDir(), `harness-${topic}`)
  if (!existsSync(dir)) throw new DsdError(`no harness worktree for ${topic} at ${dir} (LAYOUT.md §2 makes one)`)
  return dir
}

/**
 * Resolve a harness root without creating commits, builds, links or changing its files. `path` is a
 * directory, or a topic name (no `/`, not an existing directory) for its worktree, as `dsd test harness`.
 */
export function harnessWorktree(path) {
  const named = !path.includes('/') && !existsSync(resolve(path))
  let dir
  try { dir = realpathSync(named ? harnessCheckout(path) : resolve(path)) } catch (error) {
    if (error instanceof DsdError) throw error
    throw new DsdError(`--harness-worktree: no directory ${path}`)
  }
  // Canonical paths also catch aliases into immutable builds, regardless of DEEPSEA_ROOT.
  if (dir.split('/').includes('_builds')) throw new DsdError('--harness-worktree must not point into immutable _builds')
  let root
  try { root = realpathSync(git(dir, ['rev-parse', '--show-toplevel'])) } catch { throw new DsdError('--harness-worktree needs a git working tree') }
  if (dir !== root) throw new DsdError('--harness-worktree needs the working tree root')
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest) || JSON.parse(readFileSync(manifest, 'utf8')).name !== '@deepseek-ai/dsh-root'
    || !existsSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'))) throw new DsdError('--harness-worktree needs a harness checkout')
  const dist = join(dir, 'apps', 'web', 'dist')
  if (!existsSync(join(dir, 'node_modules')) || !existsSync(dist)) {
    throw new DsdError(`--harness-worktree needs pnpm install --frozen-lockfile and pnpm run build in ${dir} first`)
  }
  const committed = Number(git(dir, ['log', '-1', '--format=%ct'])) * 1000
  if (committed > statSync(dist).mtimeMs) note(`${dir}: its build is older than its last commit; it runs as built (pnpm run build there to rebuild)`)
  return { dir, commit: git(dir, ['rev-parse', 'HEAD']), dirty: Boolean(git(dir, ['--no-optional-locks', 'status', '--porcelain'])) }
}

/** Check throwaway-only options before any named variant or build is touched. */
export function checkWorktreeOptions(args, { throwaway, withApp }) {
  if (args['harness-worktree'] !== undefined && !throwaway) throw new DsdError('--harness-worktree is only for throwaways')
  if (args['harness-worktree'] !== undefined && args.harness !== undefined) throw new DsdError('--harness-worktree and --harness are alternatives')
  if (args['display-name'] !== undefined && (!throwaway || !withApp)) throw new DsdError('--display-name needs a throwaway macOS app')
  const name = args['display-name']
  if (name !== undefined && (typeof name !== 'string' || name.trim() !== name || !name || /[\x00-\x1f\x7f/\\:]/.test(name) || name === '.' || name === '..')) {
    throw new DsdError('--display-name needs a non-empty app name without path separators or control characters')
  }
}
