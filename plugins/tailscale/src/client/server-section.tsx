/**
 * The "Server" settings section: this variant's processes (relay, dsh web,
 * app) with restart, quit and launch, and who is connected right now.
 * Restart and quit ask once more inline (no native dialog, which the app's
 * automation and a phone handle badly).
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ServerAction, ServerProcess, ServerStatus } from './api.ts'
import { ago, commandLines } from './helpers.ts'
import type { SectionProps } from './tailscale-section.tsx'
import { COLORS, Hint, styles } from './ui.tsx'

const table = {
  table: { width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, lineHeight: '18px' } as CSSProperties,
  th: { textAlign: 'left', padding: '4px 6px', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 500, borderBottom: '0.5px solid var(--dsw-alias-border-l2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as CSSProperties,
  td: { padding: '6px 6px', borderBottom: '0.5px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))', verticalAlign: 'middle', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as CSSProperties,
  tag: { display: 'inline-block', padding: '0 5px', borderRadius: 6, fontSize: 10, lineHeight: '15px', background: 'var(--dsw-alias-bg-module-platform)', border: '0.5px solid var(--dsw-alias-border-l4)', marginLeft: 6, verticalAlign: '1px' } as CSSProperties,
}

/** Monochrome glyphs: ↻ restart, ▶ launch, ■ quit. */
function ActionIcon({ id }: { id: string }) {
  const common = { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (id === 'restart') return <svg {...common} aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.6 2.6v3h-3" /></svg>
  if (id === 'launch') return <svg {...common} aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" /></svg>
  return <svg {...common} aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none" /></svg>
}

export function ServerSection({ api }: SectionProps) {
  const [status, setStatus] = useState<ServerStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState<{ process: ServerProcess, action: ServerAction } | undefined>(undefined)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await api.serverStatus()
      if (!alive.current) return
      setStatus(next)
      setError(undefined)
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [api])

  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh])

  const act = async (process: ServerProcess, action: ServerAction) => {
    setConfirming(undefined)
    setBusy(`${process.id}/${action.id}`)
    setMessage(undefined)
    try {
      const next = await api.serverAct(process.id, action.id)
      if (!alive.current) return
      setStatus(next)
      setMessage(next.message)
      setError(undefined)
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }

  if (status === undefined) {
    return (
      <div style={styles.section} data-deepsea-tailscale-section="server">
        <div style={styles.group}>
          <div style={error === undefined ? styles.caption : styles.error}>{error ?? 'Loading…'}</div>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.section} data-deepsea-tailscale-section="server">
      <div style={styles.group}>
        <div style={styles.title}>Processes</div>
        <table style={table.table}>
          <colgroup>
            <col style={{ width: '34%' }} />
            <col style={{ width: 70 }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '13%' }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th style={table.th}>Process</th>
              <th style={table.th}>PID</th>
              <th style={table.th}>Uptime</th>
              <th style={table.th}>RSS</th>
              <th style={{ ...table.th, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {status.processes.map(process => (
              <tr key={process.id} data-deepsea-tailscale-process={process.id}>
                <td style={table.td}>
                  <Hint text={process.details.join('\n')}>
                    <span style={styles.dot(process.running ? COLORS.ok : COLORS.idle)} />
                    {process.title}
                  </Hint>
                </td>
                <td style={{ ...table.td, ...styles.mono }}>
                  {process.command === undefined
                    ? (process.pid ?? '—')
                    : <Hint text={commandLines(process.command).join('\n')} mono>{process.pid ?? '—'}</Hint>}
                </td>
                <td style={table.td}>{process.uptimeSeconds === undefined ? '—' : ago(process.uptimeSeconds * 1000)}</td>
                <td style={table.td}>{process.rssKb === undefined ? '—' : `${String(Math.round(process.rssKb / 1024))} MB`}</td>
                <td style={{ ...table.td, textAlign: 'right' }}>
                  {process.actions.map(action => (
                    <button
                      key={action.id}
                      type="button"
                      style={{ ...styles.iconButton, opacity: busy !== undefined ? 0.5 : 1 }}
                      disabled={busy !== undefined}
                      aria-label={`${action.label} ${process.title}`}
                      onClick={() => {
                        if (action.danger) setConfirming({ process, action })
                        else void act(process, action)
                      }}
                    >
                      {busy === `${process.id}/${action.id}` ? '…' : <ActionIcon id={action.id} />}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {confirming !== undefined && (
          <div style={styles.row} data-deepsea-tailscale-confirm>
            <span style={{ ...styles.sub, flex: 1 }}>{confirming.action.label} {confirming.process.title}?</span>
            <Button variant="primary" size="sm" onClick={() => { void act(confirming.process, confirming.action) }}>{confirming.action.label}</Button>
            <Button variant="outline" size="sm" onClick={() => { setConfirming(undefined) }}>Cancel</Button>
          </div>
        )}
        {message !== undefined && <div style={styles.caption}>{message}</div>}
        {error !== undefined && <div style={styles.error}>{error}</div>}
      </div>

      <div style={styles.group}>
        <div style={styles.title}>Clients</div>
        {!status.tracking && <div style={styles.error}>Client tracking unavailable</div>}
        <table style={table.table}>
          <colgroup>
            <col style={{ width: '18%' }} />
            <col style={{ width: 118 }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '10%' }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th style={table.th}>User</th>
              <th style={table.th}>IP</th>
              <th style={table.th}>Via</th>
              <th style={table.th}>Live</th>
              <th style={table.th}>Req</th>
              <th style={table.th}>Seen</th>
              <th style={table.th}>Viewing</th>
            </tr>
          </thead>
          <tbody>
            {status.clients.length === 0 && (
              <tr><td style={{ ...table.td, ...styles.muted }} colSpan={7}>None</td></tr>
            )}
            {status.clients.map(client => (
              <tr key={client.key}>
                <td style={table.td}>
                  <Hint text={`${client.login ?? client.admitted}\n${client.proxied ? `tailnet, ${client.admitted}` : 'loopback'}`}>
                    {client.login === undefined
                      ? <span style={styles.muted}>{client.admitted === 'cookie' ? 'QR token' : client.admitted}</span>
                      : client.login.replace(/@.*$/, '')}
                    {client.self && <span style={table.tag}>this Mac</span>}
                  </Hint>
                </td>
                <td style={{ ...table.td, ...styles.mono, fontSize: 11, letterSpacing: '-0.03em', overflow: 'visible', textOverflow: 'clip' }}>{client.address}</td>
                <td style={table.td}><Hint text={client.userAgent}>{client.agent === '—' ? <span style={styles.muted}>—</span> : client.agent}</Hint></td>
                <td style={table.td}>{client.sockets > 0 ? <span style={{ color: COLORS.ok }}>● {client.sockets}</span> : <span style={styles.muted}>—</span>}</td>
                <td style={table.td}>{client.requests}</td>
                <td style={table.td}>{ago(status.now - client.lastSeen)}</td>
                <td style={table.td}>
                  <Hint text={client.lastSession === undefined ? (client.lastPath ?? '') : [client.lastSession.workspace ?? client.lastSession.cwd ?? '', client.lastSession.sessionId ?? '', client.lastSession.method].filter(Boolean).join('\n')}>
                    {client.lastSession === undefined
                      ? <span style={styles.muted}>—</span>
                      : (
                          <>
                            {(client.lastSession.workspace ?? client.lastSession.cwd ?? '').split('/').filter(Boolean).pop() ?? ''}
                            {client.lastSession.sessionId !== undefined && <span style={{ ...styles.mono, ...styles.muted, marginLeft: 6 }}>{client.lastSession.sessionId.replace(/^session-/, '').slice(0, 8)}</span>}
                          </>
                        )}
                  </Hint>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
