/**
 * Parking: keep Safari automation windows running without ever taking focus
 * (safari.hiddenWindows: park, the default).
 *
 * WebKit pauses a page (document.visibilityState "hidden": no
 * requestAnimationFrame, frozen CSS transitions and animations) whenever
 * macOS reports its window as fully covered by opaque windows. A window
 * overhanging the left or right edge of a screen counts as visible however
 * its on-screen part is covered, in some display arrangements (README,
 * "Covered windows keep running"); 8 visible points are enough; a window may
 * sit almost entirely off screen; screenshots still capture the whole
 * viewport.
 *
 * So each automation window is placed, by what is frontmost when it opens (and
 * again whenever its page reports `hidden`):
 *
 *   beside   this server's DeepSea app is frontmost on a large screen and ends
 *            early enough: the window goes to its right, full size, cascaded,
 *            always overhanging the screen's right edge;
 *   edge     otherwise a sliver at the right edge of the screen (its close
 *            button showing), each further window one step lower; when this
 *            server's DeepSea app is frontmost it is asked to end short of
 *            that strip (`reveal`, cooperation through app-windows.mjs), and
 *            put back when the last window closes.
 *
 * When the page is still hidden afterwards and the frontmost app's window
 * reaches into the strip, DeepSea Window Helper trims that window's right edge
 * out of the strip through Accessibility (make-room), and puts it back when
 * the last parked window closes, unless the person moved it meanwhile. A
 * visible page is never moved, so a window the person dragged into view stays
 * where they put it.
 *
 * Window identity: automation windows carry no title for an outside observer
 * (CGWindowList hides titles without Screen Recording; AppleScript's
 * `every window` omits automation windows), so the page's own outer frame
 * (screenX, screenY, outerWidth, outerHeight) is matched against the helper's
 * layout.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { sameRect } from './app-windows.mjs'
import { parseJsonText } from './servers.mjs'

/** Where `apps/macos/WindowHelper/build.mjs --install` puts the helper (LAYOUT.md §6). */
export const WINDOW_HELPER_PATH = '~/Library/Application Support/io.github.taliesinb.deepsea/DeepSea Window Helper.app'
export const STP_BUNDLE_ID = 'com.apple.SafariTechnologyPreview'

const GEOMETRY = 'return { v: document.visibilityState, x: screenX, y: screenY, w: outerWidth, h: outerHeight }'
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
export const expandHome = (path) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

/**
 * Run one DeepSea Window Helper command through LaunchServices (`open`), so
 * the helper is its own responsible process for macOS's privacy checks and
 * its Accessibility grant is the one that counts. `open --stdout` appends to
 * its file: every call gets a fresh scratch directory.
 * @returns {Promise<object>} the helper's JSON reply ({ ok: false, error } on failure).
 */
export async function runHelper(appPath, args, timeoutMs = 8000) {
  const dir = await mkdtemp(join(tmpdir(), 'deepsea-browser-helper-'))
  const out = join(dir, 'out.json')
  try {
    await new Promise((resolve) => {
      execFile('open', ['-W', '-g', '-n', '-a', appPath, '--stdout', out, '--stderr', join(dir, 'err.txt'), '--args', ...args], { timeout: timeoutMs }, () => resolve())
    })
    const text = (await readFile(out, 'utf8').catch(() => '')).trim().split('\n').at(-1) ?? ''
    if (text === '') {
      const err = (await readFile(join(dir, 'err.txt'), 'utf8').catch(() => '')).trim()
      return { ok: false, error: err || `DeepSea Window Helper gave no answer (is it installed at ${appPath}?)` }
    }
    return JSON.parse(text)
  } catch (error) {
    return { ok: false, error: String(error) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Move a window with AppleScript `set bounds of window id <CG number>` (no Accessibility; Automation consent). */
function appleScriptBounds(appPath, windowNumber, rect) {
  const script = `tell application (POSIX file ${JSON.stringify(appPath)} as text) to set bounds of window id ${windowNumber} to {${Math.round(rect.x)}, ${Math.round(rect.y)}, ${Math.round(rect.x + rect.width)}, ${Math.round(rect.y + rect.height)}}`
  return new Promise(resolve => execFile('osascript', ['-e', script], { timeout: 5000 }, (error, _out, stderr) => resolve(error ? String(stderr || error).trim() : '')))
}

const near = (a, b, tolerance = 3) => Math.abs(a - b) <= tolerance
/**
 * Does a window-server frame belong to the page's window? WebKit's `screenX`
 * is global, but `screenY` counts from the top of the window's own screen (a
 * window at global y −1050 on a screen whose top is −1080 reports screenY
 * 30). Either reading is accepted.
 */
const sameFrame = (bounds, page, screens = []) => {
  if (!(near(bounds.x, page.x) && near(bounds.width, page.w) && near(bounds.height, page.h))) return false
  if (near(bounds.y, page.y)) return true
  return screens.some(s => bounds.x + bounds.width / 2 >= s.frame.x && bounds.x + bounds.width / 2 < s.frame.x + s.frame.width
    && bounds.y >= s.frame.y - 1 && bounds.y < s.frame.y + s.frame.height && near(bounds.y - s.frame.y, page.y))
}
const area = (r) => Math.max(0, r.width) * Math.max(0, r.height)
const overlap = (a, b) => area({ width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) })

/** Where slot `slot` parks on a screen's visible frame: a sliver at the right edge, one step lower per slot (wrapping). */
export function parkingSpot(visible, slot, { sliver, step }) {
  const rows = Math.max(1, Math.floor((visible.height - 60) / step))
  return { x: visible.x + visible.width - sliver, y: visible.y + (slot % rows) * step }
}

/**
 * @param {object} options
 * @param {string} options.stpApp - the STP .app bundle (derived from safari.driver).
 * @param {string} options.helper - path of "DeepSea Window Helper.app" (`~/` expanded).
 * @param {number} options.sliver - visible width of a parked window (pt).
 * @param {number} options.step - vertical offset between parked windows (pt).
 * @param {boolean} options.makeRoom - trim the frontmost window out of the strip when needed.
 * @param {number} options.minWidth - never trim a window narrower than this.
 * @param {ReturnType<import('./app-windows.mjs').createAppWindows>} [options.appWindows]
 *   this server's DeepSea apps reporting their windows: when one is frontmost, windows go beside it,
 *   or it is asked to reveal the parking strip itself (no Accessibility).
 * @param {number} [options.largeScreenWidth] - visible width (pt) from which a screen counts as large.
 * @param {number} [options.besideMaxFraction] - an app window ending within this fraction of a large
 *   screen's width gets the agent's windows beside it.
 * @param {number} [options.gap] - space between the app window and windows beside it or the strip (pt).
 * @param {number} [options.overhang] - how far a window placed beside the app sticks out past the
 *   screen's right edge (pt).
 * @param {(event: object) => void} [options.trace]
 * @param {(app: string, args: string[]) => Promise<object>} [options.run] - helper runner (test seam).
 * @param {(app: string, windowNumber: number, rect: object) => Promise<string>} [options.setBounds] - AppleScript mover (test seam).
 */
export function createPlacement(options) {
  const { stpApp, sliver, step, makeRoom, minWidth, appWindows, trace = () => {}, run = runHelper, setBounds = appleScriptBounds } = options
  const largeScreenWidth = options.largeScreenWidth ?? 1920
  const besideMaxFraction = options.besideMaxFraction ?? 0.72
  const gap = options.gap ?? 12
  const overhang = options.overhang ?? 8
  const helper = expandHome(options.helper)
  /** windowId → slot index (lowest free one reused). */
  const slots = new Map()
  /** Windows that were trimmed: { pid, before, after, via }. Restored when no window is parked any more. */
  let trims = []

  const geometry = async (conn) => {
    try { return parseJsonText(await conn.callText('evaluate_javascript', { expression: GEOMETRY })) } catch { return undefined }
  }
  const slotFor = (windowId) => {
    if (slots.has(windowId)) return slots.get(windowId)
    const used = new Set(slots.values())
    let slot = 0
    while (used.has(slot)) slot++
    slots.set(windowId, slot)
    return slot
  }

  const screenOf = (layout, r) => {
    const screens = layout.screens ?? []
    return screens.reduce((best, s) => (overlap(s.frame, r) > overlap(best.frame, r) ? s : best), screens[0])
  }

  /** A report describes a window of this Mac: same pid and bundle id, and a frame the layout shows. */
  const isLocal = (layout, app) => (layout.windows ?? []).some(w => w.pid === app.pid && w.bundleId === app.bundleId
    && Math.abs(w.bounds.x - app.frame.x) <= 4 && Math.abs(w.bounds.y - app.frame.y) <= 4 && Math.abs(w.bounds.width - app.frame.width) <= 4)

  /** The frontmost app's window when it is a DeepSea app of this server that reported in. */
  function frontApp(layout) {
    const front = layout.frontmost
    const app = front && appWindows?.get(front.pid)
    if (!app || app.bundleId !== front.bundleId || app.fullScreen) return undefined
    return isLocal(layout, app) ? app : undefined
  }

  /**
   * This server's DeepSea app on this Mac even when it is not frontmost (the
   * most recently active one, if several reported): its screen is where the
   * agent's windows belong.
   */
  function ownerApp(layout) {
    const local = [...(appWindows?.windows.values() ?? [])].filter(a => !a.fullScreen && isLocal(layout, a))
    local.sort((a, b) => (Number(b.active) - Number(a.active)) || (b.at - a.at))
    return local[0]
  }

  /** Where slot `slot` goes (see the header): beside, or edge (with `reveal` when the app is frontmost). */
  function plan(layout, stp, slot) {
    const app = frontApp(layout)
    if (app) {
      const screen = app.screen ?? screenOf(layout, app.frame)
      const vis = screen.visible
      const fraction = (app.frame.x + app.frame.width - vis.x) / vis.width
      if (vis.width >= largeScreenWidth && fraction <= besideMaxFraction) {
        const rows = Math.max(1, Math.floor((vis.height - 60) / step))
        // Beside the app window, but always overhanging the screen's right edge: a window wholly on
        // screen goes hidden as soon as something covers it later.
        const besideX = app.frame.x + app.frame.width + gap
        const overhangX = screen.frame.x + screen.frame.width - stp.bounds.width + overhang
        // Cascade from the app window's own top: the visible frame reported for a secondary screen
        // may include its menu bar.
        const top = Math.max(vis.y, app.frame.y)
        return { kind: 'beside', app, spot: { x: Math.round(Math.max(besideX, overhangX)), y: Math.round(top + (slot % rows) * step) } }
      }
      return { kind: 'edge', app, reveal: true, spot: parkingSpot(vis, slot, { sliver, step }) }
    }
    // Another app in front: slivers on the screen of this server's DeepSea app when there is one
    // (the windows belong with the window that drives them), else on the frontmost window's screen.
    const owner = ownerApp(layout)
    const front = layout.frontmost
    const frontWindow = (layout.windows ?? []).find(w => w.pid === front?.pid) // CG order: front to back
    const screen = owner ? (owner.screen ?? screenOf(layout, owner.frame)) : screenOf(layout, frontWindow?.bounds ?? stp.bounds)
    return { kind: 'edge', owner: owner?.pid, spot: parkingSpot(screen.visible, slot, { sliver, step }) }
  }

  /** Ask this server's frontmost DeepSea app to end short of the strip (cooperation; no Accessibility). */
  async function revealStrip(app, spot) {
    const limit = spot.x - gap
    if (app.frame.x + app.frame.width <= limit + 1) return { done: false, reason: 'already clear' }
    const width = Math.round(limit - app.frame.x)
    if (width < minWidth) return { done: false, reason: `the DeepSea window would be narrower than ${minWidth}` }
    const before = app.frame
    const wanted = { ...before, width }
    const report = await appWindows.setFrame(app.pid, wanted)
    trace({ event: 'safari-reveal', pid: app.pid, before, wanted, got: report?.frame })
    if (!report) return { done: false, reason: 'the DeepSea window did not answer' }
    trims.push({ pid: app.pid, before, after: report.frame, via: 'app' })
    return { done: true, via: 'app' }
  }

  /** Free the strip from the frontmost app's window through DeepSea Window Helper (Accessibility). */
  async function clearStrip(layout, strip) {
    const front = layout.frontmost ?? {}
    const frontWindows = (layout.windows ?? []).filter(w => w.pid === front.pid && overlap(w.bounds, strip) > 0)
    if (frontWindows.length === 0) return { done: false, reason: 'the strip is covered by a window that is not frontmost' }
    if (!makeRoom) return { done: false, reason: 'safari.park.makeRoom is off' }
    if (!layout.accessibility) return { done: false, reason: 'DeepSea Window Helper has no Accessibility permission (System Settings ▸ Privacy & Security ▸ Accessibility ▸ "DeepSea Window Helper")' }
    const reply = await run(helper, ['make-room', '--width', String(sliver), '--min-width', String(minWidth)])
    trace({ event: 'safari-make-room', reply })
    if (!reply.ok) return { done: false, reason: reply.error }
    if (reply.changed) {
      for (const t of reply.trims ?? []) trims.push({ pid: reply.pid, before: t.before, after: t.after, via: 'helper' })
      return { done: true, via: 'helper' }
    }
    return { done: false, reason: `${reply.name || 'the frontmost window'} was not trimmed: ${reply.reason ?? 'unknown'}` }
  }

  /**
   * Park the window (just opened, or its page hidden) and make sure it is not covered.
   * @returns {Promise<{ parked: boolean, note: string }>}
   */
  async function ensureRunning(conn, windowId, { opened = false } = {}) {
    let page = await geometry(conn)
    if (opened && (!page || typeof page !== 'object')) {
      // A new driver session has no tab until its first navigation, so script cannot run yet:
      // about:blank lets the window be parked before the agent's page loads into it.
      try { await conn.callText('navigate_to_url', { url: 'about:blank' }) } catch { /* fall through */ }
      page = await geometry(conn)
    }
    if (!page || typeof page !== 'object') { trace({ event: 'safari-park-skip', windowId, opened }); return { parked: false, note: '' } } // a dialog is open, or it is navigating
    if (!opened && page.v !== 'hidden') return { parked: false, note: '' }
    const layout = await run(helper, ['layout'])
    if (!layout.ok) {
      return { parked: false, note: page.v === 'hidden' ? `NOTE: this window's page is hidden (covered), so requestAnimationFrame and CSS animations are paused, and it could not be parked: ${layout.error}. ` : '' }
    }
    const stp = (layout.windows ?? []).find(w => w.bundleId === STP_BUNDLE_ID && sameFrame(w.bounds, page, layout.screens))
      ?? (layout.windows ?? []).find(w => /Safari Technology Preview/.test(w.owner) && sameFrame(w.bounds, page, layout.screens))
    if (!stp) {
      trace({ event: 'safari-park-unmatched', windowId, page })
      return { parked: false, note: page.v === 'hidden' ? 'NOTE: this window\'s page is hidden (covered), so animations are paused; its window could not be identified for parking. ' : '' }
    }
    const placed = plan(layout, stp, slotFor(windowId))
    const spot = placed.spot
    const strip = { x: spot.x, y: spot.y, width: sliver, height: 40 }
    // Move unless already there (±3 pt).
    if (!(near(stp.bounds.x, spot.x) && near(stp.bounds.y, spot.y))) {
      let moved
      if (layout.accessibility) {
        const reply = await run(helper, ['move', '--pid', String(stp.pid), '--match', `${stp.bounds.x},${stp.bounds.y},${stp.bounds.width},${stp.bounds.height}`, '--to', `${spot.x},${spot.y}`])
        moved = reply.ok ? '' : reply.error
      } else {
        moved = await setBounds(stpApp, stp.id, { ...spot, width: stp.bounds.width, height: stp.bounds.height })
      }
      trace({ event: 'safari-park', windowId, kind: placed.kind, spot, error: moved || undefined })
      if (moved) return { parked: false, note: page.v === 'hidden' ? `NOTE: this window's page is hidden (covered), so animations are paused; parking it failed: ${moved}. ` : '' }
    }
    // This server's DeepSea app is in front and reaches into the strip: it makes room itself, so the
    // person sees the agent's windows arrive and can reach them.
    let revealed
    if (placed.reveal) revealed = await revealStrip(placed.app, spot)
    const settle = async () => {
      let state = await geometry(conn)
      for (let i = 0; state?.v === 'hidden' && i < 5; i++) { await sleep(150); state = await geometry(conn) }
      return state
    }
    let after = await settle()
    // Still covered: make room only then. Translucent windows (the DeepSea app's) do not occlude, so a
    // frontmost window over the strip is trimmed only when it actually hides the page.
    let cleared = { done: false, reason: '' }
    const coveringFront = (layout.windows ?? []).some(w => w.pid === layout.frontmost?.pid && w.bundleId !== STP_BUNDLE_ID && overlap(w.bounds, strip) > 0)
    if (after?.v === 'hidden' && coveringFront) {
      cleared = await clearStrip(layout, strip)
      if (cleared.done) after = await settle()
    }
    trace({ event: 'safari-park-result', windowId, kind: placed.kind, visibility: after?.v, cleared, revealed })
    if (after?.v === 'hidden') {
      const why = cleared.reason || (coveringFront ? '' : 'another window covers the parking strip')
      return { parked: true, note: `NOTE: this window's page is hidden (covered), so requestAnimationFrame and CSS animations are paused; it was parked at the right edge but is still covered${why ? ` — ${why}` : ''}. ` }
    }
    return { parked: true, note: '' }
  }

  /** A Safari window closed: free its slot; when none is parked any more, put trimmed windows back. */
  async function release(windowId) {
    slots.delete(windowId)
    if (slots.size > 0 || trims.length === 0) return
    const pending = trims
    trims = []
    for (const trim of pending) {
      if (trim.via === 'app') {
        // Only if the person has not moved or resized the DeepSea window since.
        const now = appWindows?.get(trim.pid)
        if (now && sameRect(now.frame, trim.after, 4)) await appWindows.setFrame(trim.pid, trim.before)
        trace({ event: 'safari-restore', trim, current: now?.frame })
        continue
      }
      const f = (r) => `${r.x},${r.y},${r.width},${r.height}`
      const reply = await run(helper, ['restore', '--pid', String(trim.pid), '--frame', f(trim.before), '--expect', f(trim.after)])
      trace({ event: 'safari-restore', trim, reply })
    }
  }

  return { ensureRunning, release, slots, get trims() { return trims } }
}
