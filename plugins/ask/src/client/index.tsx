/**
 * @deepsea/ask, browser half.
 *
 *   - A right-sidebar page tab (`deepsea-ask`) showing the session's side
 *     thread: each question with where the main conversation was when it was
 *     asked, the read-only tool calls behind the answer, and the answer as
 *     Markdown while it streams; an input at the bottom asks the next one. A
 *     torn edge separates questions asked in materially different contexts
 *     (a later main turn, or long enough apart that the prompt cache has
 *     expired), and closes the thread when the next question would be one.
 *   - "?" markers in the chat's left gutter, one per question (at most three
 *     per turn, then "+n"), at the turn it was asked during: the turn's tail
 *     (`conversation.chat.turnTail`, present once the turn ends, visible when
 *     its work is folded) or, while the turn still runs, the question's own
 *     command row. A marker opens the tab on its question and flashes it; the
 *     tab's link icon scrolls the chat to the marker and flashes that.
 *   - Bare `/ask` opens the tab; `/ask <question>` asks and opens it.
 *
 * The thread lives on the host (POST /deepsea-ask/thread|cancel|clear|export);
 * each session's copy here is polled while an answer is streaming. Questions
 * from the panel go through the `/ask` command too, so every question is
 * logged the same way and has a command row to mark while its turn runs.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  Button, IconCopyOutlineRegular, IconLinkOutlineRegular, IconQuestionOutlineRegular, MarkdownText, Modal, TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './style.css'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The side question to bring into view and flash. */
    'deepsea-ask': { readonly focus?: string }
  }
}

const CHANNEL = '/deepsea-ask'
const KIND = 'deepsea-ask'
const TAB_ID = '@deepsea/ask'
const POLL_MS = 150
const FLASH_MS = 1400
/** Questions further apart than this start a new context: the provider's prompt cache has expired (5 minutes on Anthropic). */
const CONTEXT_GAP_MS = 10 * 60 * 1000
/** Markers shown per turn before the rest fold into "+n". */
const MARKS_PER_TURN = 3

interface ToolRow { name: string, summary: string, state: 'running' | 'ok' | 'error' | 'refused' }
interface Usage { inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }
interface Exchange {
  id: string
  question: string
  askedAt: string
  turn: number
  step: number
  running: boolean
  status: 'answering' | 'done' | 'error' | 'cancelled'
  answer: string
  error?: string
  tools: ToolRow[]
  usage?: Usage
  model?: string
  durationMs?: number
}
interface MainPosition { turn: number, running: boolean }
interface ThreadValue { version: number, exchanges: Exchange[], main?: MainPosition }
interface Thread extends ThreadValue { loaded: boolean, error?: string }
interface Actions {
  ask: (question: string) => Promise<string | undefined>
  cancel: (id: string) => void
  clear: () => void
  /** Write the thread to the session's directory; resolves to the file's path. */
  exportThread: () => Promise<string>
  refresh: () => void
  /** Scroll the chat to a question's marker and flash it. */
  jump: (id: string) => void
}

const MARKDOWN_LABELS = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied' },
  footnotes: 'Footnotes',
}

/** Runs one command line for a session (`ctx.remote.commands.execute`). */
type ExecuteCommand = (sessionId: string, line: string) => Promise<
  | { ok: true, value: { result: { kind: 'success' | 'error', text?: string } } | undefined }
  | { ok: false, error: { code: string, message: string } }>

/** The exchange id in a `/ask` result text. */
function exchangeId(text: string | undefined): string | undefined {
  return /^Side question ([0-9a-f-]{36})$/.exec(text ?? '')?.[1]
}

/** Whether `next` was asked in a materially different context from `previous`: a later main turn, or after the cache expired. */
function newContext(previous: { turn: number, at: number }, next: { turn: number, at: number }): boolean {
  return next.turn > previous.turn || next.at - previous.at > CONTEXT_GAP_MS
}

// ---- the thread copies ------------------------------------------------------------

class Threads {
  private readonly stores = new Map<string, SnapshotStore<Thread>>()
  private readonly polling = new Set<string>()
  private disposed = false

  constructor(private readonly rpc: ClientConnectionRpc, private readonly execute: ExecuteCommand) {}

  store(sessionId: string): SnapshotStore<Thread> {
    let store = this.stores.get(sessionId)
    if (store === undefined) {
      store = createSnapshotStore<Thread>({ loaded: false, version: -1, exchanges: [] })
      this.stores.set(sessionId, store)
      void this.refresh(sessionId)
    }
    return store
  }

  private async call<T = ThreadValue>(endpoint: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.rpc.call(CHANNEL, endpoint, { args }) as { ok: boolean, value?: unknown, error?: { message: string } }
    if (!result.ok) throw new Error(result.error?.message ?? 'request failed')
    return result.value as T
  }

  private publish(sessionId: string, value: ThreadValue): void {
    const store = this.store(sessionId)
    const current = store.getSnapshot()
    const main = value.main ?? current.main
    const same = current.loaded && current.error === undefined && current.version === value.version
      && current.main?.turn === main?.turn && current.main?.running === main?.running
    if (!same) store.set({ loaded: true, version: value.version, exchanges: value.exchanges, ...main === undefined ? {} : { main } })
    if (value.exchanges.some(exchange => exchange.status === 'answering')) this.poll(sessionId)
  }

  async refresh(sessionId: string): Promise<void> {
    try {
      this.publish(sessionId, await this.call('thread', { sessionId }))
    } catch (error) {
      this.store(sessionId).update((draft) => { draft.loaded = true; draft.error = error instanceof Error ? error.message : String(error) })
    }
  }

  private poll(sessionId: string): void {
    if (this.polling.has(sessionId) || this.disposed) return
    this.polling.add(sessionId)
    setTimeout(() => {
      this.polling.delete(sessionId)
      if (!this.disposed) void this.refresh(sessionId)
    }, POLL_MS)
  }

  actions(sessionId: string, jump: (id: string) => void): Actions {
    return {
      // Through the `/ask` command, so a panel question is logged and marked like a typed one.
      ask: async (question) => {
        const outcome = await this.execute(sessionId, `/ask ${question}`)
        if (!outcome.ok) throw new Error(outcome.error.message)
        if (outcome.value === undefined) throw new Error('/ask is not available in this session')
        if (outcome.value.result.kind === 'error') throw new Error(outcome.value.result.text ?? 'failed')
        await this.refresh(sessionId)
        return exchangeId(outcome.value.result.text)
      },
      cancel: (id) => { void this.call('cancel', { sessionId, id }).then((value) => { this.publish(sessionId, value) }, () => {}) },
      clear: () => { void this.call('clear', { sessionId }).then((value) => { this.publish(sessionId, value) }, () => {}) },
      exportThread: async () => (await this.call<{ path: string }>('export', { sessionId })).path,
      refresh: () => { void this.refresh(sessionId) },
      jump,
    }
  }

  dispose(): void { this.disposed = true }
}

// ---- small pieces -------------------------------------------------------------------

function clock(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function tokens(count: number): string {
  return count >= 10_000 ? `${String(Math.round(count / 1000))}k` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

function where(exchange: Exchange): string {
  if (exchange.turn === 0) return 'before turn 1'
  return exchange.running ? `turn ${String(exchange.turn)}, step ${String(exchange.step)}` : `after turn ${String(exchange.turn)}`
}

/** The tooltip of a question's time: model, prompt-cache use, duration. */
function details(exchange: Exchange): string {
  const parts = [exchange.model ?? '']
  const usage = exchange.usage
  if (usage !== undefined) {
    const read = usage.cacheReadTokens ?? 0
    const fresh = (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    if (read !== 0 || fresh !== 0) parts.push(`${tokens(read)} cached · ${tokens(fresh)} new · ${tokens(usage.outputTokens ?? 0)} out`)
  }
  if (exchange.durationMs !== undefined) parts.push(`${(exchange.durationMs / 1000).toFixed(1)} s`)
  return parts.filter(part => part !== '').join('\n')
}

function CopyIcon({ text, className }: { text: string, className: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => { setCopied(false) }, 1400)
    return () => { clearTimeout(timer) }
  }, [copied])
  return <button type="button" className={className} data-deepsea-ask-copied={copied || undefined}
    title={copied ? 'Copied' : 'Copy'} aria-label={copied ? 'Copied' : 'Copy'} onClick={() => {
      void navigator.clipboard?.writeText(text).then(() => { setCopied(true) }, () => {})
    }}><IconCopyOutlineRegular size={14} /></button>
}

function Tear(): ReactNode {
  return <div className="deepsea-ask__tear" role="separator" />
}

function ExchangeView({ exchange, flash, onJump }: {
  exchange: Exchange, flash: boolean, onJump: () => void
}): ReactNode {
  const answering = exchange.status === 'answering'
  return <div className="deepsea-ask__exchange" data-deepsea-ask-id={exchange.id} data-deepsea-ask-flash={flash || undefined}>
    <div className="deepsea-ask__question">{exchange.question}</div>
    <div className="deepsea-ask__meta">
      <button type="button" className="deepsea-ask__icon" title="Show in chat" aria-label="Show in chat" onClick={onJump}>
        <IconLinkOutlineRegular size={13} />
      </button>
      <span>{where(exchange)}</span>
      <span title={details(exchange)}>{clock(exchange.askedAt)}</span>
      <CopyIcon text={exchange.question} className="deepsea-ask__icon" />
    </div>
    {exchange.tools.length > 0 && <div className="deepsea-ask__tools">
      {exchange.tools.map((tool, index) => <div key={index} className="deepsea-ask__tool" data-state={tool.state}>
        <span className="deepsea-ask__tool-dot" />
        <span className="deepsea-ask__tool-name">{tool.name}</span>
        <span className="deepsea-ask__tool-summary">{tool.summary}</span>
      </div>)}
    </div>}
    <div className="deepsea-ask__answer">
      {exchange.answer !== ''
        ? <MarkdownText text={exchange.answer} streaming={answering} labels={MARKDOWN_LABELS} variant="compact" />
        : answering ? <TextShimmer active>Answering</TextShimmer> : null}
      {exchange.status === 'error' && <div className="deepsea-ask__error">{exchange.error ?? 'Failed'}</div>}
      {exchange.status === 'cancelled' && <div className="deepsea-ask__muted">Cancelled</div>}
      {!answering && exchange.answer !== '' && <CopyIcon text={exchange.answer} className="deepsea-ask__icon deepsea-ask__answer-copy" />}
    </div>
  </div>
}

// ---- the sidebar tab ---------------------------------------------------------------------

interface PanelInjected extends Actions {
  hooks: { thread: SnapshotStore<Thread> }
}
type PanelProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<PanelInjected>

/** A clock that ticks every 30 s, for the closing tear's cache-expiry rule. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { clearInterval(timer) }
  }, [])
  return now
}

function AskPanel(props: PanelProps): ReactNode {
  const { useTabInfo, useSession, useThread, ask, cancel, clear, exportThread, refresh, jump } = props
  const [confirmClear, setConfirmClear] = useState(false)
  const [exported, setExported] = useState<string>()
  useEffect(() => {
    if (exported === undefined) return undefined
    const timer = setTimeout(() => { setExported(undefined) }, 4000)
    return () => { clearTimeout(timer) }
  }, [exported])
  const { tab } = useTabInfo()
  const thread = useThread(value => value)
  const running = useSession(session => session.running) ?? false
  const now = useMinuteClock()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [flash, setFlash] = useState<string>()
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const focus = (tab.navigation.params as { focus?: string } | undefined)?.focus
  const revision = tab.navigation.revision
  const count = thread.exchanges.length
  const last = thread.exchanges.at(-1)
  const lastAnswer = last?.answer.length ?? 0
  const answering = thread.exchanges.filter(exchange => exchange.status === 'answering')

  // A turn starting or ending moves the main conversation: re-read where it is.
  useEffect(() => { refresh() }, [running])

  // Bring the requested question into view and flash it, once per navigation.
  useEffect(() => {
    if (focus === undefined || !thread.loaded) return undefined
    const element = list.current?.querySelector<HTMLElement>(`[data-deepsea-ask-id="${CSS.escape(focus)}"]`)
    if (element === null || element === undefined) return undefined
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(focus)
    const timer = setTimeout(() => { setFlash(undefined) }, FLASH_MS)
    return () => { clearTimeout(timer) }
  }, [focus, revision, thread.loaded, count])

  // Follow the newest answer while it streams, unless the reader scrolled up.
  const pinned = useRef(true)
  useEffect(() => {
    const element = list.current
    if (element !== null && pinned.current && flash === undefined) element.scrollTop = element.scrollHeight
  }, [count, lastAnswer, flash])

  useEffect(() => { if (tab.visible) input.current?.focus() }, [tab.visible])

  const send = async (): Promise<void> => {
    const question = draft.trim()
    if (question === '' || sending) return
    setSending(true)
    setFailure(undefined)
    try {
      await ask(question)
      setDraft('')
      pinned.current = true
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  const point = (exchange: Exchange): { turn: number, at: number } => ({ turn: exchange.turn, at: Date.parse(exchange.askedAt) })
  const closing = last !== undefined && last.status !== 'answering'
    && newContext(point(last), { turn: thread.main?.turn ?? last.turn, at: now })

  return <div className="deepsea-ask__panel">
    <div className="deepsea-ask__list" ref={list} onScroll={(event) => {
      const element = event.currentTarget
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
    }}>
      {thread.error !== undefined && <div className="deepsea-ask__error">{thread.error}</div>}
      {thread.loaded && count === 0 && thread.error === undefined && <div className="deepsea-ask__empty">No side questions</div>}
      {thread.exchanges.map((exchange, index) => {
        const previous = thread.exchanges[index - 1]
        return <div key={exchange.id}>
          {previous !== undefined && newContext(point(previous), point(exchange)) && <Tear />}
          <ExchangeView exchange={exchange} flash={flash === exchange.id} onJump={() => { jump(exchange.id) }} />
        </div>
      })}
      {closing && <Tear />}
    </div>
    <div className="deepsea-ask__composer">
      {failure !== undefined && <div className="deepsea-ask__error">{failure}</div>}
      {exported !== undefined && <div className="deepsea-ask__muted" title={exported}>Exported {exported.split('/').at(-1)}</div>}
      <textarea ref={input} className="deepsea-ask__input" rows={2} placeholder="Ask a side question" value={draft}
        onChange={(event) => { setDraft(event.target.value) }} onKeyDown={onKeyDown} />
      <div className="deepsea-ask__composer-row">
        <button type="button" className="deepsea-ask__send deepsea-ask__outline" disabled={count === 0}
          onClick={() => { setConfirmClear(true) }}>Clear</button>
        <button type="button" className="deepsea-ask__send deepsea-ask__outline" disabled={count === 0} onClick={() => {
          setFailure(undefined)
          exportThread().then(setExported, (error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) })
        }}>Export</button>
        <span className="deepsea-ask__spacer" />
        {answering.length > 0 && <button type="button" className="deepsea-ask__send deepsea-ask__cancel"
          onClick={() => { for (const exchange of answering) cancel(exchange.id) }}>Cancel</button>}
        <button type="button" className="deepsea-ask__send" disabled={draft.trim() === '' || sending} onClick={() => { void send() }}>Ask</button>
      </div>
    </div>
    <Modal open={confirmClear} title="Clear side questions?" closeLabel="Cancel" onClose={() => { setConfirmClear(false) }} width={420}
      footer={<>
        <Button variant="outline" onClick={() => { setConfirmClear(false) }}>Cancel</Button>
        <Button variant="primary" className="deepsea-ask__danger" onClick={() => { setConfirmClear(false); clear() }}>Clear</Button>
      </>}>
      <div className="deepsea-ask__dialog">
        {count === 1 ? 'The question and its answer' : `All ${String(count)} questions and their answers`} will be deleted. This cannot be undone.
      </div>
    </Modal>
  </div>
}

// ---- the gutter markers -------------------------------------------------------------------

interface MarksInjected {
  hooks: { thread: SnapshotStore<Thread> }
  open: (id: string) => void
}
type MarksProps = PropsRuntime<'conversation.chat.turnTail'> & InjectFace<MarksInjected>

function Mark({ exchange, open }: { exchange: Exchange, open: (id: string) => void }): ReactNode {
  return <button type="button" className="deepsea-ask-mark" data-state={exchange.status} data-deepsea-ask-mark={exchange.id}
    title={exchange.question} aria-label={exchange.question} onClick={() => { open(exchange.id) }}>
    <IconQuestionOutlineRegular size={14} />
  </button>
}

/** Marker height (px), for centring the first marker on a line. */
const MARK_SIZE = 20
/** Where the markers go when the turn has no final response to align with: level with the tail's first row. */
const FALLBACK_OFFSET = -24

/**
 * The vertical offset, from the turn tail's top, of the first line of the
 * turn's final response (the nearest `assistant-step` chat row before the
 * tail, within the turn), centred for a marker. Re-measured as the transcript
 * reflows.
 */
function useResponseOffset(element: { current: HTMLElement | null }, active: boolean): number {
  const [offset, setOffset] = useState(FALLBACK_OFFSET)
  useLayoutEffect(() => {
    const own = element.current
    if (!active || own === null) return undefined
    const row = own.closest<HTMLElement>('[data-chat-flow-key]')
    let anchor: HTMLElement | undefined
    for (let sibling = row?.previousElementSibling; sibling instanceof HTMLElement; sibling = sibling.previousElementSibling) {
      const key = sibling.dataset.chatFlowKey ?? ''
      if (key.includes('assistant-step')) { anchor = sibling; break }
      if (key.includes('input-message') || key.includes('turn-tail')) break
    }
    if (anchor === undefined) { setOffset(FALLBACK_OFFSET); return undefined }
    const target = anchor
    let frame = 0
    const measure = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const line = target.querySelector<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, table') ?? target
        const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight)
        const top = line.getBoundingClientRect().top - own.getBoundingClientRect().top
        setOffset(Math.round(top + ((Number.isFinite(lineHeight) ? lineHeight : 24) - MARK_SIZE) / 2))
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(target)
    if (row?.parentElement != null) observer.observe(row.parentElement)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [active])
  return offset
}

function AskMarks({ turn, useThread, open }: MarksProps): ReactNode {
  const exchanges = useThread(value => value.exchanges)
  const mine = useMemo(() => exchanges.filter(exchange => exchange.turn === turn.turn), [exchanges, turn.turn])
  const element = useRef<HTMLDivElement>(null)
  const offset = useResponseOffset(element, mine.length > 0)
  if (mine.length === 0) return null
  const shown = mine.length > MARKS_PER_TURN ? mine.slice(0, MARKS_PER_TURN - 1) : mine
  const rest = mine.slice(shown.length)
  return <div className="deepsea-ask-marks" ref={element}>
    <div className="deepsea-ask-marks__stack" style={{ top: offset }}>
      {shown.map(exchange => <Mark key={exchange.id} exchange={exchange} open={open} />)}
      {rest.length > 0 && <button type="button" className="deepsea-ask-mark deepsea-ask-more"
        data-deepsea-ask-more={rest.map(exchange => exchange.id).join(' ')}
        title={rest.map(exchange => exchange.question).join('\n')} onClick={() => { open(rest[0]!.id) }}>
        +{rest.length}
      </button>}
    </div>
  </div>
}

/**
 * The `/ask` command row. A turn's tail (where the marker normally sits) only
 * exists once the turn ends, so while the session is still running the row
 * itself, at the exact point the question was asked, shows the marker;
 * otherwise it renders an element the stylesheet uses to hide the row.
 */
type RowProps = PropsRuntime<'conversation.chat.commandview'> & InjectFace<MarksInjected>

function AskRow({ node, useSession, useThread, open }: RowProps): ReactNode {
  const running = useSession(session => session.running) ?? false
  const id = exchangeId(node.outcome?.text)
  const exchange = useThread(value => value.exchanges.find(candidate => candidate.id === id))
  if (!running || exchange === undefined || !exchange.running) return <span className="deepsea-ask-row" hidden />
  return <div className="deepsea-ask-marks" data-deepsea-ask-inline=""><Mark exchange={exchange} open={open} /></div>
}

/** Scroll the chat to a question's marker (or the "+n" that holds it) and flash it. */
function jumpToMark(id: string): void {
  const marks = [...document.querySelectorAll<HTMLElement>('[data-deepsea-ask-mark], [data-deepsea-ask-more]')]
  const target = marks.find(mark => mark.dataset.deepseaAskMark === id)
    ?? marks.find(mark => (mark.dataset.deepseaAskMore ?? '').split(' ').includes(id))
  if (target === undefined) return
  target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  target.removeAttribute('data-deepsea-ask-flash')
  // Restart the animation even when the same marker is flashing already.
  void target.offsetWidth
  target.setAttribute('data-deepsea-ask-flash', '')
  setTimeout(() => { target.removeAttribute('data-deepsea-ask-flash') }, FLASH_MS)
}

// ---- the plugin ------------------------------------------------------------------------------

export const name = 'deepsea-ask'
export const inject = ['slots', 'connection', 'remote', 'remote.commands', 'sidebarRight', 'sidebarRightTabs']

export function apply(ctx: Context): void {
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  const remote = (ctx as unknown as { remote: { commands: { execute: (sessionId: string, line: string, attachments: readonly never[]) => ReturnType<ExecuteCommand> } } }).remote
  const threads = new Threads(rpc, (sessionId, line) => remote.commands.execute(sessionId, line, []))
  ctx.effect(() => () => { threads.dispose() }, 'deepsea-ask: threads')

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.deepseaAsk = ''
    style.textContent = styles
    document.head.appendChild(style)
    return () => style.remove()
  }, 'deepsea-ask: styles')

  const open = (focus?: string): void => {
    try {
      ctx.sidebarRight.openTab(KIND, { params: focus === undefined ? {} : { focus } })
    } catch (error) {
      ctx.logger.warn('ask: cannot open the side panel: %s', error instanceof Error ? error.message : String(error))
    }
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB_ID, kind: KIND, title: () => 'Side questions' }), 'deepsea-ask: tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID,
    inject: (sessionId: SessionId): PanelInjected => ({ hooks: { thread: threads.store(sessionId) }, ...threads.actions(sessionId, jumpToMark) }),
  }, AskPanel))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'deepsea-ask',
    inject: (sessionId: SessionId): MarksInjected => ({ hooks: { thread: threads.store(sessionId) }, open }),
  }, AskMarks))
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview', key: 'ask',
    inject: (sessionId: SessionId): MarksInjected => ({ hooks: { thread: threads.store(sessionId) }, open }),
  }, AskRow))

  // `/ask <question>` from the composer: the host already started the answer.
  ctx.on('command/executed', (sessionId, commandName, result) => {
    if (commandName !== 'ask' || result.kind !== 'success') return
    void threads.refresh(sessionId)
    open(exchangeId(result.text))
  })

  // Bare `/ask` + Enter opens the panel without a host round trip.
  ctx.inject(['commandUi'], (scope) => {
    scope.effect(() => scope.commandUi.decorate({
      name: 'ask',
      available: () => true,
      ui: { kind: 'action', run: () => { open() } },
    }), 'deepsea-ask: bare /ask opens the panel')
  })
}
