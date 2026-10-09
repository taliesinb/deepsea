/**
 * @deepsea/tools, browser half: the `/tools` card.
 *
 * Registered on the keyed `conversation.chat.commandview` slot under the
 * command name, so it replaces the generic command row (a one-line summary
 * plus a `<pre>`) for `/tools` only. The host's result text is a count line
 * and a JSON listing (`listing.mjs`); anything else (an error, any other
 * text) renders as the generic row would, as text.
 *
 * Layout: a header row like every command row (icon, `tools`, the patterns,
 * the count), then a table — name | arguments | description — whose rows
 * expand to the full description and one line per parameter. The header
 * folds the table. A result focused on one tool (`/tools bash`) opens that
 * row.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { IconApiOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { decodeListing } from '../../listing.mjs'
import styles from './style.css'

interface ParamEntry { name: string, type: string, required: boolean, description: string }
interface ToolEntry { name: string, summary: string, description: string, params: ParamEntry[] }
interface Listing { v: 1, total: number, patterns: string[], mode?: string, focus?: string, tools: ToolEntry[] }

const MARKDOWN_LABELS = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied' },
  footnotes: 'Footnotes',
}

function countText(listing: Listing): string {
  const noun = listing.total === 1 ? 'tool' : 'tools'
  return listing.patterns.length === 0
    ? `${String(listing.total)} ${noun}`
    : `${String(listing.tools.length)} of ${String(listing.total)} ${noun}`
}

/** Argument names shown in a row before `…`. */
const ARGS_SHOWN = 3

/** Optional parameters are dimmed wherever a parameter name appears. */
function argClass(base: string, param: ParamEntry): string {
  return param.required ? base : `${base} ${base}--optional`
}

/**
 * The first {@link ARGS_SHOWN} names (required first), space-separated, then
 * `…` when there are more. The list wraps inside a one-line box, so a name
 * that does not fit drops out whole instead of being cut.
 */
const ARG_GAP = 4 // px between names: the `column-gap` in style.css
const MORE_WIDTH = 12 // px for the trailing `…`

/**
 * How many of the measured names fit `available` px, leaving room for the
 * `…` whenever not every parameter is shown.
 */
function namesThatFit(widths: number[], total: number, available: number): number {
  for (let count = widths.length; count > 0; count--) {
    const names = widths.slice(0, count).reduce((sum, width) => sum + width, 0) + ARG_GAP * (count - 1)
    const more = count < total ? ARG_GAP + MORE_WIDTH : 0
    if (names + more <= available) return count
  }
  return 0
}

function Args({ params }: { params: ParamEntry[] }) {
  const shown = params.slice(0, ARGS_SHOWN)
  const cell = useRef<HTMLSpanElement>(null)
  const list = useRef<HTMLSpanElement>(null)
  // Name widths are measured once, with every shown name rendered; after
  // that the count follows the cell width, so a name never shows half.
  const widths = useRef<number[] | null>(null)
  const [count, setCount] = useState(shown.length)
  useLayoutEffect(() => {
    const box = cell.current
    const names = list.current
    if (box === null || names === null) return
    widths.current ??= [...names.children].map(child => child.getBoundingClientRect().width)
    const measured = widths.current
    const fit = () => setCount(namesThatFit(measured, params.length, box.clientWidth))
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(box)
    return () => observer.disconnect()
  }, [params])
  return <span className="deepsea-tools__arg-cell" ref={cell}>
    <span className="deepsea-tools__arg-list" ref={list}>
      {shown.slice(0, count).map(param => <span key={param.name} className={argClass('deepsea-tools__arg', param)}>{param.name}</span>)}
    </span>
    {count < params.length && <span className="deepsea-tools__arg-more">…</span>}
  </span>
}

/** A type label with break opportunities after each `|` (enums wrap between values). */
function TypeLabel({ type }: { type: string }) {
  const parts = type.split('|')
  return <>{parts.map((part, index) => <span key={index}><span className="deepsea-tools__type-part">{part}</span>{index < parts.length - 1 && <>|<wbr /></>}</span>)}</>
}

/** Width of the arguments cell in mono characters, for column sizing. */
function argsChars(params: ParamEntry[]): number {
  const shown = params.slice(0, ARGS_SHOWN)
  const names = shown.reduce((sum, param) => sum + param.name.length, 0)
  // About half a mono character per separating space, two for the ellipsis.
  return names + Math.ceil(shown.length / 2) + (params.length > ARGS_SHOWN ? 2 : 0)
}

const TIP_DELAY_MS = 250
const TIP_GAP = 6
const TIP_MARGIN = 8

/**
 * Every parameter as name | type (optional names dimmed), below the hovered cell (above
 * when the viewport has no room), portaled to the body: the table's
 * container query makes it a containing block for fixed descendants.
 */
function ArgsTip({ params, anchor }: { params: ParamEntry[], anchor: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number, top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const { width, height } = el.getBoundingClientRect()
    const below = anchor.bottom + TIP_GAP
    const top = below + height > window.innerHeight - TIP_MARGIN ? Math.max(TIP_MARGIN, anchor.top - TIP_GAP - height) : below
    const left = Math.max(TIP_MARGIN, Math.min(anchor.left, window.innerWidth - TIP_MARGIN - width))
    setPlace({ left, top })
  }, [anchor])
  const style: CSSProperties = place === null ? { left: 0, top: 0, visibility: 'hidden' } : place
  return createPortal(<div className="deepsea-tools-tip" ref={ref} style={style} role="tooltip">
    <table>
      <tbody>
        {params.map(param => <tr key={param.name}>
          <td className={argClass('deepsea-tools-tip__name', param)}>{param.name}</td>
          <td className="deepsea-tools-tip__type">{param.type}</td>
        </tr>)}
      </tbody>
    </table>
  </div>, document.body)
}

function ArgsCell({ params }: { params: ParamEntry[] }) {
  const ref = useRef<HTMLTableCellElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const hide = () => {
    clearTimeout(timer.current)
    setAnchor(null)
  }
  const show = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (ref.current !== null) setAnchor(ref.current.getBoundingClientRect())
    }, TIP_DELAY_MS)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  // A scroll moves the cell away from the fixed bubble: drop it.
  useEffect(() => {
    if (anchor === null) return
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [anchor])
  const hoverable = params.length > 0
  return <td className="deepsea-tools__args" ref={ref}
    onMouseEnter={hoverable ? show : undefined} onMouseLeave={hoverable ? hide : undefined}>
    <Args params={params} />
    {anchor !== null && <ArgsTip params={params} anchor={anchor} />}
  </td>
}

function ToolDetail({ tool }: { tool: ToolEntry }) {
  return <div className="deepsea-tools__detail">
    {tool.description !== '' && <div className="deepsea-tools__description">
      <MarkdownText text={tool.description} labels={MARKDOWN_LABELS} variant="compact" />
    </div>}
    {tool.params.length > 0 && <table className="deepsea-tools__params">
      <tbody>
        {tool.params.map(param => <tr key={param.name}>
          <td className={argClass('deepsea-tools__param-name', param)}>{param.name}</td>
          <td className="deepsea-tools__param-type"><TypeLabel type={param.type} /></td>
          <td className="deepsea-tools__param-description">
            {param.description !== '' && <MarkdownText text={param.description} labels={MARKDOWN_LABELS} variant="compact" />}
          </td>
        </tr>)}
      </tbody>
    </table>}
  </div>
}

function ToolRow({ tool, open, onToggle }: { tool: ToolEntry, open: boolean, onToggle: () => void }) {
  return <>
    <tr className="deepsea-tools__row" data-deepsea-tools-open={open || undefined} onClick={onToggle}
      tabIndex={0} aria-expanded={open}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } }}>
      <td className="deepsea-tools__name">{tool.name}</td>
      <ArgsCell params={tool.params} />
      <td className="deepsea-tools__summary">{tool.summary.replace(/`/g, '')}</td>
    </tr>
    {open && <tr className="deepsea-tools__expanded">
      <td colSpan={3}><ToolDetail tool={tool} /></td>
    </tr>}
  </>
}

function ToolsTable({ listing }: { listing: Listing }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(listing.focus === undefined ? [] : [listing.focus]))
  const toggle = (name: string) => setOpen(previous => {
    const next = new Set(previous)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    return next
  })
  // Name column fits the longest name (never truncated); arguments fit the
  // longest shown list, capped in CSS; the description takes the rest.
  const widths = useMemo(() => ({
    '--deepsea-tools-name-ch': Math.max(4, ...listing.tools.map(tool => tool.name.length)),
    '--deepsea-tools-args-ch': Math.max(9, ...listing.tools.map(tool => argsChars(tool.params))),
  }) as CSSProperties, [listing])
  return <div className="deepsea-tools__body" style={widths}>
    <table className="deepsea-tools__table">
      <colgroup>
        <col className="deepsea-tools__col-name" />
        <col className="deepsea-tools__col-args" />
        <col />
      </colgroup>
      <thead>
        <tr><th>name</th><th>arguments</th><th>description</th></tr>
      </thead>
      <tbody>
        {listing.tools.map(tool => <ToolRow key={tool.name} tool={tool} open={open.has(tool.name)} onToggle={() => toggle(tool.name)} />)}
      </tbody>
    </table>
  </div>
}

function ToolsCommandCard({ node }: CommandRowProps) {
  const text = node.outcome?.text
  const listing = useMemo(() => decodeListing(text) as Listing | undefined, [text])
  const [folded, setFolded] = useState(false)
  const state = node.outcome === null ? 'running' : node.outcome.kind === 'error' ? 'error' : 'ok'
  const patterns = (node.args ?? '').trim()
  const foldable = listing !== undefined
  return <div className="deepsea-tools" data-state={state}>
    <div className="deepsea-tools__header" data-deepsea-tools-foldable={foldable || undefined}
      role={foldable ? 'button' : undefined} tabIndex={foldable ? 0 : undefined}
      aria-expanded={foldable ? !folded : undefined}
      onClick={foldable ? () => setFolded(value => !value) : undefined}
      onKeyDown={foldable ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setFolded(value => !value) } } : undefined}>
      <span className="deepsea-tools__icon">
        {state === 'error'
          ? <StateDot state="error" />
          : foldable && folded ? <IconChevronRightOutlineRegular size={14} /> : foldable ? <IconChevronDownOutlineRegular size={14} /> : <IconApiOutlineRegular size={14} />}
      </span>
      <span className="deepsea-tools__title">tools</span>
      {patterns !== '' && <><span className="deepsea-tools__separator" aria-hidden /><span className="deepsea-tools__patterns">{patterns}</span></>}
      {listing !== undefined && <><span className="deepsea-tools__separator" aria-hidden /><span>{countText(listing)}</span></>}
      {listing?.mode === 'ptc' && <><span className="deepsea-tools__separator" aria-hidden /><span>ptc</span></>}
      {listing === undefined && text !== undefined && <><span className="deepsea-tools__separator" aria-hidden />
        <span className="deepsea-tools__message" data-deepsea-tools-error={state === 'error' || undefined}>{text.split('\n')[0]}</span></>}
    </div>
    {listing !== undefined && !folded && <ToolsTable listing={listing} />}
  </div>
}

export const name = 'deepsea-tools'
export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.deepseaTools = ''
    style.textContent = styles
    document.head.appendChild(style)
    return () => style.remove()
  })
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register(
    { name: 'conversation.chat.commandview', key: 'tools' },
    ToolsCommandCard,
  ))
}
