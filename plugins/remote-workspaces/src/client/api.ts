/**
 * Typed face over the plugin's control channel
 * (`POST /deepsea-remote-workspaces/<endpoint>`, Connection envelope). Mirrors
 * the host half's snapshot shapes (index.js).
 */
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

export const CHANNEL = '/deepsea-remote-workspaces'

export interface BridgeStatus {
  url: string
  mode: 'identity' | 'token'
  bridged: boolean
  bridgedAt?: string
  lastFailure?: { at: number; status: number; message: string }
}

export interface ServerInfo {
  id: string
  url: string
  label: string
  seeded: boolean
  hasToken: boolean
  /** `/deepsea-remote-workspaces/servers/<id>/`: the iframe base, a Host path. */
  localBase: string
  bridge?: BridgeStatus
}

export interface CachedSession {
  id: string
  title: string
  updatedAt?: string
  running?: boolean
  /** Position in the remote workspace's account (creation order unless dragged there). */
  remoteIndex?: number
  /** The remote's `permissions` projection value, when it listed one. */
  permissions?: unknown
}

export interface RemoteWorkspace {
  id: string
  serverId: string
  remoteWorkspaceId: string
  /** Title in this sidebar. */
  title: string
  remotePath: string
  remoteTitle?: string
  /** The remote workspace's own registration time. */
  remoteCreatedAt?: string
  createdAt: string
  order: number
  sessionOrder?: string[]
  cache: {
    sessions: CachedSession[]
    /** Blank (no turn yet) sessions of the workspace; a persisted draft makes one a ghost row. */
    blankIds?: string[]
    polledAt?: string
    gone?: boolean
  }
  server?: { id: string; label: string; localBase: string }
}

export interface StatusSnapshot {
  lastServerUrl?: string
  servers: ServerInfo[]
  workspaces: RemoteWorkspace[]
}

export interface ProbeResult {
  url: string
  hostname: string
  serverId?: string
  label: string
  elapsedMs: number
  mode: 'identity' | 'token'
  workspaces: { workspaceId: string; path: string; title: string; sessionCount: number; mirrored: boolean }[]
}

/** What the remote reports about a typed path there (`fs.inspect`, or its directory picker). */
export interface PathInfo {
  /** The remote account's home directory (`~`). */
  home: string
  /** The typed path, `~` expanded and normalized. */
  resolved: string
  kind: 'directory' | 'file' | 'missing'
  /** A missing path can be made (`mkdir -p`): its nearest existing ancestor is a directory. */
  creatable: boolean
  /** The nearest existing ancestor when it is a file (why `creatable` is false). */
  blocker?: string
  /** Completion candidates: child directories of the typed directory whose names start with the typed last segment. */
  entries: { name: string; path: string }[]
  truncated: boolean
}

export class RemoteApiError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
  }
}

export interface RemoteApi {
  status(): Promise<StatusSnapshot>
  probeServer(url: string, token?: string): Promise<ProbeResult>
  /** Ask the remote about a path there; rejects with code `deepsea-remote-workspaces/fs-unavailable` when it cannot answer. */
  inspectPath(url: string, token: string | undefined, path: string): Promise<PathInfo>
  /** `create`: make `remotePath` on the remote first when it does not exist. */
  addWorkspace(input: { url: string; token?: string; label?: string; remoteWorkspaceId?: string; remotePath?: string; create?: boolean; title?: string }): Promise<RemoteWorkspace>
  pollWorkspace(id: string): Promise<RemoteWorkspace>
  removeWorkspace(id: string): Promise<StatusSnapshot>
  renameWorkspace(id: string, title: string): Promise<StatusSnapshot>
  reorderWorkspaces(ids: string[]): Promise<StatusSnapshot>
  reorderSessions(workspaceId: string, ids: string[]): Promise<RemoteWorkspace>
  renameSession(workspaceId: string, sessionId: string, title: string): Promise<RemoteWorkspace>
  archiveSession(workspaceId: string, sessionId: string): Promise<RemoteWorkspace>
  startSession(workspaceId: string): Promise<{ sessionId: string; created: boolean }>
  /** Move a remote session to another workspace of the same remote (the remote's own `session.move`). */
  moveSession(input: { fromWorkspaceId: string; sessionId: string; toWorkspaceId: string; stopLive?: boolean }): Promise<RemoteWorkspace>
  /** Move a session across servers: export at the source, import at the destination, archive the source copy. */
  transferSession(input: TransferRequest): Promise<TransferResult>
  /** Copy a remote session into a workspace of the same remote (the remote's own `session.copy`); the source is untouched. */
  copySession(input: { fromWorkspaceId: string; sessionId: string; toWorkspaceId: string; truncate?: boolean; title?: string }): Promise<{ workspace: RemoteWorkspace; sessionId: string; truncated: boolean }>
  /** Copy a session across servers: export at the source, import at the destination as a copy; nothing at the source changes. */
  copyAcross(input: CopyRequest): Promise<CopyResult>
}

export interface CopyRequest {
  sessionId: string
  source: TransferEnd
  destination: TransferEnd
  /** Undecided until the host reports `session/copy-live`; then true drops the turn in progress, false keeps it as interrupted. */
  truncate?: boolean
  /** Title recorded on the copy; omitted keeps the source's. */
  title?: string
  /** Append the copy notice at the destination (default true). */
  notify?: boolean
}

export interface CopyResult {
  sessionId: string
  imported: { sessionId: string; exportedId: string; parentSessionId?: string }[]
  truncated: boolean
  bytes: number
}

/** One end of a cross-server transfer. */
export type TransferEnd =
  | { local: true; workspaceId?: string; path?: string }
  | { local?: false; workspaceId: string }

export interface TransferRequest {
  sessionId: string
  source: TransferEnd
  destination: TransferEnd
  stopLive?: boolean
  /** Append the relocation notice at the destination (default true). */
  notify?: boolean
}

export interface TransferResult {
  sessionId: string
  imported: { sessionId: string; exportedId: string; parentSessionId?: string }[]
  bytes: number
}

export function createApi(rpc: ClientConnectionRpc): RemoteApi {
  const call = async <T>(endpoint: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await rpc.call(CHANNEL, endpoint, { args }) as
      | { ok: true; value: T }
      | { ok: false; error: { code: string; message: string; details?: unknown } }
    if (!result.ok) throw new RemoteApiError(result.error.code, result.error.message, result.error.details)
    return result.value
  }
  const workspaceOf = (value: { workspace: RemoteWorkspace }): RemoteWorkspace => value.workspace
  return {
    status: () => call<StatusSnapshot>('status'),
    probeServer: (url, token) => call<ProbeResult>('servers.probe', { url, token }),
    inspectPath: (url, token, path) => call<PathInfo>('servers.inspectPath', { url, token, path }),
    addWorkspace: input => call<{ workspace: RemoteWorkspace }>('workspaces.add', input).then(workspaceOf),
    pollWorkspace: id => call<{ workspace: RemoteWorkspace }>('workspaces.poll', { id }).then(workspaceOf),
    removeWorkspace: id => call<StatusSnapshot>('workspaces.remove', { id }),
    renameWorkspace: (id, title) => call<StatusSnapshot>('workspaces.rename', { id, title }),
    reorderWorkspaces: ids => call<StatusSnapshot>('workspaces.reorder', { ids }),
    reorderSessions: (workspaceId, ids) => call<{ workspace: RemoteWorkspace }>('sessions.reorder', { workspaceId, ids }).then(workspaceOf),
    renameSession: (workspaceId, sessionId, title) => call<{ workspace: RemoteWorkspace }>('sessions.rename', { workspaceId, sessionId, title }).then(workspaceOf),
    archiveSession: (workspaceId, sessionId) => call<{ workspace: RemoteWorkspace }>('sessions.archive', { workspaceId, sessionId }).then(workspaceOf),
    startSession: workspaceId => call<{ sessionId: string; created: boolean }>('sessions.start', { workspaceId }),
    moveSession: input => call<{ workspace: RemoteWorkspace }>('sessions.move', input).then(workspaceOf),
    transferSession: input => call<TransferResult>('sessions.transfer', input as unknown as Record<string, unknown>),
    copySession: input => call<{ workspace: RemoteWorkspace; sessionId: string; truncated: boolean }>('sessions.copy', input),
    copyAcross: input => call<CopyResult>('sessions.copyAcross', input as unknown as Record<string, unknown>),
  }
}
