// node --test: the chord, and the toggle against a fake settings shell.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSettingsChord, settingsShell, toggleSettings } from '../src/client/toggle.ts'

const key = (fields: Partial<Parameters<typeof isSettingsChord>[0]>) => ({
  key: '.', code: 'Period', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...fields,
})

test('⌘. on Apple devices, Ctrl+. elsewhere', () => {
  assert.equal(isSettingsChord(key({ metaKey: true }), true), true)
  assert.equal(isSettingsChord(key({ ctrlKey: true }), true), false)
  assert.equal(isSettingsChord(key({ ctrlKey: true }), false), true)
  assert.equal(isSettingsChord(key({ metaKey: true }), false), false)
})

test('nothing else held, no repeats', () => {
  for (const extra of [{ altKey: true }, { shiftKey: true }, { ctrlKey: true }, { repeat: true }]) {
    assert.equal(isSettingsChord(key({ metaKey: true, ...extra }), true), false, JSON.stringify(extra))
  }
  assert.equal(isSettingsChord(key({}), true), false)
})

test('the period by character, by physical key, or on the keypad', () => {
  assert.equal(isSettingsChord(key({ metaKey: true, code: 'KeyX' }), true), true)
  assert.equal(isSettingsChord(key({ metaKey: true, key: '>' }), true), true)
  assert.equal(isSettingsChord(key({ metaKey: true, key: '.', code: 'NumpadDecimal' }), true), true)
  assert.equal(isSettingsChord(key({ metaKey: true, key: ',', code: 'Comma' }), true), false)
})

/** A settings shell like ui-settings-general's: one instance, handed out by its slot entry's store. */
function fakeShell(open = false) {
  const calls: string[] = []
  let state = { open }
  const shell = {
    getSnapshot: () => state,
    actions: {
      open: () => { calls.push('open'); state = { open: true } },
      close: () => { calls.push('close'); state = { open: false } },
    },
  }
  const slots = { entries: (name: string) => (name === 'sidebar.settings' ? [{ store: { create: () => shell } }] : []) }
  return { shell, slots, calls }
}

test('the shell is the store instance of the sidebar.settings entry', () => {
  const { shell, slots } = fakeShell()
  assert.equal(settingsShell(slots), shell)
  assert.equal(settingsShell({ entries: () => [] }), undefined, 'not mounted yet')
  assert.equal(settingsShell({ entries: () => [{}] }), undefined, 'an entry without a store')
  assert.equal(settingsShell({ entries: () => [{ store: { create: () => ({ actions: {} }) } }] }), undefined, 'not a shell')
})

test('closed panel: opened; open panel: closed', () => {
  const { slots, calls } = fakeShell()
  assert.equal(toggleSettings(settingsShell(slots)), 'opened')
  assert.equal(toggleSettings(settingsShell(slots)), 'closed')
  assert.deepEqual(calls, ['open', 'close'])
})

test('no shell: reported, nothing done', () => {
  assert.equal(toggleSettings(undefined), 'no-shell')
})
