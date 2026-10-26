/**
 * The side threads: one per session, a list of exchanges (question, where
 * the main conversation was when it was asked, the answer and the tool calls
 * that produced it), kept in memory while answers stream and saved as one
 * JSON file per session under `<home>/plugins/ask/sessions/`. Nothing here
 * reaches the main conversation.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const VERSION = 1

/** Session ids become file names: anything outside [A-Za-z0-9_-] is refused. */
function fileName(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`invalid session id ${JSON.stringify(sessionId)}`)
  return `${sessionId}.json`
}

export class ThreadStore {
  /**
   * @param {string} directory - where the session files live.
   * @param {{ warn?: (message: string) => void }} [options]
   */
  constructor(directory, options = {}) {
    this.directory = directory
    this.warn = options.warn ?? (() => {})
    /** @type {Map<string, { exchanges: any[], version: number }>} */
    this.threads = new Map()
  }

  /** The thread of a session, loaded from disk on first use. */
  get(sessionId) {
    let thread = this.threads.get(sessionId)
    if (thread !== undefined) return thread
    const path = join(this.directory, fileName(sessionId))
    thread = { exchanges: [], version: 0 }
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      if (saved.v === VERSION && Array.isArray(saved.exchanges)) {
        // An answer that was streaming when the server stopped did not finish.
        thread.exchanges = saved.exchanges.map(exchange => exchange.status === 'answering'
          ? { ...exchange, status: 'error', error: 'The server stopped before the answer finished.' }
          : exchange)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`ask: cannot read the side thread of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.threads.set(sessionId, thread)
    return thread
  }

  /** Add a new exchange (status `answering`) and save. */
  add(sessionId, fields) {
    const thread = this.get(sessionId)
    const exchange = { id: randomUUID(), status: 'answering', answer: '', tools: [], ...fields }
    thread.exchanges.push(exchange)
    this.touch(sessionId, true)
    return exchange
  }

  /** Apply a change to one exchange; `persist` writes the file too. */
  update(sessionId, id, change, persist = false) {
    const thread = this.get(sessionId)
    const index = thread.exchanges.findIndex(exchange => exchange.id === id)
    if (index === -1) return undefined
    thread.exchanges[index] = { ...thread.exchanges[index], ...change }
    this.touch(sessionId, persist)
    return thread.exchanges[index]
  }

  /** Remove every exchange that is not still answering. */
  clear(sessionId) {
    const thread = this.get(sessionId)
    thread.exchanges = thread.exchanges.filter(exchange => exchange.status === 'answering')
    this.touch(sessionId, true)
  }

  /** The browser's view: every exchange and the thread's version (bumped on each change). */
  snapshot(sessionId) {
    const thread = this.get(sessionId)
    return { version: thread.version, exchanges: thread.exchanges }
  }

  touch(sessionId, persist) {
    const thread = this.get(sessionId)
    thread.version += 1
    if (!persist) return
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const path = join(this.directory, fileName(sessionId))
      if (thread.exchanges.length === 0) { rmSync(path, { force: true }); return }
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ v: VERSION, exchanges: thread.exchanges }, null, 1)}\n`, { mode: 0o600 })
      renameSync(temporary, path)
    } catch (error) {
      this.warn(`ask: cannot save the side thread of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
