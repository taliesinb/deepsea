import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeCondition, parseWait, pollBody, runWait, WAIT_PARAM } from '../waiting.mjs'

test('parseWait: normalises text (string or array), drops empty specs, defaults timeout', () => {
  assert.equal(parseWait(undefined), undefined)
  assert.equal(parseWait({}), undefined)
  assert.equal(parseWait({ text: [] }), undefined)
  assert.deepEqual(parseWait({ text: 'Done' }), { text: ['Done'], selector: undefined, expression: undefined, settleMs: 0, timeout: 30_000 })
  assert.deepEqual(parseWait({ selector: '#x', settleMs: 250, timeout: 5000 }), { text: undefined, selector: '#x', expression: undefined, settleMs: 250, timeout: 5000 })
  assert.deepEqual(parseWait({ settleMs: 300 }), { text: undefined, selector: undefined, expression: undefined, settleMs: 300, timeout: 30_000 })
  assert.throws(() => parseWait('nope'), /wait must be an object/)
  assert.ok(WAIT_PARAM.properties.text && WAIT_PARAM.properties.selector && WAIT_PARAM.properties.expression && WAIT_PARAM.properties.settleMs && WAIT_PARAM.properties.timeout)
})

test('pollBody: embeds the spec and slice, is a valid async function body', () => {
  const body = pollBody(parseWait({ text: ['A', 'B'], selector: '.c', expression: 'return window.ready' }), 1234)
  assert.match(body, /"text":\["A","B"\]/)
  assert.match(body, /"selector":"\.c"/)
  assert.match(body, /Date\.now\(\) \+ 1234/)
  // compiles as an async function body
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  assert.doesNotThrow(() => new AsyncFunction(body))
})

test('runWait: condition found on the second slice; summary names what matched', async () => {
  let calls = 0
  const evaluate = async () => { calls++; return calls < 2 ? { found: null } : { found: { kind: 'text', value: 'Done' } } }
  const out = await runWait(evaluate, parseWait({ text: ['Done'], timeout: 10_000 }), { maxSliceMs: 50, sleep: async () => {} })
  assert.equal(calls, 2)
  assert.equal(out.timedOut, false)
  assert.deepEqual(out.found, { kind: 'text', value: 'Done' })
  assert.match(out.summary, /^waited \d+\.\ds: text "Done" appeared$/)
})

test('runWait: selector and expression summaries; settle after the condition', async () => {
  const slept = []
  const sel = await runWait(async () => ({ found: { kind: 'selector', value: 3 } }), parseWait({ selector: '#info', settleMs: 200 }), { sleep: async (ms) => { slept.push(ms) } })
  assert.match(sel.summary, /selector "#info" matched 3 elements, then settled 200 ms$/)
  assert.deepEqual(slept, [200])
  const expr = await runWait(async () => ({ found: { kind: 'expression', value: { res: 192, ok: true } } }), parseWait({ expression: 'return window.app.status()' }), { sleep: async () => {} })
  assert.match(expr.summary, /expression returned \{"res":192,"ok":true\}$/)
})

test('runWait: timeout is a reported fact, not an exception; slices never exceed the remaining budget', async () => {
  const slices = []
  const evaluate = async (body) => { slices.push(Number(/Date\.now\(\) \+ (\d+)/.exec(body)[1])); await new Promise(r => setTimeout(r, 30)); return { found: null } }
  const out = await runWait(evaluate, parseWait({ text: ['never'], timeout: 120 }), { maxSliceMs: 50, sleep: async () => {} })
  assert.equal(out.timedOut, true)
  assert.equal(out.found, null)
  assert.match(out.summary, /^wait timed out after 0\.1s for text "never"$/)
  assert.ok(slices.every(s => s <= 50), `slices capped: ${slices}`)
  assert.ok(slices.length >= 2)
})

test('runWait: settle only (no condition)', async () => {
  const slept = []
  const out = await runWait(async () => { throw new Error('must not evaluate') }, parseWait({ settleMs: 500 }), { sleep: async (ms) => { slept.push(ms) } })
  assert.deepEqual(slept, [500])
  assert.equal(out.summary, 'settled 500 ms')
  assert.equal(out.found, null)
})

test('describeCondition lists the alternatives', () => {
  assert.equal(describeCondition(parseWait({ text: ['a', 'b'], selector: '#s', expression: 'return 1' })), 'text "a" / "b" or selector "#s" or expression "return 1"')
})
