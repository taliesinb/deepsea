/**
 * The "Tailscale" settings section: publish or remove this variant's Serve
 * path, its addresses, the QR code carrying the standing token (with Rotate),
 * and the tailnet logins admitted without a token.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `settings.section` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TailscaleApi, TailscaleStatus } from './api.ts'
import { addressVariants } from './helpers.ts'
import { COLORS, CopyButton, styles } from './ui.tsx'

export type SectionProps = PropsRuntime<'settings.section'> & InjectFace<{ api: TailscaleApi }>

/** The status line: a colour and a few words. */
export function describeRoute(status: TailscaleStatus): { color: string, text: string } {
  const path = status.servePath ?? ''
  switch (status.route) {
    case 'no-path': return { color: COLORS.idle, text: 'No Serve path' }
    case 'active': return { color: COLORS.ok, text: `Published at ${path}` }
    case 'stale': return { color: COLORS.warn, text: `${path} points at ${status.mappedTarget ?? '?'}` }
    case 'conflict': return { color: COLORS.bad, text: `${path} is taken: ${status.mappedTarget ?? 'another service'}` }
    case 'unavailable': return {
      color: COLORS.bad,
      text: `Tailscale unavailable: ${status.detail === 'binary-missing' ? 'CLI not found' : status.detail === 'not-running' ? 'not connected' : 'tailscaled unreachable'}`,
    }
    default: return { color: COLORS.idle, text: 'Not published' }
  }
}

export function TailscaleSection({ api }: SectionProps) {
  const [status, setStatus] = useState<TailscaleStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [users, setUsers] = useState('')
  const [usersDirty, setUsersDirty] = useState(false)
  const alive = useRef(true)
  const dirty = useRef(false)
  dirty.current = usersDirty

  const applyStatus = useCallback((next: TailscaleStatus) => {
    if (!alive.current) return
    setStatus(next)
    setError(undefined)
    if (!dirty.current) setUsers(next.allowedUsers.join('\n'))
  }, [])

  const run = useCallback(async (action: () => Promise<TailscaleStatus>) => {
    setBusy(true)
    try {
      applyStatus(await action())
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [applyStatus])

  useEffect(() => {
    alive.current = true
    void run(api.status)
    const timer = setInterval(() => { void api.status().then(applyStatus).catch(() => {}) }, 15_000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [api, run, applyStatus])

  const saveUsers = async (): Promise<TailscaleStatus> => {
    const next = await api.setUsers(users)
    if (alive.current) setUsersDirty(false)
    dirty.current = false
    return next
  }

  if (status === undefined) {
    return (
      <div style={styles.section} data-deepsea-tailscale-section="tailscale">
        <div style={styles.group}>
          <div style={error === undefined ? styles.caption : styles.error}>{error ?? 'Loading…'}</div>
        </div>
      </div>
    )
  }

  const route = describeRoute(status)
  const published = status.route === 'active'
  const canPublish = status.servePath !== undefined && status.route !== 'unavailable' && status.route !== 'conflict'
  const addresses = published ? addressVariants(status) : []

  return (
    <div style={styles.section} data-deepsea-tailscale-section="tailscale">
      <div style={styles.group}>
        <div style={styles.row}>
          <div style={{ ...styles.sub, flex: 1 }} data-deepsea-tailscale-route={status.route}>
            <span style={styles.dot(route.color)} />
            {route.text}
          </div>
          {status.servePath !== undefined && (
            <Button
              variant={published ? 'outline' : 'primary'}
              size="sm"
              disabled={busy || (!published && !canPublish)}
              onClick={() => { void run(published ? api.disable : api.enable) }}
            >
              {busy ? 'Working…' : published ? 'Remove' : 'Publish'}
            </Button>
          )}
        </div>
        {status.proxy.port === undefined
          ? <div style={styles.caption}>No proxy</div>
          : status.proxy.error !== undefined && <div style={styles.error}>Proxy on 127.0.0.1:{status.proxy.port}: {status.proxy.error}</div>}
        {error !== undefined && <div style={styles.error}>{error}</div>}
      </div>

      {addresses.length > 0 && (
        <div style={styles.group}>
          <div style={styles.title}>Address</div>
          {addresses.map(variant => (
            <div key={variant.label} style={{ ...styles.row, flexWrap: 'nowrap', gap: 0 }}>
              <span style={{ ...styles.muted, fontSize: 12, width: 84, flex: 'none' }}>{variant.label}</span>
              <span style={{ ...styles.mono, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'all', color: 'var(--dsw-alias-label-primary)' }}>{variant.url}</span>
              <CopyButton text={variant.url} label={`Copy ${variant.label} address`} />
            </div>
          ))}
        </div>
      )}

      {status.url !== undefined && (
        <div style={styles.group}>
          <div style={styles.row}>
            <div style={{ ...styles.title, flex: 1 }}>QR code</div>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(api.rotateToken) }}>Rotate</Button>
          </div>
          {status.qrSvg === undefined
            ? <div style={{ ...styles.qr, display: 'grid', placeItems: 'center', color: '#888', fontSize: 12 }}>unavailable</div>
            : <div style={styles.qr} data-deepsea-tailscale-qr dangerouslySetInnerHTML={{ __html: status.qrSvg }} />}
        </div>
      )}

      <div style={styles.group}>
        <div style={styles.title}>Allowed Tailscale users</div>
        <div style={{ ...styles.row, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          <textarea
            data-deepsea-tailscale-users
            style={{
              flex: '1 1 auto', minWidth: 0, resize: 'none', ...styles.mono, lineHeight: '18px', padding: '6px 10px', borderRadius: 8,
              border: '0.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary)', outline: 'none',
            }}
            rows={Math.max(1, users.split('\n').length)}
            value={users}
            placeholder={status.selfLogin === undefined ? 'user@example.com' : `${status.selfLogin} (always allowed)`}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => {
              // Logins never contain spaces or commas: those become line breaks.
              setUsers(event.currentTarget.value.replace(/[ ,;]+/g, '\n').replace(/\n{2,}/g, '\n'))
              setUsersDirty(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void run(saveUsers)
            }}
          />
          <Button variant="outline" size="sm" disabled={busy || !usersDirty} onClick={() => { void run(saveUsers) }}>Save</Button>
        </div>
      </div>
    </div>
  )
}
