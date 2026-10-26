/**
 * source.mjs — where sessions come from. Every tool reads through one
 * `SessionSource`; the resolver (resolve.mjs) never knows which kind it holds.
 *
 *   {
 *     key: 'local' | '<remote spec>',      // used in cache keys and output labels
 *     remote: null | '<remote spec>',      // null for the local instance
 *     concurrency: number,                 // parallel reads a corpus tool may issue
 *     list(signal)     → [{ id, header, cwd, createdAt, live, running, title, parent, depth }]   (titles resolved, cheap first;
 *                          live = an agent is attached, running = its turn is in progress right now)
 *     read(id, signal) → { session: header, events: [...] }                             (= ctx.sessionQuery.readSession)
 *   }
 *
 * The local source is DSH's own `ctx.sessionQuery`; the remote source is the
 * same two calls answered by serve.mjs on another instance (remote.mjs
 * carries them). serve.mjs itself serializes the LOCAL source, so both
 * machines run one code path and the wire format is `list()`'s own shape.
 */

/**
 * @param {any} ctx - plugin Context with `sessionQuery` (+ optional `sessions`, `sessionProjections`, `sessionProjectionCache`)
 * @param {{ trace?: (line: object) => void }} [options]
 */
export function createLocalSource(ctx, options = {}) {
  const trace = options.trace ?? (() => {})

  /** Cheap title: live projection → persisted projection cache → predecessor checkpoint. */
  function cheapTitle(record) {
    const id = record.header.id
    try {
      const sessions = ctx.get('sessions')
      const projections = ctx.get('sessionProjections')
      const attached = sessions?.get(id)
      if (attached !== undefined && projections !== undefined) {
        const t = projections.snapshot(attached, ['title'])?.values?.title
        if (t) return t.title ?? (typeof t === 'string' ? t : undefined)
      }
      const cache = ctx.get('sessionProjectionCache')
      if (cache !== undefined && record.header.isSeeded !== true) {
        const snap = cache.cachedSnapshot(record.header, 0, ['title']) ?? cache.cachedPredecessorTitle?.(record.header, 0)
        const t = snap?.values?.title
        if (t) return t.title ?? (typeof t === 'string' ? t : undefined)
      }
    } catch (error) {
      trace({ event: 'cheap-title-failed', id, error: String(error) })
    }
    return undefined
  }

  return {
    key: 'local',
    remote: null,
    concurrency: 1,
    /**
     * Every session with its title; `titleFor(id)` lets the caller skip the
     * fold for ids whose title it already caches.
     * @param {AbortSignal} [signal]
     * @param {{ known?: (id: string) => string | null | undefined }} [opts]
     */
    async list(signal, opts = {}) {
      const records = await ctx.sessionQuery.listSessions(signal)
      const agents = ctx.get('agents') // the same fact DSH's own session list reports as `running`
      const entries = records.map(record => ({
        id: record.header.id,
        header: record.header,
        cwd: record.header.cwd,
        createdAt: record.header.createdAt,
        live: record.live === true,
        running: record.live === true && agents?.get(record.header.id)?.status === 'running',
        title: undefined,
        parent: record.header.parentSession ?? null,
        depth: record.header.delegationDepth ?? 0,
      }))
      const missing = []
      for (const [i, entry] of entries.entries()) {
        const known = opts.known?.(entry.id)
        if (known !== undefined) { entry.title = known; continue }
        const cheap = cheapTitle(records[i])
        if (cheap !== undefined) { entry.title = cheap; continue }
        missing.push(entry)
      }
      if (missing.length > 0) {
        trace({ event: 'title-fold', count: missing.length })
        const results = await ctx.sessionQuery.readTitleSnapshots(missing.map(e => e.id), signal)
        const byId = new Map(missing.map(e => [e.id, e]))
        for (const result of results) {
          const entry = byId.get(result.sessionId)
          if (entry) entry.title = result.status === 'fulfilled' ? (result.value.title?.title ?? null) : null
        }
        for (const entry of missing) if (entry.title === undefined) entry.title = null
      }
      return entries
    },
    read(id, signal) {
      signal?.throwIfAborted()
      return ctx.sessionQuery.readSession(id)
    },
    /** Whether an agent is attached to the session right now (falls back to the listing without a `sessions` service). */
    async isLive(id, signal) {
      const sessions = ctx.get('sessions')
      if (sessions !== undefined) return sessions.get(id) !== undefined
      const records = await ctx.sessionQuery.listSessions(signal)
      return records.some(r => r.header.id === id && r.live === true)
    },
  }
}

/**
 * @param {ReturnType<import('./remote.mjs').createRemoteClient>} client
 * @param {{ concurrency?: number }} [options]
 */
export function createRemoteSource(client, options = {}) {
  return {
    key: client.key,
    remote: client.key,
    concurrency: options.concurrency ?? 4,
    async list(signal) {
      const value = await client.sessions(signal)
      const sessions = Array.isArray(value?.sessions) ? value.sessions : []
      return sessions.map(s => ({
        id: s.id,
        header: s.header ?? { id: s.id },
        cwd: s.cwd ?? s.header?.cwd,
        createdAt: s.createdAt ?? s.header?.createdAt,
        live: s.live === true,
        running: s.running === true,
        title: s.title ?? null,
        parent: s.parent ?? null,
        depth: s.depth ?? 0,
      }))
    },
    async read(id, signal) {
      const value = await client.session(id, signal)
      if (!value || typeof value !== 'object' || !Array.isArray(value.events)) throw new Error(`remote ${client.key} returned no event log for "${id}"`)
      return { session: value.session ?? { id }, events: value.events }
    },
  }
}
