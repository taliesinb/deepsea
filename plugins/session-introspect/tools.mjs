/**
 * tools.mjs — the seven model-facing tools. Each returns one canonical JSON
 * value (or a `{ kind: 'file' }` handle when `out_file` is set); `output.render`
 * turns it into text / json / jsonl. Session access goes through the resolver
 * (resolve.mjs) over one source per call: the local `ctx.sessionQuery`, or —
 * with `remote` — another DSH instance's transcript routes (remote.mjs).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { clip, matchesTool, sessionName, sessionSummary, turnRows } from './model.mjs'
import { boundRows, commonParameters, dropUndefined, IntrospectError, normalizeFmt, renderAs, renderValue, writeOutFile } from './output.mjs'
import { renderEvent, renderExport, renderFind, renderGrep, renderOutline, renderRead, renderRow, renderStats } from './render.mjs'
import { parseSince } from './resolve.mjs'
import { SECTIONS, toolStats } from './stats.mjs'

const SESSION_PARAM = {
  type: 'string',
  description: '"<workspace>/<title>" (e.g. "widgets/fix-login-redirect"), a title, an id or id prefix, "latest:<workspace>", or omit for this session. Ambiguity lists the candidates.',
}
const SESSIONS_PARAM = {
  type: 'array',
  items: { type: 'string' },
  description: 'Several sessions: session spellings, "<workspace>/*", or "*" for all. Overrides session.',
}
const REMOTE_PARAM = {
  type: 'string',
  description: 'Read sessions of another instance over the tailnet instead of this one: a machine name ("node" = its release variant at /deepsea), "node/deepsea-personal" (another variant\'s Serve path), host:port, or a URL. Needs the same plugin on that instance; admission is this machine\'s tailnet login. Omit for the local instance.',
}
const SINCE_PARAM = { type: 'string', description: 'Only sessions created at/after this ISO date/time or within a relative window like "7d", "12h" (applies to sessions/"*" selections).' }
const UNTIL_PARAM = { type: 'string', description: 'Only sessions created before this ISO date/time (or "7d" = seven days ago). With since this brackets a cohort.' }
const GREP_KINDS = ['user', 'assistant', 'reasoning', 'call', 'result', 'inject', 'system']

/**
 * @param {object} deps
 * @param {any} deps.ctx - plugin Context (for ctx.fs / sandboxPolicy in out_file)
 * @param {ReturnType<import('./resolve.mjs').createResolver>} deps.resolver
 * @param {{ maxChars: number, maxResultChars: number, findLimit: number, grepLimit: number }} deps.limits
 * @param {(line: object) => void} [deps.trace]
 */
export function createTools({ ctx, resolver, limits, trace = () => {} }) {
  /** Shared tail of every execute: fmt validation, optional out_file redirect. */
  async function finish(exec, args, rawValue, spec, allowedFmts) {
    const fmt = normalizeFmt(args.fmt, allowedFmts)
    const value = dropUndefined(rawValue)
    if (typeof args.out_file === 'string' && args.out_file.trim() !== '') {
      const rendering = renderAs(fmt, value, spec)
      const handle = await writeOutFile(ctx, exec, args.out_file.trim(), fmt, rendering)
      trace({ event: 'out_file', path: handle.path, bytes: handle.bytes })
      return handle
    }
    return value
  }
  const maxCharsOf = (args) => Math.max(2000, Math.floor(args.max_chars ?? limits.maxChars))
  const maxResultCharsOf = (args) => Math.max(40, Math.floor(args.max_result_chars ?? limits.maxResultChars))
  const output = (spec) => ({ schema: { type: 'object', additionalProperties: true }, render: (args, value) => renderValue(args, value, spec) })

  // ---------------------------------------------------------------- find
  const findSpec = {
    text: renderFind,
    rows: (v) => ({ header: { query: v.query ?? null, remote: v.remote ?? null, total: v.total, truncated: v.truncated }, rows: v.sessions }),
  }
  const find = defineTool({
    name: 'transcript_find',
    description: 'List or look up DSH sessions (any workspace) by title, workspace, id or age, so another agent\'s transcript can be inspected with the other transcript_* tools. Returns id, workspace/title, creation time and whether the session is live (an agent is attached) and running (a turn is in progress now); active:true is the status view of the local instance or, with remote, of another one. Costs no log reads unless details:true (then also model, cwd, event/call/error counts and the number of registered tools per session).',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive substring over "workspace/title" and id (e.g. "widgets", "login", "2b81"). Omit to list everything.' },
      workspace: { type: 'string', description: 'Only this workspace (basename of the working directory, e.g. "widgets").' },
      since: SINCE_PARAM,
      until: UNTIL_PARAM,
      active: { type: 'boolean', description: 'Only sessions an agent is attached to right now (live); running ones are marked. The "what is going on there" view.' },
      details: { type: 'boolean', description: 'Read each listed session and add model, cwd, events, calls, errors and registered-tool count (one log read per session; the listing itself stays cheap without it).' },
      limit: { type: 'integer', description: `Maximum rows (default ${limits.findLimit}).` },
      remote: REMOTE_PARAM,
      ...commonParameters,
    },
    output: output(findSpec),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const src = await resolver.source(args.remote, exec.signal)
      const all = await resolver.listAll(src, { callerCwd: resolver.callerCwd(exec) }, exec.signal)
      const sinceMs = parseSince(args.since)
      const untilMs = parseSince(args.until, 'until')
      const q = (args.query ?? '').trim().toLowerCase()
      const ws = (args.workspace ?? '').trim().toLowerCase()
      let hits = all.filter(e => (ws === '' || e.workspace.toLowerCase() === ws)
        && (args.active !== true || e.live)
        && (sinceMs === null || (e.createdAt ?? 0) >= sinceMs)
        && (untilMs === null || (e.createdAt ?? 0) < untilMs)
        && (q === '' || `${e.workspace}/${e.title ?? ''}`.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)))
      const total = hits.length
      const limit = Math.max(1, Math.floor(args.limit ?? limits.findLimit))
      const truncated = Math.max(0, total - limit)
      hits = hits.slice(0, limit)
      const me = src.remote === null ? resolver.callerId(exec) : undefined
      const sessions = hits.map(e => ({ id: e.id, workspace: e.workspace, title: e.title, cwd: e.cwd ?? null, createdAt: e.createdAt, live: e.live, running: e.running, depth: e.depth, parent: e.parent, self: e.id === me }))
      if (args.details === true) {
        const { models, skipped } = await resolver.models(hits, exec.signal)
        const byId = new Map(models.map(m => [m.id, m]))
        const failed = new Map(skipped.map(s => [s.id, s.error]))
        for (const s of sessions) {
          const m = byId.get(s.id)
          if (m) Object.assign(s, { model: m.model?.model ?? null, provider: m.model?.provider ?? null, events: m.stats.events, turns: m.stats.turns, calls: m.stats.calls, errors: m.stats.errors, toolsAvailable: m.toolsAvailable.length, title: m.title ?? s.title })
          else if (failed.has(s.id)) s.readError = failed.get(s.id)
        }
      }
      const value = {
        query: args.query ?? null,
        remote: src.remote,
        active: args.active === true,
        total,
        truncated,
        details: args.details === true,
        sessions,
        hint: ws !== '' && total === 0 ? `Known workspaces: ${[...new Set(all.map(e => e.workspace))].sort().join(', ')}.` : undefined,
      }
      return finish(exec, args, value, findSpec)
    },
  })

  // ------------------------------------------------------------- outline
  const outlineSpec = {
    text: renderOutline,
    rows: (v) => ({ header: { session: v.session }, rows: v.turns, trailer: v.omitted ? { kind: 'omitted', ...v.omitted } : undefined }),
  }
  const outline = defineTool({
    name: 'transcript_outline',
    description: 'Per-turn table of contents of one session: for each turn its seq range, duration, step and tool-call counts (with error counts per tool), how the turn ended (completed / error with the provider message / aborted / open), and the user prompt. Start here, then zoom in with transcript_read using the seq ranges.',
    parameters: {
      session: SESSION_PARAM,
      turns: { type: 'string', description: 'Only these turns, e.g. "4" or "3-6". Default: all.' },
      max_prompt_chars: { type: 'integer', description: 'Prompt excerpt length per turn (default 160).' },
      max_chars: { type: 'integer', description: `Inline size budget for the rendering (default ${limits.maxChars}); later turns are omitted with a continuation hint. Lifted by out_file.` },
      remote: REMOTE_PARAM,
      ...commonParameters,
    },
    output: output(outlineSpec),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const entry = await resolver.resolve(await resolver.source(args.remote, exec.signal), args.session, exec, exec.signal)
      const m = await resolver.model(entry, exec.signal)
      let turns = turnRows(m, { maxPromptChars: Math.max(20, args.max_prompt_chars ?? 160) })
      const range = parseTurnRange(args.turns)
      if (range) turns = turns.filter(t => t.turn >= range.from && t.turn <= range.to)
      const value = { session: sessionSummary(m), turns, omitted: null }
      if (!args.out_file) {
        const fmt = normalizeFmt(args.fmt)
        const one = fmt === 'text' ? (t) => renderOutline({ session: value.session, turns: [t] }).split('\n').slice(1).join('\n') : (t) => JSON.stringify(t)
        const { kept, omitted } = boundRows(turns, one, maxCharsOf(args), 200, t => t.turn)
        value.turns = kept
        if (omitted) value.omitted = { count: omitted.count, from: omitted.seqFrom, to: omitted.seqTo }
      }
      return finish(exec, args, value, outlineSpec)
    },
  })

  // ---------------------------------------------------------------- read
  const readSpec = {
    text: renderRead,
    rows: (v) => ({ header: { session: v.session, range: v.range, filters: v.filters ?? null, raw: v.raw === true }, rows: v.events, trailer: v.omitted ? { kind: 'omitted', ...v.omitted } : undefined }),
  }
  const read = defineTool({
    name: 'transcript_read',
    description: 'Render part of a session as a compact timeline: one line per event — USER / ASSISTANT text, CALL tool args, RESULT ✓/✗ with wall latency, error code and a result excerpt, images as <image W×H type size>, turn markers with how the turn ended. Filter by turn or seq range, by tool name globs, or errors only. raw:true (json/jsonl only) emits the original event objects instead — with out_file that exports the decoded log for shell/python work.',
    parameters: {
      session: SESSION_PARAM,
      turn: { type: 'integer', description: 'Only this turn (see transcript_outline).' },
      seq_from: { type: 'integer', description: 'First event seq to include.' },
      seq_to: { type: 'integer', description: 'Last event seq to include.' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Only calls/results of these tools; globs allowed ("chrome_*", "*_screenshot"). User/assistant text and turn markers stay.' },
      errors_only: { type: 'boolean', description: 'Only failed calls (their CALL, RESULT and the assistant text right after), plus turn markers and prompts.' },
      include: { type: 'array', items: { type: 'string', enum: ['args', 'results', 'assistant', 'reasoning', 'injections', 'all'] }, description: 'Row classes to include. Default: args, results, assistant. Add "reasoning" for model reasoning blocks and "injections" for plugin/AGENTS.md context injections and the system prompt; "all" for everything.' },
      max_result_chars: { type: 'integer', description: `Excerpt length per text (default ${limits.maxResultChars}). Full text of one event: transcript_event.` },
      max_chars: { type: 'integer', description: `Inline size budget (default ${limits.maxChars}); later rows are omitted with a seq_from continuation hint. Lifted by out_file.` },
      raw: { type: 'boolean', description: 'Emit original event objects (json/jsonl only) instead of timeline rows.' },
      remote: REMOTE_PARAM,
      ...commonParameters,
    },
    output: output(readSpec),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const entry = await resolver.resolve(await resolver.source(args.remote, exec.signal), args.session, exec, exec.signal)
      const m = await resolver.model(entry, exec.signal)
      const fmt = normalizeFmt(args.fmt)
      const maxResult = maxResultCharsOf(args)
      const filters = []

      // seq range from turn / seq_from / seq_to
      let seqFrom = args.seq_from ?? -Infinity
      let seqTo = args.seq_to ?? Infinity
      let turnNo
      if (args.turn !== undefined && args.turn !== null) {
        const t = m.turns.find(x => x.turn === args.turn)
        if (!t) throw new IntrospectError(`Turn ${args.turn} does not exist (session has ${m.turns.length} turns${m.turns.length ? `, T${m.turns[0].turn}–T${m.turns.at(-1).turn}` : ''}).`)
        seqFrom = Math.max(seqFrom, t.seqFrom)
        seqTo = Math.min(seqTo, t.seqTo)
        turnNo = t.turn
        filters.push(`turn ${t.turn}`)
      }

      let rows
      if (args.raw === true) {
        if (fmt === 'text') throw new IntrospectError('raw: true needs fmt "json" or "jsonl".')
        rows = m.events.filter(e => e.seq >= seqFrom && e.seq <= seqTo).map(stripBinary)
        if (args.tools?.length) { rows = rows.filter(e => !(e.type === 'tool/call' || e.type === 'tool/result') || matchesTool(toolOfEvent(e, m), args.tools)); filters.push(`tools ${args.tools.join(',')}`) }
      } else {
        const include = new Set(args.include?.length ? args.include : ['args', 'results', 'assistant'])
        const all = include.has('all')
        let sel = m.rows.filter(r => r.seq >= seqFrom && r.seq <= seqTo)
        if (args.tools?.length) {
          sel = sel.filter(r => (r.kind !== 'call' && r.kind !== 'result') || matchesTool(r.tool, args.tools))
          filters.push(`tools ${args.tools.join(',')}`)
        }
        const reactions = new Set() // reasoning rows kept in errors_only mode even without include: reasoning
        if (args.errors_only === true) {
          const failing = new Set()
          for (let i = 0; i < sel.length; i++) {
            const r = sel[i]
            if (r.kind === 'result' && r.ok === false) {
              failing.add(r.seq)
              if (r.callId) { const c = sel.find(x => x.kind === 'call' && x.callId === r.callId); if (c) failing.add(c.seq) }
              // the agent's reaction: every reasoning / assistant row up to the next call
              for (let j = i + 1; j < sel.length; j++) {
                const x = sel[j]
                if (x.kind === 'call' || x.kind === 'result' || x.kind === 'turn-end' || x.kind === 'user') break
                if (x.kind === 'assistant' || x.kind === 'reasoning') { failing.add(x.seq); if (x.kind === 'reasoning') reactions.add(x.seq) }
              }
            }
          }
          const failingTurns = new Set(sel.filter(r => failing.has(r.seq)).map(r => r.turn))
          sel = sel.filter(r => failing.has(r.seq) || ((r.kind === 'turn-start' || r.kind === 'turn-end' || r.kind === 'user') && failingTurns.has(r.turn)))
          filters.push('errors only')
        }
        sel = sel.filter(r => {
          switch (r.kind) {
            case 'call': return all || include.has('args') || include.has('results')
            case 'result': return all || include.has('results')
            case 'assistant': return all || include.has('assistant')
            case 'reasoning': return all || include.has('reasoning') || reactions.has(r.seq)
            case 'inject': case 'instructions': case 'system': return all || include.has('injections')
            case 'other': return all
            default: return true
          }
        })
        rows = sel.map(r => eventRow(r, maxResult, include.has('args') || all))
      }

      const value = {
        session: sessionSummary(m),
        range: { seqFrom: Number.isFinite(seqFrom) ? seqFrom : (m.events[0]?.seq ?? 0), seqTo: Number.isFinite(seqTo) ? seqTo : (m.events.at(-1)?.seq ?? 0), ...turnNo !== undefined ? { turn: turnNo } : {} },
        filters: filters.length ? filters.join(', ') : undefined,
        maxResultChars: maxResult,
        raw: args.raw === true,
        events: rows,
        omitted: null,
      }
      if (!args.out_file) {
        const one = fmt === 'text' && !value.raw ? (r) => renderRow(r, { maxResultChars: maxResult }) : (r) => JSON.stringify(r)
        const { kept, omitted } = boundRows(rows, one, maxCharsOf(args), 300, r => r.seq)
        value.events = kept
        value.omitted = omitted
      }
      return finish(exec, args, value, readSpec)
    },
  })

  // --------------------------------------------------------------- stats
  const statsSpec = {
    text: renderStats,
    rows: (v) => ({ header: { scope: v.scope, afterError: v.afterError }, rows: v.tools }),
  }
  const stats = defineTool({
    name: 'transcript_tool_stats',
    description: 'How tools behaved for the agent(s) in one or many sessions: per tool the call count, error count and rate, sessions that used it vs sessions where it was registered (adoption), p50/p90 wall latency, the most frequent error messages (normalized so one bug is one row, with an example session/seq in json) each with the agent\'s reaction (the reasoning/assistant text right after the failure), and what the agent did next (retry identical, retry changed, switch tool). Opt-in sections: before_error, sequences (tool bigrams/trigrams), runs (same-tool streaks), duplicates (identical-args repeats), args (parameter shapes). split_at compares the per-tool table before/after a date. Use tools globs like ["chrome_*"] and sessions ["*"] for a corpus-wide view.',
    parameters: {
      session: SESSION_PARAM,
      sessions: SESSIONS_PARAM,
      tools: { type: 'array', items: { type: 'string' }, description: 'Only these tools; globs allowed. Default: all tools.' },
      since: SINCE_PARAM,
      until: UNTIL_PARAM,
      split_at: { type: 'string', description: 'ISO date/time (or "7d"): also report the per-tool table for sessions created before vs at/after this instant, side by side.' },
      sections: { type: 'array', items: { type: 'string', enum: [...SECTIONS, 'all'] }, description: 'Extra analytics: before_error, sequences, runs, duplicates, args, or "all". Default: none beyond the base table, reactions and after-error.' },
      top_errors: { type: 'integer', description: 'Error groups listed per tool (default 5).' },
      reactions: { type: 'integer', description: 'Agent reactions (reasoning/assistant text right after the failure) kept per error group (default 2; 0 disables).' },
      top_sequences: { type: 'integer', description: 'Bigrams/trigrams listed in the sequences section (default 15).' },
      remote: REMOTE_PARAM,
      ...commonParameters,
    },
    output: output(statsSpec),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const src = await resolver.source(args.remote, exec.signal)
      const entries = await resolver.select(src, args.sessions?.length ? args.sessions : args.session, exec, { since: args.since, until: args.until }, exec.signal)
      const { models, skipped } = await resolver.models(entries, exec.signal)
      const sections = args.sections?.includes('all') ? SECTIONS : (args.sections ?? [])
      const value = toolStats(models, {
        tools: args.tools,
        topErrors: Math.max(1, args.top_errors ?? 5),
        reactions: Math.max(0, Math.floor(args.reactions ?? 2)),
        sections,
        topSequences: Math.max(1, Math.floor(args.top_sequences ?? 15)),
        splitAt: parseSince(args.split_at, 'split_at'),
      })
      value.sessions = models.map(m => ({ id: m.id, workspace: m.workspace, title: m.title }))
      value.skipped = skipped
      if (src.remote !== null) value.remote = src.remote
      return finish(exec, args, value, statsSpec)
    },
  })

  // ---------------------------------------------------------------- grep
  const grepSpec = {
    text: renderGrep,
    rows: (v) => ({ header: { pattern: v.pattern, flags: v.flags, sessions: v.sessions, truncated: v.truncated }, rows: v.hits }),
  }
  const grep = defineTool({
    name: 'transcript_grep',
    description: 'Regular-expression search over the text of one or many sessions (prompts, assistant text, tool arguments, tool results, reasoning) with a short excerpt around each match and the seq to zoom in on with transcript_read / transcript_event.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'JavaScript regular expression (case-insensitive unless case_sensitive); an invalid regex is searched literally.' },
      session: SESSION_PARAM,
      sessions: SESSIONS_PARAM,
      kinds: { type: 'array', items: { type: 'string', enum: GREP_KINDS }, description: 'Only these row kinds ("system" = the system prompt as sent). Default: all but system.' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Only calls/results of these tools (globs).' },
      case_sensitive: { type: 'boolean', description: 'Match case (default false).' },
      context_chars: { type: 'integer', description: 'Excerpt characters on each side of the match (default 160).' },
      limit: { type: 'integer', description: `Maximum hits (default ${limits.grepLimit}).` },
      per_session_limit: { type: 'integer', description: 'Maximum hits per session, so one long session cannot crowd out the rest (default: unlimited).' },
      since: SINCE_PARAM,
      until: UNTIL_PARAM,
      remote: REMOTE_PARAM,
      ...commonParameters,
    },
    output: output(grepSpec),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const pattern = String(args.pattern ?? '')
      if (pattern.trim() === '') throw new IntrospectError('pattern must not be empty.')
      const flags = args.case_sensitive === true ? 'g' : 'gi'
      let re
      try { re = new RegExp(pattern, flags) } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) }
      const kinds = args.kinds?.length ? new Set(args.kinds) : null
      const ctxChars = Math.max(20, args.context_chars ?? 160)
      const limit = Math.max(1, Math.floor(args.limit ?? limits.grepLimit))
      const perSession = args.per_session_limit ? Math.max(1, Math.floor(args.per_session_limit)) : Infinity
      const src = await resolver.source(args.remote, exec.signal)
      const entries = await resolver.select(src, args.sessions?.length ? args.sessions : args.session, exec, { since: args.since, until: args.until }, exec.signal)
      const hits = []
      let truncated = false
      const sessions = []
      const skipped = []
      outer: for (const e of entries) {
        let m
        try {
          m = await resolver.model(e, exec.signal)
        } catch (error) {
          if (entries.length === 1 || exec.signal?.aborted) throw error
          skipped.push({ id: e.id, workspace: e.workspace, title: e.title, error: (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300) })
          continue
        }
        sessions.push({ id: m.id, workspace: m.workspace, title: m.title })
        let mine = 0
        for (const r of m.rows) {
          const kind = r.kind === 'instructions' || r.kind === 'checkpoint' ? 'inject' : r.kind
          if (kinds ? !kinds.has(kind) : kind === 'system') continue
          if ((r.kind === 'call' || r.kind === 'result') && args.tools?.length && !matchesTool(r.tool, args.tools)) continue
          const text = grepText(r)
          if (!text) continue
          re.lastIndex = 0
          const match = re.exec(text)
          if (!match) continue
          const start = Math.max(0, match.index - ctxChars)
          const end = Math.min(text.length, match.index + match[0].length + ctxChars)
          const hit = { session: m.id, seq: r.seq, kind, tool: r.tool ?? null, turn: r.turn ?? null }
          if (r.callId) hit.callId = r.callId
          if (r.kind === 'call') { hit.ok = r.call?.ok ?? null; hit.ms = r.call?.ms ?? null; if (r.call?.code) hit.code = r.call.code }
          if (r.kind === 'result') { hit.ok = r.ok; hit.ms = r.ms; if (r.code) hit.code = r.code }
          hit.excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim()
          hit.match = clip(match[0], 120)
          hits.push(hit)
          if (hits.length >= limit) { truncated = true; break outer }
          if (++mine >= perSession) break
        }
      }
      const value = { pattern, flags: flags.replace('g', ''), remote: src.remote ?? undefined, sessions, hits, truncated, skipped }
      return finish(exec, args, value, grepSpec)
    },
  })

  // --------------------------------------------------------------- event
  const eventSpec = { text: renderEvent }
  const event = defineTool({
    name: 'transcript_event',
    description: 'One complete raw event of a session by seq (the full tool result text, the exact arguments, the provider error…), optionally with summaries of the neighboring events. Large binary payloads are replaced by a size marker unless raw:true.',
    parameters: {
      session: SESSION_PARAM,
      seq: { type: 'integer', required: true, description: 'Event sequence number (from transcript_read / transcript_grep / transcript_outline).' },
      before: { type: 'integer', description: 'Summarize this many preceding events (0–20).' },
      after: { type: 'integer', description: 'Summarize this many following events (0–20).' },
      raw: { type: 'boolean', description: 'Keep binary payloads (base64) verbatim.' },
      remote: REMOTE_PARAM,
      fmt: { type: 'string', enum: ['text', 'json'], description: 'text (default) or json.' },
      out_file: commonParameters.out_file,
    },
    output: output(eventSpec),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const entry = await resolver.resolve(await resolver.source(args.remote, exec.signal), args.session, exec, exec.signal)
      const m = await resolver.model(entry, exec.signal)
      const idx = m.events.findIndex(e => e.seq === args.seq)
      if (idx < 0) throw new IntrospectError(`No event with seq ${args.seq} (log spans seq ${m.events[0]?.seq ?? '?'}–${m.events.at(-1)?.seq ?? '?'}).`)
      const ev = args.raw === true ? m.events[idx] : stripBinary(m.events[idx])
      const nb = (n) => Math.max(0, Math.min(20, Math.floor(n ?? 0)))
      const rowsBySeq = new Map(m.rows.map(r => [r.seq, r]))
      const neighbors = (from, to) => m.events.slice(from, to).map(e => rowsBySeq.get(e.seq) ? eventRow(rowsBySeq.get(e.seq), 120, true) : { seq: e.seq, kind: 'other', type: e.type, text: '' })
      const value = {
        session: sessionSummary(m),
        event: ev,
        before: neighbors(Math.max(0, idx - nb(args.before)), idx),
        after: neighbors(idx + 1, idx + 1 + nb(args.after)),
      }
      return finish(exec, args, value, eventSpec, ['text', 'json'])
    },
  })

  // -------------------------------------------------------------- export
  const exportSpec = {
    text: renderExport,
    rows: (v) => ({ header: { kinds: v.kinds, tools: v.tools ?? null, sessions: v.sessions, truncated: v.truncated, skipped: v.skipped }, rows: v.rows }),
  }
  const exportTool = defineTool({
    name: 'transcript_export',
    description: 'Export tool calls (each joined with its result: full parsed args, ok, error code, latency, result text) and optionally user/assistant/reasoning/inject/system rows from one or many sessions as jsonl for offline analysis (python, jq). Every row carries session id and workspace/title, so no header join is needed. Use out_file for anything beyond a few hundred rows; inline output is bounded by max_chars.',
    parameters: {
      session: SESSION_PARAM,
      sessions: SESSIONS_PARAM,
      since: SINCE_PARAM,
      until: UNTIL_PARAM,
      tools: { type: 'array', items: { type: 'string' }, description: 'Only calls of these tools (globs). Default: all tools.' },
      kinds: { type: 'array', items: { type: 'string', enum: ['call', 'user', 'assistant', 'reasoning', 'inject', 'system'] }, description: 'Row kinds to export. Default: ["call"] (one row per call, result joined in).' },
      errors_only: { type: 'boolean', description: 'Only failed calls.' },
      max_result_chars: { type: 'integer', description: 'Result text kept per call row (default 400; 0 drops result text, keeping only resultChars).' },
      max_text_chars: { type: 'integer', description: 'Text kept per non-call row (default 2000).' },
      limit: { type: 'integer', description: 'Maximum rows (default 5000).' },
      max_chars: { type: 'integer', description: `Inline size budget when out_file is not given (default ${limits.maxChars}).` },
      remote: REMOTE_PARAM,
      ...commonParameters,
    },
    output: output(exportSpec),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const kinds = new Set(args.kinds?.length ? args.kinds : ['call'])
      const maxResult = Math.max(0, Math.floor(args.max_result_chars ?? 400))
      const maxText = Math.max(40, Math.floor(args.max_text_chars ?? 2000))
      const limit = Math.max(1, Math.floor(args.limit ?? 5000))
      const src = await resolver.source(args.remote, exec.signal)
      const entries = await resolver.select(src, args.sessions?.length ? args.sessions : args.session, exec, { since: args.since, until: args.until }, exec.signal)
      const { models, skipped } = await resolver.models(entries, exec.signal)
      const rows = []
      let truncated = false
      outer: for (const m of models) {
        const name = sessionName(m)
        for (const r of m.rows) {
          let row = null
          if (r.kind === 'call') {
            if (!kinds.has('call')) continue
            if (args.tools?.length && !matchesTool(r.tool, args.tools)) continue
            const c = r.call
            if (args.errors_only === true && c.ok !== false) continue
            row = {
              kind: 'call', session: m.id, sessionName: name, seq: r.seq, turn: r.turn, step: r.step, time: r.time, tool: r.tool, callId: r.callId,
              args: c.argsObj ?? c.args, argsChars: c.args.length,
              ok: c.ok, code: c.code, ms: c.ms, resultSeq: c.resultSeq, resultChars: c.text.length,
              ...maxResult > 0 ? { result: c.text.length > maxResult ? `${c.text.slice(0, maxResult - 1)}…` : c.text } : {},
              ...c.reason && c.reason !== c.text ? { reason: clip(c.reason, maxResult || 200) } : {},
              ...c.images?.length ? { images: c.images } : {},
            }
          } else {
            const kind = r.kind === 'instructions' || r.kind === 'checkpoint' ? 'inject' : r.kind
            if (!kinds.has(kind) || args.errors_only === true) continue
            row = { kind, session: m.id, sessionName: name, seq: r.seq, turn: r.turn ?? null, time: r.time, ...r.plugin ? { plugin: r.plugin } : {}, text: r.text.length > maxText ? `${r.text.slice(0, maxText - 1)}…` : r.text, textChars: r.text.length }
          }
          rows.push(row)
          if (rows.length >= limit) { truncated = true; break outer }
        }
      }
      const value = {
        kinds: [...kinds],
        tools: args.tools ?? null,
        remote: src.remote ?? undefined,
        sessions: models.map(m => ({ id: m.id, workspace: m.workspace, title: m.title, toolsAvailable: m.toolsAvailable })),
        rows,
        limit,
        truncated,
        skipped,
      }
      if (!args.out_file) {
        const fmt = normalizeFmt(args.fmt)
        const one = fmt === 'text' ? (r) => renderExport({ ...value, rows: [r] }).split('\n')[1] ?? '' : (r) => JSON.stringify(r)
        const { kept, omitted } = boundRows(rows, one, maxCharsOf(args), 400, r => r.seq)
        value.rows = kept
        if (omitted) { value.truncated = true; value.omitted = omitted }
      }
      return finish(exec, args, value, exportSpec)
    },
  })

  return [find, outline, read, stats, grep, event, exportTool]
}

// ------------------------------------------------------------------ helpers

/** Canonical (plain) event row from a model row; `call` back-references dropped, texts clipped honestly. */
function eventRow(r, maxChars, withArgs) {
  const out = { seq: r.seq, kind: r.kind, time: r.time }
  if (r.turn !== undefined && r.turn !== null) out.turn = r.turn
  if (r.step !== undefined && r.step !== null) out.step = r.step
  if (r.tool) out.tool = r.tool
  if (r.callId) out.callId = r.callId
  if (r.kind === 'call') { out.args = withArgs ? clip(r.args, maxChars) : undefined; out.argsChars = r.args.length }
  if (r.kind === 'result') { out.ok = r.ok; out.ms = r.ms; if (r.code) out.code = r.code; if (r.reason) out.reason = clip(r.reason, maxChars) }
  if (r.kind === 'turn-end') { out.ended = r.ended; out.ms = r.ms }
  if (r.plugin) out.plugin = r.plugin
  if (r.type) out.type = r.type
  if (typeof r.text === 'string' && r.text !== '') { out.text = clip(r.text, maxChars); out.textChars = r.text.length }
  if (r.images?.length) out.images = r.images
  return out
}

function grepText(r) {
  switch (r.kind) {
    case 'call': return r.args
    case 'result': return r.reason && r.reason !== r.text ? `${r.text}\n${r.reason}` : r.text
    case 'user': case 'assistant': case 'reasoning': case 'inject': case 'instructions': case 'checkpoint': case 'system': case 'other': case 'title': case 'approval': case 'retry': case 'command': return r.text
    default: return ''
  }
}

function toolOfEvent(e, m) {
  if (e.type === 'tool/call') return e.data?.name ?? '?'
  const callId = e.data?.message?.source?.callId
  return m.calls.find(c => c.callId === callId)?.tool ?? '?'
}

/** Replace long base64-looking string fields by a size marker (deep copy). */
export function stripBinary(value) {
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (v.length > 2000 && (key === 'data' || key === 'base64' || /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 200)))) return `<binary ${v.length} chars omitted>`
      return v
    }
    if (Array.isArray(v)) return v.map(x => walk(x, key))
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = walk(x, k); return o }
    return v
  }
  return walk(value, '')
}

/** `"4"` → {4,4}; `"3-6"` → {3,6}. */
function parseTurnRange(spec) {
  if (spec === undefined || spec === null || String(spec).trim() === '') return null
  const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(String(spec))
  if (!m) throw new IntrospectError(`turns "${spec}" must be "N" or "N-M".`)
  const from = Number(m[1])
  const to = m[2] === undefined ? from : Number(m[2])
  return { from: Math.min(from, to), to: Math.max(from, to) }
}
