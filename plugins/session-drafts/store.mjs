/**
 * The drafts of each session: one directory per session under
 * `<home>/plugins/session-drafts/sessions/<session id>/`, holding
 * `drafts.json` (every draft's document, attachments and metadata) and
 * `blobs/<sha256>` (attachment bytes, shared by the session's drafts and
 * removed once no draft lists them). Nothing here reaches the model.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = 1

/** The plugin's directory under `<home>/plugins/`. */
export const STATE_NAME = 'session-drafts'

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const BLOB_ID = /^[0-9a-f]{64}$/

/** @param {string} sessionId @returns {boolean} */
export function validSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID.test(sessionId)
}

/** @param {string} blob @returns {boolean} */
export function validBlobId(blob) {
  return typeof blob === 'string' && BLOB_ID.test(blob)
}

/**
 * @typedef {{ blob: string, name: string, type: string, size: number }} DraftAttachment
 * @typedef {{ turn: number, running: boolean }} DraftPosition
 * @typedef {{
 *   id: string, revision: number, createdAt: string, updatedAt: string,
 *   position: DraftPosition | null, document: object, attachments: DraftAttachment[],
 * }} Draft
 */

export class DraftStore {
  /**
   * @param {string} directory - `<home>/plugins/session-drafts/sessions`.
   * @param {{ warn?: (message: string) => void, now?: () => Date }} [options]
   */
  constructor(directory, options = {}) {
    this.directory = directory
    this.warn = options.warn ?? (() => {})
    this.now = options.now ?? (() => new Date())
    /** @type {Map<string, { version: number, drafts: Draft[] }>} */
    this.sessions = new Map()
  }

  /** @param {string} sessionId @returns {string} */
  sessionDirectory(sessionId) {
    if (!validSessionId(sessionId)) throw new Error(`invalid session id ${JSON.stringify(sessionId)}`)
    return join(this.directory, sessionId)
  }

  /** A session's drafts, loaded from disk on first use. */
  get(sessionId) {
    let entry = this.sessions.get(sessionId)
    if (entry !== undefined) return entry
    entry = { version: 0, drafts: [] }
    const path = join(this.sessionDirectory(sessionId), 'drafts.json')
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      if (saved.v === VERSION && Array.isArray(saved.drafts)) entry.drafts = saved.drafts
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`session-drafts: cannot read the drafts of ${sessionId}: ${messageOf(error)}`)
    }
    this.sessions.set(sessionId, entry)
    return entry
  }

  /** The browser's view: every draft, newest first, and a version bumped on each change. */
  snapshot(sessionId) {
    const entry = this.get(sessionId)
    return { version: entry.version, drafts: [...entry.drafts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  }

  /**
   * @param {string} sessionId
   * @param {{ document: object, attachments: DraftAttachment[], position: DraftPosition | null }} fields
   * @returns {Draft}
   */
  create(sessionId, fields) {
    const entry = this.get(sessionId)
    const at = this.now().toISOString()
    const draft = {
      id: randomUUID(), revision: 1, createdAt: at, updatedAt: at,
      position: fields.position, document: fields.document, attachments: fields.attachments,
    }
    entry.drafts.push(draft)
    this.save(sessionId)
    return draft
  }

  /**
   * Replace a draft's document and attachments; the last writer wins.
   * @returns {Draft | undefined} the updated draft, or undefined for an unknown id.
   */
  update(sessionId, id, fields) {
    const entry = this.get(sessionId)
    const index = entry.drafts.findIndex(draft => draft.id === id)
    if (index === -1) return undefined
    const previous = entry.drafts[index]
    const draft = {
      ...previous, revision: previous.revision + 1, updatedAt: this.now().toISOString(),
      document: fields.document, attachments: fields.attachments,
    }
    entry.drafts[index] = draft
    this.save(sessionId)
    return draft
  }

  /** @returns {boolean} whether the draft existed. */
  remove(sessionId, id) {
    const entry = this.get(sessionId)
    const next = entry.drafts.filter(draft => draft.id !== id)
    if (next.length === entry.drafts.length) return false
    entry.drafts = next
    this.save(sessionId)
    return true
  }

  /**
   * Store attachment bytes under their SHA-256.
   * @param {string} sessionId
   * @param {Uint8Array} bytes
   * @returns {{ blob: string, size: number }}
   */
  putBlob(sessionId, bytes) {
    const blob = createHash('sha256').update(bytes).digest('hex')
    const directory = join(this.sessionDirectory(sessionId), 'blobs')
    const path = join(directory, blob)
    if (!existsSync(path)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      writeFileSync(temporary, bytes, { mode: 0o600 })
      renameSync(temporary, path)
    }
    return { blob, size: bytes.byteLength }
  }

  /** @returns {string | undefined} the stored blob's path, or undefined when absent or malformed. */
  blobPath(sessionId, blob) {
    if (!validBlobId(blob)) return undefined
    const path = join(this.sessionDirectory(sessionId), 'blobs', blob)
    return existsSync(path) ? path : undefined
  }

  /** Write the session's drafts and remove blobs no draft lists. */
  save(sessionId) {
    const entry = this.get(sessionId)
    entry.version += 1
    const directory = this.sessionDirectory(sessionId)
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, 'drafts.json')
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ v: VERSION, drafts: entry.drafts }, null, 1)}\n`, { mode: 0o600 })
      renameSync(temporary, path)
    } catch (error) {
      this.warn(`session-drafts: cannot save the drafts of ${sessionId}: ${messageOf(error)}`)
      throw error
    }
    this.collect(sessionId)
  }

  /** Remove blobs no draft of the session lists (uploads less than an hour old are kept for a draft being created). */
  collect(sessionId) {
    const directory = join(this.sessionDirectory(sessionId), 'blobs')
    let names
    try {
      names = readdirSync(directory, { withFileTypes: true })
    } catch {
      // No blobs directory: nothing to collect.
      return
    }
    const listed = new Set(this.get(sessionId).drafts.flatMap(draft => draft.attachments.map(attachment => attachment.blob)))
    const cutoff = this.now().getTime() - 60 * 60 * 1000
    for (const name of names) {
      if (!name.isFile() || !validBlobId(name.name) || listed.has(name.name)) continue
      const path = join(directory, name.name)
      try {
        const { mtimeMs } = statSync(path)
        if (mtimeMs < cutoff) rmSync(path, { force: true })
      } catch (error) {
        this.warn(`session-drafts: cannot remove ${path}: ${messageOf(error)}`)
      }
    }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
