/**
 * `/import-dsh`: sessions from another home (the `$DSH_HOME` of another
 * variant or machine), one of its sessions workspaces or session directories,
 * or a @deepsea/backup-restore archive (`.backup.deepsea.zip` /
 * `.rollback.deepsea.zip`, or the earlier `.backup.dsh.zip` layout), whose
 * `sessions/` is extracted to `$TMPDIR/deepsea-import-sessions-…`.
 * The logs are read with the harness's own JSONL persistence, grouped into
 * root sessions with their subagent descendants, and stored through the
 * Session Controller's `storeSessionLogs` (harness topic session-relocation),
 * keeping their ids. Every attachment the logs reference (images, verbatim
 * files) is copied first from the source's `attachments/v1/` store into this
 * home's, through the attachment service: ids are content hashes and stored
 * images are already normalized, so saving the bytes reproduces the id.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { storeSessionLogs } from '@deepseek-ai/dsh-session-log-export'
import { resolveDestination } from './importer.mjs'

const execFileAsync = promisify(execFile)
/** Backup archive layouts: @deepsea/backup-restore's, then the earlier DSH one. */
const ARCHIVES = [
  { name: /\.(?:backup|rollback)\.deepsea\.zip$/i, root: 'home/', manifest: 'deepsea-backup.json', format: 'deepsea-home-v1' },
  { name: /\.(?:backup|rollback)\.dsh\.zip$/i, root: 'dsh/', manifest: 'dsh-backup.json', format: 'dsh-home-v1' },
]
const PROJECT_RE = /^(?:--.*--|_no-cwd)$/
const SESSION_RE = /^session-/
const LOG_RE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
const MAX_LISTING_BYTES = 64 * 1024 * 1024
/** A home's attachment store, relative to the home (attachment-local's layout). */
const ATTACHMENTS = 'attachments/v1'
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024
const SHA256_ID = /^sha256:([0-9a-f]{64})$/

function encodeSegment(raw) {
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

function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index++) {
    const code = cwd.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else {
      separatorRun = false
      readable += char !== '~' && /^[A-Za-z0-9._-]$/.test(char) ? char : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  readable = readable.replace(/^-+/, '').replace(/-+$/, '')
  return readable === '' ? '_' : `--${readable.slice(0, 251)}--`
}

async function canonical(path) {
  const absolute = resolve(path)
  try { return await realpath(absolute) } catch { return absolute }
}

export async function samePath(left, right) {
  return await canonical(left) === await canonical(right)
}

async function hasSessionLog(path) {
  try { return (await readdir(path)).some(name => LOG_RE.test(name)) } catch { return false }
}

async function hasSessionDirectory(path) {
  let entries
  try { entries = await readdir(path, { withFileTypes: true }) } catch { return false }
  for (const entry of entries) if (entry.isDirectory() && SESSION_RE.test(entry.name) && await hasSessionLog(join(path, entry.name))) return true
  return false
}

async function hasProjectDirectory(path) {
  let entries
  try { entries = await readdir(path, { withFileTypes: true }) } catch { return false }
  for (const entry of entries) if (entry.isDirectory() && PROJECT_RE.test(entry.name) && await hasSessionDirectory(join(path, entry.name))) return true
  return false
}

function safeArchiveEntry(entry) {
  return entry !== '' && !entry.includes('\\') && !entry.includes('\0') && !entry.startsWith('/') && !entry.split('/').some(part => part === '.' || part === '..')
}

/** unzip treats these as wildcards in member names; a backslash makes them literal. */
const literalMember = name => name.replace(/[[\]*?\\]/g, '\\$&')

async function extractBackup(path, layout) {
  const temporary = await mkdtemp(join(tmpdir(), 'deepsea-import-sessions-'))
  try {
    const { stdout } = await execFileAsync('unzip', ['-Z', '-1', path], { maxBuffer: MAX_LISTING_BYTES })
    const listing = String(stdout).split('\n').filter(Boolean)
    if (!listing.includes(layout.manifest) || !listing.some(entry => entry.startsWith(`${layout.root}sessions/`) && LOG_RE.test(basename(entry)))) throw new Error(`${path} is not a home backup containing sessions`)
    if (listing.some(entry => !safeArchiveEntry(entry) || (!entry.startsWith(layout.root) && entry !== layout.manifest))) throw new Error(`${path} contains an unsafe archive entry`)
    const manifest = JSON.parse(await execFileAsync('unzip', ['-p', path, layout.manifest], { maxBuffer: MAX_LISTING_BYTES }).then(result => result.stdout))
    if (manifest?.format !== layout.format || !Array.isArray(manifest.files)) throw new Error(`${path} has an invalid backup manifest`)
    await execFileAsync('unzip', ['-q', path, `${layout.root}sessions/*`, '-d', temporary], { maxBuffer: 4 * 1024 * 1024 })
    const members = new Set(listing)
    // Attachments stay in the archive; each one a log references is read from it when imported.
    const readAttachment = async relative => {
      const member = `${layout.root}${ATTACHMENTS}/${relative}`
      if (!members.has(member)) return undefined
      const { stdout: data } = await execFileAsync('unzip', ['-p', path, literalMember(member)], { encoding: 'buffer', maxBuffer: MAX_ATTACHMENT_BYTES })
      return data
    }
    return { root: join(temporary, layout.root.slice(0, -1)), cleanup: async () => { await rm(temporary, { recursive: true, force: true }) }, archive: true, readAttachment }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

/** Read `<home>/attachments/v1/<relative>`, or undefined when it is not there. */
function homeAttachments(home) {
  return async relative => {
    try { return await readFile(join(home, ATTACHMENTS, relative)) } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
      throw error
    }
  }
}

/** Resolve a home, sessions root, workspace dir, session dir, or backup ZIP. */
export async function prepareDshSelection(selected, activeHome) {
  const path = resolve(selected)
  const info = await stat(path)
  if (info.isFile()) {
    const layout = ARCHIVES.find(item => item.name.test(basename(path)))
    if (layout === undefined) throw new Error(`${path} is not a .backup.deepsea.zip or .rollback.deepsea.zip file`)
    const extracted = await extractBackup(path, layout)
    return { ...extracted, path, sessionsRoot: join(extracted.root, 'sessions'), kind: 'root' }
  }
  if (!info.isDirectory()) throw new Error(`${path} is neither a home directory nor a backup ZIP`)
  if (await samePath(path, activeHome)) throw new Error('Choose another home: this is the home the server runs on')
  // The home is the directory holding `sessions/`; its attachments sit beside them.
  if (await hasSessionLog(path)) {
    const project = dirname(path)
    return { root: dirname(project), sessionsRoot: dirname(project), project, session: path, path, kind: 'session', archive: false, cleanup: async () => {}, readAttachment: homeAttachments(dirname(dirname(project))) }
  }
  if (await hasSessionDirectory(path) && PROJECT_RE.test(basename(path))) {
    return { root: dirname(dirname(path)), sessionsRoot: dirname(path), project: path, path, kind: 'workspace', archive: false, cleanup: async () => {}, readAttachment: homeAttachments(dirname(dirname(path))) }
  }
  const sessionsRoot = basename(path) === 'sessions' ? path : join(path, 'sessions')
  if (await hasProjectDirectory(sessionsRoot)) {
    return { root: basename(path) === 'sessions' ? dirname(path) : path, sessionsRoot, path, kind: 'root', archive: false, cleanup: async () => {}, readAttachment: homeAttachments(dirname(sessionsRoot)) }
  }
  throw new Error(`${path} is not a home, a sessions workspace, or a session directory`)
}

function groupRoots(inspections) {
  const byId = new Map(inspections.map(log => [String(log.header.id), log]))
  const children = new Map()
  for (const log of inspections) {
    const parent = log.header.parentSession === undefined ? undefined : String(log.header.parentSession)
    if (parent === undefined || !byId.has(parent)) continue
    const rows = children.get(parent) ?? []
    rows.push(log)
    children.set(parent, rows)
  }
  const roots = inspections.filter(log => log.header.parentSession === undefined || !byId.has(String(log.header.parentSession)))
  const descendants = root => {
    const result = []
    const pending = [...(children.get(String(root.header.id)) ?? [])]
    while (pending.length > 0) {
      const child = pending.shift()
      result.push(child)
      pending.push(...(children.get(String(child.header.id)) ?? []))
    }
    return result
  }
  return roots.map(root => ({ root, children: descendants(root) }))
}

async function readWithPersistence(sessionsRoot, selection, signal) {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
  try {
    const snapshots = await ctx.sessionPersistence.list({ signal })
      const selectedSessionName = selection.kind === 'session' ? basename(selection.session) : undefined
    const chosen = selection.kind === 'session'
      ? snapshots.filter(snapshot => selectedSessionName === encodeSegment(String(snapshot.header.id)))
      : selection.kind === 'workspace'
        ? snapshots.filter(snapshot => join(selection.sessionsRoot, snapshot.header.cwd === undefined ? '_no-cwd' : projectKey(snapshot.header.cwd)) === selection.project)
        : snapshots
    const logs = []
    for (const snapshot of chosen) {
      signal?.throwIfAborted()
      const handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read', { signal })
      try {
        const read = await handle.read(0, Number.MAX_SAFE_INTEGER, { signal })
        logs.push({ header: handle.header, events: read.events, inheritedEventCount: handle.inheritedEventCount })
      } finally { await handle.close() }
    }
    return groupRoots(logs)
  } finally { await ctx.fiber.dispose() }
}

function titleOf(events, fallback) {
  for (let index = events.length - 1; index >= 0; index--) if (events[index]?.type === 'session/title' && typeof events[index]?.data?.title === 'string') return events[index].data.title
  return fallback
}

export async function scanDshSelection(selected, activeHome, options = {}) {
  const selection = await prepareDshSelection(selected, activeHome)
  try {
    const families = await readWithPersistence(selection.sessionsRoot, selection, options.signal)
    const workspaces = new Map()
    for (const family of families) {
      const cwd = family.root.header.cwd ?? '(ungrouped)'
      const group = workspaces.get(cwd) ?? { key: cwd, dir: cwd, dirExists: false, sessions: [] }
      if (cwd !== '(ungrouped)') { try { group.dirExists = (await stat(cwd)).isDirectory() } catch { group.dirExists = false } }
      const imported = await options.probe?.(String(family.root.header.id)).catch(() => false) ?? false
      group.sessions.push({
        id: String(family.root.header.id), sourceId: String(family.root.header.id), file: String(family.root.header.id),
        title: titleOf(family.root.events, `Session ${String(family.root.header.id).slice(-8)}`),
        startedAt: family.root.header.createdAt, endedAt: family.root.events.at(-1)?.time ?? family.root.header.createdAt,
        bytes: 0, turns: family.root.events.filter(event => event.type === 'turn/start').length,
        toolCalls: family.root.events.filter(event => event.type === 'tool/call').length,
        estimatedTokens: 0, large: false, imported, ...(family.children.length > 0 ? { subagents: family.children.length } : {}),
      })
      workspaces.set(cwd, group)
    }
    return { source: 'dsh', path: selection.path, kind: selection.kind, uploaded: false, largeTokens: Number.MAX_SAFE_INTEGER, workspaces: [...workspaces.values()], families, selection }
  } catch (error) {
    await selection.cleanup()
    throw error
  }
}

/** Every attachment reference in a family's logs (root and descendants), once per id. */
export function attachmentRefs(family) {
  const refs = new Map()
  const visit = value => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (value === null || typeof value !== 'object') return
    const ref = value.attachment
    if (ref !== null && typeof ref === 'object' && SHA256_ID.test(String(ref.attachmentId)) && !refs.has(ref.attachmentId)) refs.set(ref.attachmentId, ref)
    for (const item of Object.values(value)) visit(item)
  }
  for (const log of [family.root, ...family.children]) visit(log.events)
  return [...refs.values()]
}

const isImageRef = ref => typeof ref.mediaType === 'string' && ref.mediaType.startsWith('image/') && Number.isFinite(ref.width) && Number.isFinite(ref.height)

async function exists(path) {
  if (path === undefined) return false
  try { await stat(path); return true } catch { return false }
}

/**
 * Copy the attachments a family references from the source store into this
 * home's, before its logs are stored. Images come from `objects/<2>/<sha>`
 * and go through `saveImage` (their bytes are already normalized, so the id
 * is reproduced; a different id is counted as mismatched), verbatim files
 * from `files/<2>/<sha>/<name>` through `saveFile`. Bytes whose digest is
 * not their id are not saved. Attachments this home has are left alone.
 * @returns counts: `images` and `files` referenced; of them `copied`, `present` (here already), `missing` (not in the source, or corrupt there), `mismatched`.
 */
export async function copyAttachments(family, selection, attachments, { signal, warn } = {}) {
  const counts = { images: 0, files: 0, copied: 0, present: 0, missing: 0, mismatched: 0 }
  for (const ref of attachmentRefs(family)) {
    signal?.throwIfAborted()
    const id = String(ref.attachmentId)
    const sha = SHA256_ID.exec(id)[1]
    const image = isImageRef(ref)
    const name = typeof ref.name === 'string' ? basename(ref.name) : ''
    if (image) counts.images++
    else counts.files++
    if (!image && (name === '' || name === '.' || name === '..')) { counts.missing++; continue }
    let here
    try { here = image ? attachments.imageHostPath?.(ref) : attachments.fileHostPath?.(ref) } catch { here = undefined }
    if (await exists(here)) { counts.present++; continue }
    const data = selection.readAttachment === undefined ? undefined
      : await selection.readAttachment(image ? `objects/${sha.slice(0, 2)}/${sha}` : `files/${sha.slice(0, 2)}/${sha}/${name}`)
    if (data === undefined || createHash('sha256').update(data).digest('hex') !== sha) {
      counts.missing++
      warn?.(`${id} (${name || ref.mediaType || 'attachment'}) is ${data === undefined ? 'not in the source' : 'corrupt in the source'}; not copied`)
      continue
    }
    const saved = image
      ? await attachments.saveImage({ data: new Uint8Array(data), mediaType: ref.mediaType })
      : await attachments.saveFile({ data: new Uint8Array(data), name })
    if (String(saved.attachmentId) === id) counts.copied++
    else {
      counts.mismatched++
      warn?.(`${id} was stored as ${String(saved.attachmentId)}; references to it will not resolve`)
    }
  }
  return counts
}

export async function importDshFamily(ctx, scan, sessionId, destination, signal) {
  const family = scan.families.find(item => String(item.root.header.id) === sessionId)
  if (family === undefined) throw new Error(`session ${sessionId} is no longer available in this import`)
  // The same destinations as a transcript import (a new workspace's directory is made when missing).
  const { workspace } = await resolveDestination({ workspaces: ctx.workspaceRegistry }, destination, undefined)
  if (workspace === undefined) throw new Error('sessions from a home must be imported into a workspace')
  // Attachments first: the logs reference them, and an image a session's context still holds
  // must be readable before its next model request.
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('importing sessions from a home needs the attachments service')
  const copied = await copyAttachments(family, scan.selection, attachments, { signal, warn: message => ctx.logger?.warn(`import-dsh ${sessionId}: ${message}`) })
  const result = await storeSessionLogs(ctx, family, { workspace, origin: scan.selection.archive ? basename(scan.selection.path) : scan.selection.path, mode: 'move', keepIds: true, notify: false, crossHost: false, signal })
  return { result, workspace, family, title: titleOf(family.root.events, `Session ${sessionId.slice(-8)}`), attachments: copied }
}
