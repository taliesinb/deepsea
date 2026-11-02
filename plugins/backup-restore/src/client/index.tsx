/**
 * Browser half of @deepsea/backup-restore: decorations of the bare host
 * commands. `/backup` asks for confirmation, then shows the counts, path and
 * size of the written ZIP with a copy button; `/restore` lists the backups to
 * choose from, starts the restore and follows it across the server's restart:
 * the attempt is kept in sessionStorage, so the page that reloads onto the
 * restored home shows the worker's verified outcome (restored, rolled back,
 * rollback failed, aborted) with both archives.
 *
 * Keyboard: the shipped Modal focuses the control marked
 * `data-modal-autofocus` when the dialog opens (Back up, Close), so Enter
 * presses it; Escape closes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Button, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'

const CHANNEL = '/deepsea-backup-restore'
/** sessionStorage: the restore this page started, until its outcome is dismissed. */
const STORAGE_KEY = 'deepsea.backup-restore.pending'
const AUTOFOCUS = { 'data-modal-autofocus': '' } as const

interface Archive { name: string, bytes: number, modifiedAt: string }
interface Listing { shownBackups: string, archives: Archive[], restoring: boolean }
interface Saved { name: string, displayPath: string, counts: { workspaces: number, sessions: number }, bytes: number }
interface RestoreArchive { name: string, counts: { workspaces: number, sessions: number }, bytes: number }
interface RestoreAttempt { id: string, selected: RestoreArchive, rollback: RestoreArchive, shownBackups: string }
interface RestoreStatus extends RestoreAttempt { state: 'pending' | 'restored' | 'rolled-back' | 'rollback-failed' | 'failed', error?: string, rollbackError?: string, warning?: string, log?: string }

type View =
  | { kind: 'closed' }
  | { kind: 'choose', data: Listing, selected?: string }
  | { kind: 'confirm-backup', backups: string }
  | { kind: 'backup-busy' }
  | { kind: 'backup-done', saved: Saved }
  | { kind: 'busy', text: string }
  | { kind: 'restore-waiting', attempt: RestoreAttempt }
  | { kind: 'restore-result', result: RestoreStatus }
  | { kind: 'error', text: string }

class Store {
  value: View = { kind: 'closed' }
  listeners = new Set<(view: View) => void>()
  set(view: View): void { this.value = view; for (const listener of this.listeners) listener(view) }
  subscribe(listener: (view: View) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} megabytes`
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
const errorText = (error: unknown): string => String(error instanceof Error ? error.message : error)
function saveAttempt(attempt: RestoreAttempt): void { try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(attempt)) } catch { /* private browser storage */ } }
function clearAttempt(): void { try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* private browser storage */ } }
function pendingAttempt(): RestoreAttempt | undefined {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY)
    return value === null ? undefined : JSON.parse(value) as RestoreAttempt
  } catch { return undefined }
}

function CopyPath({ path, label }: { path: string, label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <code style={{ overflowWrap: 'anywhere', flex: 1 }}>{path}</code>
      <button type="button" className="deepsea-backup-restore-copy" aria-label={label} title={copied ? 'Copied' : 'Copy path'} style={{ border: '1px solid var(--dsh-color-border, #666)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 5, flexShrink: 0 }} onClick={() => { void writeClipboard(path).then(ok => { setCopied(ok) }) }}>
        {copied
          ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
          : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8.5" rx="1.5" /><path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5" /></svg>}
      </button>
    </div>
  )
}

function ArchiveDetail({ label, archive, shownBackups }: { label: 'Restored' | 'Rollback wrote', archive: RestoreArchive, shownBackups: string }) {
  return <div style={{ marginTop: 12 }}>
    <div>{label} {plural(archive.counts.workspaces, 'workspace')} and {plural(archive.counts.sessions, 'session')} {label === 'Restored' ? 'from:' : 'to:'}</div>
    <CopyPath path={`${shownBackups}/${archive.name}`} label={`Copy ${label === 'Restored' ? 'restored' : 'rollback'} path`} />
    <div>({megabytes(archive.bytes)}).</div>
  </div>
}

function RestoreDialog({ store, rpc }: { store: Store, rpc: ClientConnectionRpc }) {
  const [view, setView] = useState<View>(store.value)
  useEffect(() => store.subscribe(setView), [store])
  /** Stops following a restore across the restart (set by the follow effect, called on dismissal). */
  const stopFollowing = useRef<() => void>(() => {})
  const call = async (method: string, args: object = {}): Promise<unknown> => {
    const result = await rpc.call(CHANNEL, method, { args })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const close = (): void => {
    if (view.kind === 'busy' || view.kind === 'backup-busy' || view.kind === 'restore-waiting') return
    if (view.kind === 'restore-result') {
      clearAttempt()
      stopFollowing.current()
    }
    store.set({ kind: 'closed' })
  }
  // Follow a restore this page started, across the server's shutdown, the swap
  // and the restart (the page reloads onto the restored home and resumes here).
  useEffect(() => {
    const attempt = pendingAttempt()
    if (attempt === undefined) return
    let stopped = false
    let polling = false
    let observedDown = false
    let completed = false
    const tick = async (): Promise<void> => {
      if (polling || stopped) return
      polling = true
      try {
        const status = await call('status', { id: attempt.id }) as RestoreStatus
        if (stopped || completed) return
        if (status.state === 'pending') {
          store.set({ kind: 'restore-waiting', attempt })
        } else {
          completed = true
          store.set({ kind: 'restore-result', result: { ...status, shownBackups: attempt.shownBackups } })
        }
      } catch { /* the old server is shutting down, or the new one is starting */ }
      finally { polling = false }
    }
    void tick()
    const timer = setInterval(() => {
      if (completed || stopped) return
      void tick()
      void fetch(`${location.origin}${location.pathname}`, { method: 'HEAD', cache: 'no-store' }).then(response => {
        if (response.status === 503) observedDown = true
        else if (observedDown && !completed && !stopped) location.reload()
      }).catch(() => { observedDown = true })
    }, 2000)
    stopFollowing.current = () => { stopped = true; clearInterval(timer) }
    return () => { stopped = true; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, rpc])
  const backup = async (): Promise<void> => {
    store.set({ kind: 'backup-busy' })
    try { store.set({ kind: 'backup-done', saved: await call('backup') as Saved }) }
    catch (error) { store.set({ kind: 'error', text: `Backup failed: ${errorText(error)}` }) }
  }
  const restore = async (filename: string): Promise<void> => {
    store.set({ kind: 'busy', text: 'Saving a rollback…' })
    try {
      const attempt = await call('restore', { name: filename }) as RestoreAttempt
      saveAttempt(attempt)
      store.set({ kind: 'restore-waiting', attempt })
    } catch (error) { store.set({ kind: 'error', text: `Restore aborted before shutdown: ${errorText(error)}. The home was not replaced.` }) }
  }
  if (view.kind === 'closed') return null
  const title = view.kind === 'choose' ? 'Restore DeepSea'
    : view.kind === 'confirm-backup' || view.kind === 'backup-busy' ? 'Back up DeepSea?'
      : view.kind === 'backup-done' ? 'Backup saved'
        : view.kind === 'restore-result' ? 'Restore' : 'Backup and restore'
  const footer = view.kind === 'choose'
    ? <>
      <Button onClick={close}>Cancel</Button>
      <Button variant="primary" disabled={!view.selected} onClick={() => { if (view.selected) void restore(view.selected) }}>Restore</Button>
    </>
    : view.kind === 'confirm-backup'
      ? <><Button onClick={close}>Cancel</Button><Button variant="primary" {...AUTOFOCUS} onClick={() => { void backup() }}>Back up</Button></>
      : view.kind === 'error' || view.kind === 'restore-result' || view.kind === 'backup-done'
        ? <Button variant="primary" {...AUTOFOCUS} onClick={close}>Close</Button>
        : undefined
  return (
    <Modal open title={title} onClose={close} closeLabel="Close" width={620} footer={footer}>
      <div className="deepsea-backup-restore-dialog" data-view={view.kind} style={{ fontSize: 13, lineHeight: 1.5 }}>
        {view.kind === 'confirm-backup' && <>Back up this home to <code>{view.backups}</code>?</>}
        {view.kind === 'backup-busy' && 'Writing and verifying the backup…'}
        {view.kind === 'backup-done' && <>
          <div>Wrote {plural(view.saved.counts.workspaces, 'workspace')} and {plural(view.saved.counts.sessions, 'session')} to:</div>
          <CopyPath path={view.saved.displayPath} label="Copy backup path" />
          <div style={{ marginTop: 6 }}>({megabytes(view.saved.bytes)}).</div>
        </>}
        {view.kind === 'busy' && view.text}
        {view.kind === 'restore-waiting' && <>Rollback saved to <code>{view.attempt.shownBackups}/{view.attempt.rollback.name}</code>. Restoring once the server stops…</>}
        {view.kind === 'restore-result' && <>
          {view.result.state === 'restored' && <><ArchiveDetail label="Restored" archive={view.result.selected} shownBackups={view.result.shownBackups} />{view.result.warning && <div role="alert">{view.result.warning}</div>}</>}
          {view.result.state === 'rolled-back' && <div role="alert">Restore failed: {view.result.error}. The rollback was restored; the selected backup was not.</div>}
          {view.result.state === 'rollback-failed' && <div role="alert">Restore failed: {view.result.error}. The rollback failed too: {view.result.rollbackError}.{view.result.log !== undefined && <> Log: <code>{view.result.log}</code></>}</div>}
          {view.result.state === 'failed' && <div role="alert">Restore aborted: {view.result.error}. The home was not replaced.</div>}
          <ArchiveDetail label="Rollback wrote" archive={view.result.rollback} shownBackups={view.result.shownBackups} />
        </>}
        {view.kind === 'error' && <span role="alert">{view.text}</span>}
        {view.kind === 'choose' && <>
          <div style={{ marginBottom: 10, fontFamily: 'var(--dsh-font-mono, ui-monospace, monospace)', overflowWrap: 'anywhere' }}>{view.data.shownBackups}</div>
          {view.data.archives.length === 0 && <div>No backups.</div>}
          <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
            {view.data.archives.map(archive => <label key={archive.name} className="deepsea-backup-restore-archive" style={{ display: 'flex', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--dsh-color-border, #555)', cursor: 'pointer' }}>
              <input type="radio" name="deepsea-backup-restore-archive" checked={view.selected === archive.name} onChange={() => store.set({ ...view, selected: archive.name })} />
              <span style={{ overflowWrap: 'anywhere' }}>{archive.name}<br /><small>{new Date(archive.modifiedAt).toLocaleString()} · {(archive.bytes / 1024 / 1024).toFixed(1)} MB</small></span>
            </label>)}
          </div>
          {view.selected && <div role="alert" style={{ marginTop: 12, color: 'var(--dsh-color-danger, #c0392b)' }}>Replaces this whole home. A rollback is saved first.</div>}
        </>}
      </div>
    </Modal>
  )
}

export const name = 'deepsea-backup-restore'
export const inject = ['slots', 'commandUi', 'connection']

export function apply(ctx: Context): void {
  const store = new Store()
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  // The dialog opens once the listing is in, so its first view is the one that takes focus.
  const open = (then: (listing: Listing) => View): void => {
    void rpc.call(CHANNEL, 'list', { args: {} }).then(result => {
      if (!result.ok) throw new Error(result.error.message)
      store.set(then(result.value as Listing))
    }).catch(error => store.set({ kind: 'error', text: errorText(error) }))
  }
  ctx.effect(() => ctx.commandUi.decorate({ name: 'backup', available: () => true, ui: { kind: 'action', run: () => { open(listing => ({ kind: 'confirm-backup', backups: listing.shownBackups })) } } }), 'backup-restore: /backup confirmation')
  ctx.effect(() => ctx.commandUi.decorate({ name: 'restore', available: () => true, ui: { kind: 'action', run: () => { open(listing => ({ kind: 'choose', data: listing })) } } }), 'backup-restore: /restore chooser')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'deepsea-backup-restore', inject: () => ({ store, rpc }),
  }, ({ store, rpc }: { store: Store, rpc: ClientConnectionRpc }) => <RestoreDialog store={store} rpc={rpc} />)), 'backup-restore: dialog')
}
