/**
 * @deepsea/tool-system-permissions, browser half: the card of
 * `seek_system_permission`.
 *
 * The keyed `tool.call.toolview` entry for the tool replaces the generic
 * card with a header row and a table, one row per permission:
 *
 *   [shield] System permissions  DeepSea Server · 1/3
 *     ✓  Accessibility      To click through the installer.
 *     ?  Screen Recording   To take screenshots of the protot…   [Grant] [Deny]
 *     ✗  Microphone         To record the demo's narration.
 *
 * The rows are a grid (subgrid per row): mark, name, the agent's
 * justification (secondary, cut with an ellipsis, whole in its tooltip),
 * buttons. Under 520px of card width the justification wraps under the name.
 *
 *   ✓  granted (already, or during the call)
 *   ?  not granted yet: Grant asks macOS (prompt or new row) and opens the
 *      permission's System Settings pane, Deny marks it as refused; it
 *      pulses while being granted, and is orange for a stale entry
 *   ✗  denied by the user, cannot be granted here, or cancelled
 *
 * There is no state column: the row's tooltip (and the mark's accessible
 * name) is its short state ("granted after 42s", "stale entry: remove it").
 *
 * While the call runs the card asks GET ./api/deepsea-tool-system-permissions/status
 * every second; Grant and Deny POST ./api/deepsea-tool-system-permissions/action.
 * Once settled it draws the result's presentationMeta ({ deepsea:
 * 'system-permissions', subject, permissions }), or, for a cancelled call
 * (whose result carries no meta), the status route's record of it; with
 * neither, the requested names. Copy: the `card` section of locale/*.json.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports (erased at build time): slot and standard-prop declarations.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { DisclosureRow, IconCheckCircleFillRegular, IconCloseCircleFillRegular, IconQuestionOutlineRegular, IconShieldOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import enLocale from '../../locale/en.json'
import zhLocale from '../../locale/zh.json'
import { CLS, STYLESHEET, STYLE_ID } from './styles.ts'
import { appPanels, startNotices } from './notice.ts'
import { type Row, type Translate, iconOf, isOpen, nameOf, rowsFromArgs, stateKeyOf, stateText } from './model.ts'

/** Dictionary namespace of the card's copy. */
const NS = 'deepsea-tool-system-permissions'
type CardKey = keyof typeof enLocale.card

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The seek_system_permission card. */
    'deepsea-tool-system-permissions': CardKey
  }
}

/** English is the key-set source; tests/client-model.test.mjs checks the Chinese file has the same keys. */
const DICTIONARIES: { en: Record<CardKey, string>, zh: Record<CardKey, string> } = { en: enLocale.card, zh: zhLocale.card }

type T = TranslateNS<typeof NS>
type Props = PropsRuntime<'tool.call.toolview'> & PropsLocale<typeof NS>
type CommandProps = PropsRuntime<'conversation.chat.commandview'> & PropsLocale<typeof NS>
type Block = Props['block']

/** Mirrors index.js. Document-relative: behind a path-mounting proxy `/api` would escape the mount. */
const STATUS_PATH = './api/deepsea-tool-system-permissions/status'
const ACTION_PATH = './api/deepsea-tool-system-permissions/action'
const TOOL_NAME = 'seek_system_permission'
/** The slash command (command.mjs). */
const COMMAND_NAME = 'system-permissions'
const META_MARK = 'system-permissions'
const POLL_MS = 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSettled(block: Block): block is Extract<Block, { kind: 'tool-result' }> {
  return 'kind' in block
}

interface Subject { name?: string, bundleId?: string }
interface View { rows: Row[], subject: Subject | undefined, running: boolean }

function rowsOf(value: unknown): Row[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((r): r is Row => isRecord(r) && typeof r.id === 'string' && typeof r.state === 'string')
}

function subjectOf(value: unknown): Subject | undefined {
  if (!isRecord(value)) return undefined
  return { name: typeof value.name === 'string' ? value.name : undefined, bundleId: typeof value.bundleId === 'string' ? value.bundleId : undefined }
}

async function fetchStatus(callId: string, sessionId: string): Promise<View | undefined> {
  try {
    const response = await fetch(`${STATUS_PATH}?callId=${encodeURIComponent(callId)}&sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    if (!isRecord(body) || !isRecord(body.snapshot)) return undefined
    const rows = rowsOf(body.snapshot.rows)
    if (rows === undefined) return undefined
    return { rows, subject: subjectOf(body.snapshot.subject), running: body.running === true }
  } catch {
    return undefined
  }
}

async function act(action: 'grant' | 'deny', permission: string, callId: string, sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(ACTION_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, permission, callId, sessionId }),
    })
    return response.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- styles


const ROW_STYLE: CSSProperties = { fontSize: 'var(--dsh-content-font-size-secondary, 13px)' }
const HEADER_ICON = <IconShieldOutlineRegular size={14} />

/** The mark; its accessible name is the row's short state (no state column: the mark and the tooltip carry it). */
function iconNode(row: Row, label: string): ReactNode {
  const icon = iconOf(row)
  return (
    <span role="img" aria-label={label}>
      {icon === 'granted' ? <IconCheckCircleFillRegular size={14} />
        : icon === 'open' ? <IconQuestionOutlineRegular size={14} />
          : icon === 'closed' ? <IconCloseCircleFillRegular size={14} />
            : <span className={`${CLS}-dot`} />}
    </span>
  )
}

// ---------------------------------------------------------------- the card

/**
 * Open every collapsed process group around the card (the chat folds a
 * Turn's tool calls under "Called tools" in its standard and compact views;
 * the card is mounted inside, hidden), then bring it into view. The group
 * header is a button whose click toggles React state; it takes focus, so the
 * focus is handed back (the person may be typing in the composer).
 * @returns whether a group was opened.
 */
export function revealCard(root: HTMLElement): boolean {
  const focused = document.activeElement
  let opened = false
  for (let node = root.parentElement; node !== null; node = node.parentElement) {
    if (!node.hasAttribute('data-step-process')) continue
    const header = node.querySelector<HTMLButtonElement>(':scope > div > button[aria-expanded="false"]')
    if (header !== null) { header.click(); opened = true }
  }
  if (opened && focused instanceof HTMLElement && focused !== document.activeElement) focused.focus({ preventScroll: true })
  root.scrollIntoView({ block: 'nearest' })
  return opened
}

/** The live (or recorded) view of a call from the status route. */
function useStatus(callId: string, sessionId: string, poll: boolean, once: boolean): [View | undefined, () => void] {
  const [view, setView] = useState<View | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!poll && !once) return
    let cancelled = false
    let timer: number | undefined
    const ask = async () => {
      const answer = await fetchStatus(callId, sessionId)
      if (cancelled) return
      if (answer !== undefined) setView(answer)
      if (poll && (answer === undefined || answer.running)) timer = window.setTimeout(() => { void ask() }, POLL_MS)
    }
    void ask()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [callId, sessionId, poll, once, nonce])
  const refresh = useCallback(() => setNonce(n => n + 1), [])
  return [view, refresh]
}

function argsRawOf(block: Block): unknown {
  return isSettled(block) ? block.call?.argsRaw : 'argsRaw' in block ? block.argsRaw : undefined
}

export function PermissionsCard({ callId, block, sessionId, t }: Props) {
  const session = String(sessionId)
  const settled = isSettled(block)
  const meta = settled && !block.isError && isRecord(block.meta) && block.meta.deepsea === META_MARK ? block.meta : undefined
  const [status, refresh] = useStatus(callId, session, !settled, settled && meta === undefined)
  const running = !settled && (status?.running ?? true)
  const fromMeta = meta !== undefined ? rowsOf(meta.permissions) : undefined
  const rows: Row[] = fromMeta ?? status?.rows ?? rowsFromArgs(argsRawOf(block), settled ? 'cancelled' : 'checking')
  const subject = meta !== undefined ? subjectOf(meta.subject) : status?.subject
  const error = settled && block.isError && block.error?.code !== 'ABORTED' && block.error?.code !== 'ABORTED_BEFORE_DISPATCH'
    ? (block.content.map(item => item.type === 'text' ? item.text : '').join('\n').trim().split('\n')[0] || block.error?.code)
    : undefined
  const state = settled ? (block.isError ? 'error' : 'ok') : 'running'
  return <CardView callId={callId} sessionId={session} rows={rows} subject={subject} running={running} state={state} error={error}
    refresh={refresh} t={t} marker={{ tool: TOOL_NAME }} />
}

/**
 * `/system-permissions`: the keyed command row. `add` (its reply names the
 * call: a line `call: <id>`) draws the live card of the call it started;
 * `status` and `remove` show their reply, an aligned text table.
 */
export function CommandCard({ node, sessionId, t }: CommandProps) {
  const text = node.outcome?.text ?? ''
  const callId = /^call: (\S+)$/m.exec(text)?.[1]
  const session = String(sessionId)
  const [status, refresh] = useStatus(callId ?? '', session, callId !== undefined, false)
  if (callId !== undefined) {
    const running = status?.running ?? true
    return <CardView callId={callId} sessionId={session} rows={status?.rows ?? []} subject={status?.subject} running={running}
      state={running ? 'running' : 'ok'} refresh={refresh} t={t} marker={{ command: COMMAND_NAME }} />
  }
  const state = node.outcome === null ? 'running' : node.outcome.kind === 'error' ? 'error' : 'ok'
  return (
    <div style={ROW_STYLE} data-command={COMMAND_NAME} data-state={state}>
      <DisclosureRow icon={HEADER_ICON} title={`/${COMMAND_NAME}${(node.args ?? '').trimEnd()}`} open={false} expandable={false} onToggle={() => {}}
        running={node.outcome === null} contentClassName={`${CLS}-area`} contentLayoutClassName={`${CLS}-layout`} />
      {text !== '' && <pre className={`${CLS}-command-text`} data-error={state === 'error' || undefined}>{text}</pre>}
    </div>
  )
}

interface CardViewProps {
  callId: string
  sessionId: string
  rows: Row[]
  subject: Subject | undefined
  running: boolean
  /** data-state of the root: running | ok | error. */
  state: string
  error?: string | undefined
  /** Called after a Grant or Deny has been sent, to ask the status route again. */
  refresh: () => void
  t: T
  /** data-tool / data-command of the root, for tests and themes. */
  marker: { tool?: string, command?: string }
}

/** The card itself: header, rows, Grant and Deny. Shared by the tool's card and `/system-permissions add`. */
function CardView({ callId, sessionId, rows, subject, running, state, error, refresh, t, marker }: CardViewProps) {
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const granted = rows.filter(r => r.state === 'granted').length

  const click = (action: 'grant' | 'deny', id: string) => {
    if (busy !== undefined) return
    setBusy(`${action}:${id}`)
    void act(action, id, callId, sessionId).then(() => {
      if (!mounted.current) return
      setBusy(undefined)
      refresh()
    })
  }

  // The person must see a call that waits for them: open what hides it, once per call.
  const rootRef = useRef<HTMLDivElement>(null)
  const revealed = useRef(false)
  const waiting = running && rows.some(isOpen)
  useEffect(() => {
    if (!waiting || revealed.current || rootRef.current === null) return
    const root = rootRef.current
    // After the group's own layout settles (it may be mounting this very frame).
    const frame = window.requestAnimationFrame(() => { revealed.current = true; revealCard(root) })
    return () => window.cancelAnimationFrame(frame)
  }, [waiting])

  const translate = t as unknown as Translate
  const head = [subject?.name, rows.length > 0 ? t('summary', { granted, total: rows.length }) : undefined].filter(Boolean).join(' · ')
  return (
    <div ref={rootRef} style={ROW_STYLE} data-tool={marker.tool} data-command={marker.command} data-state={state} data-deepsea-permissions-call={callId}>
      <DisclosureRow icon={HEADER_ICON} title={t('title')} open={false} expandable={false} onToggle={() => {}}
        running={running && rows.some(r => r.state === 'checking')}
        contentClassName={`${CLS}-area`} contentLayoutClassName={`${CLS}-layout`}
        collapsedContent={head !== '' ? <span className={`${CLS}-head`} title={subject?.bundleId}>{head}</span> : undefined} />
      {error !== undefined && <div className={`${CLS}-error`}>{error}</div>}
      {rows.length > 0 && (
        <div className={`${CLS}-frame`}>
          <div className={`${CLS}-list`} role="list">
            {rows.map((row) => {
              const name = nameOf(row, translate)
              const state = stateText(row, translate)
              return (
                <div key={row.id} role="listitem" className={`${CLS}-row`} title={state} data-deepsea-permission={row.id} data-deepsea-permission-state={row.state}
                  data-deepsea-permission-status={row.status} data-deepsea-permission-icon={iconOf(row)} data-deepsea-permission-key={stateKeyOf(row)}>
                  <span className={`${CLS}-icon`}>{iconNode(row, state)}</span>
                  <span className={`${CLS}-name`}>{name}</span>
                  <span className={`${CLS}-justification`} title={row.justification}>{row.justification}</span>
                  <span className={`${CLS}-actions`}>
                    {running && isOpen(row) && (
                      <span className={`${CLS}-buttons`}>
                        <button type="button" className={`${CLS}-button`} data-deepsea-permission-action="grant" aria-label={t('grant.aria', { name })}
                          disabled={busy !== undefined} onClick={(event) => { event.stopPropagation(); click('grant', row.id) }}>{t('grant')}</button>
                        <button type="button" className={`${CLS}-button`} data-deepsea-permission-action="deny" aria-label={t('deny.aria', { name })}
                          disabled={busy !== undefined} onClick={(event) => { event.stopPropagation(); click('deny', row.id) }}>{t('deny')}</button>
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- plugin

export const name = 'deepsea-tool-system-permissions'
export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  ctx.effect(() => {
    document.getElementById(STYLE_ID)?.remove()
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLESHEET
    document.head.append(style)
    return () => { style.remove() }
  }, 'tool-system-permissions: stylesheet')

  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'tool-system-permissions: dictionaries')
  // In the macOS app: a waiting card nobody acted on comes up in a floating panel (notice.ts).
  ctx.effect(() => {
    const app = appPanels()
    if (app === undefined) return () => {}
    return startNotices(app, () => (/^zh/i.test(document.documentElement.lang || navigator.language) ? DICTIONARIES.zh : DICTIONARIES.en).title)
  }, 'tool-system-permissions: notices')
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME, locale: NS }, PermissionsCard))
  ctx.slots.inject('conversation.chat.commandview', () =>
    ctx.slots.register({ name: 'conversation.chat.commandview', key: COMMAND_NAME, locale: NS }, CommandCard))
}
