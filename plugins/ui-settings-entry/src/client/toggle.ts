/**
 * The chord and the toggle, free of globals so they can be tested in Node.
 *
 * The Settings panel's open state belongs to the settings shell
 * (`ui-settings-general`): the store of its `sidebar.settings` entry, whose
 * `create()` hands out the shell's one instance (the instance its sidebar
 * launcher and its own Settings command use). The toggle drives that store's
 * `open` and `close` actions, so it opens the panel whatever the sidebar
 * shows (upstream's account menu, or the plain Settings button).
 */

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

/** The settings shell's view state: whether the panel is open, and the actions that open and close it. */
export interface SettingsShell {
  getSnapshot(): { readonly open: boolean }
  readonly actions: { open(): void; close(): void }
}

/** The slice of the client's slot ledger (`ctx.slots`) the lookup reads. */
export interface SlotLedger {
  entries(name: string): readonly { readonly store?: { create(): unknown } | undefined }[]
}

/**
 * The settings shell, or undefined while it is not mounted (it mounts once
 * the page may read the server's settings).
 * @param slots - the client's slot ledger.
 */
export function settingsShell(slots: SlotLedger): SettingsShell | undefined {
  const shell = slots.entries('sidebar.settings')[0]?.store?.create() as Partial<SettingsShell> | undefined
  return typeof shell?.getSnapshot === 'function' && typeof shell.actions?.open === 'function' && typeof shell.actions.close === 'function'
    ? shell as SettingsShell
    : undefined
}

/** What a toggle did. */
export type ToggleOutcome = 'opened' | 'closed' | 'no-shell'

/**
 * Open the Settings panel, or close it when it is open.
 * @param shell - the settings shell (settingsShell).
 */
export function toggleSettings(shell: SettingsShell | undefined): ToggleOutcome {
  if (shell === undefined) return 'no-shell'
  if (shell.getSnapshot().open) {
    shell.actions.close()
    return 'closed'
  }
  shell.actions.open()
  return 'opened'
}
