// The row's duration text (src/client/format.ts, loaded with Node's type
// stripping) against both dictionaries, and the dictionaries' key sets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { formatDuration, formatElapsed } from '../src/client/format.ts'

const card = lang => JSON.parse(readFileSync(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8')).card
const translate = dict => (key, params = {}) => dict[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
const en = translate(card('en'))
const zh = translate(card('zh'))

test('every locale file has the same card keys', () => {
  assert.deepEqual(Object.keys(card('zh')).sort(), Object.keys(card('en')).sort())
})

test('totals drop zero parts', () => {
  assert.equal(formatDuration(2.34, en), '2.3s')
  assert.equal(formatDuration(10, en), '10s')
  assert.equal(formatDuration(59.6, en), '1m')
  assert.equal(formatDuration(637, en), '10m37s')
  assert.equal(formatDuration(2400, en), '40m')
  assert.equal(formatDuration(3600, en), '1h')
  assert.equal(formatDuration(3900, en), '1h5m')
  assert.equal(formatDuration(3907, en), '1h5m')
  assert.equal(formatDuration(-1, en), '0s')
})

test('the running clock keeps its seconds', () => {
  assert.equal(formatElapsed(4.9, en), '4s')
  assert.equal(formatElapsed(600, en), '10m0s')
  assert.equal(formatElapsed(637.8, en), '10m37s')
  assert.equal(formatElapsed(3605, en), '1h0m5s')
})

test('Chinese forms', () => {
  assert.equal(formatElapsed(637, zh), '10分37秒')
  assert.equal(formatDuration(2400, zh), '40分钟')
  assert.equal(formatDuration(12, zh), '12秒')
  assert.equal(formatDuration(3900, zh), '1小时5分')
})
