/**
 * The restore worker: a detached process the server starts just before it
 * shuts itself down. It waits for the server's pid to exit (never writing
 * while the old process has stores open), extracts the chosen archive beside
 * the home, swaps it in, and on failure puts the rollback archive back. Each
 * step goes to its run log in the variant's log directory
 * (plugins/backup-restore/<ts>-<pid>.log) and the outcome to the restore's
 * status file, which the next server answers the dialog from.
 *
 *   node restore-worker.mjs <home> <backups> <archive> <rollback> <server pid> <restore id>
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { extractArchive, swapHome } from './archive.mjs'
import { openRestoreLog, tildify } from './paths.mjs'
import { readRestoreStatus, writeRestoreStatus } from './restore-status.mjs'

/**
 * Restore `name` over `home`; on failure restore `rollback` (when given).
 * @param {{ home: string, backups: string, name: string, rollback?: string, id?: string, log?: (text: string) => Promise<void> }} options
 */
export async function performRestore({ home, backups, name, rollback, id, log = async () => {} }) {
  const parent = dirname(home)
  // Staging beside the home, so the swap is a rename on one file system.
  const staging = `_restore-${basename(home)}-`
  let stage
  let swapped = false
  const report = async value => {
    if (id === undefined) return
    const previous = await readRestoreStatus(backups, id)
    await writeRestoreStatus(backups, id, { ...previous, ...value })
  }
  try {
    stage = await mkdtemp(join(parent, staging))
    const extracted = await extractArchive(backups, name, stage)
    await swapHome(home, extracted)
    swapped = true
    await log(`restored ${name}`)
    await report({ state: 'restored' })
    return { restored: name }
  } catch (error) {
    await log(`restore failed: ${String(error?.stack ?? error)}`)
    if (swapped) {
      await report({ state: 'restored', warning: `Home replaced, but recording the result failed: ${String(error?.message ?? error)}` })
      return { restored: name }
    }
    if (rollback) {
      let rescue
      try {
        rescue = await mkdtemp(join(parent, staging))
        const extracted = await extractArchive(backups, rollback, rescue)
        await swapHome(home, extracted)
        await log(`rollback restored ${rollback}`)
        await report({ state: 'rolled-back', error: String(error?.message ?? error) })
      } catch (rescueError) {
        await log(`ROLLBACK FAILED: ${String(rescueError?.stack ?? rescueError)}`)
        await report({ state: 'rollback-failed', error: String(error?.message ?? error), rollbackError: String(rescueError?.message ?? rescueError) })
        throw rescueError
      } finally { if (rescue) await rm(rescue, { recursive: true, force: true }) }
    } else await report({ state: 'failed', error: String(error?.message ?? error) })
    throw error
  } finally { if (stage) await rm(stage, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [home, backups, name, rollback, pid, id] = process.argv.slice(2)
  const run = openRestoreLog(home, `restore ${name} (rollback ${rollback}, server pid ${pid})`)
  try { await writeRestoreStatus(backups, id, { ...await readRestoreStatus(backups, id), log: tildify(run.path) }) } catch { /* the outcome is still recorded below */ }
  const alive = () => { try { process.kill(Number(pid), 0); return true } catch { return false } }
  // Never write while the server has stores open; fail rather than race a hung shutdown.
  const deadline = Date.now() + 60_000
  while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  if (alive()) {
    const error = 'the server did not exit within 60 seconds; the home was not replaced'
    await run.line(`restore aborted: ${error}`)
    const previous = await readRestoreStatus(backups, id)
    await writeRestoreStatus(backups, id, { ...previous, state: 'failed', error })
    process.exitCode = 1
  } else {
    try { await performRestore({ home, backups, name, rollback, id, log: run.line }); process.exitCode = 0 }
    catch { process.exitCode = 1 }
  }
}
