/**
 * The per-session QR button in the session header's utilities row: a panel
 * with a QR code that opens this one session on another device, the
 * chrome-less `?embed=<sessionId>` page (harness topic `embed-session`) at
 * the variant's tailnet address.
 *
 * "Only you" (ticked by default) leaves the token out: the device must be
 * admitted by its Tailscale login. Unticked, the standing token rides along
 * (`?token=…&embed=…`; the proxy exchanges it and keeps `embed`), and any
 * device that scans gets in, with the same access as the Settings QR code:
 * `embed` is a presentation, not a permission. Clicking the code copies the
 * link. Off the host (a tailnet tab that is no operator's) the panel uses the
 * document's own directory, token-less.
 */
import type { CSSProperties, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { renderSVG } from 'uqr'
import { Tooltip, useDismissOnOutsidePointer, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `conversation.session.header.utilities` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TailscaleApi } from './api.ts'
import { sessionLink, sessionLinkFacts, type SessionLinkFacts } from './helpers.ts'

export interface SessionQrInjected {
  api: TailscaleApi
  /** The GUI's own document directory: the fallback base when the host's status is not readable. */
  documentBase: string
}

export type SessionQrActionProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<SessionQrInjected>

function qrSvg(text: string): string | undefined {
  try {
    return renderSVG(text, { ecc: 'M', border: 1 })
  } catch {
    return undefined
  }
}

const styles = {
  root: { position: 'relative', display: 'inline-flex', flex: 'none' } as CSSProperties,
  button: {
    display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 6,
    color: 'var(--dsw-alias-label-secondary)', background: 'transparent', border: 'none', borderRadius: 28, cursor: 'pointer',
  } as CSSProperties,
  buttonOpen: { background: 'var(--dsw-alias-interactive-bg-hover)' } as CSSProperties,
  panel: {
    position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100, boxSizing: 'border-box',
    width: 208 + 2 * 14, maxWidth: 'calc(100vw - 24px)', padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    borderRadius: 16, background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-module-platform))',
    border: '0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l4))', boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
    color: 'var(--dsw-alias-label-primary)', fontSize: 12, lineHeight: '18px', textAlign: 'left', cursor: 'default',
  } as CSSProperties,
  title: { fontSize: 12.5, lineHeight: '18px', fontWeight: 600, whiteSpace: 'nowrap' } as CSSProperties,
  caption: { fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' } as CSSProperties,
  qrWrap: { alignSelf: 'center', width: 208, height: 208, padding: 8, boxSizing: 'border-box', borderRadius: 12, background: '#fff', border: '0.5px solid var(--dsw-alias-border-l4)', cursor: 'copy' } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 22 } as CSSProperties,
  check: (disabled: boolean): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }),
  checkInput: { flex: '0 0 auto', width: 14, height: 14, margin: 0, accentColor: 'var(--dsw-alias-brand-primary)', cursor: 'inherit' } as CSSProperties,
  error: { color: 'var(--dsw-alias-state-error-primary)' } as CSSProperties,
}

/** A QR-code glyph, 16 × 16. */
function IconQr(): ReactNode {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M3.75 3.75h.5M11.75 3.75h.5M3.75 11.75h.5" strokeWidth={1.6} />
      <path d="M9.5 9.5h2v2h-2zM13.5 9.5h1M9.5 13.5h1M12.5 12.5h2v2h-2z" />
    </svg>
  )
}

/** The button and its panel; the panel asks the host for its status when it opens. */
export function SessionQrAction({ sessionId, api, documentBase }: SessionQrActionProps): ReactNode {
  const root = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [facts, setFacts] = useState<SessionLinkFacts | undefined>(undefined)
  const [onlyMe, setOnlyMe] = useState(true)
  const [copied, setCopied] = useState(false)
  useDismissOnOutsidePointer(root, open, setOpen)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open])

  useEffect(() => {
    if (!open) return
    let alive = true
    setFacts(undefined)
    setCopied(false)
    api.status()
      .then((status) => { if (alive) setFacts(sessionLinkFacts(status, documentBase)) })
      .catch(() => { if (alive) setFacts(sessionLinkFacts(undefined, documentBase)) })
    return () => { alive = false }
  }, [open, api, documentBase])

  const toggle = useCallback(() => { setOpen(value => !value) }, [])

  const token = facts?.token
  const includeToken = !onlyMe && token !== undefined
  const link = facts?.base === undefined ? undefined : sessionLink(facts.base, sessionId, includeToken ? token : undefined)
  const svg = link === undefined ? undefined : qrSvg(link)
  const copy = useCallback(() => {
    if (link === undefined) return
    void writeClipboard(link).then((ok) => {
      setCopied(ok)
      if (ok) setTimeout(() => setCopied(false), 1500)
    })
  }, [link])

  return (
    <div ref={root} style={styles.root} data-deepsea-tailscale-session-qr>
      <Tooltip label="Open on another device" side="bottom" delayMs={500} disabled={open}>
        <button
          type="button"
          style={open ? { ...styles.button, ...styles.buttonOpen } : styles.button}
          aria-label="QR code for this session"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={toggle}
        >
          <IconQr />
        </button>
      </Tooltip>
      {open && (
        <div style={styles.panel} role="dialog" aria-label="This session on another device">
          <div style={styles.title}>This session on another device</div>
          {facts === undefined && <div style={styles.caption}>Loading…</div>}
          {facts !== undefined && link === undefined && <div style={{ ...styles.caption, ...styles.error }}>{facts.problem ?? 'No address.'}</div>}
          {link !== undefined && (
            <>
              {svg === undefined
                ? <div style={{ ...styles.qrWrap, display: 'grid', placeItems: 'center', color: '#888', cursor: 'default' }}>QR unavailable</div>
                : (
                    <div
                      style={styles.qrWrap}
                      role="button"
                      tabIndex={0}
                      aria-label="Copy the link"
                      data-deepsea-tailscale-session-link={link}
                      onClick={copy}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); copy() } }}
                      dangerouslySetInnerHTML={{ __html: svg }}
                    />
                  )}
              <div style={styles.row}>
                <label style={styles.check(token === undefined)}>
                  <input
                    type="checkbox"
                    style={styles.checkInput}
                    checked={token === undefined ? true : onlyMe}
                    disabled={token === undefined}
                    onChange={(event) => { setOnlyMe(event.target.checked) }}
                  />
                  <span>Only you</span>
                </label>
                <span style={{ ...styles.caption, visibility: copied ? 'visible' : 'hidden' }} aria-live="polite">Copied</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
