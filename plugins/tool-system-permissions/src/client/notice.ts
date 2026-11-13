/**
 * Notices: the card in a floating panel of the macOS app when a call has
 * waited `noticeSeconds` (default 60) without a click, so an agent waiting in
 * a session nobody is looking at gets seen. Nothing is granted by itself.
 *
 * The package root's browser half runs this in every page of the app that
 * has `__DEEPSEA_APP__.showPanel` (apps/macos, Floating panels): it asks the
 * running route every 2 s for the open calls, shows a panel for each call
 * whose `noticeAt` (server clock) has passed, and closes it when the call no
 * longer waits. The app keeps one panel per id across its windows, and tells
 * every page when one opens or closes (`deepsea-app-panel`), so a second
 * window does not show it again. A panel the person closes comes back only
 * after another `noticeMs` of the call still waiting.
 *
 * `decide` is pure, for node:test (tests/client-model.test.mjs).
 */

/** One entry of GET running. */
export interface RunningCall {
  callId: string
  sessionId: string
  noticeAt: number | null
  noticeMs: number
  open: number
  total: number
}

export interface NoticeState {
  /** Calls whose panel is open (in any window of the app). */
  shown: Set<string>
  /** When the person closed a call's panel, on the server clock. */
  closedAt: Map<string, number>
}

/** Panel ids are app-wide: the plugin's prefix and the call id. */
export const PANEL_PREFIX = 'deepsea-tool-system-permissions:'
export const panelIdOf = (callId: string): string => `${PANEL_PREFIX}${callId}`
export const callIdOfPanel = (id: string): string | undefined => id.startsWith(PANEL_PREFIX) ? id.slice(PANEL_PREFIX.length) : undefined

/** Mirrors index.js (document-relative, as the card's routes). */
export const RUNNING_PATH = './api/deepsea-tool-system-permissions/running'
export const PANEL_PATH = './api/deepsea-tool-system-permissions/panel'
export const POLL_MS = 2000

/** Which panels to show and which to close now (server clock `now`). */
export function decide(calls: readonly RunningCall[], state: NoticeState, now: number): { show: RunningCall[], close: string[] } {
  const waiting = new Set(calls.map(c => c.callId))
  const show = calls.filter((call) => {
    if (state.shown.has(call.callId) || call.open === 0 || call.noticeAt === null) return false
    const closed = state.closedAt.get(call.callId)
    const due = Math.max(call.noticeAt, closed === undefined ? 0 : closed + call.noticeMs)
    return now >= due
  })
  const close = [...state.shown].filter(callId => !waiting.has(callId))
  return { show, close }
}

/** The panel's size for a call: room for its rows (two lines each: the panel is narrow enough that the justification wraps under the name) and the session line. */
export function panelSize(call: RunningCall): { width: number, height: number } {
  return { width: 560, height: Math.min(680, 110 + 42 * Math.max(1, call.total)) }
}

export function panelUrl(call: RunningCall): string {
  const query = new URLSearchParams({ callId: call.callId, sessionId: call.sessionId, panel: panelIdOf(call.callId) })
  return `${PANEL_PATH}?${query.toString()}`
}

interface AppPanels {
  showPanel: (options: { id: string, url: string, width: number, height: number, title: string }) => void
  closePanel: (id: string) => void
}

/** The app's panel API, when this page runs in the macOS app. */
export function appPanels(): AppPanels | undefined {
  const app = (globalThis as { __DEEPSEA_APP__?: Partial<AppPanels> }).__DEEPSEA_APP__
  return typeof app?.showPanel === 'function' && typeof app.closePanel === 'function' ? app as AppPanels : undefined
}

/**
 * Run the notices in this page until the returned function is called.
 * @param title - the panel window's title (the card's title, localized).
 */
export function startNotices(app: AppPanels, title: () => string): () => void {
  const state: NoticeState = { shown: new Set(), closedAt: new Map() }
  let offset = 0
  let stopped = false
  let timer: number | undefined
  const onPanel = (event: Event) => {
    const detail = (event as CustomEvent<{ id?: string, state?: string, by?: string }>).detail
    const callId = typeof detail?.id === 'string' ? callIdOfPanel(detail.id) : undefined
    if (callId === undefined) return
    if (detail.state === 'opened') state.shown.add(callId)
    if (detail.state === 'closed') {
      state.shown.delete(callId)
      if (detail.by === 'user') state.closedAt.set(callId, Date.now() + offset)
    }
  }
  window.addEventListener('deepsea-app-panel', onPanel)
  const tick = async () => {
    try {
      const response = await fetch(RUNNING_PATH, { credentials: 'same-origin', cache: 'no-store' })
      if (response.ok) {
        const body = await response.json() as { calls?: RunningCall[], now?: number }
        const calls = Array.isArray(body.calls) ? body.calls : []
        const now = typeof body.now === 'number' ? body.now : Date.now()
        offset = now - Date.now()
        const { show, close } = decide(calls, state, now)
        for (const call of show) {
          state.shown.add(call.callId)
          app.showPanel({ id: panelIdOf(call.callId), url: panelUrl(call), ...panelSize(call), title: title() })
        }
        for (const callId of close) {
          state.shown.delete(callId)
          state.closedAt.delete(callId)
          app.closePanel(panelIdOf(callId))
        }
      }
    } catch { /* the next tick asks again */ }
    if (!stopped) timer = window.setTimeout(() => { void tick() }, POLL_MS)
  }
  void tick()
  return () => {
    stopped = true
    window.clearTimeout(timer)
    window.removeEventListener('deepsea-app-panel', onPanel)
  }
}
