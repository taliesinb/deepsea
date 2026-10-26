/**
 * The chord: primary modifier + a digit. Pure, so it is unit-tested under
 * plain Node.
 */

/** The keydown fields a chord is read from. */
export type ChordEvent = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>

/**
 * Whether the page runs on an Apple platform (⌘ is the primary modifier).
 * @param nav - the navigator fields that tell.
 * @returns true on macOS and iOS.
 */
export function isApplePlatform(nav: { platform: string; userAgent: string }): boolean {
  return /Mac|iPhone|iPad|iPod/.test(nav.platform) || /Macintosh/.test(nav.userAgent)
}

/**
 * The slot number a keydown addresses: primary modifier (⌘ without ⌃ on
 * Apple platforms, ⌃ without ⌘ elsewhere) + a digit 1…count, no ⌥ or ⇧, not a
 * key repeat. The digit comes from `code` (`Digit1…`, `Numpad1…`) or else
 * `key`, so a non-Latin layout and the numeric keypad both work.
 * @param event - the keydown.
 * @param count - number of slots in force.
 * @param apple - whether ⌘ is the primary modifier.
 * @returns 1…count, or undefined when the event is not one of the chords.
 */
export function chordSlot(event: ChordEvent, count: number, apple: boolean): number | undefined {
  if (event.repeat || event.altKey || event.shiftKey) return undefined
  const primary = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!primary) return undefined
  const fromCode = /^(?:Digit|Numpad)([1-9])$/u.exec(event.code)?.[1]
  const digit = fromCode ?? (/^[1-9]$/u.test(event.key) ? event.key : undefined)
  if (digit === undefined) return undefined
  const n = Number(digit)
  return n <= count ? n : undefined
}
