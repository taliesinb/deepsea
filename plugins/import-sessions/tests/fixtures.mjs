/** Synthetic Claude Code and pi transcripts covering the shapes the readers must handle. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Scratch directories this test process made, removed when it exits. */
const made = []
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
/** A scratch directory `$TMPDIR/deepsea-import-sessions-<what>-…`. */
export function scratch(what) {
  const dir = mkdtempSync(join(tmpdir(), `deepsea-import-sessions-${what}-`))
  made.push(dir)
  return dir
}

const lines = records => records.map(r => JSON.stringify(r)).join('\n') + '\n'

/**
 * A Claude Code store: one project with one session (2 turns, a tool call
 * pair, a per-block assistant run, an interrupt, an image, injected noise, a
 * duplicate record, an ai-title) plus one subagent transcript; and a
 * `.jsonl.backup` and `memory/` that must be ignored.
 */
export function claudeStore() {
  const root = scratch('claude-store')
  const cwd = scratch('claude-cwd')
  const slug = cwd.replace(/[/.]/g, '-')
  const dir = join(root, slug)
  mkdirSync(dir)
  mkdirSync(join(dir, 'memory'))
  writeFileSync(join(dir, 'memory', 'notes.md'), '# memory\n')
  const sessionId = '11111111-2222-4333-8444-555555555555'
  const t = i => new Date(Date.UTC(2026, 7, 6, 10, 0, i)).toISOString()
  const base = { cwd, sessionId, version: '1.0.0' }
  const records = [
    { type: 'file-history-snapshot', messageId: 'x', snapshot: {} },
    { ...base, type: 'user', uuid: 'u1', timestamp: t(0), message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>ignore me</system-reminder>' }, { type: 'text', text: 'Hello, build the thing' }] } },
    { ...base, type: 'assistant', uuid: 'a1', timestamp: t(1), message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, content: [{ type: 'thinking', thinking: 'planning' }] } },
    { ...base, type: 'assistant', uuid: 'a2', timestamp: t(1), message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Sure.' }] } },
    { ...base, type: 'assistant', uuid: 'a3', timestamp: t(1), message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }] } },
    { ...base, type: 'assistant', uuid: 'a3', timestamp: t(1), message: { id: 'msg_1', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }] } }, // duplicate uuid
    { ...base, type: 'user', uuid: 'u2', timestamp: t(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt\nb.txt' }] } },
    { ...base, type: 'assistant', uuid: 'a4', timestamp: t(3), message: { id: 'msg_2', model: 'claude-x', usage: { input_tokens: 20, output_tokens: 7 }, content: [{ type: 'text', text: 'Two files.' }] } },
    { type: 'ai-title', aiTitle: 'Build the thing', sessionId },
    { ...base, type: 'user', uuid: 'u3', timestamp: t(4), message: { role: 'user', content: [{ type: 'text', text: 'Now look at this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } }] } },
    { ...base, type: 'assistant', uuid: 'a5', timestamp: t(5), message: { id: 'msg_3', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_2', name: 'read', input: { file_path: '/x' } }] } },
    { ...base, type: 'user', uuid: 'u4', timestamp: t(6), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
    { ...base, type: 'user', uuid: 'u5', timestamp: t(7), isSidechain: true, message: { role: 'user', content: 'sidechain prompt (old-style inline subagent)' } },
    { ...base, type: 'user', uuid: 'u6', timestamp: t(8), message: { role: 'user', content: 'Final question' } },
    { ...base, type: 'assistant', uuid: 'a6', timestamp: t(9), message: { id: 'msg_4', model: 'claude-x', content: [{ type: 'text', text: 'Final answer' }] } },
  ]
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines(records))
  writeFileSync(join(dir, `${sessionId}.jsonl.backup`), lines(records.slice(0, 3)))
  mkdirSync(join(dir, sessionId, 'subagents'), { recursive: true })
  writeFileSync(join(dir, sessionId, 'subagents', 'agent-abc.jsonl'), lines([
    { ...base, type: 'user', uuid: 's1', timestamp: t(5), isSidechain: true, agentId: 'abc', message: { role: 'user', content: 'Subtask: count files' } },
    { ...base, type: 'assistant', uuid: 's2', timestamp: t(5), isSidechain: true, agentId: 'abc', message: { id: 'msg_s1', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_s', name: 'bash', input: { command: 'ls | wc -l' } }] } },
    { ...base, type: 'user', uuid: 's3', timestamp: t(6), isSidechain: true, agentId: 'abc', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: [{ type: 'text', text: '2' }] }] } },
    { ...base, type: 'assistant', uuid: 's4', timestamp: t(6), isSidechain: true, agentId: 'abc', message: { id: 'msg_s2', model: 'claude-x', content: [{ type: 'text', text: 'There are 2 files.' }] } },
  ]))
  return { root, cwd, slug, dir, sessionId, file: join(dir, `${sessionId}.jsonl`) }
}

/**
 * A pi store: one workspace dir with one branching session (a fork whose
 * abandoned branch must be dropped), a tool pair, an image tool result, a
 * compaction record, a session_info rename; plus a second session whose cwd
 * no longer exists.
 */
export function piStore() {
  const root = scratch('pi-store')
  const cwd = scratch('pi-cwd')
  const slug = `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`
  const dir = join(root, slug)
  mkdirSync(dir)
  const id = '01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee'
  const ts = i => new Date(Date.UTC(2026, 7, 27, 15, 0, i)).toISOString()
  const ms = i => Date.UTC(2026, 7, 27, 15, 0, i)
  const records = [
    { type: 'session', version: 3, id, timestamp: ts(0), cwd },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: ts(0), provider: 'anthropic', modelId: 'claude-opus' },
    { type: 'thinking_level_change', id: 't1', parentId: 'm1', timestamp: ts(0), thinkingLevel: 'medium' },
    { type: 'message', id: 'u1', parentId: 't1', timestamp: ts(1), message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }], timestamp: ms(1) } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } }], provider: 'anthropic', model: 'claude-opus', usage: { input: 5, output: 9, cacheRead: 1, cacheWrite: 2, totalTokens: 17 }, stopReason: 'toolUse', timestamp: ms(2) } },
    { type: 'custom', id: 'c1', parentId: 'a1', timestamp: ts(2), customType: 'pi-checkpoint', data: {} },
    { type: 'message', id: 'r1', parentId: 'c1', timestamp: ts(3), message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'a b' }, { type: 'image', data: PNG_1X1, mimeType: 'image/png' }], isError: false, timestamp: ms(3) } },
    { type: 'message', id: 'a2', parentId: 'r1', timestamp: ts(4), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], provider: 'anthropic', model: 'claude-opus', usage: { input: 5, output: 2 }, stopReason: 'stop', timestamp: ms(4) } },
    // abandoned branch: an edited second prompt
    { type: 'message', id: 'u2x', parentId: 'a2', timestamp: ts(5), message: { role: 'user', content: [{ type: 'text', text: 'ABANDONED second prompt' }], timestamp: ms(5) } },
    { type: 'message', id: 'a3x', parentId: 'u2x', timestamp: ts(6), message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned answer' }], stopReason: 'stop', timestamp: ms(6) } },
    // main branch continues later
    { type: 'message', id: 'u2', parentId: 'a2', timestamp: ts(7), message: { role: 'user', content: [{ type: 'text', text: 'second prompt' }], timestamp: ms(7) } },
    { type: 'message', id: 'a3', parentId: 'u2', timestamp: ts(8), message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }], stopReason: 'stop', timestamp: ms(8) } },
    { type: 'compaction', id: 'k1', parentId: 'a3', timestamp: ts(9), summary: 'Summary of the first two turns.' },
    { type: 'session_info', id: 'n1', parentId: 'k1', timestamp: ts(9), name: 'Renamed pi session' },
    { type: 'message', id: 'u3', parentId: 'n1', timestamp: ts(10), message: { role: 'user', content: [{ type: 'text', text: 'third prompt' }], timestamp: ms(10) } },
    { type: 'message', id: 'a4', parentId: 'u3', timestamp: ts(11), message: { role: 'assistant', content: [{ type: 'text', text: 'third answer' }], stopReason: 'stop', timestamp: ms(11) } },
  ]
  const file = join(dir, `2026-08-27T15-00-00-000Z_${id}.jsonl`)
  writeFileSync(file, lines(records))
  // A workspace whose directory is gone.
  const goneCwd = '/definitely/not/here/anymore'
  const goneDir = join(root, '--definitely-not-here-anymore--')
  mkdirSync(goneDir)
  const goneId = '01a0ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee'
  writeFileSync(join(goneDir, `2026-08-01T00-00-00-000Z_${goneId}.jsonl`), lines([
    { type: 'session', version: 3, id: goneId, timestamp: ts(0), cwd: goneCwd },
    { type: 'message', id: 'g1', parentId: null, timestamp: ts(1), message: { role: 'user', content: 'lonely prompt', timestamp: ms(1) } },
    { type: 'message', id: 'g2', parentId: 'g1', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'text', text: 'lonely answer' }], stopReason: 'stop', timestamp: ms(2) } },
  ]))
  return { root, cwd, slug, dir, id, file, goneCwd, goneId }
}

/**
 * A home with one stored session (the Claude fixture's events, written
 * through the harness's own JSONL persistence in its current format), in
 * `<home>/sessions/<workspace key>/<session>/`.
 */
export async function dshHome() {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const { readClaudeSession } = await import('../host/claude-reader.mjs')
  const { toCurrentFormat } = await import('../host/importer.mjs')
  const home = scratch('home')
  const cwd = scratch('home-cwd')
  const id = 'session-11111111-2222-4333-8444-666666666666'
  const claude = claudeStore()
  const { builder } = await readClaudeSession(claude.file, { sessionId: id })
  builder.finish('Fixture session')
  const { header, events } = toCurrentFormat({ version: 3, id, createdAt: Date.UTC(2026, 7, 6, 10), cwd, isSeeded: false, delegationDepth: 0 }, builder.events)
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
  try {
    const handle = await ctx.sessionPersistence.create(header)
    try { await handle.append(events); await handle.flush() } finally { await handle.close() }
  } finally { await ctx.fiber.dispose() }
  return { home, cwd, id }
}
