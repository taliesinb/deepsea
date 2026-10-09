/**
 * render.mjs — the `text` renderings (model-facing, compact) of every tool's
 * canonical value, plus the shared `json` / `jsonl` renderers. Pure functions
 * of the canonical value: no fact exists only in prose.
 */

import { clip } from './model.mjs'

/** @param {number | null | undefined} ms */
export function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

/** @param {number | null | undefined} n */
export function fmtBytes(n) {
  if (n === null || n === undefined) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Local `MM-DD HH:MM` (the machine's zone; the model reasons about relative order, not absolute time). */
export function fmtTime(t) {
  if (typeof t !== 'number') return '?'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `HH:MM:SS` for timeline rows. */
function fmtClock(t) {
  if (typeof t !== 'number') return '??:??:??'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** `1.2k` / `130k` token counts. */
export function fmtTokens(n) {
  if (n === null || n === undefined) return '—'
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${Math.round(n / 1000)}k`
}

/** Short session id: `session-2b810855` (enough for a prefix lookup). */
export function shortId(id) {
  const m = /^(session-)?([0-9a-f]{8})/i.exec(String(id))
  return m ? `${m[1] ?? ''}${m[2]}` : String(id).slice(0, 16)
}

/** Fixed-width table: `rows` are string arrays; `align` per column ('l' | 'r'). */
export function table(header, rows, align = []) {
  const all = [header, ...rows]
  const widths = header.map((_, i) => Math.max(...all.map(r => String(r[i] ?? '').length)))
  const fmt = (r) => r.map((cell, i) => {
    const s = String(cell ?? '')
    const last = i === r.length - 1
    if (align[i] === 'r') return s.padStart(widths[i])
    return last ? s : s.padEnd(widths[i])
  }).join('  ').trimEnd()
  return all.map(fmt).join('\n')
}

function imagesText(images) {
  if (!images || images.length === 0) return ''
  return images.map(im => `<image ${im.w ?? '?'}×${im.h ?? '?'} ${im.type}${im.bytes !== null && im.bytes !== undefined ? ` ${fmtBytes(im.bytes)}` : ''}>`).join(' ')
}

// ------------------------------------------------------------------ find

export function renderFind(value) {
  const rows = value.sessions
  if (rows.length === 0) return `No ${value.active ? 'active ' : ''}sessions${value.query ? ` matched "${value.query}"` : ''}${value.remote ? ` on ${value.remote}` : ''}.${value.hint ? ` ${value.hint}` : ''}`
  const details = value.details === true
  const lines = [table(
    details
      ? ['id', 'workspace/title', 'created', 'live', 'model', 'events', 'calls', 'err', 'tools', 'cwd', '']
      : ['id', 'workspace/title', 'created', 'live', ''],
    rows.map(s => [
      shortId(s.id),
      `${s.depth ? '↳ ' : ''}${s.workspace}/${s.title ?? '(untitled)'}`,
      fmtTime(s.createdAt),
      s.running ? 'running' : s.live ? 'yes' : 'no',
      ...details ? [s.model ?? (s.readError ? '(unreadable)' : '?'), s.events ?? '', s.calls ?? '', s.errors ?? '', s.toolsAvailable ?? '', s.cwd ?? ''] : [],
      s.self ? '(this session)' : s.depth ? `subagent depth ${s.depth}` : '',
    ]),
    details ? ['l', 'l', 'l', 'l', 'l', 'r', 'r', 'r', 'r', 'l', 'l'] : ['l', 'l', 'l', 'l', 'l'],
  )]
  lines.push(`${value.total} ${value.active ? 'active ' : ''}session${value.total === 1 ? '' : 's'}${value.remote ? ` on ${value.remote}` : ''}${rows.some(s => s.running) ? ` (${rows.filter(s => s.running).length} running a turn)` : ''}${value.truncated ? `; ${value.truncated} more not shown — narrow with query/workspace/since or raise limit` : ''}.`)
  if (value.hint) lines.push(value.hint)
  return lines.join('\n')
}

// --------------------------------------------------------------- outline

function sessionLine(s) {
  const bits = [shortId(s.id), `${s.remote ? `${s.remote}:` : ''}${s.workspace}/${s.title ?? '(untitled)'}`]
  if (s.cwd) bits.push(`cwd ${s.cwd}`)
  if (s.model) bits.push(s.model)
  bits.push(`${s.events} events`, `${s.turns} turns`, `${s.calls} calls${s.errors ? ` (${s.errors} ✗)` : ''}`)
  if (s.toolsAvailable) bits.push(`${s.toolsAvailable} tools registered`)
  if (s.live) bits.push('LIVE')
  return bits.join(' · ')
}

function endedText(ended) {
  if (!ended) return ''
  let s = ended.kind
  if (ended.code) s += ` ${ended.code}`
  if (ended.message) s += ` "${clip(ended.message, 100)}"`
  return s
}

export function renderOutline(value) {
  const lines = [sessionLine(value.session)]
  for (const t of value.turns) {
    const calls = t.calls.map(c => `${c.tool} ${c.count}${c.errors ? ` (✗${c.errors})` : ''}`).join(' · ')
    const head = [
      `T${t.turn}`.padEnd(4),
      `seq ${t.seqFrom}–${t.seqTo}`.padEnd(16),
      fmtTime(t.startedAt),
      fmtMs(t.ms).padStart(5),
      `${t.steps} step${t.steps === 1 ? '' : 's'}`.padStart(8),
      `${t.totalCalls} call${t.totalCalls === 1 ? '' : 's'}`.padStart(9),
      calls ? `  ${calls}` : '',
    ].join(' ')
    const flags = []
    if (t.tokens && (t.tokens.output || t.tokens.contextEnd)) flags.push(`out ${fmtTokens(t.tokens.output)} · ctx ${fmtTokens(t.tokens.contextEnd)}`)
    if (t.retries) flags.push(`${t.retries} llm retr${t.retries === 1 ? 'y' : 'ies'}`)
    lines.push(`${head}${flags.length ? `  [${flags.join(', ')}]` : ''}  ended: ${endedText(t.ended)}`)
    if (t.prompt) lines.push(`      "${t.prompt}"`)
  }
  if (value.omitted) lines.push(`… ${value.omitted.count} more turns (T${value.omitted.from}–T${value.omitted.to}); narrow with turns.`)
  return lines.join('\n')
}

// ------------------------------------------------------------------ read

/**
 * One timeline row → one (or a few) lines. Shared by `read` and `grep`.
 * @param {any} r - canonical event row
 * @param {{ maxResultChars?: number, includeArgs?: boolean }} [opts]
 */
export function renderRow(r, opts = {}) {
  const max = opts.maxResultChars ?? 400
  const tag = `[${r.seq}]`.padEnd(7)
  const ts = (r.turn !== null && r.turn !== undefined) ? ` T${r.turn}${r.step !== null && r.step !== undefined ? ` S${r.step}` : ''}` : ''
  switch (r.kind) {
    case 'turn-start': return `${tag} ── T${r.turn} start ${fmtClock(r.time)} ──`
    case 'turn-end': return `${tag} ── T${r.turn} end ${endedText(r.ended)} (${fmtMs(r.ms)}) ──`
    case 'user': return `${tag} USER${ts} ${quote(r.text, max)}${r.images?.length ? ` ${imagesText(r.images)}` : ''}`
    case 'inject': return `${tag} INJECT ${r.plugin ?? ''}${ts} ${quote(r.text, Math.min(max, 200))}`
    case 'instructions': return `${tag} INSTRUCTIONS${ts} ${quote(r.text, Math.min(max, 120))}`
    case 'system': return `${tag} SYSTEM${ts} ${quote(r.text, Math.min(max, 200))}${r.textChars ? ` (${fmtTokens(r.textChars)} chars)` : ''}`
    case 'checkpoint': return `${tag} CHECKPOINT (compaction)${ts} ${quote(r.text, Math.min(max, 200))}`
    case 'assistant': return `${tag} ASSISTANT${ts} ${quote(r.text, max)}`
    case 'reasoning': return `${tag} REASONING${ts} ${quote(r.text, max)}`
    case 'call': return `${tag} CALL   ${r.tool}${ts}${opts.includeArgs === false ? '' : ` ${clip(r.args, max)}`}`
    case 'result': {
      const status = r.ok === false ? '✗' : '✓'
      const bits = [`${tag} RESULT ${status} ${fmtMs(r.ms)}`]
      if (r.tool && r.tool !== '?') bits.push(r.tool)
      if (r.code) bits.push(`code=${r.code}`)
      const body = r.text ? quote(r.text, max) : ''
      const imgs = imagesText(r.images)
      if (body) bits.push(body)
      if (imgs) bits.push(imgs)
      if (r.reason && r.reason !== r.text) bits.push(`reason=${clip(r.reason, 160)}`)
      return bits.join(' ')
    }
    case 'title': return `${tag} TITLE "${clip(r.text, 100)}"`
    case 'approval': return `${tag} APPROVAL ${clip(r.text, 200)}`
    case 'retry': return `${tag} LLM-RETRY ${clip(r.text, 200)}`
    case 'command': return `${tag} COMMAND ${clip(r.text, 200)}`
    case 'other': return `${tag} ${r.type} ${clip(r.text, Math.min(max, 200))}`
    default: return `${tag} ${r.kind}`
  }
}

function quote(text, max) {
  const s = clip(text, max)
  return s === '' ? '""' : `"${s}"`
}

export function renderRead(value) {
  const lines = [sessionLine(value.session)]
  const range = value.range
  lines.push(`range: seq ${range.seqFrom}–${range.seqTo}${range.turn !== undefined ? ` (turn ${range.turn})` : ''}${value.filters ? ` · ${value.filters}` : ''} · ${value.events.length} rows shown`)
  for (const r of value.events) lines.push(renderRow(r, { maxResultChars: value.maxResultChars }))
  if (value.omitted) lines.push(`… ${value.omitted.count} more rows (seq ${value.omitted.seqFrom}–${value.omitted.seqTo}) not shown; continue with seq_from: ${value.omitted.seqFrom}, narrow with tools/turn/errors_only, or use out_file.`)
  return lines.join('\n')
}

// ----------------------------------------------------------------- stats

export function renderStats(value) {
  const s = value.scope
  const lines = []
  const one = s.sessions === 1 && value.sessions?.[0]
  const skipped = value.skipped?.length ? ` (${value.skipped.length} more skipped, see below)` : ''
  const scopeLabel = one ? `${shortId(one.id)} ${one.workspace}/${one.title ?? '(untitled)'}` : `${s.sessions} sessions read${skipped}${s.from ? `, created ${fmtTime(s.from)} → ${fmtTime(s.to)}` : ''}`
  lines.push(`${value.remote ? `${value.remote}: ` : ''}${scopeLabel} · ${s.calls} calls · ${s.errors} errors${s.tools?.length ? ` · tools ${s.tools.join(', ')}` : ''}`)
  if (value.tools.length === 0) { lines.push('No tool calls matched.'); return lines.join('\n') }
  const withAvail = value.tools.some(t => t.available !== null && t.available !== undefined)
  const multi = s.sessions > 1
  const rows = []
  for (const t of value.tools) {
    const first = t.topErrors[0]
    const avail = withAvail ? (multi ? `${t.sessions}/${t.available ?? '?'}` : '') : (multi ? String(t.sessions) : '')
    rows.push([t.tool, t.calls, t.errors, `${Math.round(t.errorRate * 100)}%`, ...multi ? [avail] : [], fmtMs(t.p50Ms), fmtMs(t.p90Ms), first ? `×${first.count} ${first.message}` : ''])
    for (const e of t.topErrors.slice(1)) rows.push(['', '', '', '', ...multi ? [''] : [], '', '', `×${e.count} ${e.message}`])
  }
  const header = ['tool', 'calls', 'err', 'err%', ...multi ? [withAvail ? 'used/avail' : 'sessions'] : [], 'p50', 'p90', 'top errors (normalized; see fmt=json for example seqs)']
  lines.push(table(header, rows, ['l', 'r', 'r', 'r', ...multi ? ['r'] : [], 'r', 'r', 'l']))
  if (multi && withAvail) lines.push('used/avail = sessions that called the tool / sessions where it was registered (from request/header).')
  if (value.unused?.length) lines.push(`registered but never called: ${value.unused.slice(0, 40).map(u => `${u.tool} (${u.available})`).join(', ')}${value.unused.length > 40 ? ` … ${value.unused.length - 40} more` : ''}`)
  // reactions: what the agent thought/said right after each top error
  const reactions = []
  for (const t of value.tools) for (const e of t.topErrors) for (const r of e.reactions ?? []) reactions.push({ tool: t.tool, message: e.message, ...r })
  if (reactions.length) {
    lines.push('agent reactions right after an error (reasoning/assistant text before the next call):')
    let last = null
    for (const r of reactions) {
      const head = `${r.tool} ✗ ${clip(r.message, 70)}`
      if (head !== last) { lines.push(`  ${head}`); last = head }
      lines.push(`    ${multi ? `${shortId(r.session)} ` : ''}[${r.seq}] ${r.kind === 'reasoning' ? 'THOUGHT' : 'SAID'} "${r.text}"`)
    }
  }
  if (value.afterError.length) {
    lines.push('after an error, the next call was:')
    for (const a of value.afterError.slice(0, 12)) {
      const rel = a.relation === 'same-args' ? 'retry, identical args' : a.relation === 'retry' ? 'retry, changed args' : a.relation === 'end' ? 'nothing — session ended' : 'switch'
      lines.push(`  ${a.tool} ✗ → ${a.next ?? '(none)'} (${rel}) ×${a.count}`)
    }
  }
  if (value.beforeError?.length) {
    lines.push('before an error, the previous call was:')
    for (const b of value.beforeError.slice(0, 12)) lines.push(`  ${b.prev ?? '(turn start)'} → ${b.tool} ✗ ×${b.count}`)
  }
  if (value.sequences) {
    const q = value.sequences
    lines.push(`tool sequences (${q.pairs} adjacent pairs, ${q.sameToolPairs} same-tool repeats excluded — see runs):`)
    lines.push('  bigrams:  ' + q.bigrams.map(b => `${b.tools.join(' → ')} ×${b.count}`).join(' · '))
    lines.push('  trigrams: ' + q.trigrams.map(b => `${b.tools.join(' → ')} ×${b.count}`).join(' · '))
  }
  if (value.runs) {
    lines.push('same-tool runs within a turn (tools with a run ≥ 3):')
    lines.push(table(['tool', 'calls', 'runs', 'runs≥3', 'calls in runs≥3', 'share', 'longest'],
      value.runs.slice(0, 20).map(r => [r.tool, r.calls, r.runs, r.runs3, r.callsInRuns3, `${Math.round(r.share3 * 100)}%`, `${r.maxRun.len}${multi ? ` @ ${shortId(r.maxRun.session)}` : ''} seq ${r.maxRun.seq}`]),
      ['l', 'r', 'r', 'r', 'r', 'r', 'l']))
  }
  if (value.duplicates) {
    lines.push('identical-args repeats within one session:')
    for (const d of value.duplicates.slice(0, 15)) {
      lines.push(`  ${d.tool}: ${d.groups} group${d.groups === 1 ? '' : 's'}, ${d.extraCalls} extra call${d.extraCalls === 1 ? '' : 's'}`)
      for (const t of d.top) lines.push(`    ×${t.count} ${multi ? `${shortId(t.session)} ` : ''}seq ${t.seq}: ${t.args}`)
    }
  }
  if (value.args) {
    lines.push('parameter shapes (share of calls passing each parameter; median length of arrays / chars of strings):')
    for (const a of value.args.slice(0, 25)) {
      const ks = a.keys.map(k => `${k.key} ${Math.round(k.pct * 100)}%${k.arrayMedianLen !== undefined ? ` [med ${k.arrayMedianLen}, max ${k.arrayMaxLen}]` : ''}${k.stringMedianChars !== undefined ? ` (~${k.stringMedianChars}ch)` : ''}`)
      lines.push(`  ${a.tool} (${a.calls}): ${ks.join(', ')}`)
    }
  }
  if (value.split) {
    const sp = value.split
    lines.push(`split at ${fmtTime(sp.at)}: before ${sp.before.sessions} sessions / ${sp.before.calls} calls / ${sp.before.errors} errors · after ${sp.after.sessions} sessions / ${sp.after.calls} calls / ${sp.after.errors} errors`)
    const b = new Map(sp.before.tools.map(t => [t.tool, t]))
    const a = new Map(sp.after.tools.map(t => [t.tool, t]))
    const names = [...new Set([...b.keys(), ...a.keys()])].sort((x, y) => ((a.get(y)?.calls ?? 0) + (b.get(y)?.calls ?? 0)) - ((a.get(x)?.calls ?? 0) + (b.get(x)?.calls ?? 0)))
    const pct = (t, tot) => tot ? `${(100 * (t?.calls ?? 0) / tot).toFixed(1)}%` : '—'
    lines.push(table(['tool', 'before', 'share', 'err%', 'p50', 'after', 'share', 'err%', 'p50'],
      names.map(n => {
        const x = b.get(n); const y = a.get(n)
        return [n, x?.calls ?? 0, pct(x, sp.before.calls), x ? `${Math.round(x.errorRate * 100)}%` : '—', fmtMs(x?.p50Ms), y?.calls ?? 0, pct(y, sp.after.calls), y ? `${Math.round(y.errorRate * 100)}%` : '—', fmtMs(y?.p50Ms)]
      }), ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r']))
  }
  lines.push(...skippedLines(value.skipped))
  return lines.join('\n')
}

// ---------------------------------------------------------------- export

export function renderExport(value) {
  const lines = [`${value.rows.length} row${value.rows.length === 1 ? '' : 's'} (${value.kinds.join(', ')}) from ${value.sessions.length} session${value.sessions.length === 1 ? '' : 's'}${value.remote ? ` on ${value.remote}` : ''}${value.tools?.length ? ` · tools ${value.tools.join(', ')}` : ''}${value.truncated ? ` — truncated at limit ${value.limit}; use out_file or narrow` : ''}`]
  for (const r of value.rows) {
    const where = `${shortId(r.session)} [${r.seq}]${r.turn !== null && r.turn !== undefined ? ` T${r.turn}` : ''}`
    if (r.kind === 'call') {
      const status = r.ok === null ? '?' : r.ok ? '✓' : '✗'
      lines.push(`${where} ${r.tool} ${status} ${fmtMs(r.ms)}${r.code ? ` code=${r.code}` : ''} ${clip(JSON.stringify(r.args), 200)}${r.result ? ` → ${clip(r.result, 120)}` : ''}`)
    } else {
      lines.push(`${where} ${r.kind.toUpperCase()} ${clip(r.text ?? '', 200)}`)
    }
  }
  lines.push(...skippedLines(value.skipped))
  return lines.join('\n')
}

// ------------------------------------------------------------------ grep

export function renderGrep(value) {
  const lines = [`${value.hits.length} hit${value.hits.length === 1 ? '' : 's'} for /${value.pattern}/${value.flags ?? ''} in ${value.sessions.length} session${value.sessions.length === 1 ? '' : 's'}${value.remote ? ` on ${value.remote}` : ''}${value.truncated ? ` (showing first ${value.hits.length}; narrow or raise limit)` : ''}`]
  const multi = value.sessions.length + (value.skipped?.length ?? 0) > 1
  let lastSession = null
  for (const h of value.hits) {
    if (h.session !== lastSession) {
      const s = value.sessions.find(x => x.id === h.session)
      lines.push(`— ${shortId(h.session)} ${s ? `${s.workspace}/${s.title ?? '(untitled)'}` : ''}`)
      lastSession = h.session
    }
    // In a multi-session search every hit names its session, so a seq is never paired with the wrong session downstream.
    const where = `${multi ? `${shortId(h.session)} ` : ''}[${h.seq}] ${h.kind}${h.tool ? ` ${h.tool}` : ''}${h.turn !== null && h.turn !== undefined ? ` T${h.turn}` : ''}`
    lines.push(`${where}: …${h.excerpt}…`)
  }
  lines.push(...skippedLines(value.skipped))
  return lines.join('\n')
}

function skippedLines(skipped) {
  if (!skipped || skipped.length === 0) return []
  return [`${skipped.length} session${skipped.length === 1 ? '' : 's'} could not be read by DSH's session reader and ${skipped.length === 1 ? 'was' : 'were'} skipped (fmt=json carries the full diagnostics):`,
    ...skipped.map(s => `  ${shortId(s.id)} ${clip(`${s.workspace}/${s.title ?? '(untitled)'}`, 48)}: ${shortReadError(s.error)}`)]
}

/** The reader's diagnostic without its `failed to read stored session "<id>":` prefix and `(raw log: …)` suffix. */
function shortReadError(error) {
  let e = String(error ?? '')
  e = e.replace(/^failed to read stored session "[^"]*":\s*/, '')
  e = e.replace(/;?\s*source v\d+ artifact remains unchanged/, '')
  e = e.replace(/\s*\(raw log: [^)]*\)?\s*$/, '')
  return clip(e, 140)
}

// ----------------------------------------------------------------- event

export function renderEvent(value) {
  const lines = [sessionLine(value.session)]
  for (const b of value.before ?? []) lines.push(`  ${renderRow(b, { maxResultChars: 120 })}`)
  lines.push(`event seq ${value.event.seq} type ${value.event.type} at ${fmtClock(value.event.time)}:`)
  lines.push(JSON.stringify(value.event, null, 1))
  for (const a of value.after ?? []) lines.push(`  ${renderRow(a, { maxResultChars: 120 })}`)
  return lines.join('\n')
}

// ------------------------------------------------------------ json/jsonl

export function toJson(value) {
  return JSON.stringify(value, null, 1)
}

/**
 * JSONL: a header object, then one object per row.
 * @param {object} header - `{ kind: 'header', ... }` facts
 * @param {readonly object[]} rows
 * @param {object} [trailer] - optional final object (e.g. `{ kind: 'omitted', ... }`)
 */
export function toJsonl(header, rows, trailer) {
  const lines = [JSON.stringify({ kind: 'header', ...header })]
  for (const r of rows) lines.push(JSON.stringify(r))
  if (trailer) lines.push(JSON.stringify(trailer))
  return lines.join('\n')
}
