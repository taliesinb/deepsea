/** Shared pieces of the two settings sections: styles, a hover card for data, a copy button. */
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

export const styles = {
  section: { display: 'flex', flexDirection: 'column', width: '100%' } as CSSProperties,
  group: { display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as CSSProperties,
  title: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' } as CSSProperties,
  sub: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))' } as CSSProperties,
  caption: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))' } as CSSProperties,
  error: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' } as CSSProperties,
  muted: { color: 'var(--dsw-alias-label-tertiary)' } as CSSProperties,
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 } as CSSProperties,
  dot: (color: string): CSSProperties => ({ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: color, marginRight: 8, verticalAlign: 'middle' }),
  qr: { width: 200, height: 200, borderRadius: 12, overflow: 'hidden', background: '#fff', border: '0.5px solid var(--dsw-alias-border-l4)' } as CSSProperties,
  iconButton: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, marginLeft: 4, padding: 0,
    borderRadius: 6, border: '0.5px solid var(--dsw-alias-border-l4)', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))', cursor: 'pointer',
  } as CSSProperties,
}

export const COLORS = { ok: '#3ba55c', warn: '#e5a50a', bad: '#d0342c', idle: 'var(--dsw-alias-label-tertiary)' }

/**
 * A hover card showing data (a command line, a path, a user agent); clicking
 * copies it. In-page because native `title` tooltips do not show in the
 * DeepSea app; fixed-positioned so cells with overflow:hidden cannot clip it.
 */
export function Hint({ text, children, style, mono }: { text: string, children: ReactNode, style?: CSSProperties, mono?: boolean }) {
  const [anchor, setAnchor] = useState<{ left: number, top: number, bottom: number } | undefined>(undefined)
  const [placed, setPlaced] = useState<{ left: number, top: number } | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const card = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const show = (event: { currentTarget: Element }) => {
    const rect = event.currentTarget.getBoundingClientRect()
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom }), 150)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setAnchor(undefined)
    setPlaced(undefined)
  }
  // Below the anchor when it fits, above otherwise, never past the right edge.
  useLayoutEffect(() => {
    const element = card.current
    if (anchor === undefined || element === null) return
    const { width, height } = element.getBoundingClientRect()
    const margin = 8
    const below = anchor.bottom + 6
    const top = below + height <= window.innerHeight - margin ? below : Math.max(margin, anchor.top - 6 - height)
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - margin - width))
    setPlaced({ left, top })
  }, [anchor, text])
  const trimmed = text.trim()
  return (
    <span
      style={{ display: 'inline-block', maxWidth: '100%', verticalAlign: 'bottom', ...style }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(event) => {
        if (trimmed === '') return
        event.stopPropagation()
        void writeClipboard(trimmed).then((ok) => { setCopied(ok); setTimeout(() => setCopied(false), 1200) })
      }}
      tabIndex={trimmed === '' ? undefined : 0}
    >
      {children}
      {anchor !== undefined && trimmed !== '' && (
        <div
          ref={card}
          role="tooltip"
          data-deepsea-tailscale-hint
          style={{
            position: 'fixed', left: placed?.left ?? anchor.left, top: placed?.top ?? anchor.bottom + 6, zIndex: 10000,
            visibility: placed === undefined ? 'hidden' : 'visible',
            maxWidth: mono ? 560 : 360, padding: '8px 11px', borderRadius: 10, whiteSpace: 'pre-wrap', overflowWrap: mono ? 'normal' : 'anywhere',
            font: mono ? '11px/16px ui-monospace, SFMono-Regular, Menlo, monospace' : '12px/17px -apple-system, system-ui, sans-serif',
            color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
            background: 'var(--dsw-alias-bg-module-float, var(--dsw-alias-bg-module-platform, #2a2a2c))', border: '0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l4))',
            boxShadow: '0 8px 28px rgba(0,0,0,.28), 0 1px 3px rgba(0,0,0,.2)', pointerEvents: 'none',
          }}
        >
          {trimmed}
          {copied && <div style={{ marginTop: 6, font: '11px/14px -apple-system, system-ui, sans-serif', color: 'var(--dsw-alias-label-tertiary)' }}>Copied</div>}
        </div>
      )}
    </span>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string, label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      style={{ ...styles.iconButton, marginLeft: 6, color: copied ? COLORS.ok : undefined }}
      onClick={() => { void writeClipboard(text).then((ok) => { setCopied(ok); setTimeout(() => setCopied(false), 1200) }) }}
    >
      {copied
        ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
        : <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8.5" rx="1.5" /><path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5" /></svg>}
    </button>
  )
}
