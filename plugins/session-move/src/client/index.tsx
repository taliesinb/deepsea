/**
 * Browser half of @deepsea/session-move. Registers:
 *   - context-menu actions: Move to… and Copy to… on Sessions, Rehome… on Workspaces
 *   - `ctx.uiWorkspace.handleSessionDrop`: a Session row dropped on another
 *     Workspace group moves there at once; a refusal opens Move to… with that
 *     destination chosen
 *   - `shell.overlay`: the dialogs (dialogs.tsx)
 *   - the service `deepseaSessionMove`: destinations other plugins add (face.ts)
 *
 * Moves and copies are the Host's `session.move`, `session.moveMany` and
 * `session.copy` (harness topic session-relocation).
 */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
// Type-only merges: ctx.slots, ctx.contextMenus, ctx.uiWorkspace, ctx.sessions, ctx.workspaces, ctx.remoteAccess.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconCopyOutlineRegular, IconFolderCloseRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore } from 'react'
import { RehomeDialog, SessionDialog, type DialogActions, type HostDestination } from './dialogs.tsx'
import { SERVICE, type DestinationContribution, type SessionMoveFace } from './face.ts'
import { addContribution, type DialogRequest, type HostResult, type LocalWorkspace } from './model.ts'

export { SERVICE, type SessionMoveFace } from './face.ts'
export type { DestinationContribution, DestinationEntry, DestinationGroup, DestinationRunRequest, DestinationRunResult } from './face.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    deepseaSessionMove: SessionMoveFace
  }
}

export const name = 'deepsea-session-move'
export const inject = ['slots', 'contextMenus', 'sessions', 'workspaces', 'remoteAccess']

const ICON_MOVE = 'deepsea-session-move.move'
const ICON_COPY = 'deepsea-session-move.copy'

/** What the overlay entry receives. */
interface OverlayInjected {
  request: ObservableSnapshot<DialogRequest | null>
  workspaces: ObservableSnapshot<readonly LocalWorkspace[]>
  contributions: ObservableSnapshot<readonly DestinationContribution[]>
  actions: DialogActions
  close: () => void
}

/** Keep one value per snapshot so `useSyncExternalStore` sees a stable reference. */
function memoized<T, R>(source: ObservableSnapshot<T>, map: (value: T) => R): ObservableSnapshot<R> {
  let last: { input: T; output: R } | undefined
  return {
    getSnapshot: () => {
      const input = source.getSnapshot()
      if (last === undefined || last.input !== input) last = { input, output: map(input) }
      return last.output
    },
    subscribe: listener => source.subscribe(listener),
  }
}

function Overlay({ request, workspaces, contributions, actions, close }: OverlayInjected) {
  const current = useSyncExternalStore(request.subscribe, request.getSnapshot)
  const list = useSyncExternalStore(workspaces.subscribe, workspaces.getSnapshot)
  const contributed = useSyncExternalStore(contributions.subscribe, contributions.getSnapshot)
  if (current === null) return null
  // A new request is a new dialog: keyed, so it starts from a fresh state.
  const key = current.kind === 'session' ? `${current.action}:${current.sessionId}:${current.destinationId ?? ''}` : `rehome:${current.workspaceId}`
  return current.kind === 'session'
    ? <SessionDialog key={key} request={current} workspaces={list} contributions={contributed} actions={actions} onClose={close} />
    : <RehomeDialog key={key} request={current} workspaces={list} actions={actions} onClose={close} />
}

export function apply(ctx: Context): void {
  const request = createSnapshotStore<DialogRequest | null>(null, { flush: 'sync' })
  const contributions = createSnapshotStore<readonly DestinationContribution[]>([], { flush: 'sync' })
  const workspaces = memoized(ctx.workspaces.list, (snapshot): readonly LocalWorkspace[] => snapshot.items.map(item => ({
    workspaceId: item.workspaceId, title: item.title, path: item.path, sessionIds: item.sessionIds,
  })))

  const face: SessionMoveFace = {
    contributeDestinations(contribution) {
      contributions.set(addContribution(contributions.getSnapshot(), contribution))
      return () => { contributions.set(contributions.getSnapshot().filter(candidate => candidate !== contribution)) }
    },
    contributions,
  }
  ctx.provide(SERVICE, face)

  const destinationOf = (destination: HostDestination) => 'workspaceId' in destination
    ? { workspaceId: destination.workspaceId as WorkspaceId }
    : { path: destination.path }
  const actions: DialogActions = {
    move: async ({ sessionId, destination, stopLive, notify }) => await ctx.sessions.move({
      sessionId: sessionId as SessionId, destination: destinationOf(destination), stopLive, notify,
    }) as HostResult,
    copy: async ({ sessionId, destination, ...rest }) => await ctx.sessions.copy({
      sessionId: sessionId as SessionId, destination: destinationOf(destination), ...rest,
    }) as HostResult,
    moveMany: async ({ sessionIds, destination, stopLive, notify }) => await ctx.sessions.moveMany({
      sessionIds: sessionIds as readonly SessionId[], destination: destinationOf(destination), stopLive, notify,
    }),
    deleteWorkspace: async (workspaceId) => { await ctx.workspaces.delete(workspaceId as WorkspaceId) },
    openSession: (sessionId) => { ctx.get('uiWorkspace')?.openSession(sessionId as SessionId) },
  }

  ctx.slots.inject('contextMenu.icon', function* () {
    yield ctx.slots.register({ name: 'contextMenu.icon', key: ICON_MOVE }, IconFolderCloseRegular)
    yield ctx.slots.register({ name: 'contextMenu.icon', key: ICON_COPY }, IconCopyOutlineRegular)
  })

  const allowed = (kind: 'session' | 'workspace', id: string, action: 'session/move' | 'session/copy' | 'session/moveMany'): boolean =>
    ctx.remoteAccess.source(kind as 'session', id as SessionId, action).getSnapshot()
  const archived = (sessionId: string): boolean =>
    ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId as SessionId)
  for (const [action, order] of [['move', 350], ['copy', 360]] as const) {
    ctx.effect(() => ctx.contextMenus.register({
      id: `deepsea-session-move.${action}`, target: 'session', order,
      observe: ({ sessionId }) => [ctx.workspaces.list, ctx.remoteAccess.source('session', sessionId, `session/${action}`)],
      resolve: ({ sessionId, displayTitle }) => archived(sessionId) || !allowed('session', sessionId, `session/${action}`) ? [] : [{
        id: action,
        label: action === 'move' ? 'Move to…' : 'Copy to…',
        icon: { key: action === 'move' ? ICON_MOVE : ICON_COPY },
        run: () => { request.set({ kind: 'session', action, sessionId, displayTitle }) },
      }],
    }), `session-move: ${action} menu action`)
  }
  ctx.effect(() => ctx.contextMenus.register({
    id: 'deepsea-session-move.rehome', target: 'workspace', order: 250,
    observe: () => [ctx.workspaces.list],
    resolve: ({ workspaceId, displayTitle }) => {
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
      if (workspace === undefined || workspace.sessionIds.length === 0) return []
      return [{
        id: 'rehome', label: 'Rehome workspace…', icon: { key: ICON_MOVE },
        run: () => { request.set({ kind: 'rehome', workspaceId, title: displayTitle }) },
      }]
    },
  }), 'session-move: rehome menu action')

  // A drop on another Workspace group moves at once; a refusal (work in
  // flight, most often) opens Move to… with that destination chosen.
  ctx.inject(['uiWorkspace'], (scoped) => {
    scoped.effect(() => scoped.uiWorkspace.handleSessionDrop(({ sessionId, displayTitle, workspaceId }) => {
      void ctx.sessions.move({ sessionId, destination: { workspaceId }, notify: true }).then((result) => {
        if (!result.ok) request.set({ kind: 'session', action: 'move', sessionId, displayTitle, destinationId: workspaceId })
      }, () => {
        request.set({ kind: 'session', action: 'move', sessionId, displayTitle, destinationId: workspaceId })
      })
    }), 'session-move: drop handler')
  })

  const injected = (): OverlayInjected => ({ request, workspaces, contributions, actions, close: () => { request.set(null) } })
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'deepsea-session-move', order: 52, inject: injected,
  }, Overlay)), 'session-move: dialogs')
}
