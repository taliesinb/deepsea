/**
 * The analysis-oriented additions: tool availability from request/header, the
 * system prompt as a row, agent reactions after errors, opt-in stats sections
 * (before_error / sequences / runs / duplicates / args), split_at, until,
 * transcript_export, transcript_find details, grep row fields and
 * per_session_limit. Synthetic logs, so every number is known.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Config, build } from '../index.js'
import { buildModel } from '../model.mjs'
import { NOTICE } from '../output.mjs'
import { reactionsTo, toolStats } from '../stats.mjs'
import { fakeCtx, fakeExec, textOf } from './fake-ctx.mjs'

const T0 = Date.parse('2026-09-10T10:00:00Z')
const SPLIT = '2026-09-16T23:30:00Z'

/** A tiny log writer: `call(tool, args, { ok, text, reasoning, said })` emits call + result (+ the reaction). */
function log(id, { cwd, createdAt, tools, title }) {
  const events = []
  let seq = 0
  let time = createdAt
  const turn = 1
  const push = (type, data) => { events.push({ type, seq: seq++, time: (time += 1000), data }); return events.at(-1) }
  push('permission/preset', { preset: 'workspace-write' })
  push('turn/start', { turn })
  push('user/message', { content: [{ type: 'text', text: 'do the thing' }], source: { kind: 'user' } })
  push('system/message', { turn, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are an AI agent. Batch filesystem tools: use list_dir.' }] } })
  push('request/header', { header: { config: { provider: 'anthropic', model: 'test-model' }, tools: tools.map(name => ({ name, description: '', parameters: {} })) } })
  if (title) push('session/title', { title })
  let n = 0
  const call = (tool, args, { ok = true, text = 'ok', reasoning, said } = {}) => {
    const callId = `c${n++}`
    push('assistant/message', { turn, step: n, message: { role: 'assistant', content: [{ type: 'tool-call', callId, name: tool }] } })
    push('tool/call', { turn, step: n, callId, name: tool, arguments: JSON.stringify(args) })
    push('tool/result', { turn, step: n, message: { role: 'tool', source: { callId }, content: [{ type: 'tool-result', isError: !ok, content: text }] }, ...ok ? {} : { error: { code: 'E_TEST', reason: text } } })
    if (reasoning || said) {
      const content = []
      if (reasoning) content.push({ type: 'reasoning', text: reasoning })
      if (said) content.push({ type: 'text', text: said })
      push('assistant/message', { turn, step: n, message: { role: 'assistant', content } })
    }
  }
  const end = () => { push('turn/end', { turn, reason: { kind: 'completed' } }); return { session: { id, cwd, createdAt }, events } }
  return { call, end, push }
}

const TOOLS_A = ['bash', 'read', 'edit', 'edit_many', 'read_many', 'list_dir']
const TOOLS_B = ['bash', 'read', 'edit', 'write']

// session A (after SPLIT): edit_many available and used, a failure with a reaction, runs and duplicates
const A = 'session-aaaa1111-0000-0000-0000-000000000001'
const a = log(A, { cwd: '/w/tensatory', createdAt: Date.parse(SPLIT) + 60_000, tools: TOOLS_A, title: 'after-mount' })
a.call('read', { file_path: 'x.ts' })
a.call('edit_many', { edits: [{ file_path: 'x.ts', old_string: 'a', new_string: 'b' }, { file_path: 'y.ts', old_string: 'c', new_string: 'd' }] }, { ok: false, text: 'edit_many: 1 problem, nothing written: #2 cannot modify "y.ts": file has not been read', reasoning: 'y.ts was never read; I will read it and resend the batch.', said: 'Reading y.ts first.' })
a.call('read', { file_path: 'y.ts' })
a.call('edit_many', { edits: [{ file_path: 'x.ts', old_string: 'a', new_string: 'b' }, { file_path: 'y.ts', old_string: 'c', new_string: 'd' }] })
a.call('bash', { command: 'pnpm typecheck' })
a.call('bash', { command: 'pnpm typecheck' })
a.call('bash', { command: 'pnpm test' })
a.call('bash', { command: 'pnpm typecheck' })
a.call('list_dir', { paths: ['.'], depth: 2 })
a.call('bash', { command: 'cat big.log' }, { text: 'x'.repeat(3000) })
const snapA = a.end()

// session B (before SPLIT): no edit_many registered; an edit failure whose reaction is a bash fallback
const B = 'session-bbbb2222-0000-0000-0000-000000000002'
const b = log(B, { cwd: '/w/tensatory', createdAt: T0, tools: TOOLS_B, title: 'before-mount' })
b.call('read', { file_path: 'x.ts', offset: 10, limit: 40 })
b.call('edit', { file_path: 'x.ts', old_string: 'a', new_string: 'b' }, { ok: false, text: 'cannot edit "x.ts": file changed since it was read', reasoning: 'Stale again. I will patch it with python instead.' })
b.call('bash', { command: "python3 - <<'EOF'\nopen('x.ts','w').write('b')\nEOF" })
b.call('read', { file_path: 'x.ts', offset: 10, limit: 40 })
b.call('edit', { file_path: 'x.ts', old_string: 'b', new_string: 'c' })
const snapB = b.end()

const root = mkdtempSync(join(tmpdir(), 'si-analytics-'))
const ctx = fakeCtx({ snapshots: [snapA, snapB], workspaceRoot: root })
const { tools } = build(ctx, Config({}))
const tool = (name) => tools.find(t => t.name === name)
const exec = fakeExec(A, '/w/tensatory')
const run = (name, args) => tool(name).execute(args, exec)

test.after(() => rmSync(root, { recursive: true, force: true }))

test('model: tools available from request/header, system prompt row, reactions after a failed call', () => {
  const m = buildModel(snapA)
  assert.deepEqual(m.toolsAvailable, [...TOOLS_A].sort())
  assert.equal(typeof m.toolFirstSeen.edit_many, 'number')
  const sys = m.rows.find(r => r.kind === 'system')
  assert.match(sys.text, /Batch filesystem tools/)
  assert.equal(m.systemPromptSeq, sys.seq)
  const failed = m.calls.find(c => c.ok === false)
  const re = reactionsTo(m, failed)
  assert.deepEqual(re.map(r => r.kind), ['reasoning', 'assistant'])
  assert.match(re[0].text, /never read/)
})

test('tool_stats: used/available adoption column, unused tools, reactions under each error group', async () => {
  const v = await run('transcript_tool_stats', { sessions: ['*'] })
  const em = v.tools.find(t => t.tool === 'edit_many')
  assert.equal(em.sessions, 1)
  assert.equal(em.available, 1, 'edit_many was registered in one of two sessions')
  const bash = v.tools.find(t => t.tool === 'bash')
  assert.equal(bash.available, 2)
  assert.deepEqual(v.unused.map(u => u.tool), ['read_many', 'write'])
  assert.equal(em.topErrors[0].reactions.length, 2)
  assert.equal(em.topErrors[0].reactions[0].kind, 'reasoning')
  assert.equal(em.topErrors[0].reactions[0].session, A)
  const text = textOf(tool('transcript_tool_stats'), {}, v)
  assert.match(text, /used\/avail/)
  assert.match(text, /edit_many\s+2\s+1\s+50%\s+1\/1/)
  assert.match(text, /registered but never called: read_many \(1\), write \(1\)/)
  assert.match(text, /agent reactions right after an error/)
  assert.match(text, /THOUGHT "y\.ts was never read/)
  assert.match(text, /SAID "Reading y\.ts first\."/)
  assert.match(text, /THOUGHT "Stale again\. I will patch it with python instead\."/)
  const none = await run('transcript_tool_stats', { sessions: ['*'], reactions: 0 })
  assert.equal(none.tools.find(t => t.tool === 'edit_many').topErrors[0].reactions.length, 0)
  assert.ok(!textOf(tool('transcript_tool_stats'), {}, none).includes('agent reactions'))
})

test('tool_stats sections: before_error, sequences, runs, duplicates, args', async () => {
  const v = await run('transcript_tool_stats', { sessions: ['*'], sections: ['all'] })
  assert.deepEqual(v.scope.sections, ['before_error', 'sequences', 'runs', 'duplicates', 'args'])
  // before_error: read → edit_many ✗ and read → edit ✗
  assert.deepEqual(v.beforeError.map(b => `${b.prev}→${b.tool}`).sort(), ['read→edit', 'read→edit_many'])
  // sequences: same-tool pairs excluded, bigrams counted over both sessions
  assert.equal(v.sequences.sameToolPairs, 3, 'bash ×4 in A = 3 same-tool adjacencies; none in B')
  const bi = Object.fromEntries(v.sequences.bigrams.map(x => [x.tools.join('→'), x.count]))
  assert.equal(bi['read→edit_many'], 2)
  assert.equal(bi['read→edit'], 2)
  assert.equal(bi['edit_many→bash'], 1)
  assert.ok(v.sequences.trigrams.find(t => t.tools.join('→') === 'read→edit_many→read'))
  // runs: bash ×4 in one turn
  const bashRun = v.runs.find(r => r.tool === 'bash')
  assert.equal(bashRun.maxRun.len, 4)
  assert.equal(bashRun.maxRun.session, A)
  assert.equal(bashRun.callsInRuns3, 4)
  assert.ok(!v.runs.find(r => r.tool === 'read'), 'tools without a run ≥ 3 are not listed')
  // duplicates: `pnpm typecheck` ×3 in A, read x.ts range ×2 in B
  const dupBash = v.duplicates.find(d => d.tool === 'bash')
  assert.equal(dupBash.extraCalls, 2)
  assert.equal(dupBash.top[0].count, 3)
  const dupRead = v.duplicates.find(d => d.tool === 'read')
  assert.equal(dupRead.extraCalls, 1)
  // args: edit_many edits array median 2; read offset present in 2 of 4 calls
  const em = v.args.find(x => x.tool === 'edit_many')
  assert.equal(em.keys[0].key, 'edits')
  assert.equal(em.keys[0].arrayMedianLen, 2)
  assert.equal(em.keys[0].pct, 1)
  const rd = v.args.find(x => x.tool === 'read')
  assert.equal(rd.keys.find(k => k.key === 'offset').count, 2)
  assert.equal(rd.keys.find(k => k.key === 'offset').pct, 0.5)
  const text = textOf(tool('transcript_tool_stats'), {}, v)
  assert.match(text, /before an error, the previous call was:\n {2}read → edit(_many)? ✗ ×1/)
  assert.match(text, /tool sequences \(13 adjacent pairs, 3 same-tool repeats excluded/)
  assert.match(text, /same-tool runs within a turn/)
  assert.match(text, /bash\s+6\s+3\s+1\s+4\s+67%\s+4 @ session-aaaa1111 seq \d+/)
  assert.match(text, /identical-args repeats within one session:\n {2}bash: 1 group, 2 extra calls/)
  assert.match(text, /parameter shapes[\s\S]*edit_many \(2\): edits 100% \[med 2, max 2\]/)
  const some = await run('transcript_tool_stats', { sessions: ['*'], sections: ['runs'] })
  assert.ok(some.runs && !some.sequences && !some.duplicates && !some.args && !some.beforeError)
})

test('tool_stats split_at and since/until: cohort tables', async () => {
  const v = await run('transcript_tool_stats', { sessions: ['*'], split_at: SPLIT })
  assert.equal(v.split.before.sessions, 1)
  assert.equal(v.split.after.sessions, 1)
  assert.ok(!v.split.before.tools.find(t => t.tool === 'edit_many'))
  assert.equal(v.split.after.tools.find(t => t.tool === 'edit_many').calls, 2)
  assert.equal(v.split.before.tools.find(t => t.tool === 'edit').errorRate, 0.5)
  const text = textOf(tool('transcript_tool_stats'), {}, v)
  assert.match(text, /split at \d\d-\d\d \d\d:\d\d: before 1 sessions \/ 5 calls \/ 1 errors · after 1 sessions \/ 10 calls \/ 1 errors/)
  assert.match(text, /tool\s+before\s+share\s+err%\s+p50\s+after\s+share\s+err%\s+p50/)
  const pre = await run('transcript_tool_stats', { sessions: ['*'], until: SPLIT })
  assert.deepEqual(pre.sessions.map(s => s.id), [B])
  const post = await run('transcript_tool_stats', { sessions: ['*'], since: SPLIT })
  assert.deepEqual(post.sessions.map(s => s.id), [A])
  await assert.rejects(run('transcript_tool_stats', { sessions: ['*'], since: SPLIT, until: '2026-09-10T10:00:00Z' }), /until .* must be later than since/)
  await assert.rejects(run('transcript_tool_stats', { sessions: ['*'], split_at: 'yesterday-ish' }), /split_at "yesterday-ish" is not an ISO date/)
})

test('transcript_export: joined call rows with parsed args and result facts; kinds; errors_only; until; out_file', async () => {
  const v = await run('transcript_export', { sessions: ['*'] })
  assert.equal(v.rows.length, 15)
  const big = v.rows.find(r => r.args.command === 'cat big.log')
  assert.equal(big.resultChars, 3000)
  assert.equal(big.result.length, 400, 'result text clipped to max_result_chars')
  assert.ok(v.rows.every(r => r.kind === 'call' && r.sessionName && typeof r.args === 'object'))
  const failed = v.rows.filter(r => r.ok === false)
  assert.equal(failed.length, 2)
  assert.equal(failed[0].code, 'E_TEST')
  assert.equal(failed[0].tool, 'edit_many')
  assert.equal(failed[0].args.edits.length, 2)
  assert.match(failed[0].result, /nothing written/)
  assert.equal(typeof failed[0].ms, 'number')
  assert.equal(failed[0].resultSeq, failed[0].seq + 1)
  assert.deepEqual(v.sessions.find(s => s.id === A).toolsAvailable, [...TOOLS_A].sort())
  const onlyErr = await run('transcript_export', { sessions: ['*'], errors_only: true, tools: ['edit*'] })
  assert.equal(onlyErr.rows.length, 2)
  const texts = await run('transcript_export', { sessions: ['*'], kinds: ['reasoning', 'system'], until: SPLIT })
  assert.deepEqual(texts.rows.map(r => r.kind), ['system', 'reasoning'])
  assert.equal(texts.rows[0].session, B)
  const noResult = await run('transcript_export', { session: A, max_result_chars: 0 })
  assert.ok(noResult.rows.every(r => r.result === undefined && typeof r.resultChars === 'number'))
  const text = textOf(tool('transcript_export'), {}, v)
  assert.match(text, /^Transcript content[^\n]*\n15 rows \(call\) from 2 sessions/)
  assert.match(text, /session-aaaa1111 \[\d+\] T1 edit_many ✗ \d+(\.\d)?s code=E_TEST \{"edits":/)
  const h = await run('transcript_export', { sessions: ['*'], fmt: 'jsonl', out_file: 'calls.jsonl' })
  const lines = readFileSync(h.path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 16)
  const header = JSON.parse(lines[0])
  assert.equal(header.kind, 'header')
  assert.deepEqual(header.kinds, ['call'])
  assert.equal(JSON.parse(lines[1]).kind, 'call')
  const bounded = await run('transcript_export', { sessions: ['*'], max_chars: 2000 })
  assert.ok(bounded.rows.length < 15 && bounded.truncated === true && bounded.omitted, `inline export is bounded (${bounded.rows.length} rows kept)`)
  assert.match(textOf(tool('transcript_export'), {}, bounded), /truncated at limit/)
  const limited = await run('transcript_export', { sessions: ['*'], limit: 3 })
  assert.equal(limited.rows.length, 3)
  assert.equal(limited.truncated, true)
})

test('transcript_find details: model, counts, registered tools, until', async () => {
  const cheap = await run('transcript_find', {})
  assert.equal(cheap.sessions[0].model, undefined)
  const v = await run('transcript_find', { details: true })
  const sa = v.sessions.find(s => s.id === A)
  assert.equal(sa.model, 'test-model')
  assert.equal(sa.calls, 10)
  assert.equal(sa.errors, 1)
  assert.equal(sa.toolsAvailable, TOOLS_A.length)
  assert.equal(sa.title, 'after-mount')
  const text = textOf(tool('transcript_find'), {}, v)
  assert.match(text, /model\s+events\s+calls\s+err\s+tools\s+cwd/)
  assert.match(text, /test-model\s+\d+\s+10\s+1\s+6\s+\/w\/tensatory/)
  const older = await run('transcript_find', { until: SPLIT })
  assert.deepEqual(older.sessions.map(s => s.id), [B])
})

test('transcript_grep: call/result rows carry callId/ok/ms/code; system kind opt-in; per_session_limit', async () => {
  const res = await run('transcript_grep', { pattern: 'nothing written|file changed', sessions: ['*'], kinds: ['result'] })
  assert.equal(res.hits.length, 2)
  for (const h of res.hits) { assert.equal(h.ok, false); assert.equal(h.code, 'E_TEST'); assert.equal(typeof h.ms, 'number'); assert.ok(h.callId) }
  const calls = await run('transcript_grep', { pattern: 'edits', sessions: ['*'], kinds: ['call'] })
  assert.ok(calls.hits.length >= 2)
  assert.equal(calls.hits[0].ok, false, 'call rows report their own result status')
  assert.equal(calls.hits[1].ok, true)
  const noSys = await run('transcript_grep', { pattern: 'Batch filesystem', sessions: ['*'] })
  assert.equal(noSys.hits.length, 0, 'the system prompt is not searched unless asked')
  const sys = await run('transcript_grep', { pattern: 'Batch filesystem', sessions: ['*'], kinds: ['system'] })
  assert.equal(sys.hits.length, 2)
  const capped = await run('transcript_grep', { pattern: 'pnpm', sessions: ['*'], kinds: ['call'], per_session_limit: 1 })
  assert.equal(capped.hits.length, 1)
  const uncapped = await run('transcript_grep', { pattern: 'pnpm', sessions: ['*'], kinds: ['call'] })
  assert.equal(uncapped.hits.length, 4)
})

test('transcript_read errors_only keeps the reasoning right after a failure; injections include the system prompt', async () => {
  const v = await run('transcript_read', { session: B, errors_only: true })
  const kinds = v.events.map(e => e.kind)
  assert.ok(kinds.includes('reasoning'), `reasoning row kept without include: reasoning (${kinds})`)
  const reasoning = v.events.find(e => e.kind === 'reasoning')
  assert.match(reasoning.text, /patch it with python/)
  assert.ok(!v.events.some(e => e.kind === 'result' && e.ok === true))
  const text = textOf(tool('transcript_read'), {}, v)
  assert.match(text, /RESULT ✗[^\n]*\n\[\d+\]\s+REASONING T1 S2 "Stale again/)
  const plain = await run('transcript_read', { session: B })
  assert.ok(!plain.events.some(e => e.kind === 'reasoning' || e.kind === 'system'), 'default read shows neither reasoning nor the system prompt')
  const inj = await run('transcript_read', { session: B, include: ['injections'] })
  const sys = inj.events.find(e => e.kind === 'system')
  assert.ok(sys)
  assert.match(textOf(tool('transcript_read'), {}, inj), /SYSTEM T1 S1 "You are an AI agent/)
})

test('canonical values stay lossless JSON with the new fields', async () => {
  for (const [name, args] of [
    ['transcript_tool_stats', { sessions: ['*'], sections: ['all'], split_at: SPLIT }],
    ['transcript_export', { sessions: ['*'], kinds: ['call', 'reasoning'] }],
    ['transcript_find', { details: true }],
    ['transcript_grep', { pattern: 'edit', sessions: ['*'] }],
  ]) {
    const v = await run(name, args)
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v, name)
    assert.ok(textOf(tool(name), {}, v).startsWith(NOTICE))
  }
})

test('toolStats without any request/header reports available as null and no unused list', () => {
  const m = buildModel({ session: { id: 's', cwd: '/w' }, events: snapB.events.filter(e => e.type !== 'request/header') })
  const v = toolStats([m])
  assert.equal(v.tools[0].available, null)
  assert.deepEqual(v.unused, [])
})
