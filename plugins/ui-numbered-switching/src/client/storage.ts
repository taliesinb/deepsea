/**
 * The slot table's sessionStorage key, renamed with the plugin
 * (numbered-switching → ui-numbered-switching): the old entry is read once,
 * while the new one is absent, written under the new key and removed.
 */

/** sessionStorage key of the slot table (per window; dies with it). */
export const STORAGE_KEY = 'deepsea.ui-numbered-switching.slots'
/** Its name before the rename. */
export const OLD_STORAGE_KEY = 'deepsea.numbered-switching.slots'

/**
 * Move `from` to `to` unless `to` already holds a value. Storage failures
 * (private mode, quota) leave both as they are.
 * @param storage - where (default: this window's sessionStorage, if any).
 */
export function migrateStorageKey(from: string, to: string, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = globalThis.sessionStorage): void {
  if (storage === undefined) return
  try {
    const old = storage.getItem(from)
    if (old === null) return
    if (storage.getItem(to) === null) storage.setItem(to, old)
    storage.removeItem(from)
  } catch { /* storage unavailable: nothing to move */ }
}
