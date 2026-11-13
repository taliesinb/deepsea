// The permission table: names and aliases, automation targets, pane URLs and
// the user-facing instructions the model relays.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLASSES, PermissionNameError, instructions, paneName, paneUrl, parsePermission, parsePermissions } from '../permissions.mjs'

test('fixed classes by id, alias and System Settings name; their pane URLs', () => {
  assert.deepEqual(CLASSES.map(c => c.id), ['screen-recording', 'accessibility', 'microphone', 'camera', 'input-monitoring', 'full-disk-access'])
  assert.equal(parsePermission('screen-recording').id, 'screen-recording')
  assert.equal(parsePermission('Screen Recording').id, 'screen-recording')
  assert.equal(parsePermission('screenshot').id, 'screen-recording')
  assert.equal(parsePermission(' FDA ').id, 'full-disk-access')
  assert.equal(parsePermission('input_monitoring').id, 'input-monitoring')
  assert.equal(parsePermission('mic').id, 'microphone')
  const urls = Object.fromEntries(CLASSES.map(c => [c.id, paneUrl(c)]))
  assert.deepEqual(urls, {
    'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    'input-monitoring': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
    'full-disk-access': 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  })
  assert.equal(parsePermission('screen-recording').aliases, undefined)
})

test('automation targets: known names, bundle ids, and the errors', () => {
  const events = parsePermission('automation:system-events')
  assert.equal(events.id, 'automation:com.apple.systemevents')
  assert.equal(events.name, 'Automation: System Events')
  assert.equal(paneUrl(events), 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation')
  assert.equal(parsePermission('automation:Safari').id, 'automation:com.apple.Safari')
  assert.equal(parsePermission('automation:com.apple.safari').id, 'automation:com.apple.Safari')
  assert.deepEqual(parsePermission('automation:com.example.App').target, { bundleId: 'com.example.App', name: 'com.example.App' })
  assert.throws(() => parsePermission('automation'), PermissionNameError)
  assert.throws(() => parsePermission('automation:not a bundle'), /automation needs a target app/)
  assert.throws(() => parsePermission('telepathy'), /unknown permission "telepathy"; known: screen-recording/)
})

test('a list keeps its order, drops duplicates, accepts one string, and refuses an empty list', () => {
  assert.deepEqual(parsePermissions(['microphone', 'screen', 'screen-recording', 'mic']).map(c => c.id), ['microphone', 'screen-recording'])
  assert.deepEqual(parsePermissions('camera').map(c => c.id), ['camera'])
  assert.throws(() => parsePermissions([]), /non-empty list/)
  assert.throws(() => parsePermissions([3]), /non-empty string/)
})

test('instructions name the row and the pane; a stale entry is removed with −', () => {
  const screen = parsePermission('screen-recording')
  assert.equal(paneName(screen), 'Screen & System Audio Recording')
  assert.match(instructions(screen, 'stale', 'DeepSea Server'), /Screen & System Audio Recording has a stale "DeepSea Server" entry.*remove it with the − button/)
  assert.match(instructions(screen, 'denied', 'DeepSea Server'), /switch "DeepSea Server" on/)
  assert.match(instructions(parsePermission('fda'), 'denied', 'X'), /add it with \+ \(it is "X\.app" in ~\/Library\/Application Support\/io\.github\.taliesinb\.deepsea\.<variant>\/\)/)
  assert.match(instructions(parsePermission('automation:finder'), 'not-running', 'X'), /Finder was not running/)
  assert.match(instructions(parsePermission('automation:com.example.none'), 'unavailable', 'X'), /is not installed/)
  assert.match(instructions(parsePermission('camera'), 'restricted', 'X'), /restricted by a configuration profile/)
})

test('dialog kinds per class; the Accessibility pane\'s macOS 27 name', () => {
  const kinds = Object.fromEntries(parsePermissions(['screen-recording', 'accessibility', 'microphone', 'camera', 'input-monitoring', 'full-disk-access', 'automation:finder']).map(c => [c.id, c.grant]))
  assert.deepEqual(kinds, { 'screen-recording': 'alert', accessibility: 'pane', microphone: 'dialog', camera: 'dialog', 'input-monitoring': 'alert', 'full-disk-access': 'pane', 'automation:com.apple.finder': 'dialog' })
  assert.equal(paneName(parsePermission('accessibility')), 'Device Control and Data Access (Accessibility before macOS 27)')
  assert.equal(parsePermissions([{ permission: 'camera', justification: 'To film.' }])[0].justification, 'To film.')
})

test('parsePermissions with requireJustification refuses bare names and bad sentences', () => {
  assert.throws(() => parsePermissions(['camera'], { requireJustification: true }), /must be an object \{ permission, justification \}/)
  assert.throws(() => parsePermissions('camera', { requireJustification: true }), /non-empty list/)
  assert.throws(() => parsePermissions([{ permission: 'camera', justification: 'a\rb' }], { requireJustification: true }), /one line/)
  assert.equal(parsePermissions([{ permission: 'camera', justification: 'x'.repeat(200) }], { requireJustification: true })[0].justification.length, 200)
})
