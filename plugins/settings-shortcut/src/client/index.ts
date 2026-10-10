/**
 * @deepsea/settings-shortcut, browser half: ⌘. (Ctrl+. off Apple devices)
 * toggles the Settings panel.
 *
 * One capture-phase `keydown` listener on `window`. On the chord it calls
 * `preventDefault` and `stopPropagation` before anything else sees the key
 * (the browser's own ⌘. and the shell's shortcut dispatcher), then toggles
 * the panel (toggle.ts).
 *
 * ⌘, is not used because Safari, and a Safari web app, take ⌘, as their own
 * Settings… before the page receives a keydown; ⌘. reaches the page and can
 * be claimed in Safari and Chrome alike.
 *
 * The macOS app's Settings… (⌘,) dispatches this chord as a synthetic
 * `keydown` on `window` and reads `dispatchEvent`'s result: `false` (the
 * default was prevented) means this plugin handled it; otherwise the app
 * clicks the same controls itself. So the listener accepts untrusted events
 * and must stay on `window`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { isSettingsChord, toggleSettings } from './toggle.ts'

export const name = 'deepsea-settings-shortcut'
export const inject: string[] = []

const APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent)

export function apply(ctx: Context): void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !isSettingsChord(event, APPLE)) return
    event.preventDefault()
    event.stopPropagation()
    const outcome = toggleSettings(document)
    // The console, not ctx.logger: the page keeps no log sink, while the macOS
    // app copies console warnings into its run log.
    if (outcome === 'no-trigger' || outcome === 'no-close') console.warn(`[${name}] ${outcome}: the Settings controls were not found`)
  }
  ctx.effect(() => {
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, 'deepsea-settings-shortcut: keydown capture')
}
