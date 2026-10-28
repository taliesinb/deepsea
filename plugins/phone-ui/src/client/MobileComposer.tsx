// The tongue and the full-screen entry. Inline styles (build.mjs has no
// CSS-module loader); colours are the client's own design tokens, so the
// pieces match the composer they replace.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface MobileComposerInjected {
  /** Attribute stamped on <html> while the mobile composer is active. */
  htmlFlag: string
  /** Stop the running turn of a session (the composer's own stop action). */
  cancel: (sessionId: SessionId) => Promise<void>
}

export type MobileComposerProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<MobileComposerInjected>

const DEFAULT_MAX_WIDTH = 640
/** `<html data-deepsea-view="mobile">`: the macOS app's View ▸ Mobile. */
const VIEW_ATTR = 'data-deepsea-view'

/** The host half publishes `--deepsea-phone-ui-max-width` on :root; else the plugin default. */
function maxWidthPx(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--deepsea-phone-ui-max-width').trim()
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_WIDTH
}

/** True while the phone rules apply: the app's view attribute, or a narrow viewport. */
function useMobileMode(): boolean {
  const compute = () =>
    document.documentElement.getAttribute(VIEW_ATTR) === 'mobile'
    || window.matchMedia(`(max-width: ${maxWidthPx()}px)`).matches
  const [on, setOn] = useState(compute)
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${maxWidthPx()}px)`)
    const update = () => { setOn(compute()) }
    query.addEventListener('change', update)
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [VIEW_ATTR] })
    update()
    return () => {
      query.removeEventListener('change', update)
      observer.disconnect()
    }
  }, [])
  return on
}

interface ViewportBox { top: number; height: number; keyboard: boolean }

/**
 * The visual viewport: on iOS the on-screen keyboard covers the bottom of the
 * layout viewport instead of shrinking it, so a `position:fixed; inset:0`
 * sheet loses its bottom bar under the keys. `window.visualViewport` does
 * shrink (and scrolls); the sheet follows it. `keyboard` is true while the
 * visual viewport is clearly shorter than the layout viewport.
 */
function useVisualViewport(active: boolean): ViewportBox {
  const read = (): ViewportBox => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return { top: 0, height: window.innerHeight, keyboard: false }
    return { top: vv.offsetTop, height: vv.height, keyboard: window.innerHeight - vv.height > 120 }
  }
  const [box, setBox] = useState(read)
  useEffect(() => {
    if (!active) return
    const vv = window.visualViewport
    const update = () => { setBox(read()) }
    update()
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [active])
  return box
}

// ---- glyphs (the composer's own) -------------------------------------------

function ArrowUp({ size = 18 }: { size?: number }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
    </svg>
  )
}

function StopSquare({ size = 18 }: { size?: number }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
    </svg>
  )
}

function Chevron({ size = 18, direction }: { size?: number; direction: 'up' | 'down' }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden style={direction === 'up' ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="M3.3 5.8a1 1 0 0 1 1.4 0L8 9.1l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z" fill="currentColor" />
    </svg>
  )
}

function Cross({ size = 18 }: { size?: number }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <path d="M3.7 3.7a1 1 0 0 1 1.4 0L8 6.6l2.9-2.9a1 1 0 1 1 1.4 1.4L9.4 8l2.9 2.9a1 1 0 0 1-1.4 1.4L8 9.4l-2.9 2.9a1 1 0 0 1-1.4-1.4L6.6 8 3.7 5.1a1 1 0 0 1 0-1.4z" fill="currentColor" />
    </svg>
  )
}

// ---- styles ----------------------------------------------------------------

const GREY = 'var(--dsw-specific-input-major)'
const INK = 'var(--dsw-alias-label-primary)'
const BLUE = 'var(--dsw-alias-button-info-fill)'
const RED = 'var(--dsw-alias-state-error-primary, #e5484d)'
const FRAME = 'var(--dsw-alias-border-l2)'
/** Corner radius shared by the sheet's three buttons. */
const BUTTON_RADIUS = 8

const tongueStyle: CSSProperties = {
  position: 'fixed',
  bottom: 0,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 40,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 10px',
  paddingBottom: 'calc(4px + env(safe-area-inset-bottom, 0px))',
  background: GREY,
  borderRadius: '14px 14px 0 0',
  boxShadow: '0 -1px 0 var(--dsw-alias-border-l2)',
}

const iconButton: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 40,
  height: 36,
  padding: 0,
  border: 'none',
  borderRadius: 10,
  background: 'transparent',
  color: INK,
  cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
}

const sheetStyle: CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  // top / height follow the visual viewport (see useVisualViewport).
  zIndex: 60,
  display: 'flex',
  flexDirection: 'column',
  background: GREY,
  color: INK,
}

/** The macOS app draws its traffic lights over the top of the window: the text starts below them. */
const DARWIN_TOP_INSET = 36

const textareaStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  width: '100%',
  boxSizing: 'border-box',
  padding: '14px 12px 8px',
  paddingTop: 'calc(14px + env(safe-area-inset-top, 0px))',
  border: 'none',
  outline: 'none',
  resize: 'none',
  background: 'transparent',
  color: 'inherit',
  // 16px: below that iOS Safari zooms the page on focus.
  font: '16px/1.4 var(--dsw-font-family, -apple-system, system-ui, sans-serif)',
}

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
}

/** The sheet's button chassis: 40px tall, BUTTON_RADIUS corners; width and skin per button. */
const barButton: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  height: 40,
  padding: 0,
  boxSizing: 'border-box',
  borderRadius: BUTTON_RADIUS,
  cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
}

const minimiseStyle: CSSProperties = { ...barButton, width: 40, border: `1px solid ${FRAME}`, background: 'transparent', color: INK }
const clearStyle: CSSProperties = { ...barButton, width: 80, border: 'none', background: RED, color: '#fff' }
const sendStyle: CSSProperties = { ...barButton, width: 80, border: 'none', background: BLUE, color: '#fff' }

const confirmBackdrop: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  background: 'rgba(0,0,0,0.45)',
}

const confirmCard: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  width: 'min(320px, calc(100vw - 48px))',
  padding: 18,
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-base)',
  color: INK,
  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  font: '15px/1.4 var(--dsw-font-family, -apple-system, system-ui, sans-serif)',
}

const confirmButton: CSSProperties = {
  ...barButton,
  flex: 1,
  height: 38,
  font: 'inherit',
}

// ---- component --------------------------------------------------------------

interface Selection { start: number; end: number }

/**
 * The tongue (collapsed) or the full-screen entry (expanded); nothing outside mobile mode.
 * @param props - session standard props + injected stop action.
 */
export function MobileComposer({ sessionId, useSession, useInput, inputActions, cancel, htmlFlag }: MobileComposerProps): ReactNode {
  const mobile = useMobileMode()
  const running = useSession(s => s.running)
  const phase = useInput(s => s.phase)
  const draft = useInput(s => s.draft)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const viewport = useVisualViewport(open)
  const textarea = useRef<HTMLTextAreaElement>(null)
  // Caret / selection remembered across minimise → expand.
  const selection = useRef<Selection | null>(null)

  // Stamp the flag while active so the stylesheet hides the stock composer bar.
  useEffect(() => {
    if (!mobile) return
    document.documentElement.setAttribute(htmlFlag, '')
    return () => { document.documentElement.removeAttribute(htmlFlag) }
  }, [mobile, htmlFlag])

  // Focus on open and put the caret back where it was.
  useEffect(() => {
    if (!open) return
    const el = textarea.current
    if (el === null) return
    el.focus()
    const saved = selection.current
    const end = el.value.length
    if (saved === null) el.setSelectionRange(end, end)
    else el.setSelectionRange(Math.min(saved.start, end), Math.min(saved.end, end))
  }, [open])

  const expand = useCallback(() => {
    // Local text survives minimise (with its caret); seed from the session
    // draft only when there is none yet. The editor's clipboard projection
    // ends its last paragraph with "\n".
    if (text === '') {
      setText(draft.replace(/\n$/, ''))
      selection.current = null
    }
    setOpen(true)
  }, [draft, text])

  const minimise = useCallback(() => {
    const el = textarea.current
    if (el !== null) selection.current = { start: el.selectionStart, end: el.selectionEnd }
    inputActions.setDraft(text)
    setConfirmClear(false)
    setOpen(false)
  }, [inputActions, text])

  const busy = phase !== 'plain'
  const canSend = text.trim() !== '' && !busy
  const send = useCallback(() => {
    if (!canSend) return
    inputActions.setDraft(text)
    inputActions.submit()
    setText('')
    selection.current = null
    setConfirmClear(false)
    setOpen(false)
  }, [canSend, inputActions, text])

  const clearAll = useCallback(() => {
    setText('')
    selection.current = null
    inputActions.setDraft('')
    setConfirmClear(false)
    textarea.current?.focus()
  }, [inputActions])

  const stop = useCallback(() => { void cancel(sessionId) }, [cancel, sessionId])

  if (!mobile) return null

  if (open) {
    const hasText = text !== ''
    return createPortal(
      <div style={{ ...sheetStyle, top: viewport.top, height: viewport.height }} role="dialog" aria-label="Write a message">
        <textarea
          ref={textarea}
          style={document.documentElement.dataset.platform === 'darwin'
            ? { ...textareaStyle, paddingTop: `calc(${String(14 + DARWIN_TOP_INSET)}px + env(safe-area-inset-top, 0px))` }
            : textareaStyle}
          value={text}
          onChange={e => { setText(e.target.value) }}
          autoCapitalize="sentences"
          autoCorrect="on"
          spellCheck
        />
        {/* With the keyboard up the home-indicator inset is under the keys: drop it. */}
        <div style={viewport.keyboard ? { ...barStyle, paddingBottom: 8 } : barStyle}>
          <button type="button" style={minimiseStyle} aria-label="Minimize" onClick={minimise}>
            <Chevron size={20} direction="down" />
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            style={{ ...clearStyle, opacity: hasText ? 1 : 0.4, cursor: hasText ? 'pointer' : 'default' }}
            aria-label="Abandon message"
            disabled={!hasText}
            onClick={() => { setConfirmClear(true) }}
          >
            <Cross size={20} />
          </button>
          <button
            type="button"
            style={{ ...sendStyle, opacity: canSend ? 1 : 0.4, cursor: canSend ? 'pointer' : 'default' }}
            aria-label="Send"
            disabled={!canSend}
            onClick={send}
          >
            <ArrowUp size={18} />
          </button>
        </div>
        {confirmClear && (
          <div style={confirmBackdrop} onClick={() => { setConfirmClear(false) }}>
            <div style={confirmCard} role="alertdialog" aria-label="Abandon message?" onClick={e => { e.stopPropagation() }}>
              <div>Abandon message?</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={{ ...confirmButton, border: `1px solid ${FRAME}`, background: 'transparent', color: INK }} onClick={() => { setConfirmClear(false) }}>Cancel</button>
                <button type="button" style={{ ...confirmButton, border: 'none', background: RED, color: '#fff' }} onClick={clearAll}>Abandon</button>
              </div>
            </div>
          </div>
        )}
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div style={tongueStyle} data-deepsea-phone-ui-tongue="">
      {running && (
        <button type="button" style={{ ...iconButton, color: RED }} aria-label="Stop" onClick={stop}>
          <StopSquare size={20} />
        </button>
      )}
      <button type="button" style={iconButton} aria-label="Write a message" onClick={expand}>
        <Chevron size={20} direction="up" />
      </button>
    </div>,
    document.body,
  )
}
