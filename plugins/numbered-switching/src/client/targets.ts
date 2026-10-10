/**
 * Switch targets: what a numbered slot points at. Local sessions of this
 * server, or, while the remote-workspaces plugin is loaded, sessions of a
 * mirrored remote workspace, addressed by that plugin's `(workspaceId,
 * sessionId)` pair. Slots store the encoded string key; the rest of the
 * plugin never compares raw ids across kinds.
 *
 *   local:<sessionId>
 *   remote:<workspaceId>:<sessionId>     (the same `<ws>:<id>` the remote plugin
 *                                         stamps on its rows as
 *                                         data-deepsea-remote-session)
 *
 * Session ids are `session-<uuid>` (no colon); the remote workspace id is
 * whatever the remote plugin minted, so decoding splits at the LAST colon.
 */

export interface LocalTarget { kind: 'local'; sessionId: string }
export interface RemoteTarget { kind: 'remote'; workspaceId: string; sessionId: string }
export type Target = LocalTarget | RemoteTarget

const LOCAL_PREFIX = 'local:'
const REMOTE_PREFIX = 'remote:'

/**
 * @param target - what to encode.
 * @returns the slot key.
 */
export function encodeTarget(target: Target): string {
  return target.kind === 'local'
    ? `${LOCAL_PREFIX}${target.sessionId}`
    : `${REMOTE_PREFIX}${target.workspaceId}:${target.sessionId}`
}

/**
 * @param key - a slot key.
 * @returns the target, or undefined for a malformed key (a stale persisted table).
 */
export function decodeTarget(key: string): Target | undefined {
  if (key.startsWith(LOCAL_PREFIX)) {
    const sessionId = key.slice(LOCAL_PREFIX.length)
    return sessionId === '' ? undefined : { kind: 'local', sessionId }
  }
  if (key.startsWith(REMOTE_PREFIX)) {
    const pair = key.slice(REMOTE_PREFIX.length)
    const cut = pair.lastIndexOf(':')
    if (cut <= 0 || cut === pair.length - 1) return undefined
    return { kind: 'remote', workspaceId: pair.slice(0, cut), sessionId: pair.slice(cut + 1) }
  }
  return undefined
}

/**
 * Key of a remote row's `data-deepsea-remote-session` value (`<workspaceId>:<sessionId>`).
 * @param rowKey - the attribute value.
 * @returns the slot key, or undefined when the value is not a pair.
 */
export function remoteKeyOfRow(rowKey: string): string | undefined {
  const key = `${REMOTE_PREFIX}${rowKey}`
  return decodeTarget(key) === undefined ? undefined : key
}
