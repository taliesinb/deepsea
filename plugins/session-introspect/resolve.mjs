/**
 * resolve.mjs: session addressing and corpus access over a `SessionSource`
 * (source.mjs): the local instance's `ctx.sessionQuery`, or another
 * instance reached through remote.mjs when a tool is given `remote`.
 *
 * Accepted `session` spellings (one resolver for every tool):
 *   widgets/fix-login-redirect        <workspace basename>/<title>   (exact → prefix → substring, case-insensitive)
 *   fix-login                         bare title, all workspaces
 *   session-2b81 | 2b810855           id or id prefix
 *   @[label](dsh-session:…) | dsh-session:…   canonical mention (base64url id)
 *   latest:widgets                    newest session of a workspace
 *   self | (omitted)                  the calling agent's own session (local only)
 *
 * `remote` spellings: see remote.mjs (`node`, `node/deepsea-personal`, host:port, URL).
 *
 * Titles are read the cheap way first (the source does that); the snapshot
 * cache keeps one decoded log per (source, id) for a while. Nothing here
 * reads session files directly.
 */

import { buildModel, workspaceOf } from './model.mjs'
import { IntrospectError } from './output.mjs'
import { createRemoteClient, parseRemoteSpec, resolveRemote } from './remote.mjs'
import { createRemoteSource } from './source.mjs'

const TITLE_TTL_LIVE_MS = 15_000
const TITLE_TTL_COLD_MS = 10 * 60_000
const SNAPSHOT_TTL_LIVE_MS = 10_000
const SNAPSHOT_TTL_COLD_MS = 5 * 60_000
const LIST_TTL_REMOTE_MS = 5_000

/**
 * @param {object} deps
 * @param {ReturnType<import('./source.mjs').createLocalSource>} deps.local
 * @param {ReturnType<import('./remote.mjs').createTailnet>} [deps.tailnet] - MagicDNS lookup for bare machine names
 * @param {{ scope: 'all' | 'workspace', remoteTimeoutMs?: number, remoteConcurrency?: number, fetch?: typeof fetch, trace?: (line: object) => void }} options
 */
export function createResolver({ local, tailnet }, options) {
  const trace = options.trace ?? (() => {})
  const titles = new Map() // `${source.key}\0${id}` → { title, at, live }
  const snapshots = new Map() // `${source.key}\0${id}` → { model, at, live }
  const remotes = new Map() // remote key → source
  const remoteLists = new Map() // remote key → { at, entries }
  const k = (source, id) => `${source.key}\0${id}`

  /**
   * The source a tool call addresses: the local instance, or the remote named
   * by `remote` (resolved once per spelling; the client probes capabilities lazily).
   * @param {unknown} remoteSpec
   * @param {AbortSignal} [signal]
   */
  async function source(remoteSpec, signal) {
    const parsed = parseRemoteSpec(remoteSpec)
    if (parsed === null) return local
    const target = await resolveRemote(parsed, tailnet ?? { resolveHost: () => { throw new IntrospectError(`remote "${String(remoteSpec)}": bare machine names need Tailscale; this composition has no tailnet lookup.`) } })
    let src = remotes.get(target.key)
    if (!src) {
      const client = createRemoteClient(target, { timeoutMs: options.remoteTimeoutMs, fetch: options.fetch, trace })
      src = createRemoteSource(client, { concurrency: options.remoteConcurrency })
      remotes.set(target.key, src)
      trace({ event: 'remote', key: target.key, baseUrl: target.baseUrl })
    }
    signal?.throwIfAborted()
    return src
  }

  /**
   * Every visible session of a source as `{ record, id, cwd, workspace, title, createdAt, live, running, parent, depth, source, remote }`, newest first.
   * @param {any} src
   * @param {{ callerCwd?: string }} [opts]
   */
  async function listAll(src, opts = {}, signal) {
    const now = Date.now()
    let entries
    if (src.remote !== null) {
      const cached = remoteLists.get(src.key)
      if (cached && now - cached.at < LIST_TTL_REMOTE_MS) entries = cached.entries
      else { entries = await src.list(signal); remoteLists.set(src.key, { at: Date.now(), entries }) }
    } else {
      const known = (id) => {
        const cached = titles.get(k(src, id))
        return cached && now - cached.at < (cached.live ? TITLE_TTL_LIVE_MS : TITLE_TTL_COLD_MS) ? cached.title : undefined
      }
      entries = await src.list(signal, { known })
    }
    if (options.scope === 'workspace' && src.remote === null) {
      entries = entries.filter(e => e.cwd !== undefined && e.cwd === opts.callerCwd)
    }
    for (const e of entries) titles.set(k(src, e.id), { title: e.title ?? null, at: now, live: e.live })
    return entries.map(e => ({
      record: { header: e.header, live: e.live },
      id: e.id,
      cwd: e.cwd,
      workspace: workspaceOf(e.cwd),
      title: e.title ?? null,
      createdAt: e.createdAt,
      live: e.live === true,
      running: e.running === true,
      parent: e.parent ?? null,
      depth: e.depth ?? 0,
      source: src,
      remote: src.remote,
    })).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }

  function callerId(exec) { return exec?.agent?.session?.id ?? exec?.agent?.id }
  function callerCwd(exec) { return exec?.agent?.session?.header?.cwd }

  /**
   * Resolve one `session` spec to a listing entry of `src`.
   * @returns {Promise<Awaited<ReturnType<typeof listAll>>[number]>}
   */
  async function resolve(src, spec, exec, signal) {
    const raw = spec === undefined || spec === null ? '' : String(spec).trim()
    const all = await listAll(src, { callerCwd: callerCwd(exec) }, signal)
    const byId = (id) => all.find(e => e.id === id)
    const where = src.remote === null ? '' : ` on ${src.remote}`

    if (raw === '' || raw === 'self' || raw === 'me') {
      if (src.remote !== null) throw new IntrospectError(`No calling session${where}: pass session explicitly (transcript_find remote:"${src.remote}" lists them).`)
      const id = callerId(exec)
      const me = id ? byId(id) : undefined
      if (!me) throw new IntrospectError('No calling session to inspect; pass session explicitly.')
      return me
    }

    // canonical mention / URI
    const mention = /dsh-session:([A-Za-z0-9_-]+)/.exec(raw)
    if (mention) {
      let id
      try {
        const decoded = JSON.parse(Buffer.from(mention[1], 'base64url').toString('utf8'))
        if (typeof decoded !== 'string') throw new TypeError('decoded session id is not a string')
        id = decoded
      } catch (error) {
        throw new IntrospectError(`Invalid dsh-session reference: ${error instanceof Error ? error.message : String(error)}.`)
      }
      const hit = byId(id)
      if (!hit) throw new IntrospectError(`Mention refers to session "${id}", which is not visible${where}.`)
      return hit
    }

    // latest:<workspace>
    const latest = /^latest(?::(.*))?$/i.exec(raw)
    if (latest) {
      const ws = (latest[1] ?? '').trim().toLowerCase()
      const pool = ws === '' ? all : all.filter(e => e.workspace.toLowerCase() === ws)
      const me = src.remote === null ? callerId(exec) : undefined
      const pick = pool.find(e => e.id !== me) ?? pool[0]
      if (!pick) throw new IntrospectError(`No sessions in workspace "${ws}"${where}.`, { hint: `Known workspaces: ${workspaces(all).join(', ')}.` })
      return pick
    }

    // id or id prefix
    const exact = byId(raw)
    if (exact) return exact
    const idPrefix = raw.toLowerCase()
    const prefixHits = all.filter(e => e.id.toLowerCase().startsWith(idPrefix) || e.id.toLowerCase().replace(/^session-/, '').startsWith(idPrefix.replace(/^session-/, '')))
    if (prefixHits.length === 1 && /^(session-)?[0-9a-f]{4,}/i.test(raw)) return prefixHits[0]
    if (prefixHits.length > 1 && /^(session-)?[0-9a-f]{4,}/i.test(raw)) throw ambiguous(raw, prefixHits)

    // workspace/title or bare title
    let ws = null
    let titleQ = raw
    const slash = raw.indexOf('/')
    if (slash > 0) { ws = raw.slice(0, slash).trim().toLowerCase(); titleQ = raw.slice(slash + 1).trim() }
    const pool = ws === null ? all : all.filter(e => e.workspace.toLowerCase() === ws)
    if (ws !== null && pool.length === 0) throw new IntrospectError(`No workspace named "${ws}"${where}.`, { hint: `Known workspaces: ${workspaces(all).join(', ')}.` })
    const q = titleQ.toLowerCase()
    const titled = pool.filter(e => e.title)
    const tiers = [
      titled.filter(e => e.title.toLowerCase() === q),
      titled.filter(e => e.title.toLowerCase().startsWith(q)),
      titled.filter(e => e.title.toLowerCase().includes(q)),
      titled.filter(e => slugify(e.title).includes(slugify(titleQ))),
    ]
    for (const tier of tiers) {
      if (tier.length === 1) return tier[0]
      if (tier.length > 1) throw ambiguous(raw, tier)
    }
    throw new IntrospectError(`No session matched "${raw}"${where}.`, { hint: `Use transcript_find${src.remote === null ? '' : ` remote:"${src.remote}"`} to list sessions (workspaces: ${workspaces(pool.length ? pool : all).join(', ')}).` })
  }

  /**
   * Resolve a `sessions` selector for corpus-wide tools: `"*"`, `"<ws>/*"`,
   * one spec, or an array of specs. `since` / `until` filter by createdAt.
   */
  async function select(src, selector, exec, { since, until } = {}, signal) {
    const all = await listAll(src, { callerCwd: callerCwd(exec) }, signal)
    const sinceMs = parseSince(since)
    const untilMs = parseSince(until, 'until')
    if (sinceMs !== null && untilMs !== null && untilMs <= sinceMs) throw new IntrospectError(`until (${new Date(untilMs).toISOString()}) must be later than since (${new Date(sinceMs).toISOString()}).`)
    const inWindow = (e) => (sinceMs === null || (e.createdAt ?? 0) >= sinceMs) && (untilMs === null || (e.createdAt ?? 0) < untilMs)
    if (selector === undefined || selector === null || selector === '') selector = 'self'
    const specs = Array.isArray(selector) ? selector : [selector]
    const out = new Map()
    for (const spec of specs) {
      const s = String(spec).trim()
      if (s === '*' || s === 'all') { for (const e of all) if (inWindow(e)) out.set(e.id, e); continue }
      const wsGlob = /^([^/]+)\/\*$/.exec(s)
      if (wsGlob) {
        const ws = wsGlob[1].toLowerCase()
        const hits = all.filter(e => e.workspace.toLowerCase() === ws && inWindow(e))
        if (hits.length === 0 && !all.some(e => e.workspace.toLowerCase() === ws)) throw new IntrospectError(`No workspace named "${ws}"${src.remote === null ? '' : ` on ${src.remote}`}.`, { hint: `Known workspaces: ${workspaces(all).join(', ')}.` })
        for (const e of hits) out.set(e.id, e)
        continue
      }
      const one = await resolve(src, s, exec, signal)
      out.set(one.id, one)
    }
    return [...out.values()]
  }

  /** Read (and normalize) one session of its source, cached briefly. */
  async function model(entry, signal) {
    const now = Date.now()
    const key = k(entry.source, entry.id)
    const cached = snapshots.get(key)
    if (cached && now - cached.at < (cached.live ? SNAPSHOT_TTL_LIVE_MS : SNAPSHOT_TTL_COLD_MS) && cached.live === entry.live) {
      return cached.model
    }
    signal?.throwIfAborted()
    const t0 = Date.now()
    const snapshot = await entry.source.read(entry.id, signal)
    const m = buildModel(snapshot, { live: entry.live, title: entry.title ?? undefined, remote: entry.remote })
    if (m.title && m.title !== entry.title) titles.set(key, { title: m.title, at: now, live: entry.live })
    trace({ event: 'read', source: entry.source.key, id: entry.id, events: snapshot.events?.length ?? 0, ms: Date.now() - t0 })
    snapshots.set(key, { model: m, at: now, live: entry.live })
    return m
  }

  /**
   * Read many sessions for a corpus-wide tool (a remote source reads a few in
   * parallel): one unreadable log (a refused historical artifact, a torn
   * frame) is reported, not fatal. Results keep the entries' order.
   * @returns {Promise<{ models: any[], skipped: { id: string, workspace: string, title: string | null, error: string }[] }>}
   */
  async function models(entries, signal) {
    const results = new Array(entries.length)
    const width = Math.max(1, entries[0]?.source.concurrency ?? 1)
    let next = 0
    let fatal
    const worker = async () => {
      while (next < entries.length && fatal === undefined) {
        const i = next++
        const entry = entries[i]
        try {
          results[i] = { model: await model(entry, signal) }
        } catch (error) {
          if (entries.length === 1 || signal?.aborted) { fatal = error; return }
          const message = error instanceof Error ? error.message : String(error)
          trace({ event: 'read-failed', id: entry.id, error: message })
          results[i] = { skipped: { id: entry.id, workspace: entry.workspace, title: entry.title, error: message.split('\n')[0].slice(0, 300) } }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(width, entries.length) }, worker))
    if (fatal !== undefined) throw fatal
    const out = { models: [], skipped: [] }
    for (const r of results) { if (r?.model) out.models.push(r.model); else if (r?.skipped) out.skipped.push(r.skipped) }
    return out
  }

  return { source, local, listAll, resolve, select, model, models, callerId, callerCwd }
}

function workspaces(entries) {
  return [...new Set(entries.map(e => e.workspace))].sort()
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function ambiguous(raw, hits) {
  const list = hits.slice(0, 8).map(e => `  ${e.id}  ${e.workspace}/${e.title ?? '(untitled)'}  (${e.cwd ?? 'no cwd'})`).join('\n')
  return new IntrospectError(`"${raw}" matches ${hits.length} sessions; be more specific (workspace/title or id):\n${list}`)
}

/**
 * `since` / `until` / `split_at`: ISO date/time, or a relative `7d` / `12h` / `30m` (that long ago).
 * @param {unknown} value
 * @param {string} [name] - parameter name for the error message
 * @returns {number | null} epoch ms
 */
export function parseSince(value, name = 'since') {
  if (value === undefined || value === null || value === '') return null
  const s = String(value).trim()
  const rel = /^(\d+)\s*([mhdw])$/i.exec(s)
  if (rel) {
    const n = Number(rel[1])
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[rel[2].toLowerCase()]
    return Date.now() - n * unit
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new IntrospectError(`${name} "${s}" is not an ISO date or a relative duration like 7d, 12h, 30m.`)
  return t
}
