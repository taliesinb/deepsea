/**
 * Move to…, Copy to… (one Session) and Rehome… (every Session of a
 * Workspace), rendered from the plugin's `shell.overlay` entry.
 *
 * A Session whose Agent has work in flight refuses to move
 * (`session/move-live`); the dialog lists that work and reveals the
 * stop-and-move option, so the person chooses explicitly. A copy never
 * disturbs its source, so a running one is refused (`session/copy-live`)
 * only until the person decides what the copy does with the turn in
 * progress. Rehome moves every member of a Workspace, reports skips, and can
 * delete the emptied Workspace. Contributed destinations (another host's
 * Workspaces, say) are listed after this machine's; Rehome stays local.
 */
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, type CSSProperties } from 'react'
import { DIALOG_DEFAULT, useDialogDefaultAction } from './dialog-keys.ts'
import type { DestinationContribution } from './face.ts'
import {
  activityLine, answerFromHost, contributedGroups, copyTitle, owningWorkspace, rehomeSummary, resolveDestination, runContributed,
  workspaceLabel,
  type Activity, type Answer, type ContributedGroup, type DestinationChoice, type DialogRequest, type HostResult,
  type LocalWorkspace, type ResolvedDestination,
} from './model.ts'

/** A destination as the Host takes it. */
export type HostDestination = { readonly workspaceId: string } | { readonly path: string }

/** The Host and shell calls the dialogs make. */
export interface DialogActions {
  move(request: { sessionId: string; destination: HostDestination; stopLive: boolean; notify: boolean }): Promise<HostResult>
  copy(request: { sessionId: string; destination: HostDestination; truncate?: boolean; title?: string; notify: boolean }): Promise<HostResult>
  moveMany(request: { sessionIds: readonly string[]; destination: HostDestination; stopLive: boolean; notify: boolean }): Promise<
    | { readonly ok: true; readonly value: { readonly workspaceId: string; readonly moved: readonly string[]; readonly skipped: readonly { readonly reason: string }[] } }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  >
  deleteWorkspace(workspaceId: string): Promise<void>
  /** Open a Session (the copy, once made). */
  openSession(sessionId: string): void
}

const WIDTH = 520
const listStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', maxHeight: 260, overflowY: 'auto',
  border: '1px solid var(--dsw-alias-border-primary, rgba(127,127,127,.3))', borderRadius: 8, padding: 4,
}
const headingStyle: CSSProperties = { fontSize: 12, opacity: 0.6, padding: '6px 8px 2px' }
const rowStyle = (selected: boolean): CSSProperties => ({
  display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left', border: 0, borderRadius: 6,
  padding: '6px 8px', cursor: 'pointer', color: 'inherit', font: 'inherit',
  background: selected ? 'var(--dsw-alias-state-business-primary-subtle, rgba(59,130,246,.15))' : 'transparent',
})
const detailStyle: CSSProperties = { marginLeft: 'auto', opacity: 0.6, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }
const bodyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, font: 'inherit', color: 'inherit',
  background: 'transparent', border: '1px solid var(--dsw-alias-border-primary, rgba(127,127,127,.4))',
}

function Row({ selected, title, detail, disabled, onPick }: {
  selected: boolean
  title: string
  detail?: string | undefined
  disabled: boolean
  onPick: () => void
}) {
  return (
    <button type="button" role="option" aria-selected={selected} disabled={disabled} style={rowStyle(selected)} onClick={onPick}>
      <span>{title}</span>
      {detail !== undefined && <span style={detailStyle} title={detail}>{detail}</span>}
    </button>
  )
}

/**
 * The destination list: this machine's Workspaces, another directory, then
 * each contributed group under its heading.
 */
function DestinationList({ workspaces, groups, choice, current, onPick, disabled }: {
  workspaces: readonly LocalWorkspace[]
  groups: readonly ContributedGroup[]
  choice: DestinationChoice | undefined
  /** Workspace the item belongs to, marked while nothing is chosen. */
  current: string | undefined
  onPick: (choice: DestinationChoice) => void
  disabled: boolean
}) {
  const [path, setPath] = useState(choice?.kind === 'path' ? choice.path : '')
  const other = choice?.kind === 'path'
  return (
    <div style={listStyle} role="listbox" aria-label="Destination">
      {groups.length > 0 && <div style={headingStyle}>This machine</div>}
      {workspaces.map(workspace => (
        <Row
          key={workspace.workspaceId}
          title={workspaceLabel(workspace)}
          detail={workspace.path}
          disabled={disabled}
          selected={choice === undefined ? workspace.workspaceId === current : choice.kind === 'local' && choice.workspaceId === workspace.workspaceId}
          onPick={() => { onPick({ kind: 'local', workspaceId: workspace.workspaceId }) }}
        />
      ))}
      <Row title="Other directory" selected={other} disabled={disabled} onPick={() => { onPick({ kind: 'path', path }) }} />
      {other && (
        <div style={{ padding: '2px 8px 6px' }}>
          <input
            style={inputStyle}
            aria-label="Directory"
            placeholder="/path/to/project"
            value={path}
            disabled={disabled}
            data-modal-autofocus=""
            onChange={(event) => {
              setPath(event.currentTarget.value)
              onPick({ kind: 'path', path: event.currentTarget.value })
            }}
          />
        </div>
      )}
      {groups.map(({ group }) => (
        <div key={group.id} role="group" aria-label={group.label}>
          <div style={headingStyle}>{group.label}</div>
          {group.entries.map(entry => (
            <Row
              key={entry.key}
              title={entry.title}
              detail={entry.path}
              disabled={disabled}
              selected={choice?.kind === 'external' && choice.groupId === group.id && choice.key === entry.key}
              onPick={() => { onPick({ kind: 'external', groupId: group.id, key: entry.key }) }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function Blockers({ blockers, label }: { blockers: readonly Activity[]; label: string }) {
  return (
    <ul aria-label={label} style={{ margin: 0, paddingLeft: 18 }}>
      {blockers.map((entry, index) => <li key={`${entry.kind}-${String(index)}`}>{activityLine(entry)}</li>)}
    </ul>
  )
}

function Status({ text, alert = false }: { text: string; alert?: boolean }) {
  return <div role={alert ? 'alert' : 'status'} style={alert ? { color: 'var(--dsw-alias-state-danger, #e5484d)' } : { opacity: 0.8 }}>{text}</div>
}

const hostDestination = (destination: Exclude<ResolvedDestination, { kind: 'external' }>): HostDestination =>
  destination.kind === 'local' ? { workspaceId: destination.workspace.workspaceId } : { path: destination.path }

/**
 * Move to… or Copy to… for one Session. A move may not target the Session's
 * own Workspace; a copy may (a duplicate) and starts there.
 */
export function SessionDialog({ request, workspaces, contributions, actions, onClose }: {
  request: Extract<DialogRequest, { kind: 'session' }>
  workspaces: readonly LocalWorkspace[]
  contributions: readonly DestinationContribution[]
  actions: DialogActions
  onClose: () => void
}) {
  const copy = request.action === 'copy'
  const source = owningWorkspace(workspaces, request.sessionId)
  const groups = contributedGroups(contributions)
  const preselected = request.destinationId ?? (copy ? source?.workspaceId : undefined)
  const [choice, setChoice] = useState<DestinationChoice | undefined>(
    preselected === undefined ? undefined : { kind: 'local', workspaceId: preselected },
  )
  const destination = resolveDestination(choice, workspaces, groups)
  const [title, setTitle] = useState(copyTitle(request.displayTitle))
  const [blockers, setBlockers] = useState<readonly Activity[] | null>(null)
  const [stopLive, setStopLive] = useState(false)
  const [truncate, setTruncate] = useState(true)
  const [notify, setNotify] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const done = summary !== null
  const sameWorkspace = !copy && destination?.kind === 'local' && destination.workspace.workspaceId === source?.workspaceId
  const blocked = pending || destination === undefined || sameWorkspace || done || (!copy && blockers !== null && !stopLive)
  useDialogDefaultAction(true, blockers === null ? 'pick' : 'blocked')
  const close = (): void => { if (!pending) onClose() }
  const settle = (answer: Answer): void => {
    setPending(false)
    if (answer.ok) {
      if (answer.summary !== undefined) {
        setSummary(answer.summary)
        return
      }
      if (copy && answer.sessionId !== undefined) actions.openSession(answer.sessionId)
      onClose()
      return
    }
    if (answer.blockers !== undefined) setBlockers(answer.blockers)
    else setError(`${answer.code}: ${answer.message}`)
  }
  const confirm = (): void => {
    if (blocked) return
    setPending(true)
    setError(null)
    const named = title.trim()
    const copyOptions = {
      // Undecided until the source reports a running turn; then the checkbox decides.
      ...(blockers === null ? {} : { truncate }),
      ...(named === '' || named === request.displayTitle ? {} : { title: named }),
    }
    if (destination.kind === 'external') {
      void runContributed(contributions, destination, {
        action: request.action,
        sessionId: request.sessionId,
        sourceTitle: request.displayTitle,
        ...(source === undefined ? {} : { sourceWorkspaceId: source.workspaceId }),
        notify,
        ...(copy ? copyOptions : { stopLive }),
      }).then(settle)
      return
    }
    const target = { sessionId: request.sessionId, destination: hostDestination(destination), notify }
    const answer = copy ? actions.copy({ ...target, ...copyOptions }) : actions.move({ ...target, stopLive })
    void answer.then(answerFromHost, (failure: unknown) => ({
      ok: false as const, code: 'deepsea-session-move/failed', message: failure instanceof Error ? failure.message : String(failure),
    })).then(settle)
  }
  return (
    <Modal
      open
      width={WIDTH}
      onClose={close}
      closeLabel="Close"
      title={copy ? 'Copy session' : 'Move session'}
      {...request.displayTitle === '' ? {} : { description: request.displayTitle }}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{done ? 'Close' : 'Cancel'}</Button>
          {!done && (
            <Button variant="primary" disabled={blocked} onClick={confirm} {...DIALOG_DEFAULT}>
              {copy ? (pending ? 'Copying…' : 'Copy') : (pending ? 'Moving…' : 'Move')}
            </Button>
          )}
        </>
      )}
    >
      <div style={bodyStyle}>
        <DestinationList
          workspaces={workspaces} groups={groups} choice={choice} current={source?.workspaceId} disabled={pending || done}
          onPick={(next) => {
            setChoice(next)
            setError(null)
          }}
        />
        {sameWorkspace && <Status text="The session is already in that workspace." />}
        {copy && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Title of the copy</span>
            <input style={inputStyle} value={title} disabled={pending || done} onChange={(event) => { setTitle(event.currentTarget.value) }} />
          </label>
        )}
        {blockers !== null && !done && (
          <>
            <Blockers blockers={blockers} label={copy ? 'This session is running' : 'Work the move would interrupt'} />
            {copy
              ? <Checkbox checked={truncate} onChange={setTruncate} disabled={pending} label="Copy only up to the last completed turn" />
              : <Checkbox checked={stopLive} onChange={setStopLive} disabled={pending} label="Interrupt this work and move it" />}
          </>
        )}
        <Checkbox
          checked={notify} onChange={setNotify} disabled={pending || done}
          label={copy ? 'Inform agent it is a copy before next turn' : 'Inform agent of move before next turn'}
        />
        {summary !== null && <Status text={summary} />}
        {error !== null && <Status text={error} alert />}
      </div>
    </Modal>
  )
}

/** Rehome… for one Workspace: move every member Session elsewhere, report skips, optionally delete the emptied source. */
export function RehomeDialog({ request, workspaces, actions, onClose }: {
  request: Extract<DialogRequest, { kind: 'rehome' }>
  workspaces: readonly LocalWorkspace[]
  actions: DialogActions
  onClose: () => void
}) {
  const [choice, setChoice] = useState<DestinationChoice | undefined>(undefined)
  const destination = resolveDestination(choice, workspaces, [])
  const [stopLive, setStopLive] = useState(false)
  const [deleteSource, setDeleteSource] = useState(false)
  const [notify, setNotify] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const source = workspaces.find(workspace => workspace.workspaceId === request.workspaceId)
  const sameWorkspace = destination?.kind === 'local' && destination.workspace.workspaceId === request.workspaceId
  const blocked = pending || destination === undefined || destination.kind === 'external' || sameWorkspace || summary !== null
  useDialogDefaultAction(true, summary === null ? 'pick' : 'done')
  const close = (): void => { if (!pending) onClose() }
  const confirm = async (): Promise<void> => {
    if (blocked || source === undefined) return
    setPending(true)
    setError(null)
    try {
      const result = await actions.moveMany({ sessionIds: source.sessionIds, destination: hostDestination(destination), stopLive, notify })
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`)
        return
      }
      const { moved, skipped } = result.value
      if (deleteSource && skipped.length === 0) await actions.deleteWorkspace(request.workspaceId)
      setSummary(rehomeSummary(moved.length, skipped))
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(false)
    }
  }
  return (
    <Modal
      open
      width={WIDTH}
      onClose={close}
      closeLabel="Close"
      title={`Rehome “${request.title}”`}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{summary === null ? 'Cancel' : 'Close'}</Button>
          {summary === null && (
            <Button variant="primary" disabled={blocked} onClick={() => { void confirm() }} {...DIALOG_DEFAULT}>
              {pending ? 'Rehoming…' : 'Rehome'}
            </Button>
          )}
        </>
      )}
    >
      <div style={bodyStyle}>
        <DestinationList
          workspaces={workspaces} groups={[]} choice={choice} current={undefined} disabled={pending || summary !== null}
          onPick={(next) => {
            setChoice(next)
            setError(null)
          }}
        />
        {sameWorkspace && <Status text="That is this workspace." />}
        <Checkbox checked={stopLive} onChange={setStopLive} disabled={pending || summary !== null} label="Also move sessions with work in flight (interrupts it)" />
        <Checkbox checked={deleteSource} onChange={setDeleteSource} disabled={pending || summary !== null} label="Delete this workspace if it ends up empty" />
        <Checkbox checked={notify} onChange={setNotify} disabled={pending || summary !== null} label="Inform agents of move before next turn" />
        {summary !== null && <Status text={summary} />}
        {error !== null && <Status text={error} alert />}
      </div>
    </Modal>
  )
}
