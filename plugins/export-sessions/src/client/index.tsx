/**
 * Browser half of @deepsea/export-sessions: the bare `/export-workspace` and
 * `/export-session` export the session's own workspace or the session itself
 * at once, in a dialog that then shows the written ZIP's counts, path (with a
 * copy button) and size, and a Download button that fetches it from the
 * server (for a browser on another machine than the server).
 *
 * Keyboard: the shipped Modal focuses the control marked
 * `data-modal-autofocus` (Close); Escape closes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Button, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'

const CHANNEL = '/deepsea-export-sessions'
/** Document-relative, like the harness's own session download. */
const DOWNLOAD = 'deepsea-export-sessions/download/'
const AUTOFOCUS = { 'data-modal-autofocus': '' } as const

type Kind = 'workspace' | 'session'
interface Saved { name: string, title: string, displayPath: string, counts: { sessions: number, attachments: number }, bytes: number }

type View =
  | { kind: 'closed' }
  | { kind: 'busy', what: Kind }
  | { kind: 'done', what: Kind, saved: Saved }
  | { kind: 'error', what: Kind, text: string }

class Store {
  value: View = { kind: 'closed' }
  listeners = new Set<(view: View) => void>()
  set(view: View): void { this.value = view; for (const listener of this.listeners) listener(view) }
  subscribe(listener: (view: View) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} megabytes`
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
const capital = (kind: Kind): string => kind === 'workspace' ? 'Workspace' : 'Session'

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <code style={{ overflowWrap: 'anywhere', flex: 1 }}>{path}</code>
      <button type="button" className="deepsea-export-sessions-copy" aria-label="Copy path" title={copied ? 'Copied' : 'Copy path'} style={{ border: '1px solid var(--dsh-color-border, #666)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 5, flexShrink: 0 }} onClick={() => { void writeClipboard(path).then(ok => { setCopied(ok) }) }}>
        {copied
          ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
          : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8.5" rx="1.5" /><path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5" /></svg>}
      </button>
    </div>
  )
}

function download(name: string): void {
  const anchor = document.createElement('a')
  anchor.href = `${DOWNLOAD}${encodeURIComponent(name)}`
  anchor.download = name
  anchor.click()
}

function ExportDialog({ store }: { store: Store }) {
  const [view, setView] = useState<View>(store.value)
  useEffect(() => store.subscribe(setView), [store])
  if (view.kind === 'closed') return null
  const close = (): void => { if (view.kind !== 'busy') store.set({ kind: 'closed' }) }
  const title = view.kind === 'done' ? `${capital(view.what)} exported` : `Export ${view.what}`
  const footer = view.kind === 'done'
    ? <><Button onClick={() => { download(view.saved.name) }}>Download</Button><Button variant="primary" {...AUTOFOCUS} onClick={close}>Close</Button></>
    : view.kind === 'error' ? <Button variant="primary" {...AUTOFOCUS} onClick={close}>Close</Button> : undefined
  return (
    <Modal open title={title} onClose={close} closeLabel="Close" width={620} footer={footer}>
      <div className="deepsea-export-sessions-dialog" data-view={view.kind} style={{ fontSize: 13, lineHeight: 1.5 }}>
        {view.kind === 'busy' && `Writing the ${view.what}…`}
        {view.kind === 'done' && <>
          <div>Exported <b>{view.saved.title}</b>: {plural(view.saved.counts.sessions, 'session')} and {plural(view.saved.counts.attachments, 'attachment')} to:</div>
          <CopyPath path={view.saved.displayPath} />
          <div style={{ marginTop: 6 }}>({megabytes(view.saved.bytes)}).</div>
        </>}
        {view.kind === 'error' && <span role="alert">Export failed: {view.text}</span>}
      </div>
    </Modal>
  )
}

export const name = 'deepsea-export-sessions'
export const inject = ['slots', 'commandUi', 'connection']

export function apply(ctx: Context): void {
  const store = new Store()
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  const run = (what: Kind, sessionId: string): void => {
    store.set({ kind: 'busy', what })
    void rpc.call(CHANNEL, 'export', { args: { kind: what, sessionId } }).then(result => {
      if (!result.ok) throw new Error(result.error.message)
      store.set({ kind: 'done', what, saved: result.value as Saved })
    }).catch((error: unknown) => { store.set({ kind: 'error', what, text: String(error instanceof Error ? error.message : error) }) })
  }
  for (const what of ['workspace', 'session'] as const) {
    ctx.effect(() => ctx.commandUi.decorate({ name: `export-${what}`, available: () => true, ui: { kind: 'action', run: session => { run(what, String(session.sessionId)) } } }), `export-sessions: bare /export-${what}`)
  }
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'deepsea-export-sessions', inject: () => ({ store }),
  }, ({ store }: { store: Store }) => <ExportDialog store={store} />)), 'export-sessions: dialog')
}
