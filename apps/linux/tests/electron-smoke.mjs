// The app end to end, in Electron (under Xvfb: `xvfb-run -a electron
// tests/electron-smoke.mjs`; add `--no-sandbox` inside the Nix build sandbox).
// A fake DeepSea server on loopback (its GUI page and the forward route) and a
// dev server with an HMR socket; the dev server's port is taken here (it runs
// on this machine), so the forward is remapped. Nothing outside a temporary
// directory is touched; external opens and alerts are recorded, not shown.
import { app, BrowserWindow, Menu } from 'electron'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachEcho, createFakeHost } from './fake-host.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'deepsea-client-smoke-'))
process.env.XDG_CONFIG_HOME = join(scratch, 'config')
process.env.XDG_STATE_HOME = join(scratch, 'state')
delete process.env.DEEPSEA_LOG_ROOT

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
async function until(what, check, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await wait(50)
  }
}

app.whenReady().then(async () => {
  const sockets = new Set()
  const track = server => server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  const preview = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(`<p id="result">preview</p><script>
      const ws = new WebSocket('ws://localhost:${String(preview.address().port)}/hmr');
      ws.onopen = () => ws.send('hmr works');
      ws.onmessage = e => { document.querySelector('#result').textContent = e.data; parent.postMessage(e.data, '*'); };
    </script>`)
  })
  attachEcho(preview)
  track(preview)
  await new Promise(resolve => preview.listen(0, '127.0.0.1', resolve))
  const previewPort = preview.address().port

  const host = await createFakeHost({
    pages: (req, res) => {
      const path = new URL(req.url, 'http://x').pathname
      if (path === '/deepsea-test/fail') { res.writeHead(500).end('broken'); return true }
      if (path === '/deepsea-test/starting') { res.writeHead(503, { 'x-deepsea-relay': 'starting', 'Content-Type': 'text/html' }).end('<p id="relay">starting</p>'); return true }
      if (path !== '/deepsea-test/') return false
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // No 'unsafe-eval': the identity must not depend on it.
        'Content-Security-Policy': "script-src 'self' 'unsafe-inline'",
      })
      res.end(`<!doctype html><html><head><title>Chat — DSH Local Build</title>
        <script>window.__atStart = typeof globalThis.__DEEPSEA_APP__ + ':' + typeof (globalThis.__DEEPSEA_APP__ || {}).openExternal + ':' + document.documentElement.getAttribute('data-deepsea-view');</script>
        </head><body>
        <span class="x_brandMark">whale</span><span class="x_railMark">whale</span>
        <span class="x_localBuildTitle">DSH Local Build</span><span class="x_fallbackBrandName">DSH</span>
        <a id="away" href="https://example.com/away">away</a>
        <p id="result">waiting</p><iframe src="http://localhost:${String(previewPort)}/"></iframe>
        <script>onmessage = e => document.querySelector('#result').textContent = e.data;</script>
        </body></html>`)
      return true
    },
  })
  host.ports.add(previewPort)
  host.reserved.add(host.port)
  track(host.server)

  const timeout = setTimeout(() => { console.error('FAIL: Electron smoke test timed out'); app.exit(1) }, 60_000)
  let client
  try {
    process.argv = [process.execPath, fileURLToPath(new URL('../main.mjs', import.meta.url)), '--setup', '--hold-external', '--name', 'DeepSea Test', '--color', '#0090ff']
    const setupCreated = once(app, 'browser-window-created')
    client = await import('../main.mjs')
    const [, setup] = await setupCreated
    await once(setup.webContents, 'did-finish-load')
    const ask = js => setup.webContents.executeJavaScript(js)
    assert.equal(await ask('typeof window.deepseaClient.connect + typeof window.__DEEPSEA_APP__'), 'functionundefined')
    assert.match(await ask("window.deepseaClient.connect('http://box.example.com/')"), /needs https/)
    assert.match(await ask("window.deepseaClient.connect('')"), /Type the server/)

    // Connect through the form, the way a person does.
    const mainCreated = once(app, 'browser-window-created')
    await ask(`document.querySelector('#server').value = '127.0.0.1:${String(host.port)}/deepsea-test'; document.querySelector('form').requestSubmit()`)
    const [, window] = await mainCreated
    const contents = window.webContents
    const ses = contents.session
    await until('the GUI page', () => contents.getURL() === host.url && !contents.isLoading())
    const page = js => contents.executeJavaScript(js)

    // Routing: loopback through the forwarding proxy, the rest (and the server itself) direct.
    assert.equal(await ses.resolveProxy('https://example.com/'), 'DIRECT')
    assert.equal(await ses.resolveProxy(host.url), 'DIRECT')
    for (const name of ['localhost', 'app.localhost', '127.0.0.1', '[::1]']) {
      assert.match(await ses.resolveProxy(`http://${name}:${String(previewPort)}/`), /^PROXY 127\.0\.0\.1:\d+/, name)
    }

    // Identity at document start, with no eval and no Node in the page.
    assert.equal(await page('window.__atStart'), 'object:function:null')
    assert.deepEqual(await page('({ ...globalThis.__DEEPSEA_APP__, openExternal: typeof globalThis.__DEEPSEA_APP__.openExternal })'), { name: 'DeepSea Test', glyphColor: '#0090FF', view: 'desktop', openExternal: 'function' })
    assert.equal(await page('typeof require + typeof process + typeof window.deepseaClient'), 'undefinedundefinedundefined')
    const branding = async () => page(`({
      whale: getComputedStyle(document.querySelector('.x_brandMark')).color,
      rail: getComputedStyle(document.querySelector('.x_railMark')).color,
      label: getComputedStyle(document.querySelector('.x_localBuildTitle'), '::before').content,
      fallback: getComputedStyle(document.querySelector('.x_fallbackBrandName'), '::before').content,
      styles: document.querySelectorAll('#deepsea-app-identity').length,
    })`)
    const expected = { whale: 'rgb(0, 144, 255)', rail: 'rgb(0, 144, 255)', label: '"DeepSea Test"', fallback: '"DeepSea Test"', styles: 1 }
    assert.deepEqual(await branding(), expected)
    assert.equal(window.getTitle(), 'Chat — DeepSea Test')
    const userAgent = await page('navigator.userAgent')
    assert.match(userAgent, / DeepSea\/\d+\.\d+\.\d+$/)
    assert.doesNotMatch(userAgent, /Electron\//)

    // The preview frame: forwarded, unchanged URL, HMR socket through CONNECT, no identity.
    assert.equal(await until('HMR through the forward', async () => (await page("document.querySelector('#result').textContent")) === 'hmr works' && 'ok', 20_000), 'ok')
    const frame = contents.mainFrame.frames.find(f => f.url.includes(`localhost:${String(previewPort)}`))
    assert.ok(frame, 'the preview frame loaded at its own URL')
    assert.equal(await frame.executeJavaScript('typeof globalThis.__DEEPSEA_APP__'), 'undefined')
    const forwardRequest = host.requests.find(r => r.port === previewPort)
    assert.match(forwardRequest.headers['user-agent'], /^DeepSea\//)

    const ports = Menu.getApplicationMenu().items.find(item => item.label === 'Forwarded Ports').submenu.items
    assert.ok(ports[0].label.includes(`→ remote :${String(previewPort)}`), `remapped row: ${ports[0].label}`)
    assert.equal(ports.at(-1).label, 'Close All')

    // Links: a foreign link and openExternal go to the default browser; loopback is forwarded first.
    await page("document.querySelector('#away').click()")
    await until('the foreign link', () => client.testHooks.externalOpens.includes('https://example.com/away'))
    assert.equal(contents.getURL(), host.url, 'the page stayed')
    await page("__DEEPSEA_APP__.openExternal('https://example.com/opened'); __DEEPSEA_APP__.openExternal('javascript:alert(1)'); __DEEPSEA_APP__.openExternal('file:///etc/passwd')")
    await page(`__DEEPSEA_APP__.openExternal('http://localhost:${String(previewPort)}/dev?x=1')`)
    const local = await until('the forwarded link', () => client.testHooks.externalOpens.find(url => url.endsWith('/dev?x=1')))
    assert.match(local, /^http:\/\/127\.0\.0\.1:\d+\/dev\?x=1$/)
    assert.notEqual(new URL(local).port, String(previewPort))
    assert.ok(client.testHooks.externalOpens.includes('https://example.com/opened'))
    assert.ok(!client.testHooks.externalOpens.some(url => /^(javascript|file):/.test(url)))
    await page("__DEEPSEA_APP__.openExternal('http://localhost:1/')")
    await until('the refusal alert', () => client.testHooks.alerts.some(a => /127\.0\.0\.1:1 /.test(a.message) && /Nothing is listening/.test(a.detail)))

    // Reload keeps the identity (one style element).
    contents.reload()
    await until('the reload', async () => !contents.isLoading() && await page('document.readyState') === 'complete')
    assert.deepEqual(await branding(), expected)

    // View ▸ Mobile: attribute, identity, window size.
    const viewMenu = Menu.getApplicationMenu().items.find(item => item.label === 'View').submenu
    viewMenu.items.find(item => item.label === 'Mobile').click()
    await until('the mobile view', async () => (await page('document.documentElement.dataset.deepseaView + ":" + __DEEPSEA_APP__.view')) === 'mobile:mobile')
    const [width, height] = window.getContentSize() // Xvfb without a window manager may round by a pixel
    assert.ok(Math.abs(width - 390) <= 2 && Math.abs(height - 844) <= 2, `mobile size ${String(width)}×${String(height)}`)
    Menu.getApplicationMenu().items.find(item => item.label === 'View').submenu.items.find(item => item.label === 'Desktop').click()
    await until('the desktop view', async () => (await page('String(document.documentElement.dataset.deepseaView)')) === 'undefined')

    // A relay page shows as it is; an error status gets the failure page.
    await contents.loadURL(`${host.url}starting`).catch(() => {})
    assert.equal(await page("document.querySelector('#relay')?.textContent"), 'starting')
    void contents.loadURL(`${host.url}fail`).catch(() => {})
    await until('the failure page', () => contents.getURL().includes('/pages/offline.html'))
    await until('the failure text', async () => /HTTP 500/.test(await page("document.querySelector('#reason').textContent")))
    assert.equal(await page('typeof window.deepseaClient.retry + typeof window.__DEEPSEA_APP__'), 'functionundefined')
    // Reconnect from the page goes back to the GUI.
    await page("document.querySelector('#retry').click()")
    await until('the GUI again', () => contents.getURL() === host.url && !contents.isLoading())

    // Saved: the server and its identity; a run log was written.
    const saved = JSON.parse(readFileSync(join(scratch, 'config', 'io.github.taliesinb.deepsea', 'client', 'client.json'), 'utf8'))
    assert.deepEqual(saved, { view: 'desktop', url: host.url, name: 'DeepSea Test', glyphColor: '#0090FF' })
    const logs = readdirSync(join(scratch, 'state', 'io.github.taliesinb.deepsea', 'client'))
    assert.ok(logs.includes('latest.log'))
    const logText = readFileSync(join(scratch, 'state', 'io.github.taliesinb.deepsea', 'client', 'latest.log'), 'utf8')
    assert.match(logText.split('\n')[0], /io\.github\.taliesinb\.deepsea client pid \d+ DeepSea /)
    assert.match(logText, /forward: 127\.0\.0\.1:\d+ → remote 127\.0\.0\.1:/)

    // An unreachable server: the offline page, with automatic retries.
    host.close()
    await new Promise(resolve => host.server.close(resolve))
    contents.reload()
    void contents.loadURL(host.url).catch(() => {})
    await until('the offline page', async () => contents.getURL().includes('/pages/offline.html') && /unreachable|refused|CONNECTION/i.test(await page("document.querySelector('#title').textContent + document.querySelector('#reason').textContent")))

    console.log('PASS: connection form, routing, document-start identity and branding, HMR through a remapped forward, links and openExternal, refusal alert, reload, mobile view, relay and failure pages, reconnect, config and run log, offline page')
  } catch (error) {
    console.error('FAIL:', error)
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    app.emit('before-quit')
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    for (const socket of sockets) socket.destroy()
    preview.close()
    host.close()
    rmSync(scratch, { recursive: true, force: true })
    app.exit(process.exitCode ?? 0)
  }
})
