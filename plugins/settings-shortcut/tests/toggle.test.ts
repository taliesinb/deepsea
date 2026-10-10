// node --test: the chord and the toggle against a fake document.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLOSE_SELECTOR, TRIGGER_FALLBACK_SELECTOR, TRIGGER_SELECTOR, isSettingsChord, toggleSettings } from '../src/client/toggle.ts'

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

function fakeDocument(present: Record<string, { expanded?: string } | undefined>) {
  const clicks: string[] = []
  const root = {
    querySelector(selector: string) {
      const element = present[selector]
      if (element === undefined) return null
      return {
        getAttribute: (attr: string) => attr === 'aria-expanded' ? element.expanded ?? null : null,
        click: () => { clicks.push(selector) },
      }
    },
  }
  return { root, clicks }
}

test('closed panel: the trigger is clicked', () => {
  const { root, clicks } = fakeDocument({ [TRIGGER_SELECTOR]: { expanded: 'false' }, [CLOSE_SELECTOR]: {} })
  assert.equal(toggleSettings(root), 'opened')
  assert.deepEqual(clicks, [TRIGGER_SELECTOR])
})

test('open panel: its close button is clicked', () => {
  const { root, clicks } = fakeDocument({ [TRIGGER_SELECTOR]: { expanded: 'true' }, [CLOSE_SELECTOR]: {} })
  assert.equal(toggleSettings(root), 'closed')
  assert.deepEqual(clicks, [CLOSE_SELECTOR])
})

test('the trigger by its own class when the sidebar wrapper is not found', () => {
  const { root, clicks } = fakeDocument({ [TRIGGER_FALLBACK_SELECTOR]: { expanded: 'false' } })
  assert.equal(toggleSettings(root), 'opened')
  assert.deepEqual(clicks, [TRIGGER_FALLBACK_SELECTOR])
})

test('missing controls are reported, nothing is clicked', () => {
  assert.equal(toggleSettings(fakeDocument({}).root), 'no-trigger')
  const open = fakeDocument({ [TRIGGER_SELECTOR]: { expanded: 'true' } })
  assert.equal(toggleSettings(open.root), 'no-close')
  assert.deepEqual(open.clicks, [])
})
