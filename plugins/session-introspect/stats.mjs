/**
 * stats.mjs — the ergonomics lens over one or many normalized session models
 * (see model.mjs). Pure.
 *
 * Always: per-tool call/error/latency aggregates, in how many sessions the
 * tool was *available* (registered in a request/header) vs used, the top
 * normalized error messages each with the agent's REACTIONS (the reasoning /
 * assistant text between the failed result and the next call), and the
 * "what did the agent do right after an error" bigrams.
 *
 * Opt-in sections (`sections`):
 *   before_error  which tool preceded each failure (mirror of afterError)
 *   sequences     most common tool bigrams / trigrams (same-tool repeats excluded — see runs)
 *   runs          same-tool consecutive runs within a turn (share of calls in runs >= 3, longest run)
 *   duplicates    identical-args repeats of a call within one session
 *   args          per tool: how often each parameter is passed, median length of array/string parameters
 *
 * `splitAt` (epoch ms) additionally reports the per-tool table for sessions
 * created before / after that instant side by side.
 */

import { clip, matchesTool } from './model.mjs'

export const SECTIONS = ['before_error', 'sequences', 'runs', 'duplicates', 'args']

/**
 * Normalize an error message so one bug groups as one row: digit runs, hex
 * ids, absolute paths, quoted values and UUID-ish tokens collapse.
 * @param {string} text
 */
export function normalizeError(text) {
  let s = String(text ?? '').split('\n').find(line => line.trim() !== '') ?? ''
  s = s.replace(/\[exit code: \d+\]/g, '[exit code: N]')
  s = s.replace(/(^|[\s"'`(=:])(~|\/)[^\s"'`),]*/g, '$1<path>')
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
  s = s.replace(/\b(?:0x)?[0-9a-f]{12,}\b/gi, '<hex>')
  s = s.replace(/\d+(\.\d+)?/g, '#')
  s = s.replace(/"[^"]{0,80}"/g, '"…"')
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 160 ? `${s.slice(0, 159)}…` : s
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

function median(values) {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

/**
 * The agent's reaction to a failed call: reasoning / assistant rows between
 * the failed result and the next tool call (or the end of the turn).
 * @param {ReturnType<import('./model.mjs').buildModel>} m
 * @param {any} call - a failed call record with `resultSeq`
 * @param {number} maxChars
 */
export function reactionsTo(m, call, maxChars = 280) {
  if (call.resultSeq === null) return []
  const out = []
  let started = false
  for (const r of m.rows) {
    if (!started) { if (r.seq === call.resultSeq) started = true; continue }
    if (r.kind === 'call' || r.kind === 'turn-end' || r.kind === 'user') break
    if (r.kind === 'reasoning' || r.kind === 'assistant') out.push({ seq: r.seq, kind: r.kind, text: clip(r.text, maxChars) })
  }
  return out
}

/**
 * Aggregate tool usage over models.
 * @param {ReturnType<import('./model.mjs').buildModel>[]} models
 * @param {{ tools?: readonly string[], topErrors?: number, reactions?: number, reactionChars?: number, sections?: Iterable<string>, topSequences?: number, splitAt?: number | null }} [opts]
 */
export function toolStats(models, opts = {}) {
  const topErrors = opts.topErrors ?? 5
  const maxReactions = opts.reactions ?? 2
  const reactionChars = opts.reactionChars ?? 280
  const sections = new Set(opts.sections ?? [])
  const topSequences = opts.topSequences ?? 15
  const perTool = new Map()
  const after = new Map() // `${tool}→${next}` → { tool, next, relation, count }
  const before = new Map()
  let totalCalls = 0
  let totalErrors = 0
  let earliest = null
  let latest = null

  for (const m of models) {
    if (m.createdAt !== null) {
      earliest = earliest === null ? m.createdAt : Math.min(earliest, m.createdAt)
      latest = latest === null ? m.createdAt : Math.max(latest, m.createdAt)
    }
    const calls = m.calls
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i]
      if (!matchesTool(c.tool, opts.tools)) continue
      totalCalls += 1
      let row = perTool.get(c.tool)
      if (!row) {
        row = { tool: c.tool, calls: 0, errors: 0, unanswered: 0, latencies: [], errorGroups: new Map(), sessions: new Set() }
        perTool.set(c.tool, row)
      }
      row.calls += 1
      row.sessions.add(m.id)
      if (c.ms !== null) row.latencies.push(c.ms)
      if (c.ok === null) row.unanswered += 1
      if (c.ok === false) {
        row.errors += 1
        totalErrors += 1
        const key = normalizeError(c.reason ?? c.text) || (c.code ?? '(no message)')
        const g = row.errorGroups.get(key) ?? { message: key, count: 0, codes: new Set(), example: null, reactions: [] }
        g.count += 1
        if (c.code) g.codes.add(c.code)
        if (g.example === null) g.example = { session: m.id, seq: c.seq }
        if (g.reactions.length < maxReactions) {
          for (const r of reactionsTo(m, c, reactionChars)) {
            if (g.reactions.length >= maxReactions) break
            g.reactions.push({ session: m.id, ...r })
          }
        }
        row.errorGroups.set(key, g)
        // What happened next (same session, next tool call in seq order)?
        const next = calls[i + 1]
        if (next) {
          const retrySame = next.tool === c.tool
          const identical = retrySame && next.args === c.args
          const relation = identical ? 'same-args' : retrySame ? 'retry' : 'switch'
          const k = `${c.tool}\u0000${next.tool}\u0000${relation}`
          const a = after.get(k) ?? { tool: c.tool, next: next.tool, relation, count: 0 }
          a.count += 1
          after.set(k, a)
        } else {
          const k = `${c.tool}\u0000\u0000end`
          const a = after.get(k) ?? { tool: c.tool, next: null, relation: 'end', count: 0 }
          a.count += 1
          after.set(k, a)
        }
        if (sections.has('before_error')) {
          const prev = calls[i - 1]
          const k = `${prev?.tool ?? ''}\u0000${c.tool}`
          const b = before.get(k) ?? { prev: prev?.tool ?? null, tool: c.tool, count: 0 }
          b.count += 1
          before.set(k, b)
        }
      }
    }
  }

  // availability: sessions whose request/header listed the tool (0 when no model recorded a header)
  const availableIn = new Map()
  for (const m of models) for (const t of m.toolsAvailable ?? []) availableIn.set(t, (availableIn.get(t) ?? 0) + 1)
  const anyHeader = models.some(m => (m.toolsAvailable?.length ?? 0) > 0)

  const tools = [...perTool.values()].map(row => {
    const sorted = [...row.latencies].sort((a, b) => a - b)
    return {
      tool: row.tool,
      calls: row.calls,
      errors: row.errors,
      errorRate: row.calls === 0 ? 0 : row.errors / row.calls,
      unanswered: row.unanswered,
      sessions: row.sessions.size,
      available: anyHeader ? (availableIn.get(row.tool) ?? 0) : null,
      p50Ms: percentile(sorted, 0.5),
      p90Ms: percentile(sorted, 0.9),
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
      topErrors: [...row.errorGroups.values()].sort((a, b) => b.count - a.count).slice(0, topErrors)
        .map(g => ({ count: g.count, message: g.message, codes: [...g.codes], example: g.example, reactions: g.reactions })),
    }
  }).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))

  // tools that were available somewhere but never called (adoption = 0)
  const unused = anyHeader
    ? [...availableIn.entries()].filter(([t]) => !perTool.has(t) && matchesTool(t, opts.tools)).map(([tool, available]) => ({ tool, available })).sort((a, b) => b.available - a.available || a.tool.localeCompare(b.tool))
    : []

  const value = {
    scope: { sessions: models.length, calls: totalCalls, errors: totalErrors, from: earliest, to: latest, tools: opts.tools ?? [], sections: [...sections] },
    tools,
    unused,
    afterError: [...after.values()].sort((a, b) => b.count - a.count),
  }
  if (sections.has('before_error')) value.beforeError = [...before.values()].sort((a, b) => b.count - a.count)
  if (sections.has('sequences')) value.sequences = sequences(models, opts.tools, topSequences)
  if (sections.has('runs')) value.runs = runs(models, opts.tools)
  if (sections.has('duplicates')) value.duplicates = duplicates(models, opts.tools)
  if (sections.has('args')) value.args = argShapes(models, opts.tools)
  if (typeof opts.splitAt === 'number') {
    const side = (ms) => {
      const sub = toolStats(ms, { tools: opts.tools, topErrors: 1, reactions: 0 })
      return { sessions: ms.length, calls: sub.scope.calls, errors: sub.scope.errors, tools: sub.tools.map(t => ({ tool: t.tool, calls: t.calls, errors: t.errors, errorRate: t.errorRate, sessions: t.sessions, p50Ms: t.p50Ms, p90Ms: t.p90Ms })) }
    }
    value.split = {
      at: opts.splitAt,
      before: side(models.filter(m => (m.createdAt ?? 0) < opts.splitAt)),
      after: side(models.filter(m => (m.createdAt ?? 0) >= opts.splitAt)),
    }
  }
  return value
}

/** Tool bigrams / trigrams over each session's call sequence; same-tool repeats are left to `runs`. */
function sequences(models, tools, top) {
  const bi = new Map()
  const tri = new Map()
  let pairs = 0
  let repeats = 0
  for (const m of models) {
    const t = m.calls.map(c => c.tool)
    for (let i = 1; i < t.length; i++) {
      if (!matchesTool(t[i - 1], tools) && !matchesTool(t[i], tools)) continue
      pairs += 1
      if (t[i - 1] === t[i]) { repeats += 1; continue }
      const k = `${t[i - 1]}\u0000${t[i]}`
      bi.set(k, (bi.get(k) ?? 0) + 1)
      if (i >= 2 && !(t[i - 2] === t[i - 1] && t[i - 1] === t[i])) {
        const k3 = `${t[i - 2]}\u0000${t[i - 1]}\u0000${t[i]}`
        tri.set(k3, (tri.get(k3) ?? 0) + 1)
      }
    }
  }
  const rank = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, count]) => ({ tools: k.split('\u0000'), count }))
  return { pairs, sameToolPairs: repeats, bigrams: rank(bi), trigrams: rank(tri) }
}

/** Same-tool consecutive runs within one turn. */
function runs(models, tools) {
  const per = new Map()
  for (const m of models) {
    const cs = m.calls
    let i = 0
    while (i < cs.length) {
      let j = i
      while (j + 1 < cs.length && cs[j + 1].tool === cs[i].tool && cs[j + 1].turn === cs[i].turn) j++
      const len = j - i + 1
      const tool = cs[i].tool
      if (matchesTool(tool, tools)) {
        const r = per.get(tool) ?? { tool, calls: 0, runs: 0, runs3: 0, callsInRuns3: 0, maxRun: { len: 0, session: null, seq: null } }
        r.calls += len
        r.runs += 1
        if (len >= 3) { r.runs3 += 1; r.callsInRuns3 += len }
        if (len > r.maxRun.len) r.maxRun = { len, session: m.id, seq: cs[i].seq }
        per.set(tool, r)
      }
      i = j + 1
    }
  }
  return [...per.values()].map(r => ({ ...r, share3: r.calls ? r.callsInRuns3 / r.calls : 0 })).filter(r => r.runs3 > 0).sort((a, b) => b.callsInRuns3 - a.callsInRuns3)
}

/** Identical-args repeats of a call within one session. */
function duplicates(models, tools) {
  const per = new Map()
  for (const m of models) {
    const seen = new Map()
    for (const c of m.calls) {
      if (!matchesTool(c.tool, tools)) continue
      const k = `${c.tool}\u0000${c.args}`
      const g = seen.get(k) ?? { tool: c.tool, args: c.args, count: 0, seq: c.seq }
      g.count += 1
      seen.set(k, g)
    }
    for (const g of seen.values()) {
      if (g.count < 2) continue
      const r = per.get(g.tool) ?? { tool: g.tool, groups: 0, extraCalls: 0, top: [] }
      r.groups += 1
      r.extraCalls += g.count - 1
      r.top.push({ session: m.id, seq: g.seq, count: g.count, args: clip(g.args, 140) })
      per.set(g.tool, r)
    }
  }
  return [...per.values()].map(r => ({ ...r, top: r.top.sort((a, b) => b.count - a.count).slice(0, 3) })).sort((a, b) => b.extraCalls - a.extraCalls)
}

/** Per tool: how often each parameter is present; median length of array / string values. */
function argShapes(models, tools) {
  const per = new Map()
  for (const m of models) {
    for (const c of m.calls) {
      if (!matchesTool(c.tool, tools)) continue
      const r = per.get(c.tool) ?? { tool: c.tool, calls: 0, parsed: 0, keys: new Map() }
      r.calls += 1
      const o = c.argsObj
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        r.parsed += 1
        for (const [k, v] of Object.entries(o)) {
          if (v === undefined || v === null) continue
          const key = r.keys.get(k) ?? { key: k, count: 0, arrayLens: [], stringLens: [], trueCount: 0 }
          key.count += 1
          if (Array.isArray(v)) key.arrayLens.push(v.length)
          else if (typeof v === 'string') key.stringLens.push(v.length)
          else if (v === true) key.trueCount += 1
          r.keys.set(k, key)
        }
      }
      per.set(c.tool, r)
    }
  }
  return [...per.values()].sort((a, b) => b.calls - a.calls).map(r => ({
    tool: r.tool,
    calls: r.calls,
    keys: [...r.keys.values()].sort((a, b) => b.count - a.count).map(k => ({
      key: k.key,
      count: k.count,
      pct: r.parsed ? k.count / r.parsed : 0,
      ...k.arrayLens.length ? { arrayMedianLen: median(k.arrayLens), arrayMaxLen: Math.max(...k.arrayLens) } : {},
      ...k.stringLens.length ? { stringMedianChars: median(k.stringLens) } : {},
    })),
  }))
}
