/**
 * @deepsea/session-drafts, browser half.
 *
 *   - A Drafts View beside Chat and Trajectory (`conversation.view`, id
 *     `deepsea-drafts`): the session's drafts newest first, each an editable
 *     card like the composer (the harness's `conversation.draft.editor`
 *     Factory: text, reference chips, quotes; no command or reference menus),
 *     its attachments, when and at which turn it was made, a red Delete (after
 *     a confirmation) and a green Resume. Edits are saved shortly after typing
 *     stops, when the editor loses focus, and before Resume.
 *   - Save as draft (the composer's button, or ⌘D / Ctrl+D while the composer
 *     has the keyboard): the composer's document and attachments become a new
 *     draft on the host; once the host has stored it, the composer is cleared
 *     and the Drafts View opens on it.
 *   - Resume: the composer takes the draft's document and attachments (a
 *     non-empty composer is first saved as a draft of its own) and Chat opens;
 *     the draft stays.
 *
 * Drafts live on the host (index.js); this half reads and writes them through
 * `api/deepsea-session-drafts/*`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { InjectFace, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { DraftSnapshot, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ShortcutCatalogEntry, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  IconCheckOutlineRegular, IconCopyOutlineRegular, IconDownloadOutlineRegular, IconNewChatOutlineMedium,
  IconPaperclipOutlineRegular, IconPinFillMedium, IconPinOutlineRegular, IconTrashOutlineRegular, Tooltip, useClipboardCopy,
} from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './style.css'

/** The Drafts View's `conversation.view` id. */
const VIEW_ID = 'deepsea-drafts'
/** The Chat View's id (ui-chat). */
const CHAT_VIEW_ID = 'chat'
/** index.js PREFIX, document-relative. */
const API = 'api/deepsea-session-drafts'
const SHORTCUT_ID = 'deepsea.drafts.save' as ShortcutCommandId
/** Host poll while the Drafts View is open, for drafts written by another window. */
const POLL_MS = 10_000
/** Longest wait for a sent draft's attachments to upload. */
const UPLOAD_WAIT_MS = 120_000
/** Quiet time after the last keystroke before an edited draft is saved. */
const SAVE_DELAY_MS = 800

interface DraftAttachment { readonly blob: string, readonly name: string, readonly type: string, readonly size: number }
interface DraftPosition { readonly turn: number, readonly running: boolean }
interface Draft {
  readonly id: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly position: DraftPosition | null
  readonly document: DraftSnapshot
  readonly attachments: readonly DraftAttachment[]
}
interface DraftsState {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly drafts: readonly Draft[]
  readonly error?: string
}

const EMPTY_STATE: DraftsState = { phase: 'loading', drafts: [] }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}/${path}`, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${String(response.status)}`
    throw new Error(message)
  }
  return body as T
}

const postJson = <T,>(path: string, body: object): Promise<T> =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The host's drafts of each session seen in this page, as observable sources. */
class DraftsClient {
  private readonly sources = new Map<SessionId, SnapshotStore<DraftsState>>()

  source(sessionId: SessionId): SnapshotStore<DraftsState> {
    let source = this.sources.get(sessionId)
    if (source === undefined) {
      source = createSnapshotStore<DraftsState>(EMPTY_STATE)
      this.sources.set(sessionId, source)
    }
    return source
  }

  async refresh(sessionId: SessionId): Promise<void> {
    const source = this.source(sessionId)
    try {
      const { drafts } = await call<{ drafts: Draft[] }>(`list?session=${encodeURIComponent(sessionId)}`)
      source.set({ phase: 'ready', drafts })
    } catch (error) {
      source.set({ phase: 'error', drafts: source.getSnapshot().drafts, error: messageOf(error) })
    }
  }

  private upsert(sessionId: SessionId, draft: Draft): void {
    const source = this.source(sessionId)
    const { drafts } = source.getSnapshot()
    const next = drafts.some(row => row.id === draft.id)
      ? drafts.map(row => row.id === draft.id ? draft : row)
      : [draft, ...drafts]
    source.set({ phase: 'ready', drafts: next })
  }

  async upload(sessionId: SessionId, file: File): Promise<DraftAttachment> {
    const { blob, size } = await call<{ blob: string, size: number }>(`blob?session=${encodeURIComponent(sessionId)}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
    })
    return { blob, size, name: file.name, type: file.type }
  }

  blobUrl(sessionId: SessionId, attachment: DraftAttachment): string {
    const query = new URLSearchParams({ session: sessionId, id: attachment.blob, type: attachment.type })
    return `${API}/file?${query.toString()}`
  }

  async file(sessionId: SessionId, attachment: DraftAttachment): Promise<File> {
    const response = await fetch(this.blobUrl(sessionId, attachment), { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`${attachment.name}: HTTP ${String(response.status)}`)
    return new File([await response.blob()], attachment.name, { type: attachment.type })
  }

  async create(sessionId: SessionId, document: DraftSnapshot, attachments: readonly DraftAttachment[]): Promise<Draft> {
    const { draft } = await postJson<{ draft: Draft }>('create', { sessionId, document, attachments })
    this.upsert(sessionId, draft)
    return draft
  }

  async save(sessionId: SessionId, id: string, document: DraftSnapshot, attachments: readonly DraftAttachment[]): Promise<Draft> {
    const { draft } = await postJson<{ draft: Draft }>('update', { sessionId, id, document, attachments })
    this.upsert(sessionId, draft)
    return draft
  }

  async remove(sessionId: SessionId, id: string): Promise<void> {
    await postJson('delete', { sessionId, id })
    const source = this.source(sessionId)
    source.set({ ...source.getSnapshot(), drafts: source.getSnapshot().drafts.filter(row => row.id !== id) })
  }
}

// ---- presentation ------------------------------------------------------------------------------

/** Compact age: "just now", "5m ago", "3h ago", "2d ago", then the date. */
function ageText(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${String(days)}d ago`
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const fullTime = (iso: string): string => new Date(iso).toLocaleString()

function sameAttachments(a: readonly DraftAttachment[], b: readonly DraftAttachment[]): boolean {
  return a.length === b.length && a.every((attachment, index) => attachment.blob === b[index]?.blob)
}

/** Send: an up arrow in the outline weight of the product icons (the set has none). */
function SendIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 13V3.5M4 7.5l4-4 4 4" />
    </svg>
  )
}

interface DraftsViewInjected {
  hooks: { drafts: ObservableSnapshot<DraftsState> }
  refresh: () => void
  save: (id: string, document: DraftSnapshot, attachments: readonly DraftAttachment[]) => Promise<Draft>
  remove: (id: string) => Promise<void>
  resume: (draft: Draft) => Promise<void>
  /** Send the draft as the next message (it stays a draft). */
  send: (draft: Draft) => Promise<void>
  /** Save the stored draft as a file. */
  download: (draft: Draft) => void
  blobUrl: (attachment: DraftAttachment) => string
  /** Create an empty draft. */
  create: () => Promise<Draft>
  /** Store one file's bytes for a draft's attachment list. */
  upload: (file: File) => Promise<DraftAttachment>
}

type DraftsViewProps = PropsRuntime<'conversation.view'> & PropsRenderFactories & InjectFace<DraftsViewInjected>

interface DraftCardProps {
  readonly draft: Draft
  readonly focused: boolean
  /** Put the keyboard in this draft's editor when it mounts (a draft just made with New draft). */
  readonly editOnMount: boolean
  readonly save: DraftsViewInjected['save']
  readonly remove: DraftsViewInjected['remove']
  readonly resume: DraftsViewInjected['resume']
  readonly send: DraftsViewInjected['send']
  readonly download: DraftsViewInjected['download']
  readonly blobUrl: DraftsViewInjected['blobUrl']
  readonly upload: DraftsViewInjected['upload']
  /** Clock for the ages shown under the card; advances each minute. */
  readonly now: number
  readonly renderFactorySlot: PropsRenderFactories['renderFactorySlot']
}

type SaveStatus = 'saved' | 'pending' | 'saving' | 'failed'

function DraftCard({ draft, focused, editOnMount, save, remove, resume, send, download, blobUrl, upload, now, renderFactorySlot }: DraftCardProps): ReactNode {
  // The document and attachments as edited here; saved to the host after a pause.
  const edited = useRef({ document: draft.document, attachments: draft.attachments })
  const [attachments, setAttachments] = useState(draft.attachments)
  const [status, setStatus] = useState<SaveStatus>('saved')
  const [error, setError] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [busy, setBusy] = useState(false)
  // The host revision the editor shows; a newer one written elsewhere reloads the editor while nothing is unsaved here.
  const [loaded, setLoaded] = useState(draft.revision)
  const known = useRef(new Set([draft.revision]))
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saving = useRef<Promise<boolean> | undefined>(undefined)
  const root = useRef<HTMLDivElement>(null)

  if (!known.current.has(draft.revision) && status === 'saved') {
    known.current.add(draft.revision)
    edited.current = { document: draft.document, attachments: draft.attachments }
    setAttachments(draft.attachments)
    setLoaded(draft.revision)
  }

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current)
    timer.current = undefined
    await saving.current
    const current = edited.current
    if (JSON.stringify(current.document) === JSON.stringify(draft.document) && sameAttachments(current.attachments, draft.attachments)) {
      setStatus('saved')
      return true
    }
    setStatus('saving')
    const run = save(draft.id, current.document, current.attachments).then((saved) => {
      known.current.add(saved.revision)
      setError(undefined)
      setStatus(edited.current === current ? 'saved' : 'pending')
      return true
    }, (failure: unknown) => {
      setError(messageOf(failure))
      setStatus('failed')
      return false
    })
    saving.current = run
    return await run
  }, [draft, save])

  const schedule = useCallback(() => {
    setStatus('pending')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush() }, SAVE_DELAY_MS)
  }, [flush])

  // Unsaved edits are saved when the card goes away (View switch, deletion elsewhere).
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => {
    if (timer.current !== undefined) void flushRef.current()
  }, [])

  useEffect(() => {
    if (focused) root.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focused])

  // The card can mount (from the drafts store) just before it is marked as the one to edit, so this follows the flag.
  const tookKeyboard = useRef(false)
  useEffect(() => {
    if (!editOnMount || tookKeyboard.current) return
    tookKeyboard.current = true
    // The editor Factory mounts after this card, so wait (a few frames at most) for its editable surface.
    let frames = 0
    let handle = 0
    const attempt = (): void => {
      const input = root.current?.querySelector<HTMLElement>('[data-draft-document-input][contenteditable="true"]')
      if (input !== null && input !== undefined) {
        input.focus({ preventScroll: true })
        return
      }
      if (++frames < 30) handle = requestAnimationFrame(attempt)
    }
    attempt()
    return () => { cancelAnimationFrame(handle) }
  }, [editOnMount])

  const onChange = useCallback((document: DraftSnapshot) => {
    edited.current = { ...edited.current, document }
    schedule()
  }, [schedule])

  const removeAttachment = (blob: string): void => {
    const next = edited.current.attachments.filter(attachment => attachment.blob !== blob)
    edited.current = { ...edited.current, attachments: next }
    setAttachments(next)
    schedule()
  }

  /** Save pending edits, then hand the draft as edited here to `action`. */
  const withSaved = async (action: (current: Draft) => Promise<void> | void): Promise<void> => {
    setBusy(true)
    try {
      if (await flush()) await action({ ...draft, document: edited.current.document, attachments: edited.current.attachments })
    } finally {
      setBusy(false)
    }
  }
  const onResume = (): Promise<void> => withSaved(resume)
  const onSend = (): Promise<void> => withSaved(send)
  const onDownload = (): Promise<void> => withSaved(download)

  const onDelete = async (): Promise<void> => {
    clearTimeout(timer.current)
    timer.current = undefined
    setBusy(true)
    try {
      await remove(draft.id)
    } catch (failure) {
      setError(messageOf(failure))
      setStatus('failed')
      setBusy(false)
      setConfirming(false)
    }
  }

  const picker = useRef<HTMLInputElement>(null)
  const onPickFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    setBusy(true)
    try {
      const added = await Promise.all(files.map(file => upload(file)))
      const next = [...edited.current.attachments, ...added.filter(a => !edited.current.attachments.some(b => b.blob === a.blob))]
      edited.current = { ...edited.current, attachments: next }
      setAttachments(next)
      schedule()
    } catch (failure) {
      setError(messageOf(failure))
      setStatus('failed')
    } finally {
      setBusy(false)
    }
  }

  const { copied, onCopy } = useClipboardCopy(edited.current.document.text)
  const wasEdited = draft.updatedAt !== draft.createdAt

  return (
    <div
      ref={root}
      className="deepsea-drafts-item"
      data-deepsea-draft={draft.id}
      data-active={hovered || editing || confirming || busy || status === 'failed' ? '' : undefined}
      onPointerEnter={() => { setHovered(true) }}
      onPointerLeave={() => { setHovered(false) }}
    >
      <div
        className="deepsea-drafts-card"
        data-focused={focused ? '' : undefined}
        data-editing={editing ? '' : undefined}
        onFocus={() => { setEditing(true) }}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setEditing(false) }}
        // Pasted or dropped files become attachments; the editor itself only takes text, and drops a paste of files.
        onPasteCapture={(event) => {
          const files = [...event.clipboardData.files]
          if (files.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          void onPickFiles(files)
        }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
        onDropCapture={(event) => {
          const files = [...event.dataTransfer.files]
          if (files.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          void onPickFiles(files)
        }}
      >
        {attachments.length > 0 && (
          <div className="deepsea-drafts-attachments">
            {attachments.map(attachment => (
              <div key={attachment.blob} className="deepsea-drafts-attachment" title={attachment.name}>
                {attachment.type.startsWith('image/')
                  ? <img src={blobUrl(attachment)} alt={attachment.name} />
                  : <span className="deepsea-drafts-file">{attachment.name}</span>}
                <button type="button" className="deepsea-drafts-attachment-remove" aria-label={`Remove ${attachment.name}`} onClick={() => { removeAttachment(attachment.blob) }}>×</button>
              </div>
            ))}
          </div>
        )}
        {renderFactorySlot('conversation.draft.editor', {
          value: edited.current.document,
          revision: `${draft.id}:${String(loaded)}`,
          onChange,
          onBlur: () => { void flush() },
          placeholder: 'Empty draft',
          ariaLabel: 'Draft',
        })}
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])]
          event.currentTarget.value = ''
          void onPickFiles(files)
        }}
      />
      <div className="deepsea-drafts-below" title={error}>
        <Tooltip label="Send" side="bottom" delayMs={500} portal>
          <button type="button" className="deepsea-drafts-action" aria-label="Send" disabled={busy} onClick={() => { void onSend() }}>
            <SendIcon />
          </button>
        </Tooltip>
        <Tooltip label="Resume in Chat" side="bottom" delayMs={500} portal>
          <button type="button" className="deepsea-drafts-action" aria-label="Resume" disabled={busy} onClick={() => { void onResume() }}>
            <IconPinOutlineRegular />
          </button>
        </Tooltip>
        <Tooltip label={copied ? 'Copied' : 'Copy'} side="bottom" delayMs={500} portal>
          <button type="button" className="deepsea-drafts-action" aria-label={copied ? 'Copied' : 'Copy'} onClick={onCopy}>
            {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
          </button>
        </Tooltip>
        <Tooltip label="Attach files" side="bottom" delayMs={500} portal>
          <button type="button" className="deepsea-drafts-action" aria-label="Attach files" disabled={busy} onClick={() => { picker.current?.click() }}>
            <IconPaperclipOutlineRegular />
          </button>
        </Tooltip>
        <Tooltip label="Download" side="bottom" delayMs={500} portal>
          <button type="button" className="deepsea-drafts-action" aria-label="Download" disabled={busy} onClick={() => { void onDownload() }}>
            <IconDownloadOutlineRegular />
          </button>
        </Tooltip>
        <span className="deepsea-drafts-spring" />
        {status === 'saving' && <span className="deepsea-drafts-time">Saving…</span>}
        {status === 'failed' && <span className="deepsea-drafts-time" data-failed="">{error ?? 'Not saved'}</span>}
        {wasEdited && <span className="deepsea-drafts-time" title={fullTime(draft.updatedAt)}>edited {ageText(draft.updatedAt, now)}</span>}
        <span className="deepsea-drafts-time" title={fullTime(draft.createdAt)}>created {ageText(draft.createdAt, now)}</span>
        {confirming
          ? (
              <span className="deepsea-drafts-confirm">
                <span>Delete this draft?</span>
                <button type="button" className="deepsea-drafts-text-button" disabled={busy} onClick={() => { setConfirming(false) }}>Cancel</button>
                <button type="button" className="deepsea-drafts-text-button" data-danger="" disabled={busy} onClick={() => { void onDelete() }}>Delete</button>
              </span>
            )
          : (
              <Tooltip label="Delete draft" side="bottom" delayMs={500} portal>
                <button type="button" className="deepsea-drafts-action" aria-label="Delete draft" disabled={busy} onClick={() => { setConfirming(true) }}>
                  <IconTrashOutlineRegular />
                </button>
              </Tooltip>
            )}
      </div>
    </div>
  )
}

function DraftsView({ useDrafts, refresh, save, remove, resume, send, download, blobUrl, create, upload, viewRequest, completeViewRequest, renderFactorySlot }: DraftsViewProps): ReactNode {
  const state = useDrafts(value => value)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [])
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => { clearInterval(timer) }
  }, [refresh])
  const focus = viewRequest?.view === VIEW_ID ? viewRequest.focus : ''
  useEffect(() => {
    if (focus !== '') completeViewRequest()
  }, [focus, completeViewRequest])
  const [focused, setFocused] = useState('')
  if (focus !== '' && focus !== focused) setFocused(focus)
  const [created, setCreated] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | undefined>(undefined)
  // Oldest first: a new draft lands just above New draft.
  const drafts = [...state.drafts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  // Opened by hand (no draft asked for), the View starts at the bottom: the newest draft and New draft.
  const view = useRef<HTMLDivElement>(null)
  const placed = useRef(focus !== '')
  useEffect(() => {
    if (placed.current || state.phase !== 'ready') return
    placed.current = true
    const list = view.current?.firstElementChild
    const scroller = view.current?.closest<HTMLElement>('[data-conversation-scroll]')
    if (list === null || list === undefined || scroller === null || scroller === undefined) return
    // The cards' editors mount after the list, so keep to the bottom while it grows, until the person scrolls.
    const toBottom = (): void => { scroller.scrollTop = scroller.scrollHeight }
    const observer = new ResizeObserver(toBottom)
    const stop = (): void => {
      observer.disconnect()
      clearTimeout(timer)
      for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) scroller.removeEventListener(type, stop)
    }
    const timer = setTimeout(stop, 1500)
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) scroller.addEventListener(type, stop, { passive: true })
    observer.observe(list)
    toBottom()
    return stop
  }, [state.phase])

  const onNew = async (): Promise<void> => {
    setCreating(true)
    try {
      const draft = await create()
      setCreateError(undefined)
      setCreated(draft.id)
      setFocused(draft.id)
    } catch (error) {
      setCreateError(messageOf(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div ref={view} className="deepsea-drafts" data-deepsea-drafts-view>
      <div className="deepsea-drafts-list">
        {state.phase === 'error' && <div className="deepsea-drafts-empty" data-failed="">{state.error}</div>}
        {state.phase === 'ready' && drafts.length === 0 && <div className="deepsea-drafts-empty">No drafts</div>}
        {drafts.map(draft => (
          <DraftCard
            key={draft.id}
            draft={draft}
            focused={draft.id === focused}
            editOnMount={draft.id === created}
            save={save}
            remove={remove}
            resume={resume}
            send={send}
            download={download}
            blobUrl={blobUrl}
            upload={upload}
            now={now}
            renderFactorySlot={renderFactorySlot}
          />
        ))}
        <button type="button" className="deepsea-drafts-new" disabled={creating} onClick={() => { void onNew() }}>
          <IconNewChatOutlineMedium size={14} />
          <span>New draft</span>
        </button>
        {createError !== undefined && <div className="deepsea-drafts-empty" data-failed="">{createError}</div>}
      </div>
    </div>
  )
}

interface SaveButtonInjected {
  hooks: { shortcuts: ObservableSnapshot<readonly ShortcutCatalogEntry[]> }
  saveDraft: () => void
  bindComposer: (card: Element) => () => void
}

type SaveButtonProps = PropsRuntime<'conversation.input.left'> & InjectFace<SaveButtonInjected>

function SaveDraftButton({ useShortcuts, saveDraft, bindComposer }: SaveButtonProps): ReactNode {
  const keys = useShortcuts(rows => rows.find(row => row.id === SHORTCUT_ID)?.keys)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const card = button.current?.closest('[data-composer-card]')
    return card === null || card === undefined ? undefined : bindComposer(card)
  }, [bindComposer])
  return (
    <Tooltip label="Save as draft" shortcutKeys={keys} side="top" delayMs={500} portal>
      <button ref={button} type="button" className="deepsea-drafts-save" aria-label="Save as draft" onMouseDown={(event) => { event.preventDefault() }} onClick={saveDraft}>
        <IconPinFillMedium size={14} />
      </button>
    </Tooltip>
  )
}

// ---- plugin --------------------------------------------------------------------------------------

export const inject = ['slots', 'sessions', 'conversation', 'uiConversation', 'shortcuts']

export function apply(ctx: Context): void {
  const client = new DraftsClient()
  /** Composer cards mounted in this page, by element, with the session each composes for. */
  const composers = new Map<Element, SessionId>()
  const saving = new Set<SessionId>()

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.deepseaSessionDrafts = ''
    style.textContent = styles
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'session-drafts: style')

  const inputOf = (sessionId: SessionId): SessionInput | undefined => {
    const binding = ctx.sessions.binding(sessionId)
    return binding === undefined ? undefined : ctx.conversation.input.for(binding.ctx)
  }

  /**
   * Save the composer's document and attachments as a new draft; once the host has it, clear what was saved.
   * @returns the draft, or undefined when nothing was saved.
   */
  const saveComposer = async (sessionId: SessionId, open: boolean): Promise<Draft | undefined> => {
    const input = inputOf(sessionId)
    if (input === undefined || saving.has(sessionId)) return undefined
    const state = input.state.getSnapshot()
    if (state.phase !== 'plain' && state.phase !== 'claimed') {
      input.notify('error', 'The prompt is being sent; it cannot be saved as a draft now.')
      return undefined
    }
    const document = input.readDraft()
    const ids = [...state.attachmentIds]
    if (document.text.trim() === '' && ids.length === 0) {
      if (open) ctx.uiConversation.openView(sessionId, VIEW_ID)
      return undefined
    }
    saving.add(sessionId)
    try {
      const files = ctx.conversation.resolveDraftAttachments(ids).map(attachment => attachment.file)
      const attachments = await Promise.all(files.map(file => client.upload(sessionId, file)))
      const draft = await client.create(sessionId, document, attachments)
      const now = input.state.getSnapshot()
      if (now.draftRev === state.draftRev && now.attachmentIds.join() === ids.join()) {
        input.setDraft('')
        for (const id of ids) {
          input.removeAttachment(id)
          ctx.conversation.releaseDraftAttachment(id)
        }
      } else {
        input.notify('info', 'Saved as a draft; the composer changed meanwhile, so it was kept.')
      }
      if (open) ctx.uiConversation.openView(sessionId, VIEW_ID, draft.id)
      return draft
    } catch (error) {
      input.notify('error', `Not saved as a draft: ${messageOf(error)}`)
      return undefined
    } finally {
      saving.delete(sessionId)
    }
  }

  /**
   * Fill the composer with a draft (saving a non-empty composer as a draft first) and open Chat.
   * @returns whether the composer now holds the draft.
   */
  const resume = async (sessionId: SessionId, draft: Draft): Promise<boolean> => {
    const input = inputOf(sessionId)
    const binding = ctx.sessions.binding(sessionId)
    if (input === undefined || binding === undefined) return false
    const state = input.state.getSnapshot()
    if (state.phase !== 'plain' && state.phase !== 'claimed') {
      input.notify('error', 'The prompt is being sent; resume the draft once it is.')
      return false
    }
    if (input.readDraft().text.trim() !== '' || state.attachmentIds.length > 0) {
      if (await saveComposer(sessionId, false) === undefined) return false
    }
    let files: File[]
    try {
      files = await Promise.all(draft.attachments.map(attachment => client.file(sessionId, attachment)))
    } catch (error) {
      input.notify('error', `Cannot resume the draft: ${messageOf(error)}`)
      return false
    }
    input.setDraft(draft.document)
    if (files.length > 0) {
      const ordinary = binding.session.getSnapshot().subagent === null
      input.addAttachments(ctx.conversation.createDrafts(sessionId, files, ordinary).map(attachment => attachment.id))
    }
    ctx.uiConversation.openView(sessionId, CHAT_VIEW_ID)
    input.focus()
    return true
  }

  /**
   * Wait until the uploads of these draft attachments finish (a message is sent only with ready uploads).
   * @returns undefined once all are ready; otherwise why not.
   */
  const uploadsSettled = (ids: readonly string[]): Promise<string | undefined> => new Promise((resolve) => {
    const uploads = ctx.conversation.fileUploads
    let unsubscribe = (): void => {}
    let settled = false
    const finish = (result: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(result)
    }
    const timer = setTimeout(() => { finish('the attachments did not finish uploading') }, UPLOAD_WAIT_MS)
    const check = (): void => {
      const states = ids.flatMap(id => uploads.getSnapshot()[id] ?? [])
      const failed = states.find(upload => upload.status === 'error')
      if (failed !== undefined && failed.status === 'error') finish(failed.message)
      else if (states.every(upload => upload.status === 'ready')) finish(undefined)
    }
    unsubscribe = uploads.subscribe(check)
    check()
  })

  /**
   * Wait for the submission just started to settle.
   * @returns true when the Host accepted it: the composer leaves its busy phases empty, as it does only after a
   * committed send (a refused or failed send keeps the draft in the composer).
   */
  const accepted = (input: SessionInput): Promise<boolean> => new Promise((resolve) => {
    const busy = (phase: string): boolean => phase === 'adjudicating' || phase === 'submitting' || phase === 'sending'
    let seenBusy = busy(input.state.getSnapshot().phase)
    let unsubscribe = (): void => {}
    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(result)
    }
    const timer = setTimeout(() => { finish(false) }, UPLOAD_WAIT_MS)
    const check = (): void => {
      const state = input.state.getSnapshot()
      if (busy(state.phase)) { seenBusy = true; return }
      if (seenBusy) finish(state.draft.trim() === '' && state.attachmentIds.length === 0)
    }
    unsubscribe = input.state.subscribe(check)
    check()
  })

  /**
   * Put the draft in the composer, wait for its attachments to upload, send it as the next message, and delete the
   * draft once the Host has accepted the message.
   */
  const send = async (sessionId: SessionId, draft: Draft): Promise<void> => {
    if (!await resume(sessionId, draft)) return
    const input = inputOf(sessionId)
    if (input === undefined) return
    const failure = await uploadsSettled(input.state.getSnapshot().attachmentIds)
    if (failure !== undefined) {
      input.notify('error', `Not sent: ${failure}.`)
      return
    }
    const settled = accepted(input)
    input.submit()
    if (!await settled) return
    try {
      await client.remove(sessionId, draft.id)
    } catch (error) {
      input.notify('error', `Sent, but the draft was not deleted: ${messageOf(error)}`)
    }
  }

  /** The session's title, for file names. */
  const titleOf = (sessionId: SessionId): string => {
    const title: unknown = ctx.sessions.binding(sessionId)?.session.projections.faceOf('title').getSnapshot()
    if (typeof title === 'string' && title.trim() !== '') return title
    if (typeof title === 'object' && title !== null && 'title' in title && typeof title.title === 'string') return title.title
    return 'session'
  }

  /** Save a stored draft through the host's download route, as `<created>.<session title>.draft.md|zip`. */
  const download = (sessionId: SessionId, draft: Draft): void => {
    const created = new Date(draft.createdAt)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const stamp = `${String(created.getFullYear())}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}-${pad(created.getHours())}${pad(created.getMinutes())}`
    const name = `${stamp}.${titleOf(sessionId)}`
    const query = new URLSearchParams({ session: sessionId, id: draft.id, name })
    const anchor = document.createElement('a')
    anchor.href = `${API}/download?${query.toString()}`
    anchor.download = `${name}.draft.${draft.attachments.length === 0 ? 'md' : 'zip'}`
    anchor.click()
  }

  ctx.effect(() => ctx.shortcuts.register({
    id: SHORTCUT_ID,
    label: () => 'Save the prompt as a draft',
    aliases: ['draft', 'stash prompt'],
    // The Web shell accepts only chords browsers leave alone; plain ⌘D / Ctrl+D is handled on the composer card itself.
    defaults: {
      'desktop:macos': { code: 'KeyD', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyD', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyD', modifiers: ['primary'] },
      'web:macos': { code: 'KeyD', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyD', modifiers: ['primary', 'shift'] },
    },
    regions: ['editable', 'page'],
    modals: [],
    resolve: ({ target }) => {
      const card = target?.closest('[data-composer-card]')
      const sessionId = card === null || card === undefined ? undefined : composers.get(card)
      if (sessionId === undefined) return { status: 'pass' }
      return { status: 'handled', run: () => { void saveComposer(sessionId, true) } }
    },
  }), 'session-drafts: shortcut')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: VIEW_ID,
    order: 20,
    label: () => 'Drafts',
    inject: (sessionId: SessionId): DraftsViewInjected => ({
      hooks: { drafts: client.source(sessionId) },
      refresh: () => { void client.refresh(sessionId) },
      save: (id, document, attachments) => client.save(sessionId, id, document, attachments),
      remove: id => client.remove(sessionId, id),
      resume: async (draft) => { await resume(sessionId, draft) },
      send: draft => send(sessionId, draft),
      download: (draft) => { download(sessionId, draft) },
      blobUrl: attachment => client.blobUrl(sessionId, attachment),
      create: () => client.create(sessionId, { text: '', references: [] }, []),
      upload: file => client.upload(sessionId, file),
    }),
  }, DraftsView))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'deepsea-session-drafts',
    order: 90,
    inject: (sessionId: SessionId): SaveButtonInjected => ({
      hooks: { shortcuts: ctx.shortcuts.catalog },
      saveDraft: () => { void saveComposer(sessionId, true) },
      bindComposer: (card) => {
        composers.set(card, sessionId)
        const mac = /Mac|iPhone|iPad/u.test(navigator.platform)
        const onKeyDown = (event: Event): void => {
          if (!(event instanceof KeyboardEvent) || event.code !== 'KeyD' || event.isComposing || event.repeat) return
          if (event.altKey || event.shiftKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return
          event.preventDefault()
          event.stopPropagation()
          void saveComposer(sessionId, true)
        }
        card.addEventListener('keydown', onKeyDown, true)
        return () => {
          card.removeEventListener('keydown', onKeyDown, true)
          if (composers.get(card) === sessionId) composers.delete(card)
        }
      },
    }),
  }, SaveDraftButton))
}
