/**
 * Browser half of @deepsea/reboot: a dialog on the BARE `/reboot` (a
 * ui-commands decoration of the host command, so the catalog row, `/reboot
 * now|wait|cancel` and the command log stay the host's). While open, the
 * dialog polls the host's control routes once a second and shows:
 *
 *   - whether a reboot is a restart (a relay fronts the server) or a quit,
 *     only when it is the latter or unknown;
 *   - every session with work in flight that a reboot would interrupt;
 *   - the armed when-idle state, if any (host-side, so it survives closing
 *     the dialog or the tab, and every client sees it).
 *
 * Buttons: Cancel · Reboot when idle (only while something is busy) · Reboot
 * now. Enter = Reboot now (dialog-keys.ts), Escape = Cancel.
 *
 * After the reboot fires the dialog stays up and brings the page back: it
 * waits for the server to go away, pokes the relay's loopback URL (a page
 * served straight from the server's port would otherwise wait for the next
 * connection through the relay), and reloads once the origin answers again
 * with anything but the relay's 503 splash.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DIALOG_DEFAULT, useDialogDefaultAction } from './dialog-keys.ts'

const CHANNEL = '/deepsea-reboot'
const COMMAND = 'reboot'
const POLL_MS = 1000

type Blocker =
  | { kind: 'turn' }
  | { kind: 'queue', count: number }
  | { kind: 'jobs', labels: string[] }
  | { kind: 'subagents', count: number, running: number }

interface BusySession { sessionId: string, parentId?: string, blockers: Blocker[] }

interface Relay {
  present: boolean
  wakeUrl?: string
  listening?: boolean
}

interface Status {
  busy: BusySession[]
  armed?: { mode: 'when-idle', since: number, by?: string }
  fired: boolean
  now: number
  relay: Relay
  /** What a SIGTERM means here, worded by the host (reboot.mjs `relayVerdict`). */
  verdict: { kind: 'restart' | 'quit' | 'unknown', text: string }
  process: { pid: number, port: number, uptimeSeconds: number, home: string }
}

/** Dialog state owned by the plugin; the overlay component subscribes. */
interface DialogState { open: boolean, sessionId: string | undefined }
type Listener = (state: DialogState) => void

class DialogStore {
  private state: DialogState = { open: false, sessionId: undefined }
  private readonly listeners = new Set<Listener>()
  get(): DialogState { return this.state }
  open(sessionId: string): void { this.set({ open: true, sessionId }) }
  close(): void { this.set({ open: false, sessionId: undefined }) }
  private set(state: DialogState): void { this.state = state; for (const l of this.listeners) l(state) }
  subscribe(l: Listener): () => void { this.listeners.add(l); return () => { this.listeners.delete(l) } }
}

function blockerLabel(blocker: Blocker): string {
  switch (blocker.kind) {
    case 'turn': return 'a turn is running'
    case 'queue': return `${String(blocker.count)} queued message${blocker.count === 1 ? '' : 's'}`
    case 'jobs': return `${String(blocker.labels.length)} background job${blocker.labels.length === 1 ? '' : 's'}: ${blocker.labels.slice(0, 3).join(', ')}${blocker.labels.length > 3 ? ', …' : ''}`
    case 'subagents': return blocker.running > 0
      ? `${String(blocker.count)} subagent${blocker.count === 1 ? '' : 's'} loaded, ${String(blocker.running)} running`
      : `${String(blocker.count)} subagent${blocker.count === 1 ? '' : 's'} loaded`
  }
}

const small = { fontSize: 12, opacity: 0.75 } as const
const mono = { fontFamily: 'var(--dsh-font-mono, ui-monospace, monospace)', fontSize: 12 } as const
const danger = 'var(--dsh-color-danger, #d9534f)'

function Banner({ tone, children }: { tone: 'info' | 'warn' | 'danger', children: ReactNode }) {
  const color = tone === 'danger' ? danger : tone === 'warn' ? 'var(--dsh-color-warning, #e0a800)' : 'var(--dsh-color-border, rgba(127,127,127,0.5))'
  return (
    <div className="deepsea-reboot-banner" data-tone={tone} style={{ borderLeft: `3px solid ${color}`, padding: '6px 10px', fontSize: 13, lineHeight: 1.45, background: 'rgba(127,127,127,0.07)', borderRadius: 4 }}>
      {children}
    </div>
  )
}

/** `/Users/<login>/x` or `/home/<login>/x` → `~/x`. */
function tildify(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/**
 * After the reboot fired: wait for the server to disappear, then poke the
 * relay and probe our own origin until it answers with anything but the
 * relay's 503 splash, then reload.
 */
function useComeback(active: boolean, wakeUrl: string | undefined, serverGone: boolean): 'idle' | 'going-down' | 'waiting' {
  const [phase, setPhase] = useState<'idle' | 'going-down' | 'waiting'>('idle')
  useEffect(() => {
    if (!active) { setPhase('idle'); return }
    if (!serverGone) { setPhase('going-down'); return }
    setPhase('waiting')
    let stopped = false
    const probe = async (): Promise<void> => {
      if (wakeUrl !== undefined) {
        // Opaque cross-origin GET: the relay only needs to see a connection.
        void fetch(wakeUrl, { mode: 'no-cors', cache: 'no-store' }).catch(() => {})
      }
      try {
        const response = await fetch(`${location.origin}${location.pathname}`, { method: 'HEAD', cache: 'no-store' })
        if (!stopped && response.status !== 503) location.reload()
      } catch { /* still down */ }
    }
    void probe()
    const timer = setInterval(() => { void probe() }, 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [active, serverGone, wakeUrl])
  return phase
}

function RebootDialog({ store, rpc, sessions }: { store: DialogStore, rpc: ClientConnectionRpc, sessions: ISessions }) {
  const [state, setState] = useState<DialogState>(store.get())
  useEffect(() => store.subscribe(setState), [store])
  const [status, setStatus] = useState<Status | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  /** The host said the reboot is under way (from a status poll or our own action). */
  const [fired, setFired] = useState(false)
  /** A status poll failed after firing: the process is gone. */
  const [serverGone, setServerGone] = useState(false)
  const firedRef = useRef(false)
  /** A when-idle reboot was armed at the last poll: if the server then vanishes, that reboot fired. */
  const armedRef = useRef(false)

  const call = async (endpoint: string): Promise<Status | undefined> => {
    const result = await rpc.call(CHANNEL, endpoint, { args: { sessionId: state.sessionId } })
    if (!result.ok) throw new Error(result.error.message)
    return result.value as Status
  }

  // Poll while open. After firing, a failed poll is the signal the server is gone.
  useEffect(() => {
    if (!state.open) { setStatus(undefined); setError(undefined); setFired(false); setServerGone(false); firedRef.current = false; armedRef.current = false; return }
    let stopped = false
    const tick = async (): Promise<void> => {
      try {
        const next = await call('status')
        if (stopped || next === undefined) return
        setStatus(next)
        setError(undefined)
        armedRef.current = next.armed !== undefined
        if (next.fired) { firedRef.current = true; setFired(true) }
      } catch (failure) {
        if (stopped) return
        if (firedRef.current || armedRef.current) { firedRef.current = true; setFired(true); setServerGone(true) }
        else setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => { stopped = true; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.sessionId])

  const comeback = useComeback(fired, status?.relay.wakeUrl, serverGone)
  // Enter = Reboot now. Focus moves to it once the first status enables it,
  // and follows the dialog when the fired Modal (a different card) replaces it.
  useDialogDefaultAction(state.open, fired ? 'fired' : status === undefined ? 'loading' : 'ready')

  const act = async (endpoint: 'now' | 'wait' | 'cancel'): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      const next = await call(endpoint)
      if (next !== undefined) {
        setStatus(next)
        if (next.fired) { firedRef.current = true; setFired(true) }
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(false)
    }
  }

  if (!state.open) return null
  const close = (): void => { store.close() }
  const list = sessions.list.getSnapshot()
  const titleOf = (id: string): string => list.byId[id as keyof typeof list.byId]?.displayTitle ?? id
  const cwdOf = (id: string): string | undefined => list.byId[id as keyof typeof list.byId]?.cwd
  const busy = status?.busy ?? []
  const verdict = status?.verdict
  const armed = status?.armed

  if (fired) {
    return (
      <Modal open headless title="Rebooting DeepSea" onClose={() => {}} width={460}>
        <div className="deepsea-reboot-progress" data-phase={comeback} style={{ padding: 20, fontSize: 13, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Rebooting DeepSea…</div>
          {comeback === 'going-down' && <div>Shutting the server down.</div>}
          {comeback === 'waiting' && (
            <>
              <div>The server is down.</div>
              {verdict?.kind !== 'quit' && <div style={{ marginTop: 8 }}>Waiting for it to answer again.</div>}
            </>
          )}
          {verdict !== undefined && verdict.kind !== 'restart' && <div style={{ marginTop: 8, ...small }}>{verdict.text}</div>}
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      title="Reboot DeepSea?"
      closeLabel="Cancel"
      onClose={close}
      width={560}
      footer={<>
        {/* Armed: "Cancel" drops the armed reboot (the dialog closes via X / Escape / Close). */}
        {armed !== undefined
          ? <>
            <Button variant="outline" disabled={pending} onClick={close}>Close</Button>
            <Button variant="outline" disabled={pending} onClick={() => { void act('cancel') }}>Cancel</Button>
          </>
          : <Button variant="outline" disabled={pending} onClick={close}>Cancel</Button>}
        {/* "When idle" only means something while somebody is busy. */}
        {armed === undefined && busy.length > 0 && (
          <Button variant="outline" disabled={pending} onClick={() => { void act('wait') }}>
            Reboot when idle
          </Button>
        )}
        <Button variant="primary" {...DIALOG_DEFAULT} disabled={pending || status === undefined} style={busy.length > 0 ? { background: 'var(--dsh-color-danger, #c0392b)', borderColor: 'var(--dsh-color-danger, #c0392b)' } : undefined} onClick={() => { void act('now') }}>
          Reboot now
        </Button>
      </>}
    >
      <div className="deepsea-reboot-dialog" style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.45 }}>
        {/* The relay verdict is worth a line only when it is bad news. */}
        {verdict !== undefined && verdict.kind !== 'restart' && <Banner tone={verdict.kind === 'quit' ? 'danger' : 'warn'}>{verdict.text}</Banner>}
        {status === undefined && error === undefined && <div style={small}>Checking what is running…</div>}
        {status !== undefined && (
          busy.length === 0
            ? <Banner tone="info">Safe to reboot: no session has work in flight.</Banner>
            : (
              <div>
                <div style={{ marginBottom: 4 }}>Rebooting now would interrupt:</div>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {busy.map(row => (
                    <li key={row.sessionId}>
                      <span style={{ fontWeight: 600 }}>{titleOf(row.sessionId)}</span>
                      {row.sessionId === state.sessionId && <span style={{ ...small, marginLeft: 6 }}>(this session)</span>}
                      {row.parentId !== undefined && <span style={{ ...small, marginLeft: 6 }}>↳ subagent of {titleOf(row.parentId)}</span>}
                      {cwdOf(row.sessionId) !== undefined && <span style={{ ...mono, opacity: 0.6, marginLeft: 6 }}>{tildify(cwdOf(row.sessionId) ?? '')}</span>}
                      <div style={small}>{row.blockers.map(blockerLabel).join(' · ')}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )
        )}
        {armed !== undefined && (
          <Banner tone="warn">
            Reboot armed at {new Date(armed.since).toLocaleTimeString()}{armed.by !== undefined ? ` from ${titleOf(armed.by)}` : ''}: it fires once every session is idle.
          </Banner>
        )}
        {error !== undefined && <div role="alert" style={{ color: danger }}>{error}</div>}
      </div>
    </Modal>
  )
}

export const name = 'deepsea-reboot'
export const inject = ['slots', 'commandUi', 'connection', 'sessions']

export function apply(ctx: Context): void {
  const store = new DialogStore()
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  const sessions = ctx.get('sessions') as ISessions

  ctx.effect(() => ctx.commandUi.decorate({
    name: COMMAND,
    available: () => true,
    ui: { kind: 'action', run: (session) => { store.open(session.sessionId) } },
  }), 'reboot: bare /reboot opens the dialog')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'deepsea-reboot',
    inject: () => ({ store, rpc, sessions }),
  }, ({ store, rpc, sessions }: { store: DialogStore, rpc: ClientConnectionRpc, sessions: ISessions }) => <RebootDialog store={store} rpc={rpc} sessions={sessions} />)), 'reboot: dialog overlay')
}
