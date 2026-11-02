/**
 * @deepsea/wait, browser half: the `wait` tool's chat row.
 *
 * The keyed `tool.call.toolview` entry for `wait` replaces the generic tool
 * card with a 24px row: [clock] Wait · <reason> ▕████████░░░░▏ 4 s / 10 s [Skip] [Abort]
 *
 *   running   the bar fills against the SERVER clock: on mount the row asks
 *             GET ./api/deepsea-wait/status for { startedAt, deadline, now }
 *             and keeps the browser↔server offset, so a phone or another
 *             machine with a skewed clock still draws the right bar (before
 *             the answer arrives: the tool/call event time from the block).
 *             Skip / Abort POST ./api/deepsea-wait/control; the row then waits
 *             for the tool/result event like any other tool row.
 *   settled   a static bar: completed = full, skipped = the fraction that
 *             passed (accent), aborted = that fraction in the error colour;
 *             an interrupted turn (registry ABORTED) reads "interrupted".
 *             The outcome comes from the result's presentationMeta
 *             ({ deepsea: 'wait', outcome, waitedSeconds, … }) or the error code.
 *
 * Claiming a key suppresses the generic card for EVERY shape of that tool, so
 * the row covers running / ok / every error / missing meta.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports (erased at build time): SlotMap merges for
// 'tool.call.toolview' and the session-scope standard props.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DisclosureRow, IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'

type Props = PropsRuntime<'tool.call.toolview'>
type Block = Props['block']

/** Mirrors index.js. Document-relative (`./api/...`): behind a path-mounting proxy `/api` would escape the mount. */
const STATUS_PATH = './api/deepsea-wait/status'
const CONTROL_PATH = './api/deepsea-wait/control'
/** Error code of the user's Abort verdict (wait.mjs USER_ABORTED_WAIT). */
const USER_ABORTED_WAIT = 'USER_ABORTED_WAIT'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSettled(block: Block): block is Extract<Block, { kind: 'tool-result' }> {
  return 'kind' in block
}

function parseArgs(block: Block): { seconds: number | undefined, reason: string } {
  const raw = isSettled(block) ? block.call?.argsRaw : 'argsRaw' in block ? block.argsRaw : undefined  // preparing calls stream arguments
  let parsed: unknown
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined } catch { parsed = undefined }
  if (!isRecord(parsed)) return { seconds: undefined, reason: '' }
  const seconds = typeof parsed.seconds === 'number' && Number.isFinite(parsed.seconds) && parsed.seconds > 0 ? parsed.seconds : undefined
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
  return { seconds, reason }
}

/** `2.3 s`, `10 s`, `1 min 30 s`, `2 h 5 min` (same shape as the host's formatSeconds). */
function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  if (seconds < 60) return `${seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)} s`
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h} h`)
  if (m > 0) parts.push(`${m} min`)
  if (s > 0 && h === 0) parts.push(`${s} s`)
  return parts.join(' ')
}

/** Elapsed for the running row: whole seconds until the last one (no 0.1 s flicker). */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)} s`
  return formatSeconds(seconds)
}

type Outcome = 'completed' | 'skipped' | 'aborted' | 'interrupted' | 'failed'

interface Settled {
  outcome: Outcome
  /** Seconds that actually passed (from presentationMeta, else the call→result span). */
  waited: number | undefined
  /** First line of a failure the row cannot classify. */
  error: string | undefined
}

function settledOf(block: Extract<Block, { kind: 'tool-result' }>): Settled {
  const meta = block.meta
  const span = block.callTime !== null ? (block.time - block.callTime) / 1000 : undefined
  if (!block.isError && isRecord(meta) && meta.deepsea === 'wait') {
    const waited = typeof meta.waitedSeconds === 'number' ? meta.waitedSeconds : span
    return { outcome: meta.outcome === 'skipped' ? 'skipped' : 'completed', waited, error: undefined }
  }
  if (!block.isError) return { outcome: 'completed', waited: span, error: undefined }
  const code = block.error?.code
  if (code === USER_ABORTED_WAIT) return { outcome: 'aborted', waited: span, error: undefined }
  if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') return { outcome: 'interrupted', waited: span, error: undefined }
  const text = block.content.map(item => item.type === 'text' ? item.text : '').join('\n').trim()
  const first = (text || (block.error ? `${block.error.name}: ${block.error.code}` : 'failed')).split('\n')[0] ?? 'failed'
  return { outcome: 'failed', waited: span, error: first }
}

// ---------------------------------------------------------------- host calls

interface Status { startedAt: number, deadline: number, now: number }

async function fetchStatus(callId: string, sessionId: string): Promise<Status | undefined> {
  try {
    const response = await fetch(`${STATUS_PATH}?callId=${encodeURIComponent(callId)}&sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    if (!isRecord(body) || body.pending !== true) return undefined
    const { startedAt, deadline, now } = body
    if (typeof startedAt !== 'number' || typeof deadline !== 'number' || typeof now !== 'number') return undefined
    return { startedAt, deadline, now }
  } catch {
    return undefined
  }
}

async function control(action: 'skip' | 'abort', callId: string, sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(CONTROL_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, callId, sessionId }),
    })
    return response.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- styles

/** Class prefix of the stylesheet `apply` installs (hover states need real CSS). */
const CLS = 'deepsea-wait'
const STYLE_ID = 'deepsea-wait-style'
const STYLESHEET = `
.${CLS}-content { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; gap: 8px; margin-left: 8px; font-size: var(--dsh-content-font-size-secondary, 13px); color: var(--dsw-alias-label-secondary); }
.${CLS}-reason { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.8; }
.${CLS}-track { position: relative; flex: 1 1 80px; min-width: 40px; max-width: 280px; height: 6px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, currentColor 12%, transparent); }
.${CLS}-fill { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: var(--dsw-alias-state-business-primary, #3b82f6); }
.${CLS}-fill[data-deepsea-wait-outcome='completed'] { background: var(--dsw-alias-label-tertiary); }
.${CLS}-fill[data-deepsea-wait-outcome='skipped'] { background: var(--dsw-alias-state-business-primary, #3b82f6); }
.${CLS}-fill[data-deepsea-wait-outcome='aborted'], .${CLS}-fill[data-deepsea-wait-outcome='failed'] { background: var(--dsw-alias-state-error-primary, #e5484d); }
.${CLS}-fill[data-deepsea-wait-outcome='interrupted'] { background: var(--dsw-alias-state-warn-primary, #d97706); }
.${CLS}-time { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; opacity: 0.85; }
.${CLS}-verdict { flex: none; white-space: nowrap; }
.${CLS}-verdict[data-deepsea-wait-outcome='aborted'] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.${CLS}-verdict[data-deepsea-wait-outcome='interrupted'] { color: var(--dsw-alias-state-warn-primary, #d97706); }
.${CLS}-buttons { display: inline-flex; flex: none; gap: 4px; }
.${CLS}-button { appearance: none; height: 20px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 20%, transparent)); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--dsh-content-font-size-secondary, 12px); line-height: 18px; cursor: pointer; }
.${CLS}-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent)); color: var(--dsw-alias-label-primary); }
.${CLS}-button[data-deepsea-wait-danger]:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary, #e5484d); border-color: var(--dsw-alias-state-error-primary, #e5484d); }
.${CLS}-button:disabled { opacity: 0.5; cursor: default; }
`

// Typed like the shipped ToolRow / DisclosureRow title: the secondary content
// size follows the Settings font-size preference (a fixed 13px would render
// larger than an 11px title).
const ROW_STYLE: CSSProperties = { fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))' }

// ---------------------------------------------------------------- the row

/** 100 ms ticker while the wait runs; nothing while settled. */
function useTicker(active: boolean): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setTick(t => t + 1), 100)
    return () => window.clearInterval(id)
  }, [active])
  return tick
}

function RunningContent({ callId, sessionId, block, seconds, reason }: { callId: string, sessionId: string, block: Extract<Block, { argsRaw: string }>, seconds: number | undefined, reason: string }) {
  // Server-clock anchor: { startedAt, deadline } on the server clock plus the browser→server offset.
  const [anchor, setAnchor] = useState<{ startedAt: number, deadline: number, offset: number } | undefined>(undefined)
  const [busy, setBusy] = useState<'skip' | 'abort' | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    void fetchStatus(callId, sessionId).then((status) => {
      if (cancelled || status === undefined) return
      setAnchor({ startedAt: status.startedAt, deadline: status.deadline, offset: status.now - Date.now() })
    })
    return () => { cancelled = true; mounted.current = false }
  }, [callId, sessionId])
  useTicker(true)

  const requestedMs = anchor !== undefined ? anchor.deadline - anchor.startedAt : (seconds ?? 0) * 1000
  const startedAt = anchor?.startedAt ?? block.time
  const now = Date.now() + (anchor?.offset ?? 0)
  const elapsedMs = Math.max(0, now - startedAt)
  // Hold at 99 % until the result event lands: the bar must never claim "done" before the tool did.
  const fraction = requestedMs > 0 ? Math.min(0.99, elapsedMs / requestedMs) : 0
  const total = requestedMs / 1000

  const verdict = (action: 'skip' | 'abort') => {
    if (busy !== undefined) return
    setBusy(action)
    void control(action, callId, sessionId).then(() => { if (mounted.current) setBusy(undefined) })
  }

  return (
    <span className={`${CLS}-content`} data-deepsea-wait-outcome="running">
      {reason !== '' && <span className={`${CLS}-reason`} title={reason}>{reason}</span>}
      <span className={`${CLS}-track`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <span className={`${CLS}-fill`} style={{ width: `${fraction * 100}%` }} />
      </span>
      <span className={`${CLS}-time`}>{formatElapsed(elapsedMs / 1000)} / {formatSeconds(total)}</span>
      <span className={`${CLS}-buttons`}>
        <button type="button" className={`${CLS}-button`} disabled={busy !== undefined} onClick={(event) => { event.stopPropagation(); verdict('skip') }}>Skip</button>
        <button type="button" className={`${CLS}-button`} data-deepsea-wait-danger disabled={busy !== undefined} onClick={(event) => { event.stopPropagation(); verdict('abort') }}>Abort</button>
      </span>
    </span>
  )
}

function verdictText(settled: Settled, requested: number | undefined): string {
  const waited = settled.waited !== undefined ? formatSeconds(settled.waited) : undefined
  const total = requested !== undefined ? formatSeconds(requested) : undefined
  const ofTotal = waited !== undefined && total !== undefined ? `after ${waited} of ${total}` : waited !== undefined ? `after ${waited}` : ''
  switch (settled.outcome) {
    case 'completed': return total !== undefined ? `waited ${total}` : waited !== undefined ? `waited ${waited}` : 'done'
    case 'skipped': return `skipped ${ofTotal}`.trim()
    case 'aborted': return `aborted by user ${ofTotal}`.trim()
    case 'interrupted': return `interrupted ${ofTotal}`.trim()
    case 'failed': return settled.error ?? 'failed'
  }
}

function SettledContent({ block, seconds, reason }: { block: Extract<Block, { kind: 'tool-result' }>, seconds: number | undefined, reason: string }) {
  const settled = settledOf(block)
  const fraction = settled.outcome === 'completed' ? 1
    : settled.outcome === 'failed' ? 0
      : seconds !== undefined && settled.waited !== undefined && seconds > 0 ? Math.min(1, settled.waited / seconds) : 0
  return (
    <span className={`${CLS}-content`} data-deepsea-wait-outcome={settled.outcome}>
      {reason !== '' && <span className={`${CLS}-reason`} title={reason}>{reason}</span>}
      {settled.outcome !== 'failed' && (
        <span className={`${CLS}-track`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <span className={`${CLS}-fill`} data-deepsea-wait-outcome={settled.outcome} style={{ width: `${fraction * 100}%` }} />
        </span>
      )}
      <span className={`${CLS}-verdict`} data-deepsea-wait-outcome={settled.outcome}>{verdictText(settled, seconds)}</span>
    </span>
  )
}

/**
 * Leading glyph: the clock alone. The 16px leading box has no room for a
 * StateDot beside it (the pair renders squashed); the row's state is carried
 * by the bar (moving / colour) and the verdict text instead.
 */
const LEADING = <IconClockOutlineRegular size={14} />

export function WaitRow({ callId, block, sessionId }: Props) {
  const { seconds, reason } = parseArgs(block)
  const session = String(sessionId)
  if (!isSettled(block)) {
    // `data-tool` / `data-state` as on the shipped ToolRow.
    return (
      <div style={ROW_STYLE} data-tool="wait" data-state="running">
        <DisclosureRow icon={LEADING} title="Wait" open={false} expandable={false} onToggle={() => {}}
          collapsedContent={'argsRaw' in block ? <RunningContent callId={callId} sessionId={session} block={block} seconds={seconds} reason={reason} /> : undefined} />
      </div>
    )
  }
  const settled = settledOf(block)
  const state = settled.outcome === 'aborted' || settled.outcome === 'failed' ? 'error' : settled.outcome === 'interrupted' ? 'stopped' : 'ok'
  return (
    <div style={ROW_STYLE} data-tool="wait" data-state={state}>
      <DisclosureRow icon={LEADING} title="Wait" open={false} expandable={false} onToggle={() => {}}
        collapsedContent={<SettledContent block={block} seconds={seconds} reason={reason} />} />
    </div>
  )
}

// ---------------------------------------------------------------- plugin

export const name = 'deepsea-wait'
export const inject = ['slots']

export function apply(ctx: Context): void {
  // Hover/disabled states need a real stylesheet; one <style> per plugin lifetime.
  ctx.effect(() => {
    document.getElementById(STYLE_ID)?.remove()
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLESHEET
    document.head.append(style)
    return () => { style.remove() }
  }, 'wait: stylesheet')

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'wait' }, WaitRow))
}
