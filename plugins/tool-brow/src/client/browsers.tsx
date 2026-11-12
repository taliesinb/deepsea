/** Session-scoped Brow pages; only a mounted view polls or requests thumbnails. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconChevronDownOutlineRegular, IconDownloadOutlineRegular, IconShareOutlineRegular, IconTrashOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import styles from './browsers.css'

interface Page {
  handle: string
  backend: string
  title: string
  url: string
  opened?: string | number
  openedAt?: string | number
  headless: boolean
  visible?: boolean
  shown?: boolean
  closedAt?: number
  revision?: string | number
  usage?: { commands?: number; screenshots?: number; scripts?: number }
  counts?: { commands?: number; screenshots?: number; scripts?: number }
}
const ROOT = './api/deepsea-tool-brow/'

/** Fetch a response without hiding server errors behind JSON parser failures. */
async function checked(response: Response): Promise<Response> {
  if (response.ok) return response
  const text = await response.text()
  let message = text
  try { message = JSON.parse(text).error ?? text } catch { /* Non-JSON proxy errors remain readable. */ }
  throw new Error(message || `Request failed (${response.status})`)
}

function Eye(): ReactNode {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
}

export function PageRow({ page, sessionId, refresh }: { page: Page; sessionId: string; refresh: () => Promise<void> }): ReactNode {
  const root = useRef<HTMLElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const [targetSize, setTargetSize] = useState({ width: 0, height: 0 })
  const [near, setNear] = useState(false)
  const [thumbnail, setThumbnail] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const closed = page.closedAt !== undefined
  const visible = page.visible ?? page.shown ?? false
  const revision = page.revision ?? page.url
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '160px' })
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const element = preview.current
    if (!element) return
    const measure = (): void => {
      const bounds = element.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      const width = Math.min(2048, Math.max(1, Math.ceil(bounds.width * ratio)))
      const height = Math.min(2048, Math.max(1, Math.ceil(bounds.height * ratio)))
      setTargetSize(old => old.width === width && old.height === height ? old : { width, height })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    measure()
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  useEffect(() => {
    if (!near || page.headless || closed || !targetSize.width) return
    const controller = new AbortController()
    let url: string | undefined
    let loading = false
    async function capture(): Promise<void> {
      if (loading || document.hidden) return
      loading = true
      try {
        const query = new URLSearchParams({ sessionId, handle: page.handle, revision: String(revision), width: String(targetSize.width), height: String(targetSize.height) })
        const response = await checked(await fetch(`${ROOT}thumbnail?${query}`, { signal: controller.signal }))
        const blob = await response.blob()
        if (controller.signal.aborted) return
        const next = URL.createObjectURL(blob)
        setThumbnail(next)
        if (url) URL.revokeObjectURL(url)
        url = next
      } catch (failure) {
        if (!controller.signal.aborted) setError(String(failure instanceof Error ? failure.message : failure))
      } finally { loading = false }
    }
    void capture()
    const timer = setInterval(() => { void capture() }, 30_000)
    const onVisible = () => { if (!document.hidden) void capture() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); if (url) URL.revokeObjectURL(url) }
  }, [near, page.headless, closed, sessionId, page.handle, revision, targetSize.width, targetSize.height])

  async function act(action: 'show' | 'hide' | 'close' | 'records'): Promise<void> {
    if (busy || closed) return
    setBusy(true)
    setError(undefined)
    try {
      const response = await checked(await fetch(`${ROOT}${action === 'records' ? 'page-records' : 'page-action'}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, handle: page.handle, action }),
      }))
      if (action === 'records') {
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'page-records.zip'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
        // A native browser may cancel in-flight requests when a download starts.
        // Records do not change model usage, so the normal poll can refresh later.
        return
      }
      await refresh()
    } catch (failure) { setError(String(failure instanceof Error ? failure.message : failure)) }
    finally { setBusy(false) }
  }
  const opened = page.openedAt ?? page.opened
  const counts = page.usage ?? page.counts
  const rows: [string, ReactNode][] = [
    ['Handle', <code>{page.handle}</code>],
    ['Backend', <>{page.backend}{page.headless ? ' · headless' : ''}{closed && <span className="deepsea-browsers-closed"> closed</span>}</>],
    ['Title', page.title || '(no title)'],
    ['URL', <span className="deepsea-browsers-url">{page.url || 'about:blank'}</span>],
    ['Opened', opened ? new Date(opened).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : '—'],
    ['Usage', counts ? `${counts.commands ?? 0} commands · ${counts.screenshots ?? 0} screenshots · ${counts.scripts ?? 0} scripts` : '—'],
  ]
  return <article ref={root} className="deepsea-browsers-item" data-closed={closed || undefined} data-busy={busy || undefined} aria-label={page.title || page.handle}>
    <div className="deepsea-browsers-panels">
      <div ref={preview} className="deepsea-browsers-thumbnail" data-headless={page.headless || undefined}>
        {!page.headless && thumbnail ? <img src={thumbnail} alt={`Viewport of ${page.title || page.handle}`} /> : <span>{page.headless ? 'Headless' : closed ? 'Closed' : 'Loading…'}</span>}
      </div>
      <dl className="deepsea-browsers-details">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </div>
    <div className="deepsea-browsers-actions" aria-label="Page actions">
      <Tooltip label={visible ? 'Hide' : 'Show'}><button className="deepsea-browsers-action" aria-label={visible ? 'Hide' : 'Show'} disabled={busy || closed} onClick={() => { void act(visible ? 'hide' : 'show') }}>{visible ? <IconChevronDownOutlineRegular/> : <Eye/>}</button></Tooltip>
      <Tooltip label="Open in browser"><a className="deepsea-browsers-action" aria-label="Open in browser" aria-disabled={closed || busy} href={!closed && !busy && /^https?:/i.test(page.url) ? page.url : undefined} target="_blank" rel="noopener noreferrer"><IconShareOutlineRegular/></a></Tooltip>
      <Tooltip label="Download records"><button className="deepsea-browsers-action" aria-label="Download records" disabled={busy || closed} onClick={() => { void act('records') }}><IconDownloadOutlineRegular/></button></Tooltip>
      <span className="deepsea-browsers-status" role="status">{busy ? 'Working…' : error}</span>
      <Tooltip label="Close"><button className="deepsea-browsers-action deepsea-browsers-close" aria-label="Close" disabled={busy || closed} onClick={() => { void act('close') }}><IconTrashOutlineRegular/></button></Tooltip>
    </div>
  </article>
}

function BrowsersView({ browserSessionId }: { browserSessionId: string }): ReactNode {
  const [pages, setPages] = useState<Page[]>([])
  const [error, setError] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    const controller = new AbortController()
    let loading = false
    setPages([]); setLoaded(false); setError(undefined)
    const refresh = async (): Promise<void> => {
      if (loading || document.hidden) return
      loading = true
      try {
        const response = await checked(await fetch(`${ROOT}pages?${new URLSearchParams({ sessionId: browserSessionId })}`, { signal: controller.signal }))
        const result: { pages: Page[] } = await response.json()
        if (controller.signal.aborted) return
        setPages(result.pages); setLoaded(true); setError(undefined)
      } catch (failure) { if (!controller.signal.aborted) setError(String(failure instanceof Error ? failure.message : failure)) }
      finally { loading = false }
    }
    refreshRef.current = refresh
    void refresh()
    const timer = setInterval(() => { void refresh() }, 2000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [browserSessionId])
  return <div className="deepsea-browsers" data-deepsea-browsers-view="">
    <div className="deepsea-browsers-list">
      {error && <div className="deepsea-browsers-error" role="alert">{error}</div>}
      {!pages.length && <div className="deepsea-browsers-empty">{loaded ? 'No browser pages' : error ? '' : 'Loading…'}</div>}
      {pages.map(page => <PageRow key={`${browserSessionId}/${page.handle}`} page={page} sessionId={browserSessionId} refresh={() => refreshRef.current()}/>)}
    </div>
  </div>
}

/** Register the same conversation view seam used by session Drafts. */
export function registerBrowsersView(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.deepseaBrowsers = ''
    style.textContent = styles
    document.head.appendChild(style)
    return () => style.remove()
  })
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'deepsea-browsers', order: 30,
    label: () => 'Browsers', inject: browserSessionId => ({ browserSessionId }),
  }, BrowsersView))
}
