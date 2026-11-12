// Person-facing, session-scoped Browsers API. Never enumerate daemon-wide sessions.
import sharp from 'sharp'
import { zip, strToU8 } from 'fflate'

export const BROWSERS_PREFIX = '/api/deepsea-tool-brow'
const REFRESH_MS = 30_000
const RETENTION_MS = 10 * 60_000
const MAX_RECORD_BYTES = 64 * 1024 * 1024
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const fail = (status, message) => Object.assign(new Error(message), { status })
const textOf = result => (result.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')

export function createBrowsersView({ link, sessions, now = Date.now }) {
  const pages = new Map()
  const records = new Map()
  const thumbnails = new Map()
  let sequence = 0
  const lastPageProbe = new Map()
  const pendingThumbnails = new Map()
  let watching = Promise.resolve()
  let daemonPid = link.current()?.hello?.pid
  const entriesFor = sessionId => [...sessions.values()].filter(e => e.agent?.session?.header?.id === sessionId)
  const keyOf = (session, handle) => `${session}\0${handle}`
  const owns = session => [...sessions.values()].some(e => e.key === session)
  function prune() {
    for (const [key, record] of records) if (!owns(record.session) || now() - record.touchedAt > RETENTION_MS && !pages.has(key)) records.delete(key)
    for (const [key, page] of pages) if (page.closedAt && now() - page.closedAt > RETENTION_MS || !owns(page.session)) {
      pages.delete(key); records.delete(key); thumbnails.delete(key)
    }
  }
  function merge(window) {
    if (!owns(window.session) || typeof window.handle !== 'string') return
    const key = keyOf(window.session, window.handle)
    const old = pages.get(key)
    const changed = !old || ['url', 'title', 'shown', 'headless'].some(k => window[k] !== undefined && window[k] !== old[k])
    pages.set(key, { ...old, ...window, closedAt: old?.closedAt, revision: changed ? ++sequence : old.revision })
  }
  async function watch(client = link.current()) {
    if (!client) return
    // Serialize replacements: an older filter must never win a race with a new session.
    watching = watching.catch(() => {}).then(async () => {
      const keys = [...sessions.values()].filter(e => e.client === client).map(e => e.key)
      const result = await client.request('window.watch', { sessions: keys })
      for (const window of result.windows ?? []) merge(window)
    })
    await watching.catch(() => {}) // Older daemons can still serve list/control without events.
  }
  link.onConnected(client => {
    if (daemonPid !== undefined && client.hello?.pid !== daemonPid) records.clear()
    daemonPid = client.hello?.pid
    pages.clear(); thumbnails.clear(); lastPageProbe.clear()
    return watch(client)
  })
  link.on('window.event', event => {
    if (!owns(event?.session) || typeof event.handle !== 'string') return
    const key = keyOf(event.session, event.handle)
    const old = pages.get(key)
    if (!old && event.kind !== 'opened') return
    if (event.kind === 'opened') {
      merge({ ...event, openedAt: event.openedAt ?? event.at })
      const page = pages.get(key)
      if (page) { page.closedAt = undefined; page.revision = ++sequence }
    }
    else if (event.kind === 'closed' || event.kind === 'lost') {
      pages.set(key, { ...old, closedAt: event.at ?? now(), revision: ++sequence })
      thumbnails.delete(key)
    } else if (['navigated', 'shown', 'parked'].includes(event.kind) || event.kind === 'command' && event.entry?.status === 'ok' && !['screenshot', 'read', 'logs'].includes(event.entry.kind)) {
      pages.set(key, { ...old, ...(event.url !== undefined ? { url: event.url } : {}), ...(event.title !== undefined ? { title: event.title } : {}), ...(event.kind === 'shown' ? { shown: true } : event.kind === 'parked' ? { shown: false } : {}), revision: ++sequence })
    }
  })
  function metadata(page) {
    const mode = link.current()?.hello?.mode
    const backend = page.browser === 'chrome' ? mode === 'user' ? 'Google Chrome' : 'Chrome for Testing'
      : page.browser === 'safari' ? mode === 'managed' ? 'WebKit' : mode === 'user' ? 'Safari' : 'Safari Technology Preview' : page.handle.split(':')[0]
    return { handle: page.handle, backend, title: page.title ?? '', url: page.url ?? '', opened: page.openedAt ?? null, headless: !!page.headless, visible: !!page.shown && !page.closedAt, ...(page.closedAt ? { closedAt: page.closedAt } : {}), revision: `${page.revision ?? 0}-${Math.floor(now() / REFRESH_MS)}`, usage: page.counts ?? { commands: 0, screenshots: 0, scripts: 0 } }
  }
  async function list(sessionId, signal) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw fail(400, 'sessionId required')
    prune()
    const entries = entriesFor(sessionId)
    const client = link.current()
    if (entries.length && !client) throw fail(503, 'brow daemon is disconnected')
    for (const entry of entries) {
      if (entry.client !== client) continue
      await entry.opening
      const probe = now() - (lastPageProbe.get(entry.key) ?? -Infinity) >= REFRESH_MS
      if (probe) lastPageProbe.set(entry.key, now())
      const result = await client.request('window.list', { session: entry.key, pages: probe }, { signal })
      const live = new Set()
      for (const window of result.windows ?? []) if (window.session === entry.key) { merge(window); live.add(window.handle) }
      for (const page of pages.values()) if (page.session === entry.key && !page.closedAt && !live.has(page.handle)) { page.closedAt = now(); page.revision = ++sequence }
    }
    const keys = new Set(entries.map(e => e.key))
    return { pages: [...pages.values()].filter(p => keys.has(p.session) && (!p.closedAt || now() - p.closedAt <= REFRESH_MS)).map(metadata), refreshMs: REFRESH_MS }
  }
  async function resolve(sessionId, handle, signal, allowClosed = false) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || typeof handle !== 'string' || !/^(chrome|safari):\d+:\d+$/.test(handle)) throw fail(400, 'sessionId and exact page handle required')
    await list(sessionId, signal)
    const entry = entriesFor(sessionId).find(e => pages.has(keyOf(e.key, handle)))
    const page = entry && pages.get(keyOf(entry.key, handle))
    if (!page || page.closedAt && !allowClosed) throw fail(404, 'page not found in this session')
    return { entry, page, client: link.current(), key: keyOf(entry.key, handle) }
  }
  async function tool(client, session, name, args, signal) {
    const result = await client.request('tools.call', { session, name, arguments: args, images: 'inline' }, { signal })
    const entry = [...sessions.values()].find(e => e.key === session)
    if (entry) recordCall(entry, name, args, result)
    if (result.isError) throw fail(502, result.error?.message ?? textOf(result) ?? 'browser capture failed')
    return result
  }
  async function thumbnail(sessionId, handle, revision, signal, width, height) {
    const hasTarget = width !== undefined || height !== undefined
    const dimension = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 2048
    if (hasTarget && (!dimension(width) || !dimension(height))) throw fail(400, 'width and height must both be integers from 1 to 2048 physical pixels')
    const target = hasTarget ? { width: Number(width), height: Number(height) } : undefined
    const targetKey = target ? `${target.width}x${target.height}` : 'default'
    const { page, entry, client, key } = await resolve(sessionId, handle, signal)
    const version = metadata(page).revision
    let cached = thumbnails.get(key)
    if (cached?.revision !== version) { cached = { revision: version, variants: new Map() }; thumbnails.set(key, cached) }
    if (cached.variants.has(targetKey)) return cached.variants.get(targetKey)
    const pendingKey = `${key}\0${version}\0${targetKey}`
    if (pendingThumbnails.has(pendingKey)) return pendingThumbnails.get(pendingKey)
    const pending = render()
    pendingThumbnails.set(pendingKey, pending)
    try { return await pending } finally { pendingThumbnails.delete(pendingKey) }
    async function render() {
      try {
        const native = await client.request('window.thumbnail', { session: entry.key, handle, ...(target ?? { width: 320, height: 320 }) }, { signal })
        if (!native || native.handle !== handle || !['image/jpeg', 'image/png', 'image/webp'].includes(native.mimeType) || typeof native.data !== 'string' || !Number.isInteger(native.width) || native.width < 1 || native.width > 2048 || !Number.isInteger(native.height) || native.height < 1 || native.height > 2048) throw fail(502, 'malformed native thumbnail response')
        const bytes = decodeBase64(native.data)
        const size = await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata()
        if (size.width !== native.width || size.height !== native.height || size.width > (target?.width ?? 320) || size.height > (target?.height ?? 320)) throw fail(502, 'native thumbnail dimensions do not match target')
        bytes.contentType = native.mimeType
        remember(bytes)
        return bytes
      } catch (error) {
        if (error.code !== -32601) throw error
      }
      const result = await tool(client, entry.key, 'browser_screenshot', { handle, format: 'png' }, signal)
      const image = result.content?.find(b => b.type === 'image')
      if (!image) throw fail(502, 'brow returned no screenshot')
      const source = Buffer.from(image.data, 'base64')
      const size = await sharp(source, { limitInputPixels: 80_000_000 }).metadata()
      // Explicit targets are physical pixels (CSS box × devicePixelRatio), not a fixed wire-area ratio.
      // Keep the legacy default only for clients that do not yet send target dimensions.
      const scale = Math.min(1 / Math.sqrt(32), 320 / Math.max(size.width, size.height))
      const bounds = target ?? { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
      const bytes = await sharp(source).resize({ ...bounds, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
      remember(bytes)
      return bytes
    }
    function remember(bytes) {
      // A resizing panel may request many boxes; retain only a bounded set of sizes per page revision.
      if (cached.variants.size >= 8) cached.variants.delete(cached.variants.keys().next().value)
      cached.variants.set(targetKey, bytes)
    }
  }
  async function action(sessionId, handle, action, signal) {
    if (!['show', 'hide', 'close'].includes(action)) throw fail(400, 'action must be show, hide, or close')
    const { entry, client } = await resolve(sessionId, handle, signal)
    const method = `window.${action === 'hide' ? 'park' : action}`
    const result = await client.request(method, { session: entry.key, handle }, { signal })
    recordCall(entry, method, { handle }, result)
    return { ok: true, ...result }
  }
  function recordCall(entry, name, args, result) {
    prune()
    const firstLine = textOf(result).split('\n', 1)[0]
    const tagged = /\[((?:chrome|safari):\d+:\d+)\]/.exec(firstLine) ?? /\bOpened ((?:chrome|safari):\d+:\d+)/.exec(firstLine)
    const handles = new Set(tagged ? [tagged[1]] : [])
    // Close/script reports can name several pages; only accept already-known pages of this owner.
    if (['browser_close', 'browser_script'].includes(name)) for (const match of textOf(result).matchAll(/\b(?:chrome|safari):\d+:\d+\b/g)) {
      if (pages.has(keyOf(entry.key, match[0]))) handles.add(match[0])
    }
    if (/^(chrome|safari):\d+:\d+$/.test(args?.handle)) handles.add(args.handle)
    if (result.error?.handle) handles.add(result.error.handle)
    for (const handle of handles) {
      const key = keyOf(entry.key, handle)
      const record = records.get(key) ?? { session: entry.key, touchedAt: now(), calls: [], results: [], screenshots: [], bytes: 0, truncated: false }
      record.touchedAt = now()
      const call = { at: now(), name, arguments: args }
      const bytes = Buffer.byteLength(JSON.stringify([call, result]))
      const totalBytes = [...records.values()].reduce((sum, item) => sum + item.bytes, 0)
      if (record.calls.length >= 200 || record.bytes + bytes > MAX_RECORD_BYTES || totalBytes + bytes > 128 * 1024 * 1024) record.truncated = true
      else {
        record.calls.push(call); record.results.push(result); record.bytes += bytes
        for (const block of result.content ?? []) if (block.type === 'image') record.screenshots.push({ data: block.data, mimeType: block.mimeType })
      }
      records.set(key, record)
    }
  }
  async function archive(sessionId, handle, signal) {
    const { entry, page, client, key } = await resolve(sessionId, handle, signal, true)
    const filename = archiveFilename(entry.label, now())
    try {
      const native = await client.request('window.records', { session: entry.key, handle }, { signal })
      if (native?.version !== 1 || native.session !== entry.key || native.handle !== handle || !Array.isArray(native.files) || native.files.length > 1000 || !native.manifest || typeof native.manifest !== 'object' || Array.isArray(native.manifest)) throw fail(502, 'malformed native records response')
      const files = Object.create(null)
      const seen = new Set()
      let totalBytes = 0
      for (const file of native.files) {
        if (!file || typeof file.path !== 'string' || file.path.length > 240 || !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(file.path) || typeof file.mimeType !== 'string' || typeof file.data !== 'string' || !['base64', 'utf8'].includes(file.encoding)) throw fail(502, 'unsafe or malformed native record file')
        seen.add(file.path)
        const bytes = file.encoding === 'base64' ? decodeBase64(file.data) : strToU8(file.data)
        totalBytes += bytes.byteLength
        if (totalBytes > 256 * 1024 * 1024) throw fail(502, 'native records exceed archive size limit')
        files[file.path] = bytes
      }
      let details = {}
      if (files['page.json']) {
        try { details = JSON.parse(Buffer.from(files['page.json']).toString('utf8')) } catch { throw fail(502, 'malformed native page.json') }
        if (!details || typeof details !== 'object' || Array.isArray(details)) throw fail(502, 'malformed native page.json')
      }
      files['page.json'] = strToU8(JSON.stringify({ ...details, ...metadata(page), capturedAt: details.capturedAt ?? now(), recordsSource: 'native-window.records', manifest: native.manifest }, null, 2))
      files['manifest.json'] = strToU8(JSON.stringify(native.manifest, null, 2))
      return { bytes: await zipFiles(files), filename }
    } catch (error) {
      if (error.code !== -32601) throw error
    }
    const files = {}
    const limitations = ['page.html is the current serialized DOM, NOT the originally downloaded response HTML. Brow has no original-source export RPC. No refetch is made.', 'Captures are sequential, not an atomic snapshot. Brow tool captures count as commands and may affect idle timers.', 'Tool outputs and screenshots only include calls observed by this plugin process (not earlier calls, other clients, or individual calls inside browser_script). Retention: at most 200 calls and 64 MiB per page, 128 MiB across this plugin process.', 'Brow window.history is bounded to 200 entries and retains closed pages for ten minutes. Full-viewport screenshot is not full-page.']
    const errors = {}
    const capture = async (filename, fn) => { try { files[filename] = await fn() } catch (error) { errors[filename] = String(error.message); files[`${filename}.unavailable.txt`] = strToU8(String(error.message)) } }
    const history = await client.request('window.history', { session: entry.key, handle, limit: 200 }, { signal }).catch(error => ({ error: String(error.message) }))
    if (!page.closedAt) {
      await capture('page.html', async () => {
        const result = await tool(client, entry.key, 'browser_eval', { handle, expression: 'return { deepseaDom: document.documentElement.outerHTML }' }, signal)
        const text = textOf(result)
        const start = text.indexOf('{"deepseaDom":')
        if (start < 0) throw new Error('Unrecognized Brow DOM result framing')
        const value = JSON.parse(text.slice(start))
        if (typeof value.deepseaDom !== 'string') throw new Error('Brow returned no DOM HTML')
        return strToU8(value.deepseaDom)
      })
      await capture('page.md', async () => strToU8(textOf(await tool(client, entry.key, 'browser_read', { handle, format: 'markdown', scope: 'page', expand: false, maxChars: 2_000_000 }, signal))))
      await capture('page.png', async () => {
        const result = await tool(client, entry.key, 'browser_screenshot', { handle, format: 'png', fullPage: false }, signal)
        const image = result.content?.find(b => b.type === 'image')
        if (!image) throw new Error('Brow returned no image')
        return Buffer.from(image.data, 'base64')
      })
    } else {
      for (const filename of ['page.html', 'page.md', 'page.png']) files[`${filename}.unavailable.txt`] = strToU8('Page is closed; no live capture is available.')
    }
    const record = records.get(key)
    files['page.json'] = strToU8(JSON.stringify({ ...metadata(page), htmlSource: 'serialized-dom-not-original-response', capturedAt: now(), limitations, errors, historyTruncated: record?.truncated ?? false }, null, 2))
    files['tool-calls.jsonl'] = strToU8((record?.calls ?? []).map((call, i) => JSON.stringify({ ...call, resultIndex: i })).join('\n') + '\n')
    files['tool-results.json'] = strToU8(JSON.stringify(record?.results ?? [], null, 2))
    files['command-history.json'] = strToU8(JSON.stringify(history, null, 2))
    for (const [i, image] of (record?.screenshots ?? []).entries()) files[`screenshots/${String(i + 1).padStart(4, '0')}.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png'}`] = Buffer.from(image.data, 'base64')
    files['manifest.json'] = strToU8(JSON.stringify({ recordsSource: 'legacy-tools-fallback', fallbackReason: 'window.records method unavailable on this daemon', limitations, errors, originalHtmlAvailable: false, screenshots: record?.screenshots.length ?? 0 }, null, 2))
    return { bytes: await zipFiles(files), filename }
  }
  return { list, thumbnail, action, archive, recordCall, watch }
}

function zipFiles(files) {
  return new Promise((resolve, reject) => {
    zip(files, (error, bytes) => error ? reject(error) : resolve(bytes))
  })
}
function archiveFilename(label, timestamp) {
  const safeLabel = String(label ?? 'session').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 70) || 'session'
  return `${new Date(timestamp).toISOString().replace(/[:]/g, '-')}.${safeLabel}.page-records.zip`
}

function decodeBase64(data) {
  if (data.length > 360 * 1024 * 1024 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fail(502, 'malformed or oversized native base64 data')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) throw fail(502, 'noncanonical native base64 data')
  return bytes
}

export function registerBrowsersRoutes(ctx, view) {
  const paths = []
  for (const [suffix, method] of [['pages', 'GET'], ['thumbnail', 'GET'], ['page-action', 'POST'], ['page-records', 'POST']]) {
    const path = `${BROWSERS_PREFIX}/${suffix}`
    paths.push(path)
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register({ path, methods: [method], requestBody: 'buffered', fetch: async request => {
        try {
          let body
          if (method === 'POST') {
            if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'body must be JSON' }, 415)
            try { body = await request.json() } catch { return json({ error: 'body must be JSON' }, 400) }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'body must be an object' }, 400)
          } else body = Object.fromEntries(new URL(request.url).searchParams)
          if (suffix === 'pages') return json(await view.list(body.sessionId, request.signal))
          if (suffix === 'thumbnail') {
            const bytes = await view.thumbnail(body.sessionId, body.handle, body.revision, request.signal, body.width, body.height)
            return new Response(bytes, { headers: { 'content-type': bytes.contentType ?? 'image/jpeg', 'cache-control': 'no-store' } })
          }
          if (suffix === 'page-action') return json(await view.action(body.sessionId, body.handle, body.action, request.signal))
          const { bytes, filename } = await view.archive(body.sessionId, body.handle, request.signal)
          return new Response(bytes, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' } })
        } catch (error) { return json({ error: error.status ? error.message : 'brow request failed' }, error.status ?? (error.code === -32601 ? 501 : error.code === -32602 ? 404 : 502)) }
      } })
      return () => { void dispose() }
    }, `tool-brow: ${suffix} route`)
  }
  return paths
}
