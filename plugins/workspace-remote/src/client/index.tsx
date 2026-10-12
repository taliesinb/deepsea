/**
 * @deepsea/workspace-remote: browser half. Registers:
 *   - `sidebar.workspaces.extra`            the Remotes section
 *   - `main` key `deepsea-workspace-remote` the host box the visible frame covers
 *   - `shell.overlay`                        the iframe pool, the add-remote modal, the move/copy dialog
 *   - `deepseaSessionMove.contributeDestinations`  the remotes as destinations of session-move's
 *                                            Move to… / Copy to… dialogs on local rows
 *   - the service `deepseaRemoteWorkspaces`  for sibling plugins (ui-numbered-switching)
 *
 * Selecting a remote session selects this plugin's main panel; the shell's
 * own `openSession` resets the panel to the Conversation, which hides the
 * pool without destroying it (frames die after 10 minutes hidden, store.ts).
 *
 * In an embedded page (`?embed=<id>`, the page this plugin frames, which a
 * remote that has this plugin also runs it in) the plugin stays inactive: no
 * sidebar, and the frame shares the tab's storage with the outer page.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only merges: ctx.slots, ctx.layout, ctx.uiWorkspace and the sidebar seats.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { DestinationEntry, DestinationGroup, DestinationRunResult, SessionMoveFace } from './destinations.ts'
import { createApi, ERROR_NAMESPACE, RemoteApiError, type StatusSnapshot } from './api.ts'
import { createFace, SERVICE, type RemoteWorkspacesFace } from './face.ts'
import { workspaceLabel } from './labels.ts'
import { PANEL_ID, RemoteWorkspacesModel, type RemoteSelection } from './store.ts'
import { AddRemoteModal, FramePool, MoveRemoteDialog, RemoteSessionPanel, RemotesSection, type RemoteInjected } from './ui.tsx'

export { SERVICE, type RemoteWorkspacesFace } from './face.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    deepseaRemoteWorkspaces: RemoteWorkspacesFace
    deepseaSessionMove: SessionMoveFace
  }
}

export const name = 'deepsea-workspace-remote'
export const inject = ['slots', 'connection', 'layout', 'workspaces']

export function apply(ctx: Context): void {
  if (ctx.layout.embedSessionId !== undefined) {
    console.info('[workspace-remote] embedded page: inactive')
    return
  }
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  const api = createApi(rpc)
  const model = new RemoteWorkspacesModel(api)

  const openRemoteSession = (selection: RemoteSelection): void => {
    model.select(selection)
    try {
      ctx.layout.selectPanel(PANEL_ID as MainPanelId)
    } catch (error) {
      console.warn('[workspace-remote] main panel not registered yet', error)
    }
  }

  ctx.provide(SERVICE, createFace(model, openRemoteSession))

  const workspaces = ctx.get('workspaces') as IWorkspaces
  const localWorkspaces = (): readonly { workspaceId: string; title: string; path: string }[] =>
    workspaces.list.getSnapshot().items.map(item => ({ workspaceId: item.workspaceId, title: workspaceLabel(item.title), path: item.path }))

  const injected = (): RemoteInjected => ({
    model,
    api,
    openRemoteSession,
    localWorkspaces,
    hooks: { view: model.view, runtime: model.runtime },
  })

  // session-move's Move to… / Copy to… dialogs on local session rows list
  // the remotes as further destination groups (one per server, after "This
  // machine"); a pick of one comes back to `run` as a cross-server transfer
  // or copy. The groups observable follows the runtime snapshot; its value is
  // memoized per snapshot so an unchanged snapshot yields the same reference.
  ctx.inject(['deepseaSessionMove'], (scoped) => {
    let memo: { snapshot: StatusSnapshot | undefined; groups: readonly DestinationGroup[] } | undefined
    const groupsOf = (): readonly DestinationGroup[] => {
      const snapshot = model.runtime.getSnapshot().snapshot
      if (memo !== undefined && memo.snapshot === snapshot) return memo.groups
      const byServer = new Map<string, DestinationGroup & { entries: DestinationEntry[] }>()
      for (const workspace of snapshot?.workspaces ?? []) {
        const label = workspace.server?.label ?? workspace.serverId
        let group = byServer.get(workspace.serverId)
        if (group === undefined) {
          group = { id: `server:${workspace.serverId}`, label, entries: [] }
          byServer.set(workspace.serverId, group)
        }
        group.entries.push({ key: workspace.id, title: workspace.title, path: workspace.remotePath })
      }
      memo = { snapshot, groups: [...byServer.values()] }
      return memo.groups
    }
    const failure = (error: unknown): DestinationRunResult => error instanceof RemoteApiError
      ? { ok: false, code: error.code, message: error.message, details: error.details }
      : { ok: false, code: `${ERROR_NAMESPACE}/failed`, message: error instanceof Error ? error.message : String(error) }
    scoped.effect(() => scoped.deepseaSessionMove.contributeDestinations({
      id: 'deepsea-workspace-remote',
      order: 10,
      groups: { getSnapshot: groupsOf, subscribe: listener => model.runtime.subscribe(listener) },
      run: async (request) => {
        const destination = model.workspace(request.destinationKey)
        if (destination === undefined) return { ok: false, code: `${ERROR_NAMESPACE}/unknown-workspace`, message: 'that remote workspace is no longer in this sidebar' }
        const where = `${destination.title} on ${destination.server?.label ?? destination.serverId}`
        try {
          if (request.action === 'move') {
            const result = await model.transferSession({
              sessionId: request.sessionId, source: { local: true }, destination: { workspaceId: destination.id },
              ...(request.stopLive === undefined ? {} : { stopLive: request.stopLive }), notify: request.notify,
            })
            return { ok: true, summary: `Moved to ${where}${result.sessionId === request.sessionId ? '' : ' with a new id'}; the original is archived.` }
          }
          const result = await model.copyAcross({
            sessionId: request.sessionId, source: { local: true }, destination: { workspaceId: destination.id },
            ...(request.truncate === undefined ? {} : { truncate: request.truncate }),
            ...(request.title === undefined ? {} : { title: request.title }),
            notify: request.notify,
          })
          return { ok: true, summary: `Copied to ${where}${result.truncated ? ', without the turn in progress' : ''}.` }
        } catch (error) {
          return failure(error)
        }
      },
    }), 'workspace-remote: dialog destinations')
  })

  // The Remotes section (its own header carries add and refresh-all; nothing
  // is added to the Workspaces header).
  ctx.effect(() => ctx.slots.inject('sidebar.workspaces.extra', () => ctx.slots.register({
    name: 'sidebar.workspaces.extra', id: 'deepsea-workspace-remote.section', order: 10, inject: injected,
  }, RemotesSection)), 'workspace-remote: section')

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, inject: injected,
  }, RemoteSessionPanel)), 'workspace-remote: main panel')

  ctx.effect(() => ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({ name: 'shell.overlay', id: 'deepsea-workspace-remote.frames', order: 5, inject: injected }, FramePool)
    yield ctx.slots.register({ name: 'shell.overlay', id: 'deepsea-workspace-remote.add-modal', order: 50, inject: injected }, AddRemoteModal)
    yield ctx.slots.register({ name: 'shell.overlay', id: 'deepsea-workspace-remote.move-dialog', order: 51, inject: injected }, MoveRemoteDialog)
  }), 'workspace-remote: overlay')

  void model.refresh().then(() => {
    // Reload parity with the local shell, which restores its current session:
    // if the remote panel was the last thing shown, bring it back.
    const view = model.view.getSnapshot()
    if (view.remoteActive === true && view.selected !== undefined && model.workspace(view.selected.workspaceId) !== undefined) {
      openRemoteSession(view.selected)
    }
  })
}
