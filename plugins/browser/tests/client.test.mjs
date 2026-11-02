// The browser half (lib/client.js, built by `pnpm build` or on install): loaded under a fake
// `window.__ModuleLoader__` with stub platform modules, what `apply(ctx)` registers, the screenshot row
// rendered for every result shape it must cover (claiming a toolview key replaces the generic card for all
// of them), and the window cooperation with the DeepSea app against a fake app bridge and fake routes.
// React comes from the harness through the linked ui-primitives package (React is a platform module).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = resolve(here, '../lib/client.js')
const require = createRequire(import.meta.url)
const fromPrimitives = createRequire(require.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json'))
const React = fromPrimitives('react')
const { renderToStaticMarkup } = fromPrimitives('react-dom/server')
const jsxRuntime = fromPrimitives('react/jsx-runtime')

/** Stand-ins for the shell's primitives: enough structure to assert on. */
const primitives = {
  DisclosureRow: ({ icon, title, open, expandable, collapsedContent, children }) =>
    React.createElement('div', { 'data-disclosure': title, 'data-open': open, 'data-expandable': expandable },
      icon,
      React.createElement('span', { className: 'title' }, title),
      collapsedContent,
      open ? React.createElement('div', { className: 'body' }, children) : null),
  StateDot: ({ state }) => React.createElement('i', { 'data-dot': state }),
  IconGlobeOutlineRegular: () => React.createElement('i', { 'data-icon': 'globe' }),
}
const platform = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': { createPortal: (node) => node },
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}

function loadBundle() {
  assert.ok(existsSync(bundlePath), `lib/client.js missing: run pnpm build (${bundlePath})`)
  let loaded
  const saved = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
  try {
    new Function(readFileSync(bundlePath, 'utf8'))()
  } finally {
    globalThis.window = saved
  }
  assert.ok(loaded, 'the bundle did not call window.__ModuleLoader__.load')
  const requires = []
  const mod = loaded.factory((id) => {
    requires.push(id)
    if (!(id in platform)) throw new Error(`non-platform require: ${id}`)
    return platform[id]
  })
  return { id: loaded.id, mod, requires }
}

// The shape a live session records for an inline capture.
const attachment = {
  attachmentId: 'sha256:87b661f4e7bf001bdfdfceb57764bef07004e1ca3bb11f56460f0aeec0dd7bb9',
  mediaType: 'image/webp', width: 780, height: 1480, bytes: 27250, name: 'safari-1790106281948.png',
}
const argsRaw = JSON.stringify({ fullPage: false })
const settledOk = {
  kind: 'tool-result', callId: 'c1', isError: false, time: 2000, callTime: 1000, meta: undefined,
  call: { argsRaw },
  content: [{ type: 'image', attachment }, { type: 'text', text: '[s:8:0]; 780×1480 px; viewport; 82 kB png' }],
}
const settledSpilled = {
  ...settledOk, call: { argsRaw: JSON.stringify({ windowId: 'c:0:4' }) },
  content: [{ type: 'image', attachment }, { type: 'text', text: 'Opened c:0:4. [c:0:4]; 2560×1440 px; viewport; 2.2 MB png (≥ 2 MB: chrome-devtools-mcp wrote it to disk; read back by the plugin — format: "jpeg" or a uid crop gives a smaller capture)' }],
}
const settledFile = {
  ...settledOk,
  content: [{ type: 'text', text: '[c:0:1]; 2560×1440 px; viewport; 1.2 MB png; saved to /var/folders/x/T/deepsea-browser-chrome-screenshot-1.png; not shown inline: model "m" does not declare image input. View it with read_image' }],
}
const settledError = {
  ...settledOk, isError: true, error: { name: 'HarnessError', code: 'TOOL_ERROR' },
  content: [{ type: 'text', text: 'chrome_get_screenshot: server tool take_screenshot failed: No page with uid 3_7\nRequest: {"uid":"3_7"}\nHint: chrome_snapshot again' }],
}
const settledAborted = { ...settledOk, isError: true, error: { name: 'HarnessError', code: 'ABORTED' }, content: [] }
const running = { callId: 'c1', argsRaw: JSON.stringify({ querySelector: '#hero' }), time: 1000 }

const loadImage = Object.assign(async () => 'blob:resolved', { peek: () => 'blob:peeked' })
const render = (Row, props) => renderToStaticMarkup(React.createElement(Row, { loadImage, ...props }))
/** Render with the disclosure open (the row owns its open state). */
function renderOpen(Row, props) {
  const real = primitives.DisclosureRow
  primitives.DisclosureRow = (rowProps) => real({ ...rowProps, open: rowProps.expandable })
  try { return render(Row, props) } finally { primitives.DisclosureRow = real }
}

test('bundle: its id is the package name and only platform modules are required', () => {
  const { id, requires } = loadBundle()
  assert.equal(id, '@deepsea/browser')
  assert.ok(requires.includes('react') && requires.includes('@deepseek-ai/dsh-client-ui-primitives'))
})

test('apply registers one toolview per inline-screenshot tool, and the cooperation is inert outside the app', () => {
  const { mod } = loadBundle()
  assert.equal(mod.name, 'deepsea-browser')
  assert.deepEqual(mod.inject, ['slots'])
  const registered = []
  const effects = []
  const ctx = {
    effect(run) { effects.push(run()) },
    slots: {
      inject: (slot, cb) => { assert.equal(slot, 'tool.call.toolview'); cb() },
      register: (spec, component) => { registered.push({ spec, component }); return () => {} },
    },
  }
  mod.apply(ctx)
  assert.deepEqual(registered.map(r => r.spec), [
    { name: 'tool.call.toolview', key: 'chrome_get_screenshot' },
    { name: 'tool.call.toolview', key: 'safari_get_screenshot' },
  ])
  for (const r of registered) assert.equal(r.component, mod.ScreenshotRow)
  assert.equal(typeof effects[0], 'function', 'a disposer, even with no window')
})

test('a settled capture: the summary is window · target; open, the image (not JSON) and the result text', () => {
  const { mod } = loadBundle()
  const collapsed = render(mod.ScreenshotRow, { toolName: 'safari_get_screenshot', block: settledOk, callId: 'c1' })
  assert.match(collapsed, /Safari screenshot/)
  assert.match(collapsed, />s:8:0 · viewport</)
  assert.doesNotMatch(collapsed, /82 kB|780×1480 px ·/, 'size and bytes stay out of the summary')
  assert.match(collapsed, /font-size:var\(--dsh-content-font-size-secondary/, 'typed like the shipped title')
  assert.match(collapsed, /data-tool="safari_get_screenshot" data-state="ok"/)
  assert.match(collapsed, /data-expandable="true"/)
  assert.match(collapsed, /data-icon="globe"/)
  assert.doesNotMatch(collapsed, /<img|attachmentId/)
  const open = renderOpen(mod.ScreenshotRow, { toolName: 'safari_get_screenshot', block: settledOk, callId: 'c1' })
  assert.match(open, /<img[^>]*src="blob:peeked"/, 'drawn from the session loader')
  assert.match(open, /width="390"/, 'point size = device pixels / 2')
  assert.match(open, /\[s:8:0\]; 780×1480 px; viewport; 82 kB png/)
  assert.doesNotMatch(open, /"attachmentId"/)
  assert.doesNotMatch(open, /click to enlarge/i, 'no help text')
})

test('the spill note and an "Opened" prefix never reach the summary', () => {
  const { mod } = loadBundle()
  const html = render(mod.ScreenshotRow, { toolName: 'chrome_get_screenshot', block: settledSpilled, callId: 'c1' })
  assert.match(html, />c:0:4 · viewport</)
  assert.doesNotMatch(html, /wrote it to disk|Opened c:0:4/)
})

test('the file fallback: text, no image, still expandable', () => {
  const { mod } = loadBundle()
  const html = renderOpen(mod.ScreenshotRow, { toolName: 'chrome_get_screenshot', block: settledFile, callId: 'c1' })
  assert.match(html, /Chrome screenshot/)
  assert.match(html, />c:0:1 · viewport · saved to file</)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /saved to \/var\/folders\/x\/T\/deepsea-browser-chrome-screenshot-1\.png/)
})

test('error, interrupted and running shapes', () => {
  const { mod } = loadBundle()
  const error = render(mod.ScreenshotRow, { toolName: 'chrome_get_screenshot', block: settledError, callId: 'c1' })
  assert.match(error, /data-state="error"/)
  assert.match(error, /data-dot="error"/)
  assert.match(error, /No page with uid 3_7/)
  assert.doesNotMatch(error, /Request: /, 'only the first line is the summary')
  const aborted = render(mod.ScreenshotRow, { toolName: 'chrome_get_screenshot', block: settledAborted, callId: 'c1' })
  assert.match(aborted, /data-state="stopped"/)
  assert.match(aborted, />interrupted</)
  assert.match(aborted, /data-expandable="true"/, 'the error name and code stay readable')
  const live = render(mod.ScreenshotRow, { toolName: 'safari_get_screenshot', block: running, callId: 'c1' })
  assert.match(live, /data-state="running"/)
  assert.match(live, /data-dot="ongoing"/)
  assert.match(live, /capturing element &quot;#hero&quot;…/)
  assert.match(live, /data-expandable="false"/)
})

// ---------------------------------------------------------------- window cooperation

/** A fake page inside the DeepSea app: the message handler, events, the published window, and fetch. */
function fakeApp({ published } = {}) {
  const listeners = new Map()
  const posted = []
  const requests = []
  let commands = []
  const page = {
    webkit: { messageHandlers: { deepseaApp: { postMessage: (body) => posted.push(body) } } },
    __DEEPSEA_APP_WINDOW__: published,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    dispatch: (type, detail) => listeners.get(type)?.({ detail }),
  }
  const app = { missing: false }
  const fetch = async (url, init = {}) => {
    requests.push({ url, method: init.method ?? 'GET', body: init.body, type: init.headers?.['content-type'] })
    if (app.missing) return new Response('{}', { status: 404 })
    if (String(url).startsWith('./api/deepsea-browser/app-command')) {
      // A long poll: answer a queued command, else hold briefly.
      const command = commands.shift()
      if (!command) await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(JSON.stringify(command ? { command } : {}), { status: 200 })
    }
    return new Response('{"ok":true}', { status: 200 })
  }
  return Object.assign(app, { page, fetch, posted, requests, listeners, queue: (command) => commands.push(command) })
}

async function withApp(app, run) {
  const saved = { window: globalThis.window, fetch: globalThis.fetch }
  globalThis.window = app.page
  globalThis.fetch = app.fetch
  try { return await run() } finally { globalThis.window = saved.window; globalThis.fetch = saved.fetch }
}

test('cooperation: reports go to the server, set-frame comes back to the app, nothing after dispose', async () => {
  const { mod } = loadBundle()
  const report = { pid: 4410, bundleId: 'io.github.taliesinb.deepsea.release', frame: { x: 0, y: 34, width: 1200, height: 900 } }
  const app = fakeApp({ published: report })
  await withApp(app, async () => {
    const dispose = mod.startAppCooperation({ debounceMs: 5, missingRouteMs: 10 })
    try {
      assert.ok(app.listeners.has('deepsea-app-window'))
      await new Promise(resolve => setTimeout(resolve, 30))
      const posts = app.requests.filter(r => r.method === 'POST')
      assert.equal(posts.length, 1)
      assert.equal(posts[0].url, './api/deepsea-browser/app-window')
      assert.equal(posts[0].type, 'application/json')
      assert.deepEqual(JSON.parse(posts[0].body), report)
      assert.ok(app.requests.some(r => r.url === './api/deepsea-browser/app-command?pid=4410'))
      const frame = { x: 0, y: 34, width: 1000, height: 900 }
      app.queue({ type: 'set-frame', frame })
      await new Promise(resolve => setTimeout(resolve, 60))
      assert.deepEqual(app.posted, [{ type: 'set-frame', frame }])
      // A move: the event's report is relayed (debounced).
      app.page.dispatch('deepsea-app-window', { ...report, frame })
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.deepEqual(JSON.parse(app.requests.filter(r => r.method === 'POST').at(-1).body).frame, frame)
      dispose()
      assert.ok(!app.listeners.has('deepsea-app-window'))
      const count = app.requests.length
      await new Promise(resolve => setTimeout(resolve, 60))
      assert.ok(app.requests.length <= count + 1, 'polling stops (at most the poll in flight finishes)')
    } finally {
      dispose()
    }
  })
})

test('cooperation: a server without the routes gets no reports until they are back', async () => {
  const { mod } = loadBundle()
  const report = { pid: 4410, bundleId: 'io.github.taliesinb.deepsea.release', frame: { x: 0, y: 34, width: 1200, height: 900 } }
  const app = fakeApp({ published: report })
  app.missing = true
  await withApp(app, async () => {
    const dispose = mod.startAppCooperation({ debounceMs: 5, missingRouteMs: 40 })
    try {
      await new Promise(resolve => setTimeout(resolve, 20))
      for (let i = 0; i < 3; i++) app.page.dispatch('deepsea-app-window', { ...report, frame: { ...report.frame, x: i } })
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.ok(app.requests.some(r => r.method === 'GET'), 'the command route was asked')
      assert.equal(app.requests.filter(r => r.method === 'POST').length, 0, 'answered 404: no reports')
      app.missing = false
      await new Promise(resolve => setTimeout(resolve, 120))
      const posts = app.requests.filter(r => r.method === 'POST')
      assert.equal(posts.length, 1, 'the route is back: the latest report goes out')
      assert.equal(JSON.parse(posts[0].body).frame.x, 2)
    } finally {
      dispose()
    }
  })
})

test('cooperation: without a published window it asks the app for one', async () => {
  const { mod } = loadBundle()
  const app = fakeApp()
  await withApp(app, async () => {
    const dispose = mod.startAppCooperation()
    assert.deepEqual(app.posted, [{ type: 'window-info' }])
    assert.equal(app.requests.length, 0)
    dispose()
  })
})

test('cooperation: a page outside the DeepSea app does nothing', async () => {
  const { mod } = loadBundle()
  const app = fakeApp()
  delete app.page.webkit
  await withApp(app, async () => {
    mod.startAppCooperation()()
    assert.equal(app.listeners.size, 0)
    assert.equal(app.requests.length, 0)
  })
})
