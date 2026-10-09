/**
 * One status file per restore, `<backups>/.restore-status/<id>.json` (0600):
 * written `pending` by the server that starts the restore, completed by the
 * worker (`restored`, `rolled-back`, `rollback-failed`, `failed`) and read by
 * the next server for the dialog. It lives with the backups, never in the
 * home being replaced.
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const STATUS_DIRECTORY = '.restore-status'
export const restoreId = () => randomUUID()
const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)

async function directory(backups) {
  const path = join(backups, STATUS_DIRECTORY)
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('restore status directory must not be a symlink')
  return path
}

/** Private, atomic per-restore status; not stored inside the home being replaced. */
export async function writeRestoreStatus(backups, id, value) {
  if (!validId(id)) throw new Error('invalid restore ID')
  const dir = await directory(backups)
  const path = join(dir, `${id}.json`)
  const temp = join(dir, `.${id}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, JSON.stringify({ id, ...value }) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}

export async function readRestoreStatus(backups, id) {
  if (!validId(id)) throw new Error('invalid restore ID')
  const dir = await directory(backups)
  const path = join(dir, `${id}.json`)
  let handle
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('invalid restore status file')
    handle = await open(path, 'r')
    const info = await handle.stat()
    if (!info.isFile() || info.size > 64 * 1024) throw new Error('invalid restore status file')
    const value = JSON.parse(await handle.readFile('utf8'))
    if (value.id !== id) throw new Error('restore status ID mismatch')
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  } finally { await handle?.close() }
}
