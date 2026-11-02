/**
 * The `deepseaRemoteWorkspaces` service other browser plugins see
 * (plugins/AGENTS.md, contracts; consumer: numbered-switching). Consumers
 * `ctx.inject(['deepseaRemoteWorkspaces'], …)` so they run only while this
 * plugin is loaded and unwind when it goes. Row identity for DOM patchers:
 * every remote session row carries
 * `data-deepsea-remote-session="<workspaceId>:<sessionId>"` (`frameKey`).
 */
import type { RemoteWorkspace } from './api.ts'
import type { RemoteSelection, RuntimeState, ViewState } from './store.ts'

/** The service name. */
export const SERVICE = 'deepseaRemoteWorkspaces'

export interface RemoteWorkspacesFace {
  /** The remote session on screen, or undefined while a local Conversation or another panel shows. */
  getSelection(): RemoteSelection | undefined
  /**
   * Whether the session may still exist. False only on positive evidence:
   * the workspace is no longer in this sidebar or gone on the remote, or it
   * has been fetched and neither lists the session nor knows it as a blank.
   * Before the first host snapshot, or for a workspace never polled (a
   * collapsed group), the answer is true: unknown is not gone.
   */
  has(selection: RemoteSelection): boolean
  /** Select the session and show the remote panel (what a row click does). */
  open(selection: RemoteSelection): void
  /** Fires on any change of the selection, the on-screen state, or the remote workspaces. */
  subscribe(listener: () => void): () => void
}

/** What the face reads of the model (store.ts). */
export interface FaceModel {
  view: { getSnapshot(): ViewState; subscribe(listener: () => void): () => void }
  runtime: { getSnapshot(): Pick<RuntimeState, 'loaded' | 'snapshot'>; subscribe(listener: () => void): () => void }
  workspace(id: string): RemoteWorkspace | undefined
}

/**
 * @param model - the plugin's stores.
 * @param open - what a row click does (select, show the panel).
 * @returns the service value.
 */
export function createFace(model: FaceModel, open: (selection: RemoteSelection) => void): RemoteWorkspacesFace {
  return {
    getSelection: () => {
      const view = model.view.getSnapshot()
      return view.remoteActive === true ? view.selected : undefined
    },
    has: (selection) => {
      const runtime = model.runtime.getSnapshot()
      if (!runtime.loaded || runtime.snapshot === undefined) return true
      const workspace = model.workspace(selection.workspaceId)
      if (workspace === undefined || workspace.cache.gone === true) return false
      if (workspace.cache.polledAt === undefined && workspace.cache.sessions.length === 0) return true
      if (workspace.cache.sessions.some(session => session.id === selection.sessionId)) return true
      if (workspace.cache.blankIds?.includes(selection.sessionId) === true) return true
      const selected = model.view.getSnapshot().selected
      return selected?.workspaceId === selection.workspaceId && selected.sessionId === selection.sessionId
    },
    open,
    subscribe: (listener) => {
      const stopView = model.view.subscribe(listener)
      const stopRuntime = model.runtime.subscribe(listener)
      return () => { stopView(); stopRuntime() }
    },
  }
}
