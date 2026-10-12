/**
 * What a framed remote session is being typed into, read from this side of
 * the same-origin frame: the persisted composer draft of a blank remote
 * session (ghost rows) and the slug convention of the local
 * session-title-slug plugin (previews on New Session rows).
 */

/** The page global @deepsea/session-title-slug publishes while loaded (plugins/AGENTS.md, contracts). */
export interface SlugConvention {
  parseSlug: (text: string) => string | undefined
}

/** `globalThis.__DEEPSEA_SESSION_TITLE_SLUG__`, or undefined while that plugin is not loaded. */
export function slugConvention(scope: object = globalThis): SlugConvention | undefined {
  const convention = (scope as { __DEEPSEA_SESSION_TITLE_SLUG__?: unknown }).__DEEPSEA_SESSION_TITLE_SLUG__
  return typeof convention === 'object' && convention !== null && typeof (convention as SlugConvention).parseSlug === 'function'
    ? convention as SlugConvention
    : undefined
}

/** The harness's ui-conversation store key; the framed page namespaces it per embedded session (client-store page-mode.ts). */
const CONVERSATION_STORE_KEY = 'dsh.conversation'

/**
 * The persisted composer draft of a framed remote session, read from this
 * origin's localStorage: `embed:<id>:dsh.conversation.<id>` holds `{ draft,
 * view, viewRequest }`, `draft` a string or `{ text, references }`.
 * @param sessionId - the remote session.
 * @param storage - where to read (default: this page's localStorage).
 * @returns the draft text, or '' when nothing usable is stored.
 */
export function framedDraftOf(sessionId: string, storage: Pick<Storage, 'getItem'> = localStorage): string {
  try {
    const raw = storage.getItem(`embed:${sessionId}:${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return ''
    const parsed: unknown = JSON.parse(raw)
    const draft = typeof parsed === 'object' && parsed !== null ? (parsed as { draft?: unknown }).draft : undefined
    if (typeof draft === 'string') return draft
    const text = typeof draft === 'object' && draft !== null ? (draft as { text?: unknown }).text : undefined
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}
