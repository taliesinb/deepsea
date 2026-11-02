/**
 * Where @deepsea/backup-restore reads and writes (LAYOUT.md §1, §4, §5):
 *
 *   home      $DSH_HOME (resolveDshHome)                         ~/.deepsea/<v>/
 *   variant   @deepsea/logs' `variantOf` ($DEEPSEA_VARIANT, else the
 *             home's name in the DeepSea root), else the home's directory name
 *   backups   config `directory`, else `_backups/<v>/` beside the home   ~/.deepsea/_backups/<v>/
 *   logs      the plugin's log directory (@deepsea/logs)
 *             ~/Library/Logs/io.github.taliesinb.deepsea.<v>/plugins/backup-restore/
 *   staging   `_restore-<v>-…` beside the home (same file system, so the swap is a rename)
 *
 * Backups sit beside the homes rather than in one, because a backup inside the
 * home would include itself. A home outside the DeepSea layout gets its
 * `_backups/` beside it all the same, so a test home never writes into a real
 * variant's backups.
 */
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { openRunLog, pluginLogDirectory, variantName, variantOf } from '@deepsea/logs'

const PLUGIN = 'backup-restore'

/**
 * The home, its variant and its backups directory.
 * @param {{ directory?: string, env?: Record<string, string | undefined> }} [options]
 */
export function locations({ directory, env = process.env } = {}) {
  const home = resolveDshHome(undefined, env)
  const variant = variantOf(home, env) ?? basename(home)
  const backups = directory !== undefined ? resolve(expandHomePath(directory)) : join(dirname(home), '_backups', variant)
  return { home, variant, backups }
}

/** `~/x` for display, when the path is under the OS home. */
export function tildify(path) {
  const home = homedir()
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

/**
 * The restore worker's run log: `<ts>-<pid>.log` in the plugin's log
 * directory, its first line naming the run (LAYOUT.md §5).
 * @returns {{ path: string, line(text: string): Promise<void> }}
 */
export function openRestoreLog(home, what, env = process.env) {
  const id = variantOf(home, env)
  const run = openRunLog(pluginLogDirectory(PLUGIN, home, env), { identity: `${id ? `${variantName(id)} ` : ''}${PLUGIN} restore worker pid ${process.pid} ${what}` })
  return { path: run.path, line: async (text) => { run.identify(text) } }
}
