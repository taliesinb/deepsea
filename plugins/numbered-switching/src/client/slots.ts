/**
 * Numbered slots: a fixed number of positions (1…N) holding the most recently
 * viewed sessions. Pure data; the browser half feeds it selection changes.
 *
 * RULES
 *   - A session already holding a slot keeps its number for as long as it
 *     stays in the recent set — numbers are stable, never shuffled.
 *   - A novel session takes the first empty slot; when none is empty it takes
 *     the LEAST RECENTLY USED slot (the holder viewed longest ago is evicted).
 *   - "Used" means "was the current session": every time a session becomes
 *     current its recency is bumped, whether by click, ⌘N, or New Session.
 *   - Sessions that disappear (archived, deleted) free their slot on prune.
 */

/** The complete slot state; treat as immutable (every operation returns a new one). */
export interface SlotState {
  /** Slot holders by index (slot number = index + 1); `undefined` is empty. */
  readonly slots: readonly (string | undefined)[]
  /** Recency stamp per holder: higher = more recently current. */
  readonly lastUsed: Readonly<Record<string, number>>
  /** Monotonic counter behind the stamps. */
  readonly tick: number
}

/**
 * Empty state with `count` slots.
 * @param count - number of slots (1…9).
 * @returns the empty state.
 */
export function createSlotState(count: number): SlotState {
  const n = Math.max(1, Math.min(9, Math.trunc(count)))
  return { slots: Array.from({ length: n }, () => undefined), lastUsed: {}, tick: 0 }
}

/**
 * Record that `id` became the current session: bump it if it holds a slot,
 * otherwise seat it in the first empty slot, else evict the LRU holder.
 * @param state - previous state.
 * @param id - session that became current.
 * @returns the next state (a new object even when only the stamp moved).
 */
export function touch(state: SlotState, id: string): SlotState {
  const tick = state.tick + 1
  const lastUsed = { ...state.lastUsed, [id]: tick }
  if (state.slots.includes(id)) return { slots: state.slots, lastUsed, tick }

  let index = state.slots.indexOf(undefined)
  if (index === -1) {
    // Evict the least recently used holder. A holder without a stamp (should
    // not happen, but a restored state could carry one) counts as oldest.
    let oldest = Number.POSITIVE_INFINITY
    index = 0
    state.slots.forEach((holder, i) => {
      const stamp = holder === undefined ? -1 : state.lastUsed[holder] ?? -1
      if (stamp < oldest) {
        oldest = stamp
        index = i
      }
    })
    const evicted = state.slots[index]
    if (evicted !== undefined) delete lastUsed[evicted]
  }
  const slots = [...state.slots]
  slots[index] = id
  return { slots, lastUsed, tick }
}

/**
 * Free the slots of sessions that no longer exist (or are archived).
 * @param state - previous state.
 * @param isLive - true for sessions that may keep a slot.
 * @returns the same state object when nothing changed.
 */
export function prune(state: SlotState, isLive: (id: string) => boolean): SlotState {
  if (state.slots.every(holder => holder === undefined || isLive(holder))) return state
  const lastUsed = { ...state.lastUsed }
  const slots = state.slots.map((holder) => {
    if (holder === undefined || isLive(holder)) return holder
    delete lastUsed[holder]
    return undefined
  })
  return { slots, lastUsed, tick: state.tick }
}

/**
 * The 1-based slot number a session holds.
 * @param state - slot state.
 * @param id - session id.
 * @returns 1…N, or undefined when the session holds no slot.
 */
export function slotOf(state: SlotState, id: string): number | undefined {
  const index = state.slots.indexOf(id)
  return index === -1 ? undefined : index + 1
}

/**
 * The session holding slot `number`.
 * @param state - slot state.
 * @param number - 1-based slot number.
 * @returns the holder, or undefined for an empty or out-of-range slot.
 */
export function holderOf(state: SlotState, number: number): string | undefined {
  return state.slots[number - 1]
}

/**
 * Validate a persisted state (sessionStorage JSON) and coerce it to `count` slots.
 * @param raw - parsed JSON of unknown shape.
 * @param count - the slot count in force.
 * @returns a usable state, or undefined when the input is not a SlotState.
 */
export function restoreSlotState(raw: unknown, count: number): SlotState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as Partial<Record<keyof SlotState, unknown>>
  if (!Array.isArray(candidate.slots) || typeof candidate.lastUsed !== 'object' || candidate.lastUsed === null) return undefined
  if (typeof candidate.tick !== 'number' || !Number.isFinite(candidate.tick)) return undefined
  const rawSlots: readonly unknown[] = candidate.slots
  const base = createSlotState(count)
  const slots = base.slots.map((_, i) => {
    const holder = rawSlots[i]
    return typeof holder === 'string' && holder !== '' ? holder : undefined
  })
  const lastUsed: Record<string, number> = {}
  for (const [id, stamp] of Object.entries(candidate.lastUsed as Record<string, unknown>)) {
    if (typeof stamp === 'number' && Number.isFinite(stamp) && slots.includes(id)) lastUsed[id] = stamp
  }
  return { slots, lastUsed, tick: candidate.tick }
}
