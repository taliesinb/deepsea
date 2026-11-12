import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'

type SessionId = SessionListState['ids'][number]
type SessionSummary = SessionListState['byId'][SessionId]

export interface SessionPickerItem {
  readonly sessionId: string
  readonly workspaceName: string
  readonly sessionName: string
  readonly qualifiedName: string
  readonly updatedAt: number
}

/**
 * The picker's catalog: ordinary sessions other than the current one (no
 * subagents, no blank New Session, nothing archived), newest activity first.
 * A session in no Workspace is named after its working directory.
 */
export function sessionPickerItems(
  sessions: SessionListState,
  workspaces: WorkspaceSnapshot,
  currentSessionId: string,
): SessionPickerItem[] {
  const workspaceBySession = workspaceNames(workspaces)
  const archived = new Set<string>(workspaces.archivedSessionIds)
  const items: SessionPickerItem[] = []
  for (const sessionId of sessions.ids) {
    const session = sessions.byId[sessionId]
    if (session === undefined || session.id === currentSessionId || session.origin === 'subagent'
      || session.blank || archived.has(session.id)) continue
    items.push(pickerItem(session, workspaceBySession))
  }
  return items.sort((left, right) => right.updatedAt - left.updatedAt
    || left.qualifiedName.localeCompare(right.qualifiedName))
}

/** The word that always names the current session: `%this`. */
export const THIS_SESSION = 'this'

/**
 * The current session as a picker row, offered whenever the query is a
 * prefix of `this` (so also for a bare `%`) or matches its own name.
 * @returns the row, or `undefined` when the session is not in the list or the query misses it.
 */
export function currentSessionPickerItem(
  sessions: SessionListState,
  workspaces: WorkspaceSnapshot,
  currentSessionId: string,
  query: string,
): SessionPickerItem | undefined {
  const session = sessions.byId[currentSessionId as SessionId] as SessionSummary | undefined
  if (session === undefined) return undefined
  const item = pickerItem(session, workspaceNames(workspaces))
  return THIS_SESSION.startsWith(query.toLocaleLowerCase()) || filterSessionPickerItems([item], query).length > 0
    ? item
    : undefined
}

/**
 * What picking the current session inserts and sends: plain text, not a
 * `dsh-session:` mention, because the server's session-reference resolver
 * refuses a session that references itself.
 */
export function thisSessionText(item: SessionPickerItem): string {
  return `this session (${item.qualifiedName}, id ${item.sessionId})`
}

function workspaceNames(workspaces: WorkspaceSnapshot): Map<string, string> {
  const workspaceBySession = new Map<string, string>()
  for (const workspace of workspaces.items) {
    for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace.title)
  }
  return workspaceBySession
}

function pickerItem(
  session: SessionSummary,
  workspaceBySession: ReadonlyMap<string, string>,
): SessionPickerItem {
  const workspaceName = workspaceBySession.get(session.id) ?? fallbackWorkspaceName(session.cwd)
  return {
    sessionId: session.id,
    workspaceName,
    sessionName: session.displayTitle,
    qualifiedName: `${workspaceName}/${session.displayTitle}`,
    updatedAt: session.updatedAt,
  }
}

/** Apply `%foo` full-name or `%foo/bar` component-aware matching. */
export function filterSessionPickerItems(items: readonly SessionPickerItem[], query: string): SessionPickerItem[] {
  const normalized = query.toLocaleLowerCase()
  const slash = normalized.indexOf('/')
  if (slash < 0) {
    return items.filter(item => item.qualifiedName.toLocaleLowerCase().includes(normalized))
  }
  const workspaceNeedle = normalized.slice(0, slash)
  const sessionNeedle = normalized.slice(slash + 1)
  return items.filter(item => item.workspaceName.toLocaleLowerCase().includes(workspaceNeedle)
    && item.sessionName.toLocaleLowerCase().includes(sessionNeedle))
}

function fallbackWorkspaceName(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return '(unregistered)'
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/u, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || '(unregistered)'
}

/**
 * A row's title, `workspace / session` with the separator in quiet ink
 * (candidate `labelSegments`, harness topic `input-triggers`); the
 * row's identity stays the unspaced qualified name.
 */
export function sessionLabelSegments(workspace: string, session: string) {
  return [
    { text: workspace },
    { text: ' / ', dim: true },
    { text: session },
  ] as const
}

/** Compact relative activity age, in the vocabulary of the built-in `@` picker (`now`, `2min`, `4h`, `3d`). */
export function relativeSessionAge(updatedAt: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - updatedAt)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (elapsed < minute) return 'now'
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}min`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  return `${Math.floor(elapsed / day)}d`
}
