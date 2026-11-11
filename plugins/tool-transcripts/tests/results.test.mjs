// Tool results as current (format v4) logs store them: a tool-role message
// whose content is an array of blocks and whose isError flag says whether
// the call failed. Every tool reads them through model.mjs → resultParts.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildModel, resultCallId, resultParts } from '../model.mjs'
import { Config, build } from '../tools.js'
import { fakeCtx, fakeExec, textOf } from './fake-ctx.mjs'

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'))
const v4 = fixture('tool-role-results') // chrome/safari/edit/file results: 3 ok, 3 failed, 2 with images
const ID = v4.session.id
const BROWSER = ['chrome_*', 'safari_*']

const root = mkdtempSync(join(tmpdir(), 'si-results-'))
const { tools } = build(fakeCtx({ snapshots: [v4], workspaceRoot: root }), Config({}))
const tool = (name) => tools.find(t => t.name === name)
const exec = fakeExec('session-caller', '/Users/USER/projects/browser-check')
const run = (name, args) => tool(name).execute(args, exec)
test.after(() => rmSync(root, { recursive: true, force: true }))

test('resultParts: tool-role message with block content — text, images, other blocks, isError', () => {
  const m = buildModel(v4)
  const byId = Object.fromEntries(m.calls.map(c => [c.callId, c]))
  assert.equal(m.stats.calls, 6)
  assert.equal(m.stats.errors, 3)
  assert.deepEqual(m.calls.map(c => c.ok), [true, false, true, false, false, true])
  assert.equal(byId.toolu_c1.text, 'Navigated to http://127.0.0.1:8765/ (title: Demo)')
  assert.match(byId.toolu_c2.text, /Execution context was destroyed/)
  assert.equal(byId.toolu_c3.text, 'Screenshot of the viewport')
  assert.deepEqual(byId.toolu_c3.images, [{ w: 2200, h: 1600, type: 'webp', bytes: 109136, name: 'viewport.png' }])
  assert.equal(byId.toolu_s4.text, 'Error: safari_get_screenshot: element moved during capture')
  assert.equal(byId.toolu_s4.images.length, 1)
  assert.equal(byId.toolu_r5.code, 'FS_NOT_OBSERVED')
  assert.equal(byId.toolu_r5.reason, 'notes.md was not read in this session')
  assert.equal(byId.toolu_f6.text, '<file report.pdf application/pdf 12345 bytes>')
  assert.ok(m.calls.every(c => c.resultSeq !== null && c.ms !== null), 'every result is paired with its call')
})

test('resultParts: released v3 wrapper, plain string content, error metadata alone, toolCallId fallback', () => {
  const wrapper = (inner, isError) => ({ message: { role: 'user', source: { kind: 'tool', callId: 'k' }, content: [{ type: 'tool-result', toolCallId: 'k', content: inner, ...isError === undefined ? {} : { isError } }] } })
  assert.deepEqual(resultParts(wrapper('boom', true)), { ok: false, text: 'boom', images: [] })
  const blocks = resultParts(wrapper([{ type: 'text', text: 'shot' }, { type: 'image', attachment: { mediaType: 'image/png', width: 4, height: 3, bytes: 10 } }]))
  assert.equal(blocks.ok, true)
  assert.equal(blocks.text, 'shot')
  assert.deepEqual(blocks.images, [{ w: 4, h: 3, type: 'png', bytes: 10 }])
  assert.deepEqual(resultParts({ message: { role: 'tool', toolCallId: 'k', content: 'plain', isError: true } }), { ok: false, text: 'plain', images: [] })
  assert.equal(resultParts({ message: { role: 'tool', toolCallId: 'k', content: [] }, error: { name: 'X', code: 'E' } }).ok, false)
  assert.equal(resultParts({ message: { role: 'tool', toolCallId: 'k', content: [{ type: 'text', text: 'fine' }] } }).ok, true, 'isError absent = ok')
  assert.equal(resultCallId({ message: { role: 'tool', toolCallId: 'only-here', content: [] } }), 'only-here')
  assert.equal(resultCallId({ message: { source: { kind: 'tool', callId: 'src' }, toolCallId: 'src' } }), 'src')
  assert.equal(resultCallId({ callId: 'legacy' }), 'legacy')
})

test('transcript_tool_stats: counts block-content failures and groups them by their text', async () => {
  const v = await run('transcript_tool_stats', { sessions: ['*'], tools: BROWSER })
  assert.equal(v.scope.calls, 4)
  assert.equal(v.scope.errors, 2)
  const page = v.tools.find(t => t.tool === 'chrome_get_page_content')
  assert.equal(page.errors, 1)
  assert.match(page.topErrors[0].message, /Execution context was destroyed/)
  assert.equal(v.tools.find(t => t.tool === 'safari_get_screenshot').errors, 1)
  assert.equal(v.tools.find(t => t.tool === 'chrome_get_screenshot').errors, 0)
  const all = await run('transcript_tool_stats', { session: ID })
  assert.equal(all.scope.errors, 3)
  assert.match(textOf(tool('transcript_tool_stats'), {}, v), /· 4 calls · 2 errors/)
})

test('transcript_grep: matches text inside block content of results', async () => {
  const g = await run('transcript_grep', { pattern: 'Execution context', sessions: ['*'], kinds: ['result'] })
  assert.equal(g.hits.length, 1)
  assert.equal(g.hits[0].tool, 'chrome_get_page_content')
  const file = await run('transcript_grep', { pattern: 'report\\.pdf', session: ID, kinds: ['result'] })
  assert.equal(file.hits.length, 1, 'file blocks are greppable through their placeholder')
  const browser = await run('transcript_grep', { pattern: '.', session: ID, kinds: ['result'], tools: BROWSER })
  assert.equal(browser.hits.length, 4, 'no browser result reads as empty')
})

test('transcript_export: ok flag, result text and images from block content', async () => {
  const v = await run('transcript_export', { session: ID, tools: BROWSER })
  assert.deepEqual(v.rows.map(r => [r.tool, r.ok]), [['chrome_navigate', true], ['chrome_get_page_content', false], ['chrome_get_screenshot', true], ['safari_get_screenshot', false]])
  assert.ok(v.rows.every(r => r.result !== '' && r.resultChars > 0))
  assert.deepEqual(v.rows[2].images, [{ w: 2200, h: 1600, type: 'webp', bytes: 109136, name: 'viewport.png' }])
  const errs = await run('transcript_export', { session: ID, errors_only: true })
  assert.deepEqual(errs.rows.map(r => r.callId), ['toolu_c2', 'toolu_s4', 'toolu_r5'])
  assert.equal(errs.rows[2].code, 'FS_NOT_OBSERVED')
})

test('transcript_outline / transcript_find details: error counts include isError results', async () => {
  const o = await run('transcript_outline', { session: ID })
  assert.equal(o.turns[0].errors, 3)
  assert.deepEqual(o.turns[0].calls.find(c => c.tool === 'chrome_get_page_content'), { tool: 'chrome_get_page_content', count: 1, errors: 1 })
  assert.equal(o.session.errors, 3)
  const f = await run('transcript_find', { details: true })
  assert.equal(f.sessions[0].errors, 3)
})

test('transcript_read: ✗ and image summaries for block results; errors_only; raw tools filter keeps results', async () => {
  const all = await run('transcript_read', { session: ID })
  const text = textOf(tool('transcript_read'), {}, all)
  assert.match(text, /RESULT ✓ \S+ chrome_get_screenshot "?Screenshot of the viewport"? <image 2200×1600 webp 107 KB>/)
  assert.match(text, /RESULT ✗ \S+ safari_get_screenshot .*element moved during capture.* <image 800×600 png 2 KB>/)
  assert.match(text, /RESULT ✗ \S+ edit code=FS_NOT_OBSERVED/)
  const errs = await run('transcript_read', { session: ID, errors_only: true })
  assert.deepEqual(errs.events.filter(e => e.kind === 'result').map(e => e.callId), ['toolu_c2', 'toolu_s4', 'toolu_r5'])
  const raw = await run('transcript_read', { session: ID, raw: true, fmt: 'json', tools: ['safari_*'] })
  const toolEvents = raw.events.filter(e => e.type === 'tool/call' || e.type === 'tool/result')
  assert.deepEqual(toolEvents.map(e => e.type), ['tool/call', 'tool/result'])
})
