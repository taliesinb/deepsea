/**
 * @deepsea/browser, browser half.
 *
 * 1. Chat rows for the two inline-screenshot tools, so a capture is seen in
 *    the transcript:
 *
 *      chrome_get_screenshot   [globe] Chrome screenshot  c:0:1 · viewport
 *      safari_get_screenshot   [globe] Safari screenshot  s:0:0 · element "h1"
 *
 *    Collapsed: the window and what was captured. Expanded: the image at point
 *    size (device pixels ÷ 2: the captures come from retina windows), a click
 *    opens an in-page lightbox (fit ↔ 1:1), then the tool's result text (size,
 *    NOTE:s) underneath.
 *
 *    The chat dispatches each tool card through the keyed `tool.call.toolview`
 *    slot; a tool nobody claims falls to the generic card, which prints an
 *    image block as its JSON. The shared `tool.call.images` gallery slot is
 *    `single` and owned by the read_image entry, so this row draws its own
 *    <img> through the session-authorized `loadImage` loader every toolview
 *    receives. Claiming a key replaces the generic card for every shape of
 *    that tool, so the row covers: running, a capture with its image, a
 *    capture saved to a file instead (a model without image input), an error,
 *    and an interrupted turn.
 *
 * 2. Window cooperation with the DeepSea macOS app. Inside the app the page
 *    has `webkit.messageHandlers.deepseaApp`, `window.__DEEPSEA_APP_WINDOW__`
 *    and `deepsea-app-window` events describing the app's window. This half
 *    relays those reports to the server (POST ./api/deepsea-browser/app-window)
 *    and hands the server's `set-frame` requests (long poll on
 *    ./api/deepsea-browser/app-command) to the app, so the host can place an
 *    agent's Safari windows beside the window that drives them (placement.mjs).
 *    Anywhere else (a browser, a phone) it does nothing.
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
import { DisclosureRow, IconGlobeOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type Props = PropsRuntime<'tool.call.toolview'>
type Block = Props['block']
type Settled = Extract<Block, { kind: 'tool-result' }>
type LoadImage = Props['loadImage']

/** Mirror of the harness's ImageAttachmentRef (narrowed at runtime: the block comes off the wire). */
interface ImageRef {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
/** The id is opaque (only its presence is checked); everything else exact. */
function asImageRef(value: unknown): ImageRef | undefined {
  if (!isRecord(value)) return undefined
  const { attachmentId, mediaType, bytes, width, height, name } = value
  if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
  if (typeof mediaType !== 'string' || !MEDIA_TYPES.has(mediaType)) return undefined
  if (!positiveInt(bytes) || !positiveInt(width) || !positiveInt(height)) return undefined
  const ref: ImageRef = { attachmentId, mediaType: mediaType as ImageRef['mediaType'], bytes, width, height }
  if (typeof name === 'string') ref.name = name
  return ref
}

function isSettled(block: Block): block is Settled {
  return 'kind' in block
}

/** The result text: text blocks verbatim, image blocks left out (they render), anything else as JSON. */
function resultText(block: Block): string {
  if (!isSettled(block)) return ''
  const parts: string[] = []
  for (const item of block.content) {
    if (item.type === 'text') parts.push(item.text)
    else if (item.type !== 'image') parts.push(JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n').trim()
}

function imageRefsOf(block: Block): ImageRef[] {
  if (!isSettled(block)) return []
  const refs: ImageRef[] = []
  for (const item of block.content) {
    if (item.type === 'image' && 'attachment' in item) {
      const ref = asImageRef((item as { attachment?: unknown }).attachment)
      if (ref !== undefined) refs.push(ref)
    }
  }
  return refs
}

function parseArgs(block: Block): Record<string, unknown> {
  const raw = isSettled(block) ? block.call?.argsRaw : 'argsRaw' in block ? block.argsRaw : undefined // preparing calls stream arguments
  if (typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

type RowState = 'running' | 'ok' | 'error' | 'stopped'

function stateOf(block: Block): RowState {
  if (!isSettled(block)) return 'running'
  if (!block.isError) return 'ok'
  const code = block.error?.code
  return code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH' ? 'stopped' : 'error'
}

/** What the call asked for, from its arguments (a running row has no result text yet). */
function targetOf(args: Record<string, unknown>): string {
  if (typeof args.querySelector === 'string' && args.querySelector !== '') return `element ${JSON.stringify(args.querySelector)}`
  if (typeof args.uid === 'string' && args.uid !== '') return `element uid ${args.uid}`
  if (args.fullPage === true) return 'full page'
  return 'viewport'
}

/**
 * Collapsed summary `c:0:1 · viewport`: the window (from the `[id]` tag the
 * host puts on every result) and what was captured (from the arguments).
 * Pixel size, byte count and the other `;`-separated details of the result
 * text are for the model and stay in the expanded body; only the file
 * fallback adds `saved to file`, which says why there is no picture.
 */
function summaryOf(text: string, target: string): string {
  const line = text.split('\n')[0] ?? ''
  const id = /\[([a-z]:\d+:\d+)\]/.exec(line)?.[1]
  const parts = [id, target]
  if (line.includes('; saved to ')) parts.push('saved to file')
  return parts.filter((part): part is string => part !== undefined).join(' · ')
}

function firstLine(text: string, max = 120): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// ---------------------------------------------------------------- image

/** Resolve a content-block image to a displayable URL through the session loader. */
function useImageUrl(loadImage: LoadImage, image: ImageRef): { url: string | undefined, failed: boolean } {
  const [url, setUrl] = useState<string | undefined>(() => loadImage.peek?.(image as never))
  const [failed, setFailed] = useState(false)
  const id = image.attachmentId
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    loadImage(image as never).then(
      (resolved) => { if (!cancelled) setUrl(resolved) },
      () => { if (!cancelled) setFailed(true) },
    )
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, loadImage])
  return { url, failed }
}

const FRAME: CSSProperties = {
  display: 'block',
  width: 'fit-content',
  maxWidth: '100%',
  alignSelf: 'flex-start',
  borderRadius: 6,
  overflow: 'hidden',
  boxShadow: '0 0 0 1px color-mix(in srgb, currentColor 14%, transparent)',
  boxSizing: 'content-box',
}

/**
 * The capture at point size: the browsers run on retina displays, so a
 * 1280×720 CSS-px viewport arrives as 2560×1440 device pixels; halving shows
 * it at the size the page had. `max-width: 100%` keeps a full-page capture in
 * the column; the lightbox has the 1:1 view.
 */
function Shot({ loadImage, image, alt }: { loadImage: LoadImage, image: ImageRef, alt: string }) {
  const { url, failed } = useImageUrl(loadImage, image)
  const [broken, setBroken] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const width = Math.max(1, Math.round(image.width / 2))
  if (failed || broken) return <div style={{ opacity: 0.7, fontSize: 12 }}>[image unavailable: {image.name ?? image.attachmentId}]</div>
  if (url === undefined) return <div style={{ ...FRAME, width, aspectRatio: `${image.width} / ${image.height}`, opacity: 0.4 }} />
  return (
    <div style={FRAME}>
      <img
        src={url}
        alt={alt}
        width={width}
        style={{ display: 'block', width, maxWidth: '100%', height: 'auto', cursor: 'zoom-in' }}
        onClick={(event) => { event.stopPropagation(); setZoomed(true) }}
        onError={() => setBroken(true)}
      />
      {zoomed && <Lightbox url={url} alt={alt} caption={`${alt} — ${image.width}×${image.height} px`} onClose={() => setZoomed(false)} />}
    </div>
  )
}

/**
 * Full-size view in the page (never `window.open`: the macOS app's web view
 * would load the URL into its only window). Escape, a click outside or × close
 * it; a click on the image toggles fit ↔ 1:1 pixels.
 */
function Lightbox({ url, alt, caption, onClose }: { url: string, alt: string, caption: string, onClose: () => void }) {
  const [actual, setActual] = useState(false)
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const bg = getComputedStyle(document.body).backgroundColor
  const background = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? bg : (dark ? '#000' : '#fff')
  const fg = dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.7)'
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div
      role="dialog"
      aria-label={alt}
      onClick={(e) => { e.stopPropagation(); onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', cursor: 'zoom-out' }}
    >
      <img
        src={url}
        alt={alt}
        onClick={(e) => { e.stopPropagation(); setActual(a => !a) }}
        style={actual
          ? { display: 'block', maxWidth: 'none', cursor: 'zoom-out' }
          : { display: 'block', maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 72px)', width: 'auto', height: 'auto', cursor: 'zoom-in' }}
      />
      <div style={{ position: 'fixed', left: 16, bottom: 12, fontSize: 12, color: fg, fontFamily: 'var(--dsh-font-mono, ui-monospace, monospace)' }}>{caption}{actual ? ' · 1:1' : ' · fit'}</div>
      <button type="button" aria-label="Close" onClick={(e) => { e.stopPropagation(); onClose() }} style={{ position: 'fixed', top: 12, right: 16, fontSize: 22, lineHeight: 1, color: fg, background: 'transparent', border: 0, cursor: 'pointer' }}>×</button>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------- the row

// Typed like the shipped ToolRow / DisclosureRow title: the secondary content
// size follows the Settings font-size preference (a fixed 13px would render
// larger than an 11px title).
const ROW_STYLE: CSSProperties = { fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))' }
const SUMMARY_STYLE: CSSProperties = { flex: '1 1 auto', minWidth: 0, marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'inherit', lineHeight: 'inherit', color: 'var(--dsw-alias-label-tertiary)' }
const ERROR_SUMMARY_STYLE: CSSProperties = { ...SUMMARY_STYLE, color: 'var(--dsw-alias-state-error-primary, #e5484d)' }
const BODY_STYLE: CSSProperties = { padding: '6px 0 8px 22px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }
const PRE_STYLE: CSSProperties = { margin: 0, alignSelf: 'stretch', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: '18px', maxHeight: 360, overflow: 'auto', opacity: 0.85 }

const GLOBE = <IconGlobeOutlineRegular size={14} />

function leading(state: RowState): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    case 'running': return <StateDot state="ongoing" />
    default: return GLOBE
  }
}

function browserOf(toolName: string): 'Chrome' | 'Safari' {
  return toolName.startsWith('safari_') ? 'Safari' : 'Chrome'
}

export function ScreenshotRow({ toolName, block, loadImage }: Props) {
  const [open, setOpen] = useState(false)
  const state = stateOf(block)
  const args = parseArgs(block)
  const title = `${browserOf(toolName)} screenshot`
  const text = resultText(block)
  const refs = imageRefsOf(block)
  const target = targetOf(args)

  const summary = state === 'running'
    ? `capturing ${target}…`
    : state === 'ok'
      ? summaryOf(text, target)
      : state === 'stopped'
        ? 'interrupted'
        : (firstLine(text) || 'failed')
  const summaryStyle = state === 'error' ? ERROR_SUMMARY_STYLE : SUMMARY_STYLE

  const expandable = state !== 'running' && (refs.length > 0 || text !== '')
  // `data-tool` / `data-state` as on the shipped ToolRow.
  return (
    <div style={ROW_STYLE} data-tool={toolName} data-state={state}>
      <DisclosureRow
        icon={leading(state)}
        title={title}
        open={open && expandable}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setOpen(v => !v)}
        collapsedContent={<span style={summaryStyle}>{summary}</span>}
      >
        <div style={BODY_STYLE}>
          {refs.map(ref => <Shot key={ref.attachmentId} loadImage={loadImage} image={ref} alt={`${title}: ${target}`} />)}
          {text !== '' && <pre style={PRE_STYLE}>{text}</pre>}
        </div>
      </DisclosureRow>
    </div>
  )
}

// ---------------------------------------------------------------- window cooperation with the DeepSea app

/** Mirrors app-windows.mjs. Document-relative (`./api/...`): behind a path-mounting proxy `/api` would escape the mount. */
export const APP_WINDOW_PATH = './api/deepsea-browser/app-window'
export const APP_COMMAND_PATH = './api/deepsea-browser/app-command'

type AppBridge = { postMessage: (body: unknown) => void }
type AppWindowInfo = { pid?: number } & Record<string, unknown>
type AppGlobals = {
  webkit?: { messageHandlers?: { deepseaApp?: AppBridge } }
  __DEEPSEA_APP_WINDOW__?: AppWindowInfo
}

/**
 * Inside the DeepSea macOS app: relay its window reports to this server and
 * the server's `set-frame` requests back to the app. Anywhere else: nothing.
 * A server without the routes (Safari parking off) answers 404: reports stop,
 * and the command route is asked again once a minute; when it is back, the
 * latest report goes out at once.
 * @param options - test seams: the delays.
 * @returns the disposer.
 */
export function startAppCooperation(options: { debounceMs?: number, missingRouteMs?: number } = {}): () => void {
  if (typeof window === 'undefined') return () => {}
  const page = window as unknown as AppGlobals
  const bridge = page.webkit?.messageHandlers?.deepseaApp
  if (!bridge) return () => {}
  const debounceMs = options.debounceMs ?? 150
  const missingRouteMs = options.missingRouteMs ?? 60_000
  let disposed = false
  let latest: AppWindowInfo | undefined
  let routeMissing = false
  let polling = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  function send(): void {
    if (disposed || routeMissing || latest === undefined) return
    void fetch(APP_WINDOW_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(latest) })
      .then((response) => { if (response.status === 404) routeMissing = true })
      .catch(() => {})
  }

  async function pollCommands(): Promise<void> {
    polling = true
    let backoff = 1000
    while (!disposed && latest !== undefined) {
      try {
        const response = await fetch(`${APP_COMMAND_PATH}?pid=${latest.pid}`, { credentials: 'same-origin', cache: 'no-store' })
        if (response.status === 404) { routeMissing = true; await sleep(missingRouteMs); continue }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        if (routeMissing) { routeMissing = false; send() }
        const body = await response.json() as { command?: { type?: string, frame?: unknown } }
        if (!disposed && body.command?.type === 'set-frame') bridge!.postMessage({ type: 'set-frame', frame: body.command.frame })
        backoff = 1000
      } catch {
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
    polling = false
  }

  function relay(info: AppWindowInfo | undefined): void {
    if (disposed || !info || typeof info.pid !== 'number') return
    latest = info
    clearTimeout(debounce)
    debounce = setTimeout(send, debounceMs)
    if (!polling) void pollCommands()
  }

  const onWindow = (event: Event) => relay((event as CustomEvent<AppWindowInfo>).detail)
  window.addEventListener('deepsea-app-window', onWindow)
  // The app publishes after each load, possibly before this listener existed: read the global, else ask.
  const current = page.__DEEPSEA_APP_WINDOW__
  if (current) relay(current)
  else { try { bridge.postMessage({ type: 'window-info' }) } catch { /* the app went away */ } }
  return () => {
    disposed = true
    clearTimeout(debounce)
    window.removeEventListener('deepsea-app-window', onWindow)
  }
}

// ---------------------------------------------------------------- plugin

/** The tools whose results carry an inline image block (tools.mjs `inlineFinalizer`). */
export const SCREENSHOT_TOOLS = ['chrome_get_screenshot', 'safari_get_screenshot'] as const

export const name = 'deepsea-browser'
export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('tool.call.toolview', () =>
    SCREENSHOT_TOOLS.map(key => ctx.slots.register({ name: 'tool.call.toolview', key }, ScreenshotRow)))
  ctx.effect(() => startAppCooperation())
}
