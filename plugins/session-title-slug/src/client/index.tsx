/**
 * @deepsea/session-title-slug: browser half.
 *
 * A New Session whose first prompt starts with a slug (`foo-bar-baz: do the
 * thing`) is named after it by the host half (index.js). This half shows it
 * coming: while the person types, the session's "New Session" row in the
 * sidebar previews the slug, and reverts when the prefix stops matching.
 *
 * HOW: one invisible entry in `conversation.input.dock` (a session-scoped
 * list slot above the composer, hero layout included, so it exists for
 * exactly the session being typed into) reads `useInput(s => s.draft)` and
 * `useSession(s => s.blank)`; the preview itself is a DOM patch of the row
 * (preview.ts explains why).
 *
 * GHOST ROWS: a blank session that was typed into stays reachable after
 * another session is selected: ghosts.ts draws a dimmed row (the slug, or
 * "New Session") under its Workspace header for every blank, non-current
 * session whose persisted draft is not empty; clicking it opens the session.
 *
 * CONVENTION: `globalThis.__DEEPSEA_SESSION_TITLE_SLUG__ = { parseSlug }`
 * while loaded, for other browser plugins that draw New Session rows of
 * their own (the remote-workspaces plugin) and want the same preview without
 * a build-time dependency; absent, they show none.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only (erased): `ctx.uiWorkspace` (Context merge), the `mainView`
// reference source, the slot map, the session standard props (useSession),
// the composer standard props (useInput) and `ctx.locale`.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect } from 'react'
import { parseSlug } from '../../slug.mjs'
import { installPreview } from './preview.ts'
import { installGhosts } from './ghosts.ts'

export { parseSlug } from '../../slug.mjs'

/** The branded session id, taken from the Sessions face (avoids linking @deepseek-ai/dsh-session for one type). */
type SessionId = Parameters<ISessions['binding']>[0]

/** The page global other browser plugins read. */
export interface SessionTitleSlugConvention {
  parseSlug: (text: string) => string | undefined
}
declare global {
  // eslint-disable-next-line no-var
  var __DEEPSEA_SESSION_TITLE_SLUG__: SessionTitleSlugConvention | undefined
}

/**
 * The session shown in the main view: the list row retained by the
 * `mainView` reference source (the Workspace browser's own row-highlight
 * derivation; the selection itself is private to ui-workspace).
 * @param list - Session Controller list snapshot.
 * @returns the current session id, or undefined.
 */
export function currentSessionOf(list: SessionListState): SessionId | undefined {
  return Object.values(list.byId).find(summary => (summary.retainedBy.mainView ?? 0) > 0)?.id
}

/** Registration inject face: a plain callback created in apply. */
interface Injected {
  /** Publish the slug a blank session's row should preview (`undefined` restores its label). */
  setPreview: (sessionId: SessionId, slug: string | undefined) => void
}

type Props = PropsRuntime<'conversation.input.dock'> & Injected

/** Renders nothing; previews the slug of this slot's session while it is blank. */
function SlugWatcher({ sessionId, useInput, useSession, setPreview }: Props) {
  const draft = useInput(state => state.draft)
  const blank = useSession(snapshot => snapshot.blank)
  // Only a blank session has a "New Session" row to relabel.
  const slug = blank ? parseSlug(draft) : undefined
  useEffect(() => {
    setPreview(sessionId, slug)
    return () => { setPreview(sessionId, undefined) }
  }, [sessionId, slug, setPreview])
  return null
}

export const name = 'deepsea-session-title-slug'
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'locale']

/**
 * Client plugin body.
 * @param ctx - browser-side cordis context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  const workspaceText = ctx.locale.bind('workspace')

  ctx.effect(() => {
    globalThis.__DEEPSEA_SESSION_TITLE_SLUG__ = { parseSlug }
    return () => { delete globalThis.__DEEPSEA_SESSION_TITLE_SLUG__ }
  }, 'session-title-slug: convention global')

  const preview = installPreview()
  ctx.effect(() => () => { preview.dispose() }, 'session-title-slug: sidebar preview')

  // Ghost rows follow the Sessions list (rows and the current one) and the Workspaces.
  const ghosts = installGhosts(
    (sessionId) => { ctx.uiWorkspace.openSession(sessionId as SessionId) },
    () => workspaceText('session.new'),
  )
  const feedGhosts = (): void => {
    const list = sessions.list.getSnapshot()
    ghosts.update({
      sessions: list.ids.map(id => list.byId[id]).filter(s => s !== undefined),
      current: currentSessionOf(list),
      workspaces: workspaces.list.getSnapshot().items,
    })
  }
  ctx.effect(() => {
    const unsubscribeSessions = sessions.list.subscribe(feedGhosts)
    const unsubscribeWorkspaces = workspaces.list.subscribe(feedGhosts)
    feedGhosts()
    return () => {
      unsubscribeSessions()
      unsubscribeWorkspaces()
      ghosts.dispose()
    }
  }, 'session-title-slug: ghost rows')

  // One preview at a time: the last blank session to report wins, and only
  // its own clear resets it (a stale clear from an unmounting sibling must
  // not blank a newer session's preview).
  let previewOwner: SessionId | undefined
  const injected = (): Injected => ({
    setPreview: (sessionId, slug) => {
      if (slug === undefined) {
        if (previewOwner !== sessionId) return
        previewOwner = undefined
        preview.set(undefined)
        return
      }
      previewOwner = sessionId
      preview.set({ sessionId, slug })
    },
  })

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'deepsea-session-title-slug', order: 1000, inject: injected },
      SlugWatcher,
    ))
}
