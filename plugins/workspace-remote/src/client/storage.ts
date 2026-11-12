/**
 * Browser storage keys renamed with the plugin (remote-workspaces →
 * workspace-remote): the old entry is read once, while the new one is absent,
 * written under the new key and removed.
 */

/** The view store's persist name. */
export const VIEW_KEY = 'deepsea.workspace-remote.view'
/** Its name before the rename. */
export const OLD_VIEW_KEY = 'deepsea.remote-workspaces.view'

/**
 * Move `from` to `to` unless `to` already holds a value. Storage failures
 * (private mode, quota) leave both as they are.
 * @param storage - where (default: this page's localStorage, if any).
 */
export function migrateStorageKey(from: string, to: string, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = globalThis.localStorage): void {
  if (storage === undefined) return
  try {
    const old = storage.getItem(from)
    if (old === null) return
    if (storage.getItem(to) === null) storage.setItem(to, old)
    storage.removeItem(from)
  } catch { /* storage unavailable: nothing to move */ }
}
