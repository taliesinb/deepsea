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
  content: [{ type: 'image', attachment }, { type: 'text', text: '[safari:8:0]\nviewport, 780×1480 px, 82 kB png' }],
}
const settledOpened = {
  ...settledOk, call: { argsRaw: JSON.stringify({}) },
  content: [{ type: 'image', attachment }, { type: 'text', text: 'Opened chrome:0:4. Installed Chrome for Testing 157.0.8103.38 (first use, 9 s). [chrome:0:4]\nviewport, 2560×1440 px, 2.2 MB png' }],
}
const settledFile = {
  ...settledOk,
  content: [{ type: 'text', text: '[chrome:0:1]\nviewport, 2560×1440 px, 1.2 MB png; not shown inline (model "m" does not declare image input); saved to /var/folders/x/T/deepsea-tool-brow-screenshot-1.png, view it with read_image' }],
}
const settledError = {
  ...settledOk, isError: true, error: { name: 'HarnessError', code: 'TOOL_ERROR' },
  content: [{ type: 'text', text: 'browser_screenshot: chrome server tool take_screenshot failed: No page with uid 3_7\nRequest: {"target":{"uid":"3_7"}}\nHint: read format "a11y" again' }],
}
const settledAborted = { ...settledOk, isError: true, error: { name: 'HarnessError', code: 'ABORTED' }, content: [] }
const running = { callId: 'c1', argsRaw: JSON.stringify({ target: { selector: '#hero' } }), time: 1000 }
const navigated = {
  ...settledOk, call: { argsRaw: JSON.stringify({ url: 'https://example.com/', screenshot: true }) },
  content: [{ type: 'image', attachment }, { type: 'text', text: '[safari:0:2]\nLoaded https://example.com/ — "Example Domain"\nscreenshot: viewport, 780×1480 px, 82 kB png' }],
}

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
  assert.equal(id, '@deepsea/tool-brow')
  assert.ok(requires.includes('react') && requires.includes('@deepseek-ai/dsh-client-ui-primitives'))
})

test('apply registers one toolview per tool that can carry a screenshot, and the cooperation is inert outside the app', () => {
  const { mod } = loadBundle()
  assert.equal(mod.name, 'deepsea-tool-brow')
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
  assert.deepEqual(registered.map(r => r.spec.key), ['browser_screenshot', 'browser_navigate', 'browser_eval', 'browser_act', 'browser_script'])
  for (const r of registered) assert.equal(r.component, mod.BrowserRow)
  assert.equal(typeof effects[0], 'function', 'a disposer, even with no window')
})

test('a settled capture: the summary is window · target; open, the image (not JSON) and the result text', () => {
  const { mod } = loadBundle()
  const collapsed = render(mod.BrowserRow, { toolName: 'browser_screenshot', block: settledOk, callId: 'c1' })
  assert.match(collapsed, /Safari screenshot/)
  assert.match(collapsed, />safari:8:0 · viewport</)
  assert.doesNotMatch(collapsed, /82 kB/, 'size and bytes stay out of the summary')
  assert.match(collapsed, /font-size:var\(--dsh-content-font-size-secondary/, 'typed like the shipped title')
  assert.match(collapsed, /data-tool="browser_screenshot" data-state="ok"/)
  assert.match(collapsed, /data-icon="globe"/)
  assert.doesNotMatch(collapsed, /<img|attachmentId/)
  const open = renderOpen(mod.BrowserRow, { toolName: 'browser_screenshot', block: settledOk, callId: 'c1' })
  assert.match(open, /<img[^>]*src="blob:peeked"/, 'drawn from the session loader')
  assert.match(open, /width="390"/, 'point size = device pixels / 2')
  assert.match(open, /viewport, 780×1480 px, 82 kB png/)
  assert.doesNotMatch(open, /"attachmentId"/)
})

test('notes before the tag (opened, installed) never reach the summary; the browser comes from the handle', () => {
  const { mod } = loadBundle()
  const html = render(mod.BrowserRow, { toolName: 'browser_screenshot', block: settledOpened, callId: 'c1' })
  assert.match(html, /Chrome screenshot/)
  assert.match(html, />chrome:0:4 · viewport</)
  assert.doesNotMatch(html, />[^<]*Installed Chrome/)
})

test('navigate with a screenshot: the load line is the summary, the image is drawn', () => {
  const { mod } = loadBundle()
  const collapsed = render(mod.BrowserRow, { toolName: 'browser_navigate', block: navigated, callId: 'c1' })
  assert.match(collapsed, /Safari navigate/)
  assert.match(collapsed, />safari:0:2 · Loaded https:\/\/example.com\/ — &quot;Example Domain&quot;</)
  assert.match(renderOpen(mod.BrowserRow, { toolName: 'browser_navigate', block: navigated, callId: 'c1' }), /<img/)
  const evalRow = render(mod.BrowserRow, { toolName: 'browser_eval', block: { ...settledOk, call: { argsRaw: JSON.stringify({ handle: 'chrome', expression: 'return 1' }) }, content: [{ type: 'text', text: '[chrome:0:0]\n1' }] }, callId: 'c1' })
  assert.match(evalRow, /Chrome script/)
  assert.match(evalRow, />chrome:0:0 · 1</)
})

test('browser_script: the run\'s headline; a failed run is an error row with its screenshot; help and running shapes', () => {
  const { mod } = loadBundle()
  const report = (text, extra = []) => ({ ...settledOk, call: { argsRaw: JSON.stringify({ action: 'start', file: 'login.browser.js' }) }, content: [...extra, { type: 'text', text }] })
  const passed = render(mod.BrowserRow, { toolName: 'browser_script', block: report('[run:17] login.browser.js · passed in 1.2 s · 3 calls · chrome\n✓ open (0.4 s)\nreturned: {"ok":true}'), callId: 'c1' })
  assert.match(passed, /Chrome script run/)
  assert.match(passed, />run:17 · login.browser.js · passed in 1.2 s · 3 calls · chrome</)
  assert.match(passed, /data-state="ok"/)
  const failedBlock = report('NOTE: the brow daemon restarted (pid 1 → 2); this chat\'s earlier browser windows are gone. [run:18] login.browser.js · FAILED after 9.8 s · 9 calls · safari\n✗ dashboard (5.1 s)\nAt failure: safari:0:4 http://localhost/ (kept open)', [{ type: 'image', attachment }])
  const failed = render(mod.BrowserRow, { toolName: 'browser_script', block: failedBlock, callId: 'c1' })
  assert.match(failed, /Safari script run/)
  assert.match(failed, /data-state="error"/)
  assert.match(failed, />run:18 · login.browser.js · FAILED after 9.8 s · 9 calls · safari</)
  const failedOpen = renderOpen(mod.BrowserRow, { toolName: 'browser_script', block: failedBlock, callId: 'c1' })
  assert.match(failedOpen, /<img/, 'the failure screenshot is drawn, not printed as JSON')
  assert.match(failedOpen, /At failure: safari:0:4/)
  const cancelled = render(mod.BrowserRow, { toolName: 'browser_script', block: report('[run:19] inline script · CANCELLED after 2.0 s · 1 call · chrome, safari'), callId: 'c1' })
  assert.match(cancelled, /data-state="stopped"/)
  assert.match(cancelled, /Browser script run/, 'two browsers: no single one in the title')
  assert.match(cancelled, />run:19 · inline script · CANCELLED/)
  const help = render(mod.BrowserRow, { toolName: 'browser_script', block: { ...settledOk, call: { argsRaw: JSON.stringify({ action: 'help' }) }, content: [{ type: 'text', text: 'Browser scripts: an async program…\nmore' }] }, callId: 'c1' })
  assert.match(help, />Browser scripts: an async program…</)
  const live = render(mod.BrowserRow, { toolName: 'browser_script', block: { callId: 'c1', argsRaw: JSON.stringify({ action: 'start', source: '\n  await navigate("https://example.com")\nreturn 1' }), time: 1 }, callId: 'c1' })
  assert.match(live, />start await navigate\(&quot;https:\/\/example.com&quot;\)…</)
})

test('the file fallback: text, no image, still expandable', () => {
  const { mod } = loadBundle()
  const html = renderOpen(mod.BrowserRow, { toolName: 'browser_screenshot', block: settledFile, callId: 'c1' })
  assert.match(html, /Chrome screenshot/)
  assert.match(html, />chrome:0:1 · viewport · saved to file</)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /saved to \/var\/folders\/x\/T\/deepsea-tool-brow-screenshot-1\.png/)
})

test('error, interrupted and running shapes', () => {
  const { mod } = loadBundle()
  const error = render(mod.BrowserRow, { toolName: 'browser_screenshot', block: settledError, callId: 'c1' })
  assert.match(error, /data-state="error"/)
  assert.match(error, /data-dot="error"/)
  assert.match(error, /No page with uid 3_7/)
  assert.doesNotMatch(error, /Request: /, 'only the first line is the summary')
  const aborted = render(mod.BrowserRow, { toolName: 'browser_screenshot', block: settledAborted, callId: 'c1' })
  assert.match(aborted, /data-state="stopped"/)
  assert.match(aborted, />interrupted</)
  const live = render(mod.BrowserRow, { toolName: 'browser_screenshot', block: running, callId: 'c1' })
  assert.match(live, /data-state="running"/)
  assert.match(live, /data-dot="ongoing"/)
  assert.match(live, /element &quot;#hero&quot;…/)
  assert.match(live, /Browser screenshot/)
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
    if (String(url).startsWith('./api/deepsea-tool-brow/app-command')) {
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
      assert.equal(posts[0].url, './api/deepsea-tool-brow/app-window')
      assert.equal(posts[0].type, 'application/json')
      assert.deepEqual(JSON.parse(posts[0].body), report)
      assert.ok(app.requests.some(r => r.url === './api/deepsea-tool-brow/app-command?pid=4410'))
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
