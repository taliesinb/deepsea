/**
 * @deepsea/ui-settings-entry, browser half: ⌘. (Ctrl+. off Apple devices)
 * toggles the Settings panel.
 *
 * One capture-phase `keydown` listener on `window`. On the chord it calls
 * `preventDefault` and `stopPropagation` before anything else sees the key
 * (the browser's own ⌘. and the shell's shortcut dispatcher), then toggles
 * the panel (toggle.ts).
 *
 * ⌘, is not used because Safari takes ⌘, as its own Settings… before the
 * page receives a keydown; ⌘. reaches the page and can be claimed in Safari
 * and Chrome alike.
 *
 * The macOS app's Settings… (⌘,) dispatches this chord as a synthetic
 * `keydown` on `window` and reads `dispatchEvent`'s result: `false` (the
 * default was prevented) means this plugin handled it; otherwise the app
 * falls back to upstream's own Settings command. So the listener accepts
 * untrusted events and must stay on `window`.
 *
 * The bundle patch also turns off upstream's account launcher
 * (`ui-settings-account`), so the sidebar's foot shows the Settings button
 * again rather than an account menu.
 */
import type { Context } from '@deepseek-ai/cordis'
import { isSettingsChord, settingsShell, toggleSettings, type SlotLedger } from './toggle.ts'

export const name = 'deepsea-ui-settings-entry'
export const inject: string[] = ['slots']

const APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent)

export function apply(ctx: Context): void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !isSettingsChord(event, APPLE)) return
    event.preventDefault()
    event.stopPropagation()
    const outcome = toggleSettings(settingsShell((ctx as unknown as { slots: SlotLedger }).slots))
    // The console, not ctx.logger: the page keeps no log sink, while the macOS
    // app copies console warnings into its run log.
    if (outcome === 'no-shell') console.warn(`[${name}] no-shell: the Settings panel is not mounted`)
  }
  ctx.effect(() => {
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, 'deepsea-ui-settings-entry: keydown capture')
}
