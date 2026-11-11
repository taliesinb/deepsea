import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { unzipSync, strFromU8 } from 'fflate'
import { createBrowsersView, registerBrowsersRoutes } from '../browsers-view.mjs'

async function fixture({ nativeThumbnail, nativeRecords, nativeError } = {}) {
  let clock = 1_000_000
  const calls = []
  const handlers = new Map()
  const hooks = []
  const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const windows = [
    { session: 'agent-A', handle: 'chrome:0:1', browser: 'chrome', title: 'A', url: 'https://example.com/a', openedAt: 100, headless: true, shown: false, counts: { commands: 2, screenshots: 1, scripts: 0 } },
    { session: 'agent-B', handle: 'chrome:1:1', browser: 'chrome', title: 'B', url: 'https://example.com/b', openedAt: 200, headless: false, shown: true },
  ]
  const client = { hello: { pid: 100 }, async request(method, params) {
    calls.push({ method, params })
    if (['window.thumbnail', 'window.records'].includes(method)) {
      if (nativeError) throw nativeError
      if (method === 'window.thumbnail' && nativeThumbnail) return nativeThumbnail(params, png)
      if (method === 'window.records' && nativeRecords) return nativeRecords(params, png)
      throw Object.assign(new Error('method not found'), { code: -32601 })
    }
    if (method === 'window.watch') return { windows: windows.filter(w => params.sessions.includes(w.session)) }
    if (method === 'window.list') return { windows: windows.filter(w => params.session === w.session) }
    if (method === 'window.history') return { entries: [{ id: '1', kind: 'navigate', status: 'ok', text: 'navigate()' }] }
    if (method === 'tools.call') {
      const content = params.name === 'browser_screenshot' ? [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]
        : [{ type: 'text', text: params.name === 'browser_eval' ? `[${params.arguments.handle}]\n${JSON.stringify({ deepseaDom: '<html><body>DOM</body></html>' })}` : `[${params.arguments.handle}]\n# Page` }]
      return { content, isError: false }
    }
    if (['window.show', 'window.park', 'window.close'].includes(method)) return { handle: params.handle, shown: method === 'window.show' }
    throw new Error(`unexpected method ${method}`)
  } }
  const sessions = new Map([
    ['agent-A', { key: 'agent-A', client, label: 'Session A', agent: { id: 'agent-A', session: { header: { id: 'session-A' } } } }],
    ['agent-B', { key: 'agent-B', client, label: 'Session B', agent: { id: 'agent-B', session: { header: { id: 'session-B' } } } }],
  ])
  let connected = client
  const link = { current: () => connected, onConnected: f => hooks.push(f), on: (name, fn) => handlers.set(name, fn) }
  const view = createBrowsersView({ link, sessions, now: () => clock })
  const routes = new Map()
  const disposers = []
  registerBrowsersRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } }, effect(fn) { disposers.push(fn()) } }, view)
  const request = (suffix, data, method = 'GET') => routes.get(`/api/deepsea-tool-brow/${suffix}`).fetch(new Request(`http://example.com/api/deepsea-tool-brow/${suffix}${method === 'GET' ? '?' + new URLSearchParams(data) : ''}`, method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {}))
  return { view, calls, windows, sessions, client, request, reconnect: async pid => { client.hello.pid = pid; for (const hook of hooks) await hook(client) }, event: e => handlers.get('window.event')(e), tick: ms => { clock += ms }, disconnect: () => { connected = undefined }, dispose: () => disposers.forEach(f => f()), routes, png }
}

test('listing resolves persisted session header id, never agent id or unrelated sessions', async () => {
  const f = await fixture()
  const result = await f.view.list('session-A')
  assert.equal(result.refreshMs, 30000)
  assert.deepEqual(result.pages.map(p => p.handle), ['chrome:0:1'])
  assert.equal(result.pages[0].opened, 100)
  assert.equal(result.pages[0].headless, true)
  assert.deepEqual((await f.view.list('agent-A')).pages, [])
  assert.ok(f.calls.every(c => c.params.session === 'agent-A'))
  f.event({ session: 'unrelated', handle: 'chrome:9:1', kind: 'opened', title: 'Secret' })
  assert.equal((await f.view.list('session-A')).pages.length, 1)
  await assert.rejects(f.view.list(''), { status: 400 })
})

test('scoped watch, event revisions, close retention and disposal filtering', async () => {
  const f = await fixture()
  await f.view.watch()
  assert.deepEqual(f.calls[0].params.sessions, ['agent-A', 'agent-B'])
  const before = (await f.view.list('session-A')).pages[0].revision
  f.event({ session: 'agent-A', handle: 'chrome:0:1', kind: 'command', entry: { kind: 'click', status: 'ok' } })
  assert.notEqual((await f.view.list('session-A')).pages[0].revision, before)
  f.windows.splice(0, 1)
  f.event({ session: 'agent-A', handle: 'chrome:0:1', kind: 'closed', at: 1_000_000 })
  assert.equal((await f.view.list('session-A')).pages[0].closedAt, 1_000_000)
  f.tick(600_001)
  assert.deepEqual((await f.view.list('session-A')).pages, [])
  f.sessions.delete('agent-B')
  assert.deepEqual((await f.view.list('session-B')).pages, [])
})

test('thumbnail is genuinely resized server-side to 1/32 area, bounded, cached', async () => {
  const f = await fixture()
  const bytes = await f.view.thumbnail('session-A', 'chrome:0:1', '0')
  const size = await sharp(bytes).metadata()
  assert.equal(size.width, 283)
  assert.equal(size.height, 159)
  assert.equal(size.format, 'jpeg')
  await f.view.thumbnail('session-A', 'chrome:0:1', 'arbitrary')
  assert.equal(f.calls.filter(c => c.method === 'tools.call').length, 1)
  f.tick(30000)
  await f.view.thumbnail('session-A', 'chrome:0:1')
  assert.equal(f.calls.filter(c => c.method === 'tools.call').length, 2)
  await assert.rejects(f.view.thumbnail('session-A', 'chrome:1:1'), { status: 404 })
})

test('controls use native methods and scope every operation; exact handles only', async () => {
  const f = await fixture()
  for (const action of ['show', 'hide', 'close']) await f.view.action('session-A', 'chrome:0:1', action)
  assert.deepEqual(f.calls.filter(c => ['window.show', 'window.park', 'window.close'].includes(c.method)).map(c => [c.method, c.params.session]), [['window.show', 'agent-A'], ['window.park', 'agent-A'], ['window.close', 'agent-A']])
  await assert.rejects(f.view.action('session-A', 'chrome:1:1', 'close'), { status: 404 })
  await assert.rejects(f.view.action('session-A', 'chrome', 'close'), { status: 400 })
  await assert.rejects(f.view.action('session-A', 'chrome:0:1', 'delete'), { status: 400 })
})

test('ZIP has requested artifact names, observed results/screenshots, honest DOM provenance', async () => {
  const f = await fixture()
  const entry = f.sessions.get('agent-A')
  const result = { content: [{ type: 'text', text: '[chrome:0:1]\nScreenshot' }, { type: 'image', data: f.png.toString('base64'), mimeType: 'image/png' }], isError: false }
  f.view.recordCall(entry, 'browser_screenshot', { handle: 'chrome:0:1' }, result)
  const { bytes, filename } = await f.view.archive('session-A', 'chrome:0:1')
  assert.match(filename, /^.*\.Session-A\.page-records\.zip$/)
  const files = unzipSync(bytes)
  for (const name of ['page.html', 'page.md', 'page.png', 'page.json', 'tool-calls.jsonl', 'tool-results.json', 'screenshots/0001.png', 'manifest.json']) assert.ok(files[name], name)
  assert.equal(strFromU8(files['page.html']), '<html><body>DOM</body></html>')
  assert.equal(JSON.parse(strFromU8(files['manifest.json'])).originalHtmlAvailable, false)
  assert.equal(JSON.parse(strFromU8(files['page.json'])).htmlSource, 'serialized-dom-not-original-response')
  assert.equal(JSON.parse(strFromU8(files['tool-calls.jsonl']).split('\n')[0]).name, 'browser_screenshot')
  assert.deepEqual(JSON.parse(strFromU8(files['tool-results.json']))[0], result)
  assert.deepEqual(files['screenshots/0001.png'], new Uint8Array(f.png))
  await assert.rejects(f.view.archive('session-A', 'chrome:1:1'), { status: 404 })
})

test('Fetch routes validate JSON, return attachment/image MIME and unregister', async () => {
  const f = await fixture()
  assert.equal((await f.request('pages', { sessionId: 'session-A' })).status, 200)
  assert.equal((await f.request('pages', {})).status, 400)
  assert.match((await f.request('thumbnail', { sessionId: 'session-A', handle: 'chrome:0:1' })).headers.get('content-type'), /image\/jpeg/)
  const zip = await f.request('page-records', { sessionId: 'session-A', handle: 'chrome:0:1' }, 'POST')
  assert.equal(zip.headers.get('content-type'), 'application/zip')
  assert.match(zip.headers.get('content-disposition'), /attachment; filename=/)
  const bad = await f.routes.get('/api/deepsea-tool-brow/page-action').fetch(new Request('http://example.com', { method: 'POST', body: '{}' }))
  assert.equal(bad.status, 415)
  f.disconnect()
  assert.equal((await f.request('pages', { sessionId: 'session-A' })).status, 503)
  f.dispose()
  assert.equal(f.routes.size, 0)
})

test('lost/closed events cannot be resurrected by stale list snapshots; opened revives', async () => {
  const f = await fixture()
  await f.view.list('session-A')
  f.event({ session: 'agent-A', handle: 'chrome:0:1', kind: 'lost', at: 1_000_000 })
  assert.equal((await f.view.list('session-A')).pages[0].closedAt, 1_000_000)
  await assert.rejects(f.view.thumbnail('session-A', 'chrome:0:1'), { status: 404 })
  f.event({ session: 'agent-A', handle: 'chrome:0:1', kind: 'opened', at: 1_000_001, reopened: true })
  assert.equal((await f.view.list('session-A')).pages[0].closedAt, undefined)
})

test('open output is recorded, per-page bounds are disclosed rather than silently fabricating history', async () => {
  const f = await fixture()
  const entry = f.sessions.get('agent-A')
  const result = { content: [{ type: 'text', text: 'Opened chrome:0:1 (Chrome for Testing).' }], isError: false }
  for (let i = 0; i < 201; i++) f.view.recordCall(entry, 'browser_open', { url: 'about:blank' }, result)
  const { bytes } = await f.view.archive('session-A', 'chrome:0:1')
  const files = unzipSync(bytes)
  const calls = strFromU8(files['tool-calls.jsonl']).trim().split('\n').map(JSON.parse)
  assert.equal(calls.length, 200)
  assert.equal(calls[0].name, 'browser_open')
  assert.equal(JSON.parse(strFromU8(files['page.json'])).historyTruncated, true)
})

test('live page title probes run at most every 30s; cheap metadata polls in between', async () => {
  const f = await fixture()
  await f.view.list('session-A')
  await f.view.list('session-A')
  f.tick(30_000)
  await f.view.list('session-A')
  assert.deepEqual(f.calls.filter(c => c.method === 'window.list').map(c => c.params.pages), [true, false, true])
})

test('same-daemon reconnect preserves observed records; a new daemon pid clears reused-handle records', async () => {
  const f = await fixture()
  const result = { content: [{ type: 'text', text: 'Opened chrome:0:1 (Chrome for Testing).' }], isError: false }
  f.view.recordCall(f.sessions.get('agent-A'), 'browser_open', {}, result)
  await f.reconnect(100)
  let files = unzipSync((await f.view.archive('session-A', 'chrome:0:1')).bytes)
  assert.equal(JSON.parse(strFromU8(files['tool-calls.jsonl']).split('\n')[0]).name, 'browser_open')
  await f.reconnect(200)
  files = unzipSync((await f.view.archive('session-A', 'chrome:0:1')).bytes)
  assert.ok(!strFromU8(files['tool-calls.jsonl']).includes('browser_open'))
})

test('Retina target dimensions are physical pixels; 640px is not capped to 320 and has a separate cache variant', async () => {
  const f = await fixture()
  const small = await f.request('thumbnail', { sessionId: 'session-A', handle: 'chrome:0:1', width: '320', height: '180' })
  const large = await f.request('thumbnail', { sessionId: 'session-A', handle: 'chrome:0:1', width: '640', height: '360' })
  const smallBytes = Buffer.from(await small.arrayBuffer())
  const largeBytes = Buffer.from(await large.arrayBuffer())
  const smallSize = await sharp(smallBytes).metadata()
  const largeSize = await sharp(largeBytes).metadata()
  assert.deepEqual([smallSize.width, smallSize.height], [320, 180])
  assert.deepEqual([largeSize.width, largeSize.height], [640, 360])
  assert.ok(largeBytes.length > smallBytes.length)
  await f.request('thumbnail', { sessionId: 'session-A', handle: 'chrome:0:1', width: '320', height: '180' })
  await f.request('thumbnail', { sessionId: 'session-A', handle: 'chrome:0:1', width: '640', height: '360' })
  assert.equal(f.calls.filter(c => c.method === 'tools.call').length, 2)
})

test('thumbnail target bounds validate both dimensions before capture and preserve aspect ratio without upscaling', async () => {
  const f = await fixture()
  for (const target of [{ width: '0', height: '100' }, { width: '2049', height: '100' }, { width: '1.5', height: '100' }, { width: 'NaN', height: '100' }, { width: '100' }, { height: '100' }, { width: '', height: '100' }]) {
    const response = await f.request('thumbnail', { sessionId: 'session-A', handle: 'chrome:0:1', ...target })
    assert.equal(response.status, 400, JSON.stringify(target))
  }
  assert.equal(f.calls.length, 0)
  const box = await f.view.thumbnail('session-A', 'chrome:0:1', undefined, undefined, 640, 640)
  const boxSize = await sharp(box).metadata()
  assert.deepEqual([boxSize.width, boxSize.height], [640, 360])
  const oversized = await f.view.thumbnail('session-A', 'chrome:0:1', undefined, undefined, 2048, 2048)
  const size = await sharp(oversized).metadata()
  assert.deepEqual([size.width, size.height], [1600, 900])
})

test('native thumbnail uses scoped physical target, preserves image MIME, caches without model tools', async () => {
  const f = await fixture({ nativeThumbnail: async (params, png) => {
    assert.deepEqual(params, { session: 'agent-A', handle: 'chrome:0:1', width: 640, height: 360 })
    const bytes = await sharp(png).resize({ width: params.width, height: params.height, fit: 'inside' }).png().toBuffer()
    return { handle: params.handle, data: bytes.toString('base64'), mimeType: 'image/png', width: 640, height: 360, sourceWidth: 1600, sourceHeight: 900, devicePixelRatio: 2, capturedAt: 123 }
  } })
  const response = await f.request('thumbnail', { sessionId: 'session-A', handle: 'chrome:0:1', width: '640', height: '360' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width, 640)
  await f.request('thumbnail', { sessionId: 'session-A', handle: 'chrome:0:1', width: '640', height: '360' })
  assert.equal(f.calls.filter(c => c.method === 'window.thumbnail').length, 1)
  assert.equal(f.calls.filter(c => c.method === 'tools.call').length, 0)
})

const nativeRecordReply = params => ({ version: 1, session: params.session, handle: params.handle, files: [
  { path: 'page.html', mimeType: 'text/html', encoding: 'utf8', data: '<html>Original captured response</html>' },
  { path: 'page.md', mimeType: 'text/markdown', encoding: 'utf8', data: '# Native markdown' },
  { path: 'page.json', mimeType: 'application/json', encoding: 'utf8', data: JSON.stringify({ capturedAt: 123, htmlSource: 'captured-main-resource-response', title: 'native title', source: { devicePixelRatio: 2 } }) },
  { path: 'tool-calls.jsonl', mimeType: 'application/x-ndjson', encoding: 'utf8', data: '{"id":"native-1"}\n' },
  { path: 'tool-results.json', mimeType: 'application/json', encoding: 'utf8', data: '[{"id":"native-1","value":"ok"}]' },
], manifest: { retention: { maxCalls: 200 }, omissions: [] } })

test('native records ZIP retains native source artifacts, outputs and provenance and merges same UI metadata', async () => {
  const f = await fixture({ nativeRecords: async (params, png) => {
    assert.deepEqual(params, { session: 'agent-A', handle: 'chrome:0:1' })
    const reply = nativeRecordReply(params)
    reply.files.push({ path: 'page.png', mimeType: 'image/png', encoding: 'base64', data: png.toString('base64') }, { path: 'screenshots/0001.png', mimeType: 'image/png', encoding: 'base64', data: png.toString('base64') })
    return reply
  } })
  const { bytes } = await f.view.archive('session-A', 'chrome:0:1')
  const files = unzipSync(bytes)
  const details = JSON.parse(strFromU8(files['page.json']))
  assert.equal(details.title, 'A')
  assert.equal(details.backend, 'Chrome for Testing')
  assert.equal(details.htmlSource, 'captured-main-resource-response')
  assert.equal(details.capturedAt, 123)
  assert.deepEqual(details.source, { devicePixelRatio: 2 })
  assert.equal(details.recordsSource, 'native-window.records')
  assert.match(strFromU8(files['page.html']), /Original captured response/)
  assert.deepEqual(JSON.parse(strFromU8(files['manifest.json'])).omissions, [])
  assert.deepEqual(files['page.png'], new Uint8Array(f.png))
  assert.ok(files['screenshots/0001.png'])
  assert.equal(f.calls.filter(c => c.method === 'tools.call' || c.method === 'window.history').length, 0)
})

test('native capture errors never silently use the legacy fallback', async () => {
  for (const code of [-32602, -32603, -1]) {
    const f = await fixture({ nativeError: Object.assign(new Error('capture failed'), { code }) })
    await assert.rejects(f.view.thumbnail('session-A', 'chrome:0:1', undefined, undefined, 640, 360), /capture failed/)
    await assert.rejects(f.view.archive('session-A', 'chrome:0:1'), /capture failed/)
    assert.equal(f.calls.filter(c => c.method === 'tools.call').length, 0)
  }
})

test('native records reject traversal, duplicate paths, invalid encodings and wrong ownership', async () => {
  const malformed = [
    reply => { reply.files[0].path = '../page.html' },
    reply => { reply.files[0].path = '/page.html' },
    reply => { reply.files[0].path = 'screenshots/../page.html' },
    reply => { reply.files[0].path = 'screenshots\\page.html' },
    reply => { reply.files.push({ ...reply.files[0] }) },
    reply => { reply.files[0].encoding = 'binary' },
    reply => { reply.files[0].encoding = 'base64'; reply.files[0].data = '!!notbase64!!' },
    reply => { reply.files[0].data = 123 },
    reply => { reply.session = 'agent-B' },
    reply => { reply.handle = 'chrome:1:1' },
  ]
  for (const mutate of malformed) {
    const f = await fixture({ nativeRecords: params => { const reply = nativeRecordReply(params); mutate(reply); return reply } })
    await assert.rejects(f.view.archive('session-A', 'chrome:0:1'), { status: 502 })
    assert.equal(f.calls.filter(c => c.method === 'tools.call').length, 0)
  }
})

test('native thumbnail rejects untrusted dimensions and ownership instead of recapturing through model tools', async () => {
  for (const wrong of [{ handle: 'chrome:1:1' }, { width: 900 }, { data: 'garbage!' }]) {
    const f = await fixture({ nativeThumbnail: async (params, png) => {
      const image = await sharp(png).resize(320, 180).png().toBuffer()
      return { handle: params.handle, mimeType: 'image/png', data: image.toString('base64'), width: 320, height: 180, ...wrong }
    } })
    await assert.rejects(f.view.thumbnail('session-A', 'chrome:0:1', undefined, undefined, 320, 180), { status: 502 })
    assert.equal(f.calls.filter(c => c.method === 'tools.call').length, 0)
  }
})
