// placement.mjs decisions against a fake window helper, a fake driver connection and the real app-window
// registry: no STP, no window server, no helper process.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAppWindows } from '../app-windows.mjs'
import { createPlacement, expandHome, parkingSpot, WINDOW_HELPER_PATH } from '../placement.mjs'

const LAPTOP = { frame: { x: 0, y: 0, width: 1710, height: 1107 }, visible: { x: 50, y: 34, width: 1660, height: 1073 } }
const WIDE = { frame: { x: -44, y: -1080, width: 2560, height: 1080 }, visible: { x: -44, y: -1080, width: 2560, height: 1080 } }
const APP = 'io.github.taliesinb.deepsea.release'
const EDITOR = 'com.example.editor'

/** A fake STP window and driver connection whose page reports `v` and the window's frame. */
function fakeWindow(start, v = 'visible') {
  const state = { x: start.x, y: start.y, w: 1024, h: 768, v }
  const conn = {
    callText: async (name) => {
      if (name === 'evaluate_javascript') return JSON.stringify(JSON.stringify(state))
      return '{}'
    },
  }
  return { state, conn }
}

/** A fake helper over a mutable layout; `move` moves the fake STP window. */
function fakeHelper(layout, win, { accessibility = true, onMakeRoom } = {}) {
  const calls = []
  const run = async (_app, args) => {
    calls.push(args)
    if (args[0] === 'layout') {
      const stp = { id: 99, pid: 500, owner: 'Safari Technology Preview', bundleId: 'com.apple.SafariTechnologyPreview', bounds: { x: win.state.x, y: win.state.y, width: 1024, height: 768 } }
      return { ok: true, accessibility, ...layout, windows: [...layout.windows, stp] }
    }
    if (args[0] === 'move') {
      const [x, y] = args[args.indexOf('--to') + 1].split(',').map(Number)
      Object.assign(win.state, { x, y })
      return { ok: true }
    }
    if (args[0] === 'make-room') return onMakeRoom ? onMakeRoom() : { ok: true, changed: false, reason: 'already clear' }
    return { ok: true }
  }
  return { run, calls }
}

const base = { stpApp: '/Applications/Safari Technology Preview.app', helper: '/x/DeepSea Window Helper.app', sliver: 48, step: 32, makeRoom: true, minWidth: 480 }

test('the helper lives in the machine-wide Application Support directory', () => {
  assert.equal(WINDOW_HELPER_PATH, '~/Library/Application Support/io.github.taliesinb.deepsea/DeepSea Window Helper.app')
  assert.ok(!expandHome(WINDOW_HELPER_PATH).startsWith('~'))
})

test('frontmost DeepSea app on a large screen, left ~70 %: windows open beside it, nothing resized', async () => {
  const appWindows = createAppWindows()
  const app = { x: -44, y: -1050, width: 1789, height: 1050 }
  appWindows.report({ pid: 730, bundleId: APP, frame: app, screen: WIDE })
  const layout = { screens: [LAPTOP, WIDE], frontmost: { pid: 730, bundleId: APP }, windows: [{ id: 60, pid: 730, bundleId: APP, owner: 'DeepSea', bounds: app }] }
  const win = fakeWindow({ x: 219, y: 34 })
  const { run, calls } = fakeHelper(layout, win)
  const placement = createPlacement({ ...base, appWindows, run })
  await placement.ensureRunning(win.conn, 's:0:0', { opened: true })
  assert.deepEqual([win.state.x, win.state.y], [1789 - 44 + 12, -1050], 'beside, from the app window\'s top')
  assert.equal(calls.some(a => a[0] === 'make-room'), false)
  // A second window cascades one step lower.
  const win2 = fakeWindow({ x: 219, y: 34 })
  const helper2 = fakeHelper(layout, win2)
  const placement2 = createPlacement({ ...base, appWindows, run: helper2.run })
  placement2.slots.set('s:0:0', 0)
  await placement2.ensureRunning(win2.conn, 's:0:1', { opened: true })
  assert.deepEqual([win2.state.x, win2.state.y], [1757, -1018])
})

test('frontmost DeepSea app on the laptop: right-edge sliver, the app reveals the strip, then is restored', async () => {
  const appWindows = createAppWindows({ pollMs: 200 })
  const app = { x: 53, y: 34, width: 1656, height: 1050 }
  appWindows.report({ pid: 730, bundleId: APP, frame: app, screen: LAPTOP })
  // The browser half and the app: answer set-frame commands by reporting the new frame.
  let stop = false
  const relay = (async () => {
    while (!stop) {
      const command = await appWindows.poll(730)
      if (command?.type === 'set-frame') appWindows.report({ pid: 730, bundleId: APP, frame: command.frame, screen: LAPTOP })
    }
  })()
  const layout = { screens: [LAPTOP, WIDE], frontmost: { pid: 730, bundleId: APP }, windows: [{ id: 60, pid: 730, bundleId: APP, owner: 'DeepSea', bounds: app }] }
  const win = fakeWindow({ x: 219, y: 34 })
  const { run } = fakeHelper(layout, win)
  const placement = createPlacement({ ...base, appWindows, run })
  await placement.ensureRunning(win.conn, 's:0:0', { opened: true })
  const spot = parkingSpot(LAPTOP.visible, 0, { sliver: 48, step: 32 })
  assert.deepEqual([win.state.x, win.state.y], [spot.x, spot.y])
  assert.equal(appWindows.get(730).frame.width, spot.x - 12 - 53, 'the app window ends a gap short of the strip')
  await placement.release('s:0:0')
  assert.deepEqual(appWindows.get(730).frame, app, 'restored on the last close')
  stop = true
  await relay
})

test('another app in front: a sliver on that app\'s screen; a report whose frame is not on screen is ignored', async () => {
  const appWindows = createAppWindows()
  // Same pid and bundle id as the frontmost app, but a frame no local window has: an app on another Mac.
  appWindows.report({ pid: 742, bundleId: EDITOR, frame: { x: 0, y: 0, width: 800, height: 600 }, screen: LAPTOP })
  const layout = { screens: [LAPTOP, WIDE], frontmost: { pid: 742, bundleId: EDITOR }, windows: [{ id: 90, pid: 742, bundleId: EDITOR, owner: 'Editor', bounds: { x: 100, y: -1000, width: 2000, height: 900 } }] }
  const win = fakeWindow({ x: 219, y: 34 })
  const { run } = fakeHelper(layout, win)
  const placement = createPlacement({ ...base, appWindows, run })
  await placement.ensureRunning(win.conn, 's:0:0', { opened: true })
  const spot = parkingSpot(WIDE.visible, 0, { sliver: 48, step: 32 })
  assert.deepEqual([win.state.x, win.state.y], [spot.x, spot.y], 'parked on the wide screen, where the frontmost window is')
})

test('a window on a secondary screen is matched although WebKit counts screenY from that screen\'s top', async () => {
  const appWindows = createAppWindows()
  const app = { x: -44, y: -1050, width: 1789, height: 1050 }
  appWindows.report({ pid: 730, bundleId: APP, frame: app, screen: WIDE })
  const layout = { screens: [LAPTOP, WIDE], frontmost: { pid: 730, bundleId: APP }, windows: [{ id: 60, pid: 730, bundleId: APP, owner: 'DeepSea', bounds: app }] }
  // The STP window is at global (657, −1050); its page says screenY = 30.
  const win = fakeWindow({ x: 657, y: -1050 })
  const { run } = fakeHelper(layout, win)
  const real = win.conn.callText
  win.conn.callText = async (name, args) => name === 'evaluate_javascript'
    ? JSON.stringify(JSON.stringify({ ...win.state, y: win.state.y - WIDE.frame.y }))
    : real(name, args)
  const placement = createPlacement({ ...base, appWindows, run })
  await placement.ensureRunning(win.conn, 's:0:0', { opened: true })
  assert.deepEqual([win.state.x, win.state.y], [1757, -1050])
})

test('a visible page that was not just opened is never moved', async () => {
  const win = fakeWindow({ x: 400, y: 300 }, 'visible')
  const { run, calls } = fakeHelper({ screens: [LAPTOP], frontmost: { pid: 1 }, windows: [] }, win)
  const placement = createPlacement({ ...base, run })
  const result = await placement.ensureRunning(win.conn, 's:0:0', { opened: false })
  assert.deepEqual([win.state.x, win.state.y], [400, 300])
  assert.equal(calls.length, 0)
  assert.deepEqual(result, { parked: false, note: '' })
})

test('another app in front while this server\'s DeepSea app is on the other screen: slivers go on the app\'s screen', async () => {
  const appWindows = createAppWindows()
  const app = { x: -44, y: -1050, width: 1789, height: 1050 }
  appWindows.report({ pid: 730, bundleId: APP, frame: app, screen: WIDE })
  // The editor is frontmost on the laptop; the DeepSea app sits on the wide screen behind it.
  const layout = { screens: [LAPTOP, WIDE], frontmost: { pid: 742, bundleId: EDITOR }, windows: [
    { id: 90, pid: 742, bundleId: EDITOR, owner: 'Editor', bounds: { x: 53, y: 34, width: 1657, height: 1073 } },
    { id: 60, pid: 730, bundleId: APP, owner: 'DeepSea', bounds: app },
  ] }
  const win = fakeWindow({ x: 219, y: 34 })
  const { run } = fakeHelper(layout, win)
  const placement = createPlacement({ ...base, appWindows, run })
  await placement.ensureRunning(win.conn, 's:0:0', { opened: true })
  const spot = parkingSpot(WIDE.visible, 0, { sliver: 48, step: 32 })
  assert.deepEqual([win.state.x, win.state.y], [spot.x, spot.y])
  assert.deepEqual(appWindows.get(730).frame, app, 'the app window is not resized when it is not frontmost')
})

test('beside a narrower app window: the window is pushed right until it overhangs the screen edge', async () => {
  const appWindows = createAppWindows()
  const app = { x: -44, y: -1050, width: 1200, height: 1050 } // ends at 1156; the free band (1360 pt) is wider than the window
  appWindows.report({ pid: 730, bundleId: APP, frame: app, screen: WIDE })
  const layout = { screens: [LAPTOP, WIDE], frontmost: { pid: 730, bundleId: APP }, windows: [{ id: 60, pid: 730, bundleId: APP, owner: 'DeepSea', bounds: app }] }
  const win = fakeWindow({ x: 219, y: 34 })
  const { run } = fakeHelper(layout, win)
  const placement = createPlacement({ ...base, appWindows, run })
  await placement.ensureRunning(win.conn, 's:0:0', { opened: true })
  const right = WIDE.frame.x + WIDE.frame.width
  assert.equal(win.state.x, right - 1024 + 8, 'right edge 8 pt past the screen')
  assert.ok(win.state.x >= app.x + app.width + 12, 'still clear of the app window')
})

test('without Accessibility the window is moved with AppleScript, and a hidden page gets a NOTE naming the missing grant', async () => {
  const layout = { screens: [LAPTOP], frontmost: { pid: 742, bundleId: EDITOR }, windows: [{ id: 90, pid: 742, bundleId: EDITOR, owner: 'Editor', bounds: { x: 50, y: 34, width: 1660, height: 1073 } }] }
  const win = fakeWindow({ x: 300, y: 100 }, 'hidden')
  const { run, calls } = fakeHelper(layout, win, { accessibility: false })
  const moves = []
  const setBounds = async (_app, windowNumber, rect) => { moves.push({ windowNumber, rect }); Object.assign(win.state, { x: rect.x, y: rect.y }); return '' }
  const placement = createPlacement({ ...base, run, setBounds })
  const result = await placement.ensureRunning(win.conn, 's:0:0', { opened: false })
  const spot = parkingSpot(LAPTOP.visible, 0, { sliver: 48, step: 32 })
  assert.deepEqual(moves, [{ windowNumber: 99, rect: { ...spot, width: 1024, height: 768 } }])
  assert.equal(calls.some(a => a[0] === 'move' || a[0] === 'make-room'), false)
  assert.equal(result.parked, true)
  assert.match(result.note, /still covered — DeepSea Window Helper has no Accessibility permission/)
})

test('make-room trims the frontmost window when the page stays hidden, and restore puts it back', async () => {
  const editor = { x: 50, y: 34, width: 1660, height: 1073 }
  const layout = { screens: [LAPTOP], frontmost: { pid: 742, bundleId: EDITOR }, windows: [{ id: 90, pid: 742, bundleId: EDITOR, owner: 'Editor', bounds: editor }] }
  const win = fakeWindow({ x: 300, y: 100 }, 'hidden')
  const trimmed = { ...editor, width: 1612 }
  const { run, calls } = fakeHelper(layout, win, { onMakeRoom: () => { win.state.v = 'visible'; return { ok: true, pid: 742, changed: true, trims: [{ before: editor, after: trimmed }] } } })
  const placement = createPlacement({ ...base, run })
  const result = await placement.ensureRunning(win.conn, 's:0:0', { opened: false })
  assert.deepEqual(result, { parked: true, note: '' })
  assert.deepEqual(calls.find(a => a[0] === 'make-room'), ['make-room', '--width', '48', '--min-width', '480'])
  assert.equal(placement.trims.length, 1)
  await placement.release('s:0:0')
  assert.deepEqual(calls.at(-1), ['restore', '--pid', '742', '--frame', '50,34,1660,1073', '--expect', '50,34,1612,1073'])
  assert.equal(placement.trims.length, 0)
})

test('a helper that is not installed: a hidden page says why it could not be parked', async () => {
  const win = fakeWindow({ x: 300, y: 100 }, 'hidden')
  const placement = createPlacement({ ...base, run: async () => ({ ok: false, error: 'DeepSea Window Helper gave no answer (is it installed at /x/DeepSea Window Helper.app?)' }) })
  const result = await placement.ensureRunning(win.conn, 's:0:0', { opened: false })
  assert.equal(result.parked, false)
  assert.match(result.note, /could not be parked: DeepSea Window Helper gave no answer/)
})
