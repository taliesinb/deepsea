/**
 * Pool of isolated Safari page readers for safari_get_page_content (with a
 * url) and safari_get_youtube_notes.
 *
 * A reader is one private `safaridriver --mcp` process (its own automation
 * session and STP window, labeled "DeepSea: page reader #n") driven through a
 * private MCP client: it is in no agent's tool list, and no chat's own window
 * is touched. The pool starts empty. A read takes an idle reader or starts a
 * new one, so concurrent reads (from subagents, say) each get their own
 * window. When a read finishes, the reader closes its tab and returns to the
 * pool; readers beyond `maxIdle` are disposed at once, the rest after `idleMs`
 * without a read (STP quits when the last session ends).
 *
 * The read itself (the plugin's markdown serializer, or WebKit's extraction
 * through the server's get_page_content for the other formats, and the steps
 * around it: expand collapsed content, scope to a subtree, mark headings,
 * clean up) is page-read.mjs, shared with window mode.
 */

import { extractPage, FORMATS } from './page-read.mjs'
import { connectServer } from './servers.mjs'

export { FORMATS }

/**
 * @param {object} options
 * @param {string} options.driver - safaridriver executable (STP).
 * @param {string} options.labelPrefix - window banner prefix, e.g. "DeepSea: ".
 * @param {number} options.maxIdle - readers kept warm after their read (>= 0).
 * @param {number} options.idleMs - dispose all warm readers after this long unused (0 = never).
 * @param {number} options.readTimeoutMs - per MCP call timeout.
 * @param {(record: object) => void} options.trace - lifecycle trace sink.
 * @param {{ warn(message: string): void }} options.logger
 * @param {'close_tab' | 'about:blank'} [options.park] - how a reader releases its page after a read.
 * @param {typeof connectServer} [options.connect] - test seam.
 */
export function createReaderPool(options) {
  const { driver, labelPrefix, maxIdle, idleMs, readTimeoutMs, trace, logger, park = 'close_tab', connect = connectServer } = options
  /** @type {Array<{ id: number, conn: import('./servers.mjs').ServerConnection, busy: boolean, dead: boolean }>} */
  const readers = []
  let nextId = 1
  let idleTimer
  let disposed = false
  /**
   * Cold-start gate. Two brand-new sessions navigating at the same instant can
   * both launch an STP instance, leaving an orphan no session owns. The first
   * read after the pool is empty holds this until its navigation completes
   * (STP is then running and later drivers reuse it); other reads wait for it.
   * @type {Promise<void> | undefined}
   */
  let warming

  async function spawnReader() {
    const id = nextId++
    const reader = { id, conn: undefined, busy: true, dead: false }
    reader.conn = await connect({
      command: driver,
      args: ['--mcp'],
      clientName: `${labelPrefix}page reader #${id}`,
      safari: true,
      timeoutMs: readTimeoutMs,
      onClose: () => { reader.dead = true; forget(reader) },
      onError: (error) => { logger.warn(`browser: reader #${id} transport error: ${String(error)}`) },
    })
    readers.push(reader)
    trace({ event: 'reader-spawn', reader: id, pool: readers.length })
    return reader
  }

  function forget(reader) {
    const index = readers.indexOf(reader)
    if (index >= 0) readers.splice(index, 1)
    if (readers.length === 0) warming = undefined
  }

  async function disposeReader(reader, reason) {
    forget(reader)
    reader.dead = true
    try {
      await reader.conn.close() // closes stdin → driver exits → its window closes
    } catch (error) {
      logger.warn(`browser: reader #${reader.id} close failed: ${String(error)}`)
    }
    trace({ event: 'reader-dispose', reader: reader.id, reason, pool: readers.length })
  }

  function armIdleTimer() {
    clearTimeout(idleTimer)
    if (idleMs === 0 || readers.length === 0) return
    idleTimer = setTimeout(() => {
      if (readers.some(reader => reader.busy)) { armIdleTimer(); return }
      void Promise.all(readers.slice().map(reader => disposeReader(reader, 'idle')))
    }, idleMs)
    idleTimer.unref?.()
  }

  async function acquire() {
    if (disposed) throw new Error('browser: the reader pool is disposed')
    clearTimeout(idleTimer)
    const idle = readers.find(reader => !reader.busy && !reader.dead)
    if (idle !== undefined) {
      idle.busy = true
      return idle
    }
    return spawnReader()
  }

  async function release(reader) {
    if (reader.dead) { forget(reader); armIdleTimer(); return }
    reader.busy = false
    const idleCount = readers.filter(candidate => !candidate.busy && !candidate.dead).length
    if (idleCount > maxIdle) {
      await disposeReader(reader, 'surplus')
    }
    armIdleTimer()
  }

  const call = (reader, name, args) => reader.conn.callText(name, args)

  /**
   * Read one page in an isolated reader.
   * @param {ReturnType<import('./page-read.mjs').planRead> & { url: string, waitMs: number }} request
   * @returns {Promise<{ url?: string, title?: string, format: string, content: string, notes: string[], scriptResult?: unknown }>}
   */
  async function read(request) {
    let releaseWarm
    if (readers.length === 0 && warming === undefined) {
      warming = new Promise((resolve) => { releaseWarm = resolve })
    } else if (warming !== undefined) {
      await warming
    }
    const reader = await acquire()
    try {
      try {
        await call(reader, 'navigate_to_url', { url: request.url })
      } finally {
        if (releaseWarm !== undefined) releaseWarm()
      }
      if (request.waitMs > 0) await new Promise(resolve => setTimeout(resolve, request.waitMs))
      const result = await extractPage((name, args) => call(reader, name, args), request, true)
      if (result.url === undefined) result.url = request.url
      trace({ event: 'read', reader: reader.id, url: request.url, format: request.format, chars: result.content.length, script: request.script !== undefined, expand: request.expand, scope: result.scope?.scope })
      return result
    } finally {
      // Release the page. Default: close the tab (its window goes with it; the
      // driver session and STP stay warm, the next read opens a fresh tab).
      // Parking on about:blank keeps the window but was observed to leave an
      // orphaned STP instance with a lone about:blank window when a session
      // ended right after the navigation.
      if (!reader.dead) {
        try {
          if (park === 'about:blank') {
            await call(reader, 'navigate_to_url', { url: 'about:blank' })
          } else {
            const tabs = JSON.parse(await call(reader, 'list_tabs', {}))
            for (const tab of tabs) await call(reader, 'close_tab', { handle: tab.handle })
          }
        } catch {
          // The reader may have died mid-read; release() drops it.
        }
      }
      await release(reader)
    }
  }

  async function dispose() {
    disposed = true
    clearTimeout(idleTimer)
    await Promise.all(readers.slice().map(reader => disposeReader(reader, 'pool-dispose')))
  }

  return {
    read,
    dispose,
    /** Snapshot for diagnostics. */
    stats: () => ({ readers: readers.length, busy: readers.filter(reader => reader.busy).length }),
  }
}
