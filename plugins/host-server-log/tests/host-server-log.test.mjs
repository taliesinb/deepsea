import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, backlog, Config, passes, render, timestamp } from '../index.js'

const exporter = { colors: false }
const message = (type, args, name = 'deepsea-llm-billing') => ({ sn: 1, ts: Date.parse('2026-10-09T20:13:24.115Z'), type, level: 1, name, args })

test('lines carry the local time, level and logger name; placeholders and objects are formatted', () => {
  assert.match(timestamp(Date.now()), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/)
  const line = render(message('warn', ['usage read failed: %s (%d tries)', 'timeout', 3]), exporter)
  assert.match(line, / warn  deepsea-llm-billing  usage read failed: timeout \(3 tries\)$/)
  assert.match(render(message('info', ['state', { a: 1 }]), exporter), /info  deepsea-llm-billing  state \{"a":1\}$/)
})

test('a multi-line message (a stack) gets the prefix on every line', () => {
  const error = new Error('boom')
  const lines = render(message('error', [error]), exporter).split('\n')
  assert.ok(lines.length > 1)
  for (const line of lines) assert.match(line, / error deepsea-llm-billing  /)
  assert.match(lines[0], /Error: boom$/)
})

test('config: a level, nothing else', () => {
  const v = Config['~standard'].validate
  assert.deepEqual(v({}), { value: { level: 'debug' } })
  assert.deepEqual(v({ level: 'warn' }), { value: { level: 'warn' } })
  assert.ok(v({ level: 'loud' }).issues)
  assert.ok(v({ file: '/x' }).issues)
})

test('levels in the usual order: warn keeps errors and warnings, drops info and debug', () => {
  assert.deepEqual(['error', 'warn', 'info', 'debug'].map(t => passes(t, 'warn')), [true, true, false, false])
  assert.deepEqual(['error', 'warn', 'info', 'debug'].map(t => passes(t, 'debug')), [true, true, true, true])
  assert.deepEqual(['error', 'warn', 'info', 'debug'].map(t => passes(t, 'error')), [true, false, false, false])
})

test('messages logged before it was active are written first, once', () => {
  const at = n => ({ sn: n, ts: Date.parse('2026-10-09T20:13:24.115Z') + n, type: 'info', level: 1, name: 'early', args: [`line ${n}`] })
  assert.deepEqual(backlog([at(3), at(1), at(2)], 1).map(m => m.sn), [2, 3])
  const written = []
  const write = process.stderr.write
  process.stderr.write = (text) => { written.push(text); return true }
  try {
    const exporters = []
    const ctx = { logger: { buffer: [at(101), at(102)], exporter: e => exporters.push(e) } }
    delete globalThis[Symbol.for('deepsea.host-server-log.written')]
    apply(ctx)
    apply(ctx)
    assert.equal(written.length, 2)
    assert.match(written[0], /early  line 101/)
    assert.equal(exporters.length, 2)
  } finally { process.stderr.write = write }
})
