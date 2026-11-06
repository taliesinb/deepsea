import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rejectRequest, selectEvents, summarize } from '../driver.mjs'
import { isThrowawayHome, loaderProblems, parseModel } from '../index.js'

const token = 'a'.repeat(64)
const req = (over = {}) => ({ remoteAddress: '127.0.0.1', headers: { authorization: `Bearer ${token}`, ...over.headers }, ...over })

test('requests: loopback only, never from a page, with the bearer token', () => {
  assert.equal(rejectRequest(req(), token), undefined)
  assert.equal(rejectRequest(req({ remoteAddress: '::1' }), token), undefined)
  assert.equal(rejectRequest(req({ remoteAddress: '100.64.0.7' }), token).status, 403)
  assert.equal(rejectRequest(req({ headers: { origin: 'http://127.0.0.1:3200' } }), token).status, 403)
  assert.equal(rejectRequest(req({ headers: { authorization: 'Bearer wrong' } }), token).status, 401)
  assert.equal(rejectRequest({ remoteAddress: '127.0.0.1', headers: {} }, token).status, 401)
})

test('arms only in a throwaway home', () => {
  const home = mkdtempSync(join(tmpdir(), 'td-'))
  try {
    assert.equal(isThrowawayHome(home), false)
    writeFileSync(join(home, 'variant.yml'), 'id: release\nthrowaway: false\n')
    assert.equal(isThrowawayHome(home), false)
    writeFileSync(join(home, 'variant.yml'), 'id: release-3f9a1c\nparent: release\nthrowaway: true\n')
    assert.equal(isThrowawayHome(home), true)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('model specs and loader problems', () => {
  assert.deepEqual(parseModel('scripted/script'), { provider: 'scripted', model: 'script' })
  assert.deepEqual(parseModel('anthropic/claude:high'), { provider: 'anthropic', model: 'claude', reasoningEffort: 'high' })
  assert.throws(() => parseModel('script'), /provider\/model/)
  const entries = [
    { options: { id: 'a', name: 'a' }, fiber: { state: 2 } },
    { options: { id: 'b', name: 'b' }, fiber: { state: 3 } },
    { options: { id: 'c', name: 'c' }, disabled: true },
    { options: { id: 'g', group: true } },
  ]
  assert.deepEqual(loaderProblems({ entries: () => entries }), { known: true, counts: { active: 1, failed: 1, disabled: 1 }, problems: [{ id: 'b', name: 'b', phase: 'failed' }] })
  assert.deepEqual(loaderProblems(undefined), { known: false })
})

test('summary: text, reasoning, tool outcomes, commands, how the turn ended', () => {
  const events = [
    { seq: 10, type: 'turn/start', data: {} },
    { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'plan' }, { type: 'text', text: 'Looking.' }, { type: 'tool-call', id: 'c1' }] } } },
    { seq: 12, type: 'tool/call', data: { callId: 'c1', name: 'bash' } },
    { seq: 13, type: 'tool/call', data: { callId: 'c2', name: 'read' } },
    { seq: 14, type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok\n' }] } } },
    { seq: 15, type: 'tool/result', data: { message: { toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'no such file' }] }, error: { code: 'ENOENT' } } },
    { seq: 16, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done.' }] } } },
    { seq: 17, type: 'command/run', data: { commandId: 'k', name: 'tools' } },
    { seq: 18, type: 'command/done', data: { commandId: 'k', kind: 'text', text: '3 tools' } },
    { seq: 19, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SCRIPT_EXPECTATION', message: 'line 5: …' } } } },
  ]
  assert.deepEqual(summarize(events), {
    turns: 1,
    turnEnd: { kind: 'error', error: { code: 'SCRIPT_EXPECTATION', message: 'line 5: …' } },
    text: 'Done.',
    texts: ['Looking.', 'Done.'],
    reasoningBlocks: 1,
    tools: [{ callId: 'c1', name: 'bash', ok: true, output: 'ok\n' }, { callId: 'c2', name: 'read', ok: false, output: 'no such file', errorCode: 'ENOENT' }],
    commands: [{ name: 'tools', kind: 'text', text: '3 tools' }],
  })
  assert.deepEqual(summarize([]), { turns: 0, tools: [], commands: [] })
  assert.deepEqual(selectEvents(events, { since: 15, types: ['tool/*', 'turn/end'] }).map(e => e.seq), [15, 19])
  assert.deepEqual(selectEvents(events, { limit: 2 }).map(e => e.seq), [18, 19])
})
