/**
 * @deepsea/numbered-switching: browser half.
 *
 * The five most recently viewed sessions hold the numbers 1…5. ⌘1…⌘5 (Ctrl
 * off Apple platforms) switch to the holder of that number; the number is
 * drawn on the holder's sidebar row. Numbers are stable: a session keeps its
 * number while it stays in the recent set. Opening a sixth (novel) session,
 * by click, search or New Session (+), evicts the LEAST RECENTLY VIEWED
 * holder and takes its number. Pure browser state: the slot table lives in
 * `sessionStorage`, so a reload keeps the numbering for this window and
 * nothing is written to the server.
 *
 * REMOTE WORKSPACES: while the remote-workspaces plugin is loaded, its
 * sessions (framed from other servers) take part exactly like local ones:
 * they are numbered when viewed, evict and get evicted, and ⌘N brings their
 * frame back. The coupling is the OPTIONAL browser service that plugin
 * provides (`deepseaRemoteWorkspaces`: getSelection / has / open /
 * subscribe) plus the `data-deepsea-remote-session` attribute on its rows;
 * `ctx.inject(['deepseaRemoteWorkspaces'], …)` runs that part only while the
 * service exists and unwinds when it goes. Without it nothing here changes.
 * Slot keys are `local:<id>` / `remote:<ws>:<id>` (targets.ts).
 *
 * WHERE THE CHORD ARRIVES: in the DeepSea macOS app, whose menus define no
 * ⌘digit equivalents, so the chords reach the page. Browsers reserve ⌘1…⌘9
 * for tabs or bookmarks and never deliver them to a page. The numbers are
 * drawn everywhere regardless: they mark the recent five even where the
 * chord is taken.
 *
 * HOW
 *   - Current LOCAL session: the Session Controller list row with
 *     `retainedBy.mainView > 0` (the Workspace browser's own row-highlight
 *     derivation; the selection itself is private to ui-workspace). It counts
 *     only while no global main panel is showing (`usePanelInfo().activePanelId
 *     === null`, read by a renderless `shell.overlay` entry): the retained
 *     local session does not become "viewed" because Settings or a remote
 *     frame covered it.
 *   - Current REMOTE session: `deepseaRemoteWorkspaces.getSelection()`
 *     (defined only while the remote panel is on screen).
 *   - Every change of the current key is one `touch` of the slot model
 *     (slots.ts); vanished and archived holders are pruned on every update.
 *   - Switching: `ctx.uiWorkspace.openSession(id)`, the verb a row click runs
 *     (it also returns the main view to the Conversation when a panel such as
 *     Settings is showing), or `deepseaRemoteWorkspaces.open(selection)` for a
 *     remote holder.
 *   - Badges: badges.ts patches the rendered rows (no per-row slot exists).
 *   - Chord: one capture-phase `keydown` on `window` (chord.ts), claimed
 *     with preventDefault before any editor keymap.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only (erased): merges `ctx.uiWorkspace` and `ctx.layout` into the
// cordis Context, the `mainView` reference source into
// SessionReferenceSourceMap, `ctx.slots`, and the `shell.overlay` slot with
// its `usePanelInfo` root hook.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { useEffect } from 'react'
import { installBadges } from './badges.ts'
import { chordSlot, isApplePlatform } from './chord.ts'
import { createSlotState, holderOf, prune, restoreSlotState, slotOf, touch, type SlotState } from './slots.ts'
import { decodeTarget, encodeTarget } from './targets.ts'

export { createSlotState, holderOf, prune, restoreSlotState, slotOf, touch } from './slots.ts'
export { decodeTarget, encodeTarget } from './targets.ts'
export { rowKey } from './badges.ts'
export { chordSlot, isApplePlatform } from './chord.ts'

/** Number of numbered slots (⌘1…⌘N). */
export const SLOT_COUNT = 5
/** sessionStorage key of the slot table (per window; dies with it). */
const STORAGE_KEY = 'deepsea.numbered-switching.slots'
/** The optional service of the remote-workspaces plugin. */
const REMOTE_SERVICE = 'deepseaRemoteWorkspaces'

/** The branded session id, derived from the list (avoids linking @deepseek-ai/dsh-session for one type). */
type SessionId = SessionListState['ids'][number]

/** A remote session, as the remote-workspaces plugin addresses it. */
export interface RemoteSelection { workspaceId: string; sessionId: string }

/**
 * The optional browser service `deepseaRemoteWorkspaces` of the
 * remote-workspaces plugin (structural; no build-time dependency).
 */
export interface RemoteWorkspacesFace {
  /** The remote session on screen, or undefined while no remote panel shows. */
  getSelection(): RemoteSelection | undefined
  /** Whether a remote session still exists (false only on positive evidence). */
  has(selection: RemoteSelection): boolean
  /** Bring that remote session's frame on screen. */
  open(selection: RemoteSelection): void
  /** Called whenever the selection or the remote session lists change. */
  subscribe(listener: () => void): () => void
}

const IS_APPLE = isApplePlatform(navigator)
const MODIFIER_GLYPH = IS_APPLE ? '⌘' : 'Ctrl+'

/**
 * The session shown in the main view, per the list's local reference counts.
 * @param list - Session Controller list snapshot.
 * @returns its id, or undefined (New Session view).
 */
export function currentSessionOf(list: SessionListState): SessionId | undefined {
  return Object.values(list.byId).find(summary => (summary.retainedBy.mainView ?? 0) > 0)?.id
}

/**
 * What is on screen, as a slot key, or `'panel'` while a global panel other
 * than the remote frame shows (not a session view: nothing gets touched).
 * @param args.remote - the remote selection on screen, when the remote plugin reports one.
 * @param args.activePanelId - the layout's selected main panel (null = Conversation).
 * @param args.local - the retained local session.
 * @returns the current key, `'panel'`, or undefined for the New Session view.
 */
export function currentKeyOf(args: {
  remote: RemoteSelection | undefined
  activePanelId: string | null
  local: string | undefined
}): string | 'panel' | undefined {
  if (args.remote !== undefined) return encodeTarget({ kind: 'remote', ...args.remote })
  if (args.activePanelId !== null) return 'panel'
  return args.local === undefined ? undefined : encodeTarget({ kind: 'local', sessionId: args.local })
}

function loadState(): SlotState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw !== null) {
      const restored = restoreSlotState(JSON.parse(raw), SLOT_COUNT)
      if (restored !== undefined) return restored
    }
  } catch {
    // Storage disabled or corrupt: start empty.
  }
  return createSlotState(SLOT_COUNT)
}

function saveState(state: SlotState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage disabled: the numbering simply does not survive a reload.
  }
}

/** Registration inject face of the panel watcher. */
interface PanelWatcherInjected {
  setActivePanel: (panelId: string | null) => void
}

/** Renders nothing; reports the layout's active main panel to apply. */
function PanelWatcher({ usePanelInfo, setActivePanel }: PropsRuntime<'shell.overlay'> & PanelWatcherInjected) {
  const activePanelId = usePanelInfo(info => info.activePanelId)
  useEffect(() => { setActivePanel(activePanelId) }, [activePanelId, setActivePanel])
  return null
}

export const name = 'deepsea-numbered-switching'
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'layout']

/**
 * Client plugin body.
 * @param ctx - browser-side cordis context.
 */
export function apply(ctx: Context): void {
  // An embedded page (`?embed=<id>`, the chrome-less page the remote-workspaces
  // plugin frames for a remote session) is a SAME-ORIGIN iframe running this
  // very plugin, and iframes share the tab's sessionStorage: left running,
  // the framed instance would see its pinned session as current, prune every
  // other holder from the shared table and corrupt the outer window's
  // numbering. It has no sidebar and no chord of its own to serve; stay out.
  if (ctx.layout.embedSessionId !== undefined) {
    console.info('[numbered-switching] embedded page: inactive')
    return
  }
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces

  let state = loadState()
  let current: string | 'panel' | undefined
  let activePanelId: string | null = null
  /** Present only while the remote-workspaces plugin is loaded (see the inject below). */
  let remote: RemoteWorkspacesFace | undefined

  const commit = (next: SlotState): void => {
    if (next === state) return
    state = next
    saveState(state)
    badges.update()
  }

  const badges = installBadges({
    numberOf: key => slotOf(state, key),
    tooltip: n => `${MODIFIER_GLYPH}${n}`,
  })
  ctx.effect(() => () => { badges.dispose() }, 'numbered-switching: sidebar badges')

  /**
   * A holder keeps its slot while it is still listed (and not archived). A
   * remote holder is pruned only on positive evidence from the remote
   * plugin: while that plugin is absent (not installed, or mid-reload: its
   * service disappears for a moment during a bundle hot-swap, and at boot it
   * may come up after this one) the answer is "unknown", and unknown keeps
   * the slot. A stale remote key then sits there without a row until the LRU
   * rule evicts it.
   */
  const isLive = (key: string): boolean => {
    const target = decodeTarget(key)
    if (target === undefined) return false
    if (target.kind === 'local') {
      const id = target.sessionId as SessionId
      return sessions.list.getSnapshot().ids.includes(id)
        && !workspaces.list.getSnapshot().archivedSessionIds.includes(id)
    }
    return remote === undefined ? true : remote.has(target)
  }

  // Follow what is on screen: bump or seat the current session, free the
  // slots of sessions that vanished or were archived.
  const follow = (): void => {
    let next = prune(state, isLive)
    const now = currentKeyOf({
      remote: remote?.getSelection(),
      activePanelId,
      local: currentSessionOf(sessions.list.getSnapshot()),
    })
    if (now !== current) {
      current = now
      if (now !== undefined && now !== 'panel') next = touch(next, now)
    }
    commit(next)
  }
  ctx.effect(() => {
    const unsubscribeSessions = sessions.list.subscribe(follow)
    const unsubscribeWorkspaces = workspaces.list.subscribe(follow)
    follow()
    return () => {
      unsubscribeSessions()
      unsubscribeWorkspaces()
    }
  }, 'numbered-switching: follow selection')

  // The layout's active panel, read through the only seam that exposes it
  // (the `usePanelInfo` root hook of slot components).
  const panelInjected = (): PanelWatcherInjected => ({
    setActivePanel: (panelId) => {
      if (panelId === activePanelId) return
      activePanelId = panelId
      follow()
    },
  })
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'deepsea-numbered-switching-panel-watcher', order: 1000, inject: panelInjected },
      PanelWatcher,
    ))

  // Optional: remote sessions join the numbering while the remote-workspaces
  // plugin is loaded. The scoped fiber starts when the service appears and is
  // disposed when it goes (remote holders then keep their slots, unopenable
  // and unbadged, until the plugin returns or the LRU rule evicts them).
  ctx.inject([REMOTE_SERVICE], (scoped) => {
    const face = scoped.get(REMOTE_SERVICE) as RemoteWorkspacesFace | undefined
    if (face === undefined) return
    scoped.effect(() => {
      remote = face
      const unsubscribe = face.subscribe(follow)
      follow()
      return () => {
        unsubscribe()
        remote = undefined
        follow()
      }
    }, 'numbered-switching: remote workspaces')
    console.info('[numbered-switching] remote workspaces joined the numbering')
  })

  const openKey = (key: string): void => {
    const target = decodeTarget(key)
    if (target === undefined) return
    if (target.kind === 'local') {
      ctx.uiWorkspace.openSession(target.sessionId as SessionId)
      return
    }
    remote?.open({ workspaceId: target.workspaceId, sessionId: target.sessionId })
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return
    const n = chordSlot(event, SLOT_COUNT, IS_APPLE)
    if (n === undefined) return
    // Claim the chord even for an empty slot: the page owns ⌘1…⌘N here.
    event.preventDefault()
    event.stopPropagation()
    const target = holderOf(state, n)
    if (target === undefined || target === current) return
    openKey(target)
  }
  ctx.effect(() => {
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, 'numbered-switching: keydown capture')

  console.info(`[numbered-switching] ${MODIFIER_GLYPH}1…${MODIFIER_GLYPH}${SLOT_COUNT} switch between the ${SLOT_COUNT} most recent sessions`)
}
