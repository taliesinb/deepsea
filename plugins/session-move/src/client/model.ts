/**
 * The dialogs' pure logic: destinations, Host and contributor answers,
 * refusal blockers and their lines, and result texts. No React, no DOM, so
 * tests/model.test.ts runs it under node:test.
 */
import type { DestinationContribution, DestinationEntry, DestinationGroup, DestinationRunRequest } from './face.ts'

/** One family of work a refused move or copy names (the Host's `SessionActivity`). */
export interface Activity {
  readonly kind: string
  readonly items?: readonly { readonly id: string; readonly label?: string }[]
}

/** A Workspace of this machine, as the dialogs list it. */
export interface LocalWorkspace {
  readonly workspaceId: string
  readonly title: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** What opened a dialog. */
export type DialogRequest =
  | {
    readonly kind: 'session'
    readonly action: 'move' | 'copy'
    readonly sessionId: string
    readonly displayTitle: string
    /** Preselected destination (a drop the Host refused). */
    readonly destinationId?: string
  }
  | { readonly kind: 'rehome'; readonly workspaceId: string; readonly title: string }

/** A chosen destination: a Workspace of this machine, a directory, or one entry of a contributed group. */
export type DestinationChoice =
  | { readonly kind: 'local'; readonly workspaceId: string }
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'external'; readonly groupId: string; readonly key: string }

/** One contributed group with the contribution it came from. */
export interface ContributedGroup {
  readonly contributionId: string
  readonly group: DestinationGroup
}

/** A choice resolved against the current lists; undefined once it is no longer offered. */
export type ResolvedDestination =
  | { readonly kind: 'local'; readonly workspace: LocalWorkspace }
  | { readonly kind: 'path'; readonly path: string }
  | {
    readonly kind: 'external'
    readonly contributionId: string
    readonly group: DestinationGroup
    readonly entry: DestinationEntry
  }

/** One answer from the Host or from a contributor, in the shape the dialog reacts to. */
export type Answer =
  | { readonly ok: true; readonly sessionId?: string; readonly workspaceId?: string; readonly summary?: string }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly blockers?: readonly Activity[] }

/** A Host `RemoteResult` as the dialogs see it. */
export type HostResult =
  | { readonly ok: true; readonly value: { readonly sessionId: string; readonly workspaceId: string } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } }

const LIVE = new Set(['session/move-live', 'session/copy-live'])

/**
 * The live, non-empty groups of every contribution, in contribution order.
 * @param contributions - current contributions.
 * @returns the groups to list after this machine's Workspaces.
 */
export function contributedGroups(contributions: readonly DestinationContribution[]): ContributedGroup[] {
  return contributions.flatMap(contribution => contribution.groups.getSnapshot()
    .filter(group => group.entries.length > 0)
    .map(group => ({ contributionId: contribution.id, group })))
}

/**
 * Resolve a choice against the current lists.
 * @param choice - the chosen destination, if any.
 * @param workspaces - this machine's Workspaces.
 * @param groups - contributed groups.
 * @returns the destination, or undefined when it is not (or no longer) offered.
 */
export function resolveDestination(
  choice: DestinationChoice | undefined,
  workspaces: readonly LocalWorkspace[],
  groups: readonly ContributedGroup[],
): ResolvedDestination | undefined {
  if (choice === undefined) return undefined
  if (choice.kind === 'path') return choice.path.trim() === '' ? undefined : { kind: 'path', path: choice.path.trim() }
  if (choice.kind === 'local') {
    const workspace = workspaces.find(candidate => candidate.workspaceId === choice.workspaceId)
    return workspace === undefined ? undefined : { kind: 'local', workspace }
  }
  const contributed = groups.find(candidate => candidate.group.id === choice.groupId)
  const entry = contributed?.group.entries.find(candidate => candidate.key === choice.key)
  return contributed === undefined || entry === undefined
    ? undefined
    : { kind: 'external', contributionId: contributed.contributionId, group: contributed.group, entry }
}

/**
 * The Workspace that lists a Session, if any.
 * @param workspaces - this machine's Workspaces.
 * @param sessionId - the Session.
 * @returns its owning Workspace.
 */
export function owningWorkspace(workspaces: readonly LocalWorkspace[], sessionId: string): LocalWorkspace | undefined {
  return workspaces.find(workspace => workspace.sessionIds.includes(sessionId))
}

/**
 * The work a refusal names; a live refusal without any reads as a running turn.
 * @param details - the refusal's details.
 * @returns the activity families.
 */
export function blockersFrom(details: unknown): Activity[] {
  if (typeof details !== 'object' || details === null || !('blockers' in details) || !Array.isArray(details.blockers)) {
    return [{ kind: 'turn' }]
  }
  return details.blockers.filter((entry: unknown): entry is Activity =>
    typeof entry === 'object' && entry !== null && 'kind' in entry && typeof entry.kind === 'string')
}

/**
 * One line per activity family.
 * @param entry - one family.
 * @returns the line the dialog lists.
 */
export function activityLine(entry: Activity): string {
  const labels = (entry.items ?? []).map(item => item.label ?? item.id)
  const named = (noun: string): string => labels.length === 0 ? noun : `${noun}: ${labels.join(', ')}`
  switch (entry.kind) {
    case 'turn': return 'A turn in progress'
    case 'job': return named(labels.length === 1 ? 'A background job' : 'Background jobs')
    case 'subagent': return named(labels.length === 1 ? 'A subagent' : 'Subagents')
    case 'schedule': return named('Scheduled follow-ups')
    default: return named(entry.kind)
  }
}

/**
 * A Host result as an answer.
 * @param result - `session.move` or `session.copy`.
 * @returns the answer.
 */
export function answerFromHost(result: HostResult): Answer {
  if (result.ok) return { ok: true, sessionId: result.value.sessionId, workspaceId: result.value.workspaceId }
  const { code, message, details } = result.error
  return LIVE.has(code) ? { ok: false, code, message, blockers: blockersFrom(details) } : { ok: false, code, message }
}

/**
 * Hand a contributed destination to its contributor; a throw or a withdrawn contribution becomes a refusal.
 * @param contributions - current contributions.
 * @param destination - the chosen contributed entry.
 * @param request - the operation, without the destination fields.
 * @returns the answer.
 */
export async function runContributed(
  contributions: readonly DestinationContribution[],
  destination: Extract<ResolvedDestination, { kind: 'external' }>,
  request: Omit<DestinationRunRequest, 'groupId' | 'destinationKey'>,
): Promise<Answer> {
  const contribution = contributions.find(candidate => candidate.id === destination.contributionId)
  if (contribution === undefined) {
    return { ok: false, code: 'deepsea-session-move/destination-gone', message: 'that destination is no longer offered' }
  }
  try {
    const result = await contribution.run({ ...request, groupId: destination.group.id, destinationKey: destination.entry.key })
    if (result.ok) return result.summary === undefined ? { ok: true } : { ok: true, summary: result.summary }
    return LIVE.has(result.code)
      ? { ok: false, code: result.code, message: result.message, blockers: blockersFrom(result.details) }
      : { ok: false, code: result.code, message: result.message }
  } catch (failure: unknown) {
    return { ok: false, code: 'deepsea-session-move/destination-failed', message: failure instanceof Error ? failure.message : String(failure) }
  }
}

/**
 * The prefilled title of a copy.
 * @param displayTitle - the source's title.
 * @returns the source's title with a copy suffix, or empty.
 */
export function copyTitle(displayTitle: string): string {
  return displayTitle === '' ? '' : `${displayTitle} (copy)`
}

/**
 * What Rehome… reports.
 * @param moved - Sessions moved.
 * @param skipped - why the others did not move.
 * @returns the result line.
 */
export function rehomeSummary(moved: number, skipped: readonly { readonly reason: string }[]): string {
  const live = skipped.filter(skip => skip.reason === 'live').length
  const sessions = `${String(moved)} session${moved === 1 ? '' : 's'}`
  if (skipped.length === 0) return `Moved ${sessions}.`
  return live === 0
    ? `Moved ${sessions}, skipped ${String(skipped.length)}.`
    : `Moved ${sessions}, skipped ${String(skipped.length)} (${String(live)} with work in flight, not interrupted).`
}

/**
 * The title a Workspace is listed under.
 * @param workspace - title and path.
 * @returns the title, else the directory's last segment, else the path.
 */
export function workspaceLabel(workspace: { readonly title: string; readonly path: string }): string {
  if (workspace.title.trim() !== '') return workspace.title
  const segments = workspace.path.split('/').filter(Boolean)
  return segments.at(-1) ?? workspace.path
}

/**
 * Keep contributions sorted by `order` and unique by id.
 * @param current - registered contributions.
 * @param next - the one to add.
 * @returns the new list.
 * @throws when `next.id` is already registered.
 */
export function addContribution(
  current: readonly DestinationContribution[],
  next: DestinationContribution,
): DestinationContribution[] {
  if (current.some(candidate => candidate.id === next.id)) {
    throw new Error(`deepsea-session-move: duplicate destination contribution "${next.id}"`)
  }
  return [...current, next].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
