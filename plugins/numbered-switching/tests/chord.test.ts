import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chordSlot, isApplePlatform } from '../src/client/chord.ts'

const key = (fields: Partial<KeyboardEvent>) => ({
  key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...fields,
})

test('⌘digit on Apple platforms, Ctrl+digit elsewhere', () => {
  assert.equal(chordSlot(key({ key: '3', code: 'Digit3', metaKey: true }), 5, true), 3)
  assert.equal(chordSlot(key({ key: '3', code: 'Digit3', ctrlKey: true }), 5, true), undefined)
  assert.equal(chordSlot(key({ key: '3', code: 'Digit3', ctrlKey: true }), 5, false), 3)
  assert.equal(chordSlot(key({ key: '3', code: 'Digit3', metaKey: true }), 5, false), undefined)
})

test('other modifiers, repeats and digits past the slot count are not chords', () => {
  assert.equal(chordSlot(key({ key: '2', code: 'Digit2', metaKey: true, shiftKey: true }), 5, true), undefined)
  assert.equal(chordSlot(key({ key: '2', code: 'Digit2', metaKey: true, altKey: true }), 5, true), undefined)
  assert.equal(chordSlot(key({ key: '2', code: 'Digit2', metaKey: true, ctrlKey: true }), 5, true), undefined)
  assert.equal(chordSlot(key({ key: '2', code: 'Digit2', metaKey: true, repeat: true }), 5, true), undefined)
  assert.equal(chordSlot(key({ key: '7', code: 'Digit7', metaKey: true }), 5, true), undefined)
  assert.equal(chordSlot(key({ key: '0', code: 'Digit0', metaKey: true }), 5, true), undefined)
  assert.equal(chordSlot(key({ key: 'a', code: 'KeyA', metaKey: true }), 5, true), undefined)
})

test('the keypad and non-Latin layouts address the same slots', () => {
  assert.equal(chordSlot(key({ key: '2', code: 'Numpad2', metaKey: true }), 5, true), 2)
  // AZERTY: the digit row types symbols unshifted; `code` still names the digit.
  assert.equal(chordSlot(key({ key: '&', code: 'Digit1', metaKey: true }), 5, true), 1)
  // No usable code (synthetic events): the key decides.
  assert.equal(chordSlot(key({ key: '4', metaKey: true }), 5, true), 4)
})

test('isApplePlatform', () => {
  assert.equal(isApplePlatform({ platform: 'MacIntel', userAgent: '' }), true)
  assert.equal(isApplePlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), true)
  assert.equal(isApplePlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), false)
})
