/**
 * The chord and the toggle, free of globals so they can be tested in Node.
 *
 * The Settings panel's open state belongs to the settings shell
 * (`ui-settings-general`); no service or slot opens it from outside, so the
 * toggle clicks the shell's own controls, exactly as a person would: the
 * sidebar's Settings trigger to open, the panel's close button to close (the
 * shell then restores focus as for a mouse close). The shell's CSS-module
 * classes compile to `<hash>_<local>`, so the `_local` suffixes below are
 * stable across client builds while the hash prefix is not. The macOS app's
 * Settings… (⌘,) uses the same selectors when this plugin is absent.
 */

/** The trigger in the sidebar foot's settings area (ui-sidebar SidebarRoot, ui-settings-general SettingsRoot). */
export const TRIGGER_SELECTOR = '[class$="_settingsArea"] button[aria-haspopup="dialog"]'
/** The same trigger by its own class, should the sidebar wrapper change. */
export const TRIGGER_FALLBACK_SELECTOR = 'button[aria-haspopup="dialog"][class*="_trigger"]'
/** The open panel's header close button (ui-settings-general SettingsPanel). */
export const CLOSE_SELECTOR = '[role="dialog"][class$="_panel"] button[class$="_close"]'

/** The slice of a KeyboardEvent the chord test reads. */
export interface ChordEvent {
  readonly key: string
  readonly code: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
}

/**
 * True for exactly the chord: the primary modifier (⌘ on Apple devices,
 * Ctrl elsewhere) and the period key, nothing else held, not a repeat.
 * `key` follows the layout; `code` names the physical key, and
 * `NumpadDecimal` is the keypad's (and how System Events sends ⌘.).
 * @param event - the keydown.
 * @param apple - whether the device is an Apple one.
 */
export function isSettingsChord(event: ChordEvent, apple: boolean): boolean {
  if (event.repeat || event.altKey || event.shiftKey) return false
  const primary = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!primary) return false
  return event.key === '.' || event.code === 'Period' || event.code === 'NumpadDecimal'
}

/** What a toggle did. */
export type ToggleOutcome = 'opened' | 'closed' | 'no-trigger' | 'no-close'

/** The slice of an element the toggle uses. */
interface Clickable {
  getAttribute(name: string): string | null
  click(): void
}

/** The slice of a document the toggle uses. */
export interface QueryRoot {
  querySelector(selector: string): Clickable | null
}

/**
 * Open the Settings panel, or close it when it is open (the trigger's
 * `aria-expanded`).
 * @param root - the document.
 */
export function toggleSettings(root: QueryRoot): ToggleOutcome {
  const trigger = root.querySelector(TRIGGER_SELECTOR) ?? root.querySelector(TRIGGER_FALLBACK_SELECTOR)
  if (trigger === null) return 'no-trigger'
  if (trigger.getAttribute('aria-expanded') === 'true') {
    const close = root.querySelector(CLOSE_SELECTOR)
    if (close === null) return 'no-close'
    close.click()
    return 'closed'
  }
  trigger.click()
  return 'opened'
}
