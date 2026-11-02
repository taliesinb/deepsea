/**
 * @deepsea/backup-restore, host half: `/backup` writes the whole home to a
 * private ZIP in the variant's backups directory; `/restore <file>` saves a
 * rollback of the current home, starts the detached restore worker and shuts
 * the server down gracefully, so the worker swaps the home only once nothing
 * has it open. With a relay in front, the next connection starts the server
 * on the restored home.
 *
 * The browser half decorates both bare commands (a confirmation for
 * /backup, a chooser for /restore) and reaches the host through the control
 * routes `POST /deepsea-backup-restore/{list,backup,restore,status}`, behind
 * DSH's own request gate with the Connection JSON envelope.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listBackups, makeBackup, validateArchive } from './archive.mjs'
import { locations, tildify } from './paths.mjs'
import { readRestoreStatus, restoreId, writeRestoreStatus } from './restore-status.mjs'

export const name = 'deepsea-backup-restore'
export const inject = ['commands', 'webServer', 'connection']

/** The control routes' prefix (document-relative in the browser). */
export const CHANNEL = '/deepsea-backup-restore'
/** Answer the request (and let command/done land) before the process goes. */
const SHUTDOWN_DELAY_MS = 400

/**
 * `{ directory? }`: the backups directory; default `_backups/<v>/` beside the
 * home (paths.mjs). It must lie outside the home.
 */
export function resolveConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'directory')) throw new TypeError('Invalid backup-restore configuration: the only key is `directory`')
  const directory = input.directory
  if (directory !== undefined && (typeof directory !== 'string' || directory.trim() === '' || directory.includes('\0') || !(directory.startsWith('/') || directory.startsWith('~')))) throw new TypeError('Invalid backup directory: an absolute path or one starting with ~')
  return directory === undefined ? {} : { directory }
}
export const Config = { '~standard': { version: 1, vendor: 'deepsea-backup-restore', validate(input) {
  try { return { value: resolveConfig(input ?? {}) } }
  catch (error) { return { issues: [{ message: error.message }] } }
} } }

const megabytes = bytes => `${(bytes / 1_000_000).toFixed(1)} megabytes`
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ directory?: string }} config
 */
export function apply(ctx, config = {}) {
  const { home, backups } = locations({ directory: config?.directory })
  const shownBackups = tildify(backups)
  let restoring = false
  const backup = () => makeBackup({ home, backups })
  const restore = async filename => {
    if (restoring) throw new Error('a restore is already pending')
    restoring = true
    let pendingId
    try {
      const selected = await validateArchive(backups, filename)
      const rollback = await makeBackup({ home, backups, kind: 'rollback' })
      const id = restoreId()
      pendingId = id
      const input = { name: filename, counts: selected.manifest.counts, bytes: selected.bytes }
      const rescue = { name: rollback.name, counts: rollback.counts, bytes: rollback.bytes }
      await writeRestoreStatus(backups, id, { state: 'pending', selected: input, rollback: rescue })
      const child = spawn(process.execPath, [fileURLToPath(new URL('./restore-worker.mjs', import.meta.url)), home, backups, filename, rollback.name, String(process.pid), id], { detached: true, stdio: 'ignore', env: process.env })
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      child.unref()
      ctx.logger.info(`backup-restore: restoring ${filename} after shutdown (rollback ${rollback.name}, restore ${id})`)
      setTimeout(() => { process.kill(process.pid, 'SIGTERM') }, SHUTDOWN_DELAY_MS)
      return { id, rollback: rescue, selected: input, shownBackups }
    } catch (error) {
      restoring = false
      if (pendingId) {
        const previous = await readRestoreStatus(backups, pendingId)
        await writeRestoreStatus(backups, pendingId, { ...previous, state: 'failed', error: `Restore aborted before shutdown: ${String(error?.message ?? error)}` })
      }
      throw error
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'backup',
    description: `Back up this home to ${shownBackups}`,
    handler: async ({ rawInput }) => {
      if (rawInput.trim()) return { kind: 'error', text: 'Usage: /backup' }
      try {
        const saved = await backup()
        return { kind: 'success', text: `Wrote ${plural(saved.counts.workspaces, 'workspace')} and ${plural(saved.counts.sessions, 'session')} to:\n\`${shownBackups}/${saved.name}\` (${megabytes(saved.bytes)}).` }
      } catch (error) { return { kind: 'error', text: `Backup failed: ${String(error?.message ?? error)}` } }
    },
  }), 'backup-restore: /backup')

  ctx.effect(() => ctx.commands.register({
    name: 'restore',
    description: 'Restore this home from a backup',
    input: { hint: 'backup file name' },
    handler: async ({ rawInput }) => {
      const filename = rawInput.trim()
      if (!filename) {
        const names = (await listBackups(backups)).map(item => item.name)
        return { kind: 'success', text: names.length === 0 ? `No backups in ${shownBackups}.` : `Backups in ${shownBackups}: ${names.join(', ')}.` }
      }
      try {
        const result = await restore(filename)
        return { kind: 'success', text: `Restoring ${result.selected.name} once the server stops; rollback saved as ${result.rollback.name}.` }
      } catch (error) { return { kind: 'error', text: `Restore aborted: ${String(error?.message ?? error)}` } }
    },
  }), 'backup-restore: /restore')

  const fail = message => ({ ok: false, error: { code: 'deepsea-backup-restore/error', message, details: {} } })
  const dispatch = async (endpoint, args) => {
    try {
      switch (endpoint) {
        case 'list': return { ok: true, value: { shownBackups, archives: await listBackups(backups), restoring } }
        case 'backup': {
          const saved = await backup()
          return { ok: true, value: { name: saved.name, counts: saved.counts, bytes: saved.bytes, displayPath: `${shownBackups}/${saved.name}` } }
        }
        case 'restore': return { ok: true, value: await restore(args.name) }
        case 'status': {
          const status = await readRestoreStatus(backups, args.id)
          return status === undefined ? fail('Restore status not found') : { ok: true, value: status }
        }
        default: return fail('Unknown action')
      }
    } catch (error) { return fail(String(error?.message ?? error)) }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = new URL(req.url ?? '/', 'http://x').pathname.slice(CHANNEL.length + 1)
      if (req.method !== 'POST' || !['list', 'backup', 'restore', 'status'].includes(endpoint)) { res.writeHead(404); res.end('not found'); return }
      try {
        const chunks = []
        let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024) throw new Error('request too large'); chunks.push(chunk) }
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) throw new Error('invalid client-request envelope')
        const result = await dispatch(endpoint, message.payload?.args ?? {})
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
      } catch (error) { if (!res.headersSent) { res.writeHead(400); res.end(String(error?.message ?? error)) } }
    },
  }), 'backup-restore: control routes')
}
