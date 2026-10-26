/**
 * Focus and the foreground.
 *
 * `createForeground` is the `activate` remedy for a covered Safari window
 * (safari.hiddenWindows: activate). macOS reports an STP window that opaque
 * windows cover completely as occluded, and WebKit then marks the page
 * `document.visibilityState === 'hidden'`: requestAnimationFrame stops, CSS
 * transitions and animations and Web Animations freeze, so a page whose
 * content appears after an animation hangs behind its spinner. No driver call
 * un-hides a window (switch_tab, set_viewport_size, create_tab and
 * window.focus() all leave it hidden), and WebKit's occlusion switch is
 * private API. What works: AppleScript `activate` of STP, then `switch_tab`
 * to the window's own tab. It is done only when the page reports `hidden`, so
 * a visible window costs one evaluate and never takes focus. The default
 * remedy, parking, never takes focus at all (placement.mjs).
 *
 * `keepingFocus` gives focus back when Chrome takes it: Chrome activates
 * itself when it launches.
 */

import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { parseJsonText } from './servers.mjs'

/** The .app bundle that contains a safaridriver binary (…/X.app/Contents/MacOS/safaridriver), or undefined. */
export function appBundleOf(driverPath) {
  const macos = dirname(driverPath)
  const contents = dirname(macos)
  const app = dirname(contents)
  return app.endsWith('.app') ? app : undefined
}

/**
 * Activate an app with AppleScript's `activate` (an Apple Event the app
 * handles itself). For STP this orders its automation windows above other
 * apps' windows, whereas activating from outside
 * (`NSRunningApplication.activateWithOptions`, even with
 * NSApplicationActivateAllWindows) makes STP frontmost but leaves automation
 * windows covered. Resolves false when osascript failed (Automation consent
 * refused, say).
 * @param {string} appPath - absolute path of the .app bundle.
 */
export function activateApp(appPath) {
  const script = `tell application (POSIX file ${JSON.stringify(appPath)} as text) to activate`
  return new Promise(resolve => {
    execFile('osascript', ['-e', script], { timeout: 5000 }, (error) => resolve(!error))
  })
}

const VISIBILITY = 'return document.visibilityState'
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param {object} options
 * @param {string} options.driver - safaridriver path (its app bundle is the one activated).
 * @param {(event: object) => void} [options.trace]
 * @param {(appPath: string) => Promise<boolean>} [options.activate] - test seam.
 * @returns {(conn: import('./servers.mjs').ServerConnection, windowId: string) => Promise<{ note: string }>}
 */
export function createForeground({ driver, trace = () => {}, activate = activateApp }) {
  const app = appBundleOf(driver)
  const visibility = async (conn) => {
    try { return parseJsonText(await conn.callText('evaluate_javascript', { expression: VISIBILITY })) } catch { return undefined }
  }
  return async function ensureRunning(conn, windowId) {
    const before = await visibility(conn)
    // undefined: the page could not run script (a dialog is open, the window is navigating); leave it alone.
    if (before !== 'hidden' || app === undefined) return { note: '' }
    const activated = await activate(app)
    try {
      const tabs = JSON.parse(await conn.callText('list_tabs', {}))
      const tab = tabs.find(t => t.active) ?? tabs[0]
      if (tab?.handle) await conn.callText('switch_tab', { handle: tab.handle })
    } catch { /* raising within STP is best effort; activation alone often suffices */ }
    let after = await visibility(conn)
    for (let i = 0; after === 'hidden' && i < 4; i++) { await sleep(150); after = await visibility(conn) }
    trace({ event: 'safari-raise', windowId, activated, after })
    if (after === 'hidden') {
      return { note: 'NOTE: this window\'s page is hidden (the Safari Technology Preview window is covered or on another Space and could not be brought to the front), so requestAnimationFrame and CSS animations are paused; content that appears after an animation may be missing. ' }
    }
    return { note: '' }
  }
}

/**
 * The frontmost app (`{ pid, bundleId }`), or undefined. JXA and NSWorkspace:
 * no permission needed.
 */
export function frontmostApp() {
  const script = 'ObjC.import("AppKit"); const a = $.NSWorkspace.sharedWorkspace.frontmostApplication; a ? JSON.stringify({ pid: a.processIdentifier, bundleId: a.bundleIdentifier.js }) : ""'
  return new Promise(resolve => execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000 }, (error, stdout) => {
    try { resolve(error ? undefined : JSON.parse(String(stdout).trim())) } catch { resolve(undefined) }
  }))
}

/** Re-activate the app with this pid (NSRunningApplication; no Apple Events, no permission). */
export function activatePid(pid) {
  const script = `ObjC.import('AppKit'); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}); a ? a.activateWithOptions(0) : false`
  return new Promise(resolve => execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000 }, (error, stdout) => resolve(!error && String(stdout).trim() === 'true')))
}

/**
 * Run `action`; if it makes an app in `thief` (bundle ids) frontmost that was
 * not frontmost before, give focus back to the previous app. Returns the
 * action's result.
 * @param {string[]} thief
 * @param {() => Promise<T>} action
 * @param {(event: object) => void} [trace]
 * @param {{ frontmost?: typeof frontmostApp, activate?: typeof activatePid }} [seams] - test seams.
 * @template T
 */
export async function keepingFocus(thief, action, trace = () => {}, seams = {}) {
  const frontmost = seams.frontmost ?? frontmostApp
  const activate = seams.activate ?? activatePid
  const before = await frontmost()
  if (!before || thief.includes(before.bundleId)) return action()
  // Watch while the action runs (Chrome activates itself during its launch, about 1 s before the page
  // call returns) and for a moment after, giving focus back the moment the thief is frontmost.
  let done = false
  let settleUntil = Infinity
  const watch = (async () => {
    while (!(done && Date.now() > settleUntil)) {
      const now = await frontmost()
      if (now && thief.includes(now.bundleId) && now.pid !== before.pid) {
        const ok = await activate(before.pid)
        trace({ event: 'focus-restored', from: now.bundleId, to: before.bundleId, ok })
      }
      if (done && settleUntil === Infinity) settleUntil = Date.now() + 700
      await sleep(60)
    }
  })()
  try {
    return await action()
  } finally {
    done = true
    await watch
  }
}
