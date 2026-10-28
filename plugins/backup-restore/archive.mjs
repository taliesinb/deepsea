/**
 * Home archives: one ZIP per backup, holding the manifest `deepsea-backup.json`
 * (format `deepsea-home-v1`: counts and every file with its size, link target or
 * SQLite flag) and the home itself under `home/`. SQLite databases are
 * snapshotted through Node's online backup API; links are archived as links;
 * sockets and FIFOs (runtime endpoints, recreated by their owners) are left
 * out. `validateArchive` checks the ZIP, every entry name and type, and the
 * manifest before anything is extracted.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'

/** The folder in the ZIP holding the home. */
export const HOME_DIR = 'home'
export const ROOT = `${HOME_DIR}/`
export const MANIFEST = 'deepsea-backup.json'
/** Backup and rollback file names. */
export const ARCHIVE_NAME = /\.(?:backup|rollback)\.deepsea\.zip$/
/** Workspace and session exports (@deepsea/export-sessions): imported, never restored. */
const EXPORT_NAME = /\.(workspace|session)\.deepsea\.zip$/
const MAX_LISTING = 64 * 1024 * 1024
const SQLITE_HEADER = Buffer.from('SQLite format 3\0')
const SQLITE_SIDECAR = /-(?:wal|shm|journal)$/
const SQLITE_NAME = /\.(?:sqlite(?:3)?|db(?:3)?)$/i

function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024, cwd: options.cwd, signal: options.signal, windowsHide: true }, (error, stdout) => {
      if (error) { reject(error); return }
      resolve(String(stdout))
    })
  })
}

async function regularDirectory(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} must be a real directory, not a symlink`)
}

async function ensureBackups(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await regularDirectory(path)
  await chmod(path, 0o700)
}

async function walk(path, prefix = '') {
  const names = await readdir(path, { withFileTypes: true })
  const entries = []
  for (const entry of names) {
    const name = prefix + entry.name
    const full = join(path, entry.name)
    const info = await lstat(full)
    if (info.isSymbolicLink()) { entries.push({ name, link: await readlink(full) }); continue }
    if (info.isDirectory()) entries.push(...await walk(full, `${name}/`))
    else if (info.isFile()) entries.push({ name, size: info.size })
    else if (info.isSocket() || info.isFIFO()) continue
    else throw new Error(`cannot archive a special file: ${name}`)
  }
  return entries
}

async function sqliteFiles(home, files) {
  const names = new Set(files.map(file => file.name))
  const databases = new Set()
  for (const file of files) {
    if (file.link !== undefined || SQLITE_SIDECAR.test(file.name)) continue
    if (file.size < SQLITE_HEADER.length) {
      if (SQLITE_NAME.test(file.name)) throw new Error(`SQLite file has no valid header: ${file.name}`)
      continue
    }
    const handle = await open(join(home, file.name), 'r')
    try {
      const header = Buffer.alloc(SQLITE_HEADER.length)
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      if (bytesRead === header.length && header.equals(SQLITE_HEADER)) databases.add(file.name)
      else if (SQLITE_NAME.test(file.name)) throw new Error(`SQLite file has no valid header: ${file.name}`)
    } finally { await handle.close() }
  }
  // A sidecar without a recognizable main DB must never be silently copied as
  // an independent file: it could belong to an uninitialized or changing DB.
  for (const file of files) {
    if (!SQLITE_SIDECAR.test(file.name) || file.link !== undefined) continue
    const main = file.name.replace(SQLITE_SIDECAR, '')
    if (!names.has(main) || !databases.has(main)) throw new Error(`orphan SQLite sidecar: ${file.name}`)
  }
  return databases
}

async function snapshotSqlite(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    await sqliteBackup(db, destination)
  } finally { db.close() }
  const output = new DatabaseSync(destination, { readOnly: true })
  try {
    const result = output.prepare('PRAGMA integrity_check').get()
    if (result?.integrity_check !== 'ok') throw new Error(`SQLite integrity check failed: ${source}`)
  } finally { output.close() }
}

async function checkSnapshotSqlite(home, files) {
  const databases = await sqliteFiles(home, files)
  for (const name of databases) {
    const db = new DatabaseSync(join(home, name), { readOnly: true })
    try {
      const result = db.prepare('PRAGMA integrity_check').get()
      if (result?.integrity_check !== 'ok') throw new Error(`SQLite integrity check failed: ${name}`)
    } finally { db.close() }
  }
  return databases
}

async function counts(home, files) {
  const plugins = new Set()
  try {
    for (const profile of await readdir(join(home, 'profiles'))) {
      try {
        const file = JSON.parse(await readFile(join(home, 'profiles', profile, 'package.json'), 'utf8'))
        for (const name of file.dsh?.profile?.bundles ?? []) if (typeof name === 'string') plugins.add(name)
      } catch { /* profile may have no package.json */ }
    }
  } catch { /* profiles are optional */ }
  const workspaces = new Set()
  const sessions = new Set()
  for (const file of files) {
    const parts = file.name.split('/')
    if (parts[0] === 'sessions' && parts.length >= 3 && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(parts.at(-1))) {
      sessions.add(parts.slice(1, -1).join('/'))
      if (parts.length > 3) workspaces.add(parts[1])
    }
  }
  try {
    const data = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
    if (Array.isArray(data)) for (const item of data) if (item) workspaces.add(JSON.stringify(item))
  } catch { /* workspace store is optional; session directory count remains */ }
  return { plugins: plugins.size, workspaces: workspaces.size, sessions: sessions.size }
}

function stamp(date) {
  const component = number => String(number).padStart(2, '0')
  return `y${date.getFullYear()}m${component(date.getMonth() + 1)}d${component(date.getDate())}h${component(date.getHours())}m${component(date.getMinutes())}s${component(date.getSeconds())}`
}

/**
 * `y2026m09d28h14m03s04.h<host>.f<harness commit>.p5.w1.s3.backup.deepsea.zip`, or for a
 * rollback `h<host>--y2026-m09-d28-h14-m03-s04--c<harness commit>-p5-w1-s3.rollback.deepsea.zip`:
 * local time, this machine's short host name, the harness commit, and the counts of
 * plugins, workspaces and sessions.
 */
export function archiveName({ date, host, commit, plugins, workspaces, sessions, kind }) {
  const safe = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '_')
  const suffix = `h${safe(host)}.f${safe(commit)}.p${plugins}.w${workspaces}.s${sessions}`
  if (kind === 'rollback') return `h${safe(host)}--y${date.getFullYear()}-m${String(date.getMonth() + 1).padStart(2, '0')}-d${String(date.getDate()).padStart(2, '0')}-h${String(date.getHours()).padStart(2, '0')}-m${String(date.getMinutes()).padStart(2, '0')}-s${String(date.getSeconds()).padStart(2, '0')}--c${safe(commit)}-p${plugins}-w${workspaces}-s${sessions}.rollback.deepsea.zip`
  return `${stamp(date)}.${suffix}.backup.deepsea.zip`
}

/** The harness commit this plugin runs against (the repository's `harness` link: a build's git worktree). */
async function harnessCommit() {
  try { return (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: fileURLToPath(new URL('../../harness/', import.meta.url)) })).trim() }
  catch { return 'unknown' }
}

/** This machine's short host name (`name.local` → `name`). */
export function shortHost(name = hostname()) {
  return String(name).replace(/\.local$/i, '').split('.')[0] || 'unknown'
}

async function verifyZip(path) {
  await run('unzip', ['-tq', path], { maxBuffer: 1024 * 1024 })
}

export async function makeBackup({ home, backups, kind = 'backup', commit, date = new Date(), signal }) {
  if (backups === home || backups.startsWith(home + '/')) throw new Error('the backup directory must be outside the home')
  await regularDirectory(home)
  await ensureBackups(backups)
  const files = await walk(home)
  const databases = await sqliteFiles(home, files)
  const totals = await counts(home, files)
  const name = archiveName({ date, host: shortHost(), commit: commit ?? await harnessCommit(), ...totals, kind })
  const target = join(backups, name)
  const temp = join(backups, `.${randomUUID()}.partial.zip`)
  const stage = await mkdtemp(join(backups, '.stage-'))
  let reserved = false
  try {
    await mkdir(join(stage, HOME_DIR), { mode: 0o700 })
    const archived = []
    for (const file of files) {
      signal?.throwIfAborted()
      if (SQLITE_SIDECAR.test(file.name) && databases.has(file.name.replace(SQLITE_SIDECAR, ''))) continue
      const destination = join(stage, ROOT, file.name)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const source = join(home, file.name)
      const info = await lstat(source)
      if (file.link !== undefined) {
        if (!info.isSymbolicLink() || await readlink(source) !== file.link) throw new Error(`source changed during backup: ${file.name}`)
        await symlink(file.link, destination)
      } else if (databases.has(file.name)) {
        if (!info.isFile()) throw new Error(`source changed during backup: ${file.name}`)
        await snapshotSqlite(source, destination)
        await chmod(destination, 0o600)
      } else {
        if (!info.isFile()) throw new Error(`source changed during backup: ${file.name}`)
        await pipeline(createReadStream(source), createWriteStream(destination, { mode: 0o600 }), { signal })
        if ((await stat(destination)).size !== file.size) throw new Error(`source changed during backup: ${file.name}`)
      }
      archived.push({ name: file.name, ...(file.link === undefined ? { size: (await stat(destination)).size, ...(databases.has(file.name) ? { sqlite: true } : {}) } : { link: file.link }) })
    }
    // The backup API may create transient WAL/SHM files beside the staged DB.
    // Close/check it and remove those sidecars before ZIP traverses the tree.
    for (const file of archived.filter(item => item.sqlite === true)) {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        const sidecar = join(stage, ROOT, `${file.name}${suffix}`)
        try {
          if ((await lstat(sidecar)).size > 0 && suffix !== '-shm') throw new Error(`SQLite snapshot left a nonempty sidecar: ${file.name}${suffix}`)
          await rm(sidecar)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    }
    const manifest = { format: 'deepsea-home-v1', createdAt: date.toISOString(), counts: totals, files: archived }
    await writeFile(join(stage, MANIFEST), JSON.stringify(manifest) + '\n', { mode: 0o600 })
    await run('zip', ['-q', '-r', '-y', temp, MANIFEST, HOME_DIR], { cwd: stage, signal })
    await verifyZip(temp)
    const zipEntries = (await run('unzip', ['-Z', '-1', temp], { maxBuffer: MAX_LISTING })).trim().split('\n')
    if (!zipEntries.includes(MANIFEST) || archived.some(file => !zipEntries.includes(ROOT + file.name))) throw new Error('archive did not contain every staged file')
    const handle = await open(target, 'wx', 0o600)
    reserved = true
    await handle.close()
    await rename(temp, target)
    reserved = false
    await chmod(target, 0o600)
    return { name, path: target, counts: totals, bytes: (await stat(target)).size }
  } finally {
    if (reserved) await rm(target, { force: true })
    await rm(temp, { force: true })
    await rm(stage, { recursive: true, force: true })
  }
}

export async function listBackups(backups) {
  await ensureBackups(backups)
  const names = await readdir(backups)
  const result = []
  for (const name of names.filter(name => ARCHIVE_NAME.test(name))) {
    const path = join(backups, name)
    const info = await lstat(path)
    if (info.isFile() && !info.isSymbolicLink()) result.push({ name, bytes: info.size, modifiedAt: info.mtime.toISOString() })
  }
  return result.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

export async function validateArchive(backups, name) {
  const exported = typeof name === 'string' ? EXPORT_NAME.exec(name) : null
  if (exported !== null) throw new Error(`a ${exported[1]} export is imported with /import-${exported[1]}, not restored`)
  if (typeof name !== 'string' || name !== basename(name) || !ARCHIVE_NAME.test(name)) throw new Error('choose a backup from the backups directory')
  await regularDirectory(backups)
  const path = join(backups, name)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('backup must be a regular file')
  await verifyZip(path)
  const listing = (await run('unzip', ['-Z', '-1', path], { maxBuffer: MAX_LISTING })).trim().split('\n')
  if (!listing.includes(MANIFEST) || !listing.some(item => item.startsWith(ROOT) && !item.endsWith('/'))) throw new Error('not a home backup')
  const seen = new Set()
  for (const item of listing) {
    if (item.includes('\\') || item.includes('\0') || item.startsWith('/') || item.split('/').includes('..') || item.split('/').includes('.') || (!item.startsWith(ROOT) && item !== MANIFEST) || (item.startsWith(ROOT) && item.slice(ROOT.length).split('/').some(part => part === '' && item !== ROOT && !item.endsWith('/')))) throw new Error(`unsafe archive entry: ${item}`)
    if (seen.has(item)) throw new Error(`duplicate archive entry: ${item}`)
    seen.add(item)
  }
  const manifest = JSON.parse(await run('unzip', ['-p', path, MANIFEST], { maxBuffer: MAX_LISTING }))
  if (!Array.isArray(manifest?.files)) throw new Error('backup manifest is incomplete')
  const names = new Set(manifest.files.map(file => file?.name))
  if (manifest.format !== 'deepsea-home-v1' || !Array.isArray(manifest.files) || manifest.files.length === 0 || names.size !== manifest.files.length || manifest.files.some(file => file === null || typeof file !== 'object' || typeof file.name !== 'string' || !seen.has(ROOT + file.name) || (file.sqlite !== undefined && file.sqlite !== true) || (file.link !== undefined && (typeof file.link !== 'string' || file.link.includes('\0') || file.sqlite !== undefined))) || listing.some(item => item.startsWith(ROOT) && !item.endsWith('/') && !names.has(item.slice(ROOT.length)))) throw new Error('backup manifest is incomplete')
  const metadata = await run('zipinfo', ['-l', path], { maxBuffer: MAX_LISTING })
  const types = new Map(metadata.split('\n').filter(line => /^[dl-][rwx-]{9}\s/.test(line)).map(line => {
    const fields = line.trim().split(/\s+/)
    return [fields.at(-1), line[0]]
  }))
  if (manifest.files.some(file => types.get(ROOT + file.name) !== (file.link === undefined ? '-' : 'l'))) throw new Error('archive entry types do not match the manifest')
  return { path, manifest, bytes: info.size }
}

export async function extractArchive(backups, name, destination) {
  const { path, manifest } = await validateArchive(backups, name)
  await regularDirectory(destination)
  await run('unzip', ['-q', path, '-d', destination], { maxBuffer: 4 * 1024 * 1024 })
  const extracted = join(destination, HOME_DIR)
  await regularDirectory(extracted)
  const files = await walk(extracted)
  if (files.length !== manifest.files.length || files.some(file => {
    const expected = manifest.files.find(item => item.name === file.name)
    return expected === undefined || (file.link === undefined ? file.size !== expected.size : file.link !== expected.link)
  })) throw new Error('extracted files do not match the manifest')
  const actual = await checkSnapshotSqlite(extracted, files)
  if (manifest.files.some(file => (file.sqlite === true) !== actual.has(file.name))) throw new Error('SQLite snapshot metadata does not match the archive')
  return extracted
}

/**
 * Replace the home with an extracted one, by rename, only after the server has
 * stopped and released its stores. The old home waits beside it as
 * `_restore-old-<v>-<uuid>` (names beside the homes that are not homes start
 * with `_`) until the new one is in place.
 */
export async function swapHome(home, extracted) {
  const previous = join(dirname(home), `_restore-old-${basename(home)}-${randomUUID()}`)
  await rename(home, previous)
  try { await rename(extracted, home) }
  catch (error) { await rename(previous, home); throw error }
  await rm(previous, { recursive: true, force: true })
}
