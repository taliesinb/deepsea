// The card's pure part (src/client/model.ts, loaded with Node's type
// stripping) against both dictionaries, and the dictionaries' key sets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { formatDuration, iconOf, isOpen, nameOf, rowsFromArgs, stateKeyOf, stateText, waitedOf } from '../src/client/model.ts'

const card = lang => JSON.parse(readFileSync(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8')).card
const translate = dict => (key, params = {}) => {
  assert.ok(key in dict, `missing key ${key}`)
  return dict[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
}
const en = translate(card('en'))
const zh = translate(card('zh'))

test('both locale files have the same card keys', () => {
  assert.deepEqual(Object.keys(card('zh')).sort(), Object.keys(card('en')).sort())
})

test('icons: tick for granted, question mark while open, cross once it will not be granted', () => {
  assert.equal(iconOf({ id: 'a', state: 'granted' }), 'granted')
  assert.equal(iconOf({ id: 'a', state: 'pending' }), 'open')
  assert.equal(iconOf({ id: 'a', state: 'granting' }), 'open')
  assert.equal(iconOf({ id: 'a', state: 'checking' }), 'checking')
  for (const state of ['denied', 'unavailable', 'cancelled', 'not-applicable']) assert.equal(iconOf({ id: 'a', state }), 'closed')
  assert.equal(isOpen({ id: 'a', state: 'granting' }), true)
  assert.equal(isOpen({ id: 'a', state: 'denied' }), false)
})

test('short states, from the row state and the probe status', () => {
  const text = (row, t = en) => stateText({ id: 'screen-recording', ...row }, t)
  assert.equal(text({ state: 'granted', already: true }), 'granted')
  assert.equal(text({ state: 'granted', waitedSeconds: 42 }), 'granted after 42s')
  assert.equal(text({ state: 'granted', grantingSince: 1000, grantedAt: 126_000 }), 'granted after 2m5s')
  assert.equal(text({ state: 'pending', status: 'not-determined' }), 'not granted')
  assert.equal(text({ state: 'pending', status: 'denied' }), 'switched off')
  assert.equal(text({ state: 'pending', status: 'stale' }), 'stale entry')
  assert.equal(text({ state: 'pending', status: 'not-running' }), 'app not running')
  assert.equal(text({ state: 'granting', status: 'not-determined' }), 'waiting')
  assert.equal(text({ state: 'granting', status: 'stale' }), 'stale entry: remove it')
  assert.equal(text({ state: 'denied' }), 'denied')
  assert.equal(text({ state: 'unavailable', status: 'restricted' }), 'restricted')
  assert.equal(text({ state: 'unavailable', status: 'unavailable' }), 'not installed')
  assert.equal(text({ state: 'cancelled' }), 'cancelled')
  assert.equal(text({ state: 'not-applicable' }), 'not applicable')
  assert.equal(text({ state: 'checking' }), 'checking')
  assert.equal(text({ state: 'granted', waitedSeconds: 42 }, zh), '42秒后已授权')
  assert.equal(stateKeyOf({ id: 'x', state: 'weird' }), 'state.cancelled')
  assert.equal(waitedOf({ id: 'x', state: 'granted' }), undefined)
})

test('names in both languages; Automation keeps the target app\'s name', () => {
  assert.equal(nameOf({ id: 'screen-recording', state: 'pending' }, en), 'Screen Recording')
  assert.equal(nameOf({ id: 'full-disk-access', state: 'pending' }, zh), '完全磁盘访问权限')
  assert.equal(nameOf({ id: 'automation:com.apple.systemevents', name: 'Automation: System Events', state: 'pending' }, en), 'Automation: System Events')
  assert.equal(nameOf({ id: 'automation:com.apple.systemevents', name: 'Automation: System Events', state: 'pending' }, zh), '自动化：System Events')
  assert.equal(nameOf({ id: 'automation:com.example.App', state: 'pending' }, en), 'Automation: com.example.App')
})

test('rows from the arguments before any answer; durations', () => {
  assert.deepEqual(rowsFromArgs('{"permissions":["camera"," mic ",3]}', 'checking'), [{ id: 'camera', state: 'checking' }, { id: 'mic', state: 'checking' }])
  assert.deepEqual(rowsFromArgs('{"permissions":', 'checking'), [])
  assert.deepEqual(rowsFromArgs(undefined, 'cancelled'), [])
  assert.equal(formatDuration(3.4, en), '3s')
  assert.equal(formatDuration(600, en), '10m')
  assert.equal(formatDuration(3900, en), '1h5m')
  assert.equal(formatDuration(3600, zh), '1小时')
})

test('rows from the arguments carry the justifications', () => {
  assert.deepEqual(rowsFromArgs('{"permissions":[{"permission":"camera","justification":" To film the demo. "},{"permission":""},{"justification":"x"},"mic"]}', 'checking'),
    [{ id: 'camera', state: 'checking', justification: 'To film the demo.' }, { id: 'mic', state: 'checking' }])
})
