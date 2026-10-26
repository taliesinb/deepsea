import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'

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
  const workspaceBySession = new Map<string, string>()
  for (const workspace of workspaces.items) {
    for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace.title)
  }
  const archived = new Set<string>(workspaces.archivedSessionIds)
  const items: SessionPickerItem[] = []
  for (const sessionId of sessions.ids) {
    const session = sessions.byId[sessionId]
    if (session === undefined || session.id === currentSessionId || session.origin === 'subagent'
      || session.blank || archived.has(session.id)) continue
    const workspaceName = workspaceBySession.get(session.id) ?? fallbackWorkspaceName(session.cwd)
    items.push({
      sessionId: session.id,
      workspaceName,
      sessionName: session.displayTitle,
      qualifiedName: `${workspaceName}/${session.displayTitle}`,
      updatedAt: session.updatedAt,
    })
  }
  return items.sort((left, right) => right.updatedAt - left.updatedAt
    || left.qualifiedName.localeCompare(right.qualifiedName))
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
 * (candidate `labelSegments`, harness topic `trigger-label-segments`); the
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
