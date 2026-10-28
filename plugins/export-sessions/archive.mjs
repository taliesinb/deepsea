/**
 * Workspace and session exports: one ZIP per export, in the layout of a
 * @deepsea/backup-restore home backup with only part of the home under
 * `home/`, so @deepsea/import-sessions reads all three alike:
 *
 *   deepsea-backup.json                              the manifest (format, what was exported, counts, files)
 *   home/sessions/<project>/<session>/…              each exported session's directory, lease file left out
 *   home/attachments/v1/{objects,file-objects}/<2>/<sha>, files/<2>/<sha>/…
 *                                                    every attachment the exported logs reference
 *
 * A workspace export (`.workspace.deepsea.zip`, format `deepsea-workspace-v1`)
 * holds the workspace's sessions; a session export (`.session.deepsea.zip`,
 * format `deepsea-session-v1`) one session. Either way every subagent
 * descendant comes along.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

export const MANIFEST = 'deepsea-backup.json'
const HOME_DIR = 'home'
const ROOT = `${HOME_DIR}/`
/** Export file names, by kind. */
export const EXPORT_NAME = /\.(workspace|session)\.deepsea\.zip$/
export const FORMATS = { workspace: 'deepsea-workspace-v1', session: 'deepsea-session-v1' }
/** A home's attachment store, relative to the home (attachment-local's layout). */
const ATTACHMENTS = 'attachments/v1'
const SHA256_ID = /^sha256:([0-9a-f]{64})$/
/** Session lease files: runtime state of the server holding the session. */
const SESSION_LOCK = /(?:^|\/)session\.lock$/
/** A file that grows while it is copied (a live session's log) is copied again, at most this many times. */
const COPY_ATTEMPTS = 5
const MAX_LISTING = 64 * 1024 * 1024

function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024, cwd: options.cwd, signal: options.signal, windowsHide: true }, (error, stdout) => {
      if (error) { reject(error); return }
      resolve(String(stdout))
    })
  })
}

async function walk(path, prefix = '') {
  const entries = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name
    const full = join(path, entry.name)
    const info = await lstat(full)
    if (info.isSymbolicLink()) entries.push({ name, link: await readlink(full) })
    else if (info.isDirectory()) entries.push(...await walk(full, `${name}/`))
    else if (info.isFile()) entries.push({ name, size: info.size })
  }
  return entries
}

async function entryKind(path) {
  try {
    const info = await lstat(path)
    return info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
    throw error
  }
}

function stamp(date) {
  const two = number => String(number).padStart(2, '0')
  return `y${date.getFullYear()}m${two(date.getMonth() + 1)}d${two(date.getDate())}h${two(date.getHours())}m${two(date.getMinutes())}s${two(date.getSeconds())}`
}

const safe = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '_')

/**
 * `y2026m09d28h21m03s04.h<host>.f<harness commit>.s12.<title>.workspace.deepsea.zip`
 * (or `.session.deepsea.zip`): local time, this machine's short host name, the
 * harness commit, the number of sessions (subagent sessions included) and the
 * title, reduced to `[A-Za-z0-9_-]`.
 */
export function exportName({ kind, date, host, commit, sessions, title }) {
  const slug = String(title).replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || kind
  return `${stamp(date)}.h${safe(host)}.f${safe(commit)}.s${sessions}.${slug}.${kind}.deepsea.zip`
}

/** This machine's short host name (`name.local` → `name`). */
export function shortHost(name = hostname()) {
  return String(name).replace(/\.local$/i, '').split('.')[0] || 'unknown'
}

/** The harness commit this plugin runs against (the repository's `harness` link: a build's git worktree). */
async function harnessCommit() {
  try { return (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: fileURLToPath(new URL('../../harness/', import.meta.url)) })).trim() }
  catch { return 'unknown' }
}

/** Session directory names: the JSONL backend's segment encoding of a session id. */
export function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    out += char !== '~' && /^[A-Za-z0-9._-]$/.test(char) ? char : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** The sha256 hex digests of every attachment reference (`{ attachment: { attachmentId } }`) in `value`, added to `into`. */
export function collectAttachmentDigests(value, into = new Set()) {
  if (Array.isArray(value)) { for (const item of value) collectAttachmentDigests(item, into); return into }
  if (value === null || typeof value !== 'object') return into
  const match = SHA256_ID.exec(String(value.attachment?.attachmentId ?? ''))
  if (match !== null) into.add(match[1])
  for (const item of Object.values(value)) collectAttachmentDigests(item, into)
  return into
}

/**
 * The given sessions and every subagent descendant, parents first.
 * @param {readonly { header: { id: string, parentSession?: string } }[]} snapshots - the persistence's `list()`
 * @param {readonly string[]} roots
 */
export function withDescendants(snapshots, roots) {
  const children = new Map()
  for (const snapshot of snapshots) {
    const parent = snapshot.header.parentSession
    if (parent === undefined) continue
    children.set(String(parent), [...(children.get(String(parent)) ?? []), String(snapshot.header.id)])
  }
  const ids = []
  const pending = roots.map(String)
  while (pending.length > 0) {
    const id = pending.shift()
    if (ids.includes(id)) continue
    ids.push(id)
    pending.push(...(children.get(id) ?? []))
  }
  return ids
}

/**
 * Write an export to `directory`.
 * @param {{ kind: 'workspace' | 'session', home: string, directory: string, title: string, roots: readonly string[], describe: object, persistence: { flush?(): Promise<void>, list(options?: object): Promise<readonly { header: { id: string, parentSession?: string } }[]>, open(id: string, access: 'read', options?: object): Promise<{ read(offset: number, length: number, options?: object): Promise<{ events: unknown[] }>, close(): Promise<void> }> }, commit?: string, date?: Date, signal?: AbortSignal }} options
 *   `roots`: the sessions to export (their subagent descendants are added);
 *   `describe`: the manifest's `workspace` / `session` fields.
 * @returns the export: name, path, bytes, counts (`sessions`, `attachments`) and `missingAttachments` (referenced, absent from this home's store)
 */
export async function makeExport({ kind, home, directory, title, roots, describe, persistence, commit, date = new Date(), signal }) {
  if (roots.length === 0) throw new Error(`${title} has no sessions`)
  await persistence.flush?.()
  const ids = withDescendants(await persistence.list({ signal }), roots)
  // Session directories by name, across every project directory.
  const located = new Map()
  for (const project of await readdir(join(home, 'sessions'), { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const entry of await readdir(join(home, 'sessions', project.name), { withFileTypes: true })) {
      if (entry.isDirectory()) located.set(entry.name, [...(located.get(entry.name) ?? []), `sessions/${project.name}/${entry.name}`])
    }
  }
  const files = []
  const digests = new Set()
  for (const id of ids) {
    signal?.throwIfAborted()
    const places = located.get(encodeSegment(id)) ?? []
    if (places.length !== 1) throw new Error(places.length === 0 ? `session ${id} has no directory under sessions/` : `session ${id} is stored in more than one place: ${places.join(', ')}`)
    for (const file of await walk(join(home, places[0]), `${places[0]}/`)) if (!SESSION_LOCK.test(file.name)) files.push(file)
    const handle = await persistence.open(id, 'read', { signal })
    try { collectAttachmentDigests((await handle.read(0, Number.MAX_SAFE_INTEGER, { signal })).events, digests) }
    finally { await handle.close() }
  }
  let attachments = 0
  let missingAttachments = 0
  for (const sha of digests) {
    const found = []
    for (const store of ['objects', 'file-objects']) {
      const name = `${ATTACHMENTS}/${store}/${sha.slice(0, 2)}/${sha}`
      if (await entryKind(join(home, name)) === 'file') found.push({ name, size: (await stat(join(home, name))).size })
    }
    const named = `${ATTACHMENTS}/files/${sha.slice(0, 2)}/${sha}`
    if (await entryKind(join(home, named)) === 'directory') found.push(...await walk(join(home, named), `${named}/`))
    if (found.length === 0) missingAttachments++
    else attachments++
    files.push(...found)
  }
  const counts = { sessions: ids.length, attachments }
  const name = exportName({ kind, date, host: shortHost(), commit: commit ?? await harnessCommit(), sessions: ids.length, title })
  const written = await writeZip({ home, directory, name, files, manifest: { format: FORMATS[kind], createdAt: date.toISOString(), [kind]: describe, counts, missingAttachments }, signal })
  return { ...written, counts, missingAttachments }
}

/**
 * Stage `files` (relative to the home) under `home/`, add the manifest with the
 * staged list, zip, test the ZIP against the list and rename it into place as
 * `name` (owner-only: sessions are private).
 */
async function writeZip({ home, directory, name, files, manifest, signal }) {
  await mkdir(directory, { recursive: true })
  const target = join(directory, name)
  const temp = join(directory, `.${randomUUID()}.partial.zip`)
  const stage = await mkdtemp(join(directory, '.deepsea-export-'))
  try {
    await mkdir(join(stage, HOME_DIR), { mode: 0o700 })
    const archived = []
    for (const file of files) {
      signal?.throwIfAborted()
      const destination = join(stage, ROOT, file.name)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const source = join(home, file.name)
      if (file.link !== undefined) {
        await symlink(file.link, destination)
        archived.push({ name: file.name, link: file.link })
        continue
      }
      for (let attempt = 1, expected = file.size; ; attempt++) {
        await pipeline(createReadStream(source), createWriteStream(destination, { mode: 0o600 }), { signal })
        const copied = (await stat(destination)).size
        if (copied === expected) break
        const now = (await stat(source)).size
        if (attempt === COPY_ATTEMPTS || now < expected) throw new Error(`${file.name} changed while it was copied`)
        expected = now
      }
      archived.push({ name: file.name, size: (await stat(destination)).size })
    }
    await writeFile(join(stage, MANIFEST), JSON.stringify({ ...manifest, files: archived }) + '\n', { mode: 0o600 })
    await run('zip', ['-q', '-r', '-y', temp, MANIFEST, HOME_DIR], { cwd: stage, signal })
    await run('unzip', ['-tq', temp], { maxBuffer: 1024 * 1024 })
    const entries = (await run('unzip', ['-Z', '-1', temp], { maxBuffer: MAX_LISTING })).trim().split('\n')
    if (!entries.includes(MANIFEST) || archived.some(file => !entries.includes(ROOT + file.name))) throw new Error('the ZIP did not contain every staged file')
    const handle = await open(target, 'wx', 0o600)
    await handle.close()
    try { await rename(temp, target) } catch (error) { await rm(target, { force: true }); throw error }
    await chmod(target, 0o600)
    return { name, path: target, bytes: (await stat(target)).size }
  } finally {
    await rm(temp, { force: true })
    await rm(stage, { recursive: true, force: true })
  }
}
