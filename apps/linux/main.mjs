/**
 * DeepSea for Linux — the Electron main process: one window on one DeepSea
 * server's web GUI, usually another machine's, reached on the tailnet.
 *
 *   - the server: the command line (`deepsea-client <server>`), else the saved
 *     one, else the connection form; short forms as in resolve.mjs;
 *   - on every connect the mount URL is probed (any HTTP answer counts: a
 *     relay answers 503 while its server starts); no answer shows the
 *     offline page, which retries every 5 s; a main-frame error status shows
 *     the failure page, except the relay's own pages (`x-deepsea-relay`),
 *     which show as they are;
 *   - one persistent browser store per server URL (paths.mjs), so cookies
 *     (a token's cookie) stay with their server;
 *   - the page identity at document start (preload.cjs) and the window
 *     title with "DSH Local Build" replaced;
 *   - links: the server's own pages stay in the app (window.open gets a
 *     second window), everything else opens in the default browser
 *     (`xdg-open`); loopback URLs name the SERVER's loopback, so their port is
 *     forwarded first (forward.mjs): frames and requests of the page through
 *     the session's loopback proxy, unchanged, links in the default browser
 *     on the forwarded local port; Forwarded Ports lists the forwards;
 *   - View ▸ Desktop / Mobile (390×844, `data-deepsea-view="mobile"`);
 *   - a run log per launch (paths.mjs).
 *
 * Flags: `--setup` (the form, even with a saved server), `--name <name>`,
 * `--color <#rrggbb>` (the app identity for this server; '' clears), and for
 * tests `--hold-external`: external opens and alerts are recorded in
 * `testHooks`, never shown.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRunLog } from '../../packages/logs/index.mjs'
import { describeForwardError, Forwarder, ForwardError, loopbackPort, loopbackRedirectPort, onLocalPort, startLoopbackProxy } from './forward.mjs'
import { cleanName, configDirectory, logDirectory, partitionOf, readConfig, ROOT_NAME, writeConfig } from './paths.mjs'
import { magicDnsSuffix, parseServerInput, Scope } from './resolve.mjs'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const VERSION = JSON.parse(readFileSync(here('./package.json'), 'utf8')).version
const APP_NAME = 'DeepSea'
/** The product title the shipped client uses for its wordmark and `document.title`. */
const GENERIC_TITLE = 'DSH Local Build'
const PAGES = new URL('./pages/', import.meta.url).href
const MOBILE = { width: 390, height: 844 }
const RETRY_MS = 5000
const ALERT_INTERVAL_MS = 30_000
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'loopback-network', 'local-network-access', 'local-network'])
const USAGE = `Usage: deepsea-client [<server>] [--setup] [--name <name>] [--color <#rrggbb>]

<server>: https://<node>.example.ts.net/deepsea/ (a ?token=… is used once),
          <host>, <user>@<host>, <host>/deepsea-<v>, <host>:<port>[/path]
Without a server: the saved one, else the connection form.
--setup   the connection form, even with a saved server
--name    the app's name in the page (wordmark, title); '' uses the server's own
--color   the whale's colour in the page; '' uses the server's own`

/** Recorded instead of shown with `--hold-external` (tests). */
export const testHooks = { externalOpens: [], alerts: [] }

export function parseArguments(argv) {
  const options = { setup: false, help: false, holdExternal: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--setup') options.setup = true
    else if (arg === '--hold-external') options.holdExternal = true
    else if (arg === '--name') options.name = argv[++index] ?? ''
    else if (arg === '--color') options.color = argv[++index] ?? ''
    else if (arg.startsWith('-')) { /* Chromium's and Electron's own switches */ }
    else options.server ??= arg
  }
  return options
}

const options = parseArguments(process.argv.slice(2))
const configFile = join(configDirectory(), 'client.json')
let config = readConfig(configFile)
let log

app.setName(APP_NAME)
app.setPath('userData', configDirectory())

function note(line) {
  try { log?.identify(line) } catch { /* the log is best effort */ }
}

function alert(message, detail, window) {
  note(`alert: ${message}${detail ? `: ${detail}` : ''}`)
  if (options.holdExternal) { testHooks.alerts.push({ message, detail }); return }
  const parent = window && !window.isDestroyed() ? window : undefined
  void (parent ? dialog.showMessageBox(parent, { type: 'warning', title: APP_NAME, message, detail }) : dialog.showMessageBox({ type: 'warning', title: APP_NAME, message, detail }))
}

// ---------------------------------------------------------------------------
// The server in use

/**
 * @typedef {{
 *   url: string, scope: Scope, session: Electron.Session, token?: string,
 *   window: BrowserWindow, forwarder: Forwarder, proxy: { port: number, close(): void },
 *   offline: boolean, connecting: boolean, retryTimer?: NodeJS.Timeout,
 *   desktopSize?: number[], failures: Map<number, { status: number, url: string }>,
 *   lastAlert: Map<number, number>, disposed: boolean,
 * }} Server
 */
/** @type {Server | undefined} */
let current
/** @type {BrowserWindow | undefined} */
let setupWindow
const configured = new WeakSet()

/**
 * What the preload gives a page of the server: the whole identity in a main frame; in a frame
 * (a remote session framed through remote-workspaces) only `openExternal`, so a sign-in there
 * asks with its own server's address. Nothing for a page of any other origin.
 */
function identityFor(state, href, frame) {
  if (state === undefined || !state.scope.contains(href)) return null
  if (frame) return { frame: true }
  return { name: config.name ?? '', glyphColor: config.glyphColor ?? '', view: config.view }
}

/**
 * The DeepSea server a page belongs to: the app's own for a main frame, else the directory of a
 * frame of the server's origin, another server's page framed through remote-workspaces
 * (`<mount>deepsea-remote-workspaces/servers/<id>/`, whose egress reaches that server).
 */
function pageServer(state, frame) {
  if (frame === null || frame === undefined || frame.parent === null) return state.url
  return new URL('.', frame.url).href
}

function userAgent() {
  const base = app.userAgentFallback
    .replace(/ Electron\/\S+/g, '')
    .replace(new RegExp(` ${APP_NAME}/\\S+`, 'g'), '')
  return `${base} DeepSea/${VERSION}`
}

function headerValue(headers, name) {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value.join(', ') : value
  }
  return undefined
}

/** Once per session: user agent, permissions, the main-frame status gate. */
function configureSession(ses) {
  if (configured.has(ses)) return
  configured.add(ses)
  ses.setUserAgent(userAgent())
  const allowed = (permission, origin) => {
    if (!ALLOWED_PERMISSIONS.has(permission)) return false
    try {
      return (current !== undefined && current.scope.contains(new URL(origin).origin + current.scope.mount.pathname)) || loopbackPort(origin) !== undefined
    } catch { return false }
  }
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, details.requestingUrl)))
  ses.setPermissionCheckHandler((_contents, permission, origin) => allowed(permission, origin))
  ses.webRequest.onHeadersReceived((details, callback) => {
    const status = details.statusCode
    if (details.resourceType === 'mainFrame' && (status < 200 || status >= 400) && headerValue(details.responseHeaders, 'x-deepsea-relay') === undefined
      && current !== undefined && current.session === ses) {
      // An error page of the server is replaced by the app's failure page; the relay's pages show as they are.
      current.failures.set(details.webContentsId, { status, url: details.url, line: details.statusLine })
      callback({ cancel: true })
      return
    }
    callback({})
  })
}

async function start(url, token) {
  stop(current)
  const ses = session.fromPartition(partitionOf(url))
  configureSession(ses)
  /** @type {Server} */
  const state = {
    url, scope: new Scope(url), session: ses, token, offline: true, connecting: false,
    failures: new Map(), lastAlert: new Map(), disposed: false,
  }
  state.forwarder = new Forwarder({
    mount: () => (state.offline ? undefined : state.url),
    headers: async (endpoint) => {
      const cookies = await ses.cookies.get({ url: endpoint })
      return {
        'User-Agent': `DeepSea/${VERSION}`,
        ...(cookies.length > 0 ? { Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } : {}),
      }
    },
    log: note,
  })
  let pendingMenu = false
  state.forwarder.on('change', () => {
    if (pendingMenu) return
    pendingMenu = true
    setImmediate(() => { pendingMenu = false; rebuildMenu() })
  })
  state.proxy = await startLoopbackProxy(state.forwarder, {
    onError: (port, error) => reportForwardFailure(state, port, error),
    redirect: (_port, target) => state.scope.resolve(`${target.pathname}${target.search}`),
  })
  // Loopback destinations go through the forwarding proxy, everything else
  // direct; the server itself is direct even when it is on loopback.
  const mount = state.scope.mount
  const own = loopbackPort(mount.href) === undefined ? '' : `;${mount.host}`
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${String(state.proxy.port)}`, proxyBypassRules: `*;<-loopback>${own}` })
  await ses.closeAllConnections()
  state.window = makeWindow(state)
  current = state
  note(`server: ${url}`)
  rebuildMenu()
  void connect(state)
  return state
}

function stop(state) {
  if (state === undefined || state.disposed) return
  state.disposed = true
  clearTimeout(state.retryTimer)
  state.forwarder.dispose()
  state.proxy.close()
  if (!state.window.isDestroyed()) state.window.destroy()
  if (current === state) current = undefined
}

function makeWindow(state) {
  const size = config.view === 'mobile' ? MOBILE : { width: 1280, height: 860 }
  const window = new BrowserWindow({
    title: config.name || APP_NAME,
    width: size.width,
    height: size.height,
    useContentSize: true,
    minWidth: 360,
    minHeight: 320,
    autoHideMenuBar: false,
    webPreferences: {
      session: state.session,
      preload: here('./preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The preload runs in frames too (still sandboxed, no Node): a frame of the server's origin
      // gets `openExternal` (identityFor); any other frame gets nothing.
      nodeIntegrationInSubFrames: true,
      webviewTag: false,
    },
  })
  if (config.view === 'mobile') state.desktopSize = [1280, 860]
  wireContents(state, window.webContents, true)
  window.on('closed', () => { if (current === state) stop(state) })
  return window
}

function wireContents(state, contents, main) {
  contents.setWindowOpenHandler(({ url }) => {
    if (state.scope.contains(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 720, autoHideMenuBar: true } }
    }
    openFromPage(state, url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', (window) => wireContents(state, window.webContents, false))
  contents.on('will-navigate', (event, url) => {
    const target = event.url ?? url
    if (/^(about|blob|data):/i.test(target) || target.startsWith(PAGES) || state.scope.contains(target)) return
    event.preventDefault()
    if (loopbackPort(target) !== undefined) {
      void forwardLoopback(state, target).then((local) => {
        if (local === undefined || contents.isDestroyed()) return
        if (state.scope.contains(local)) void contents.loadURL(local)
        else openExternal(local)
      })
      return
    }
    if (/^(https?|mailto):/i.test(target)) openExternal(target)
  })
  contents.on('will-attach-webview', event => event.preventDefault())
  contents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    const window = BrowserWindow.fromWebContents(contents)
    const name = config.name || APP_NAME
    const clean = String(title ?? '').replaceAll(GENERIC_TITLE, name).trim()
    window?.setTitle(clean === '' ? name : clean)
  })
  contents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') note(`[console ${event.level}] ${String(event.message).slice(0, 2000)}`)
  })
  contents.on('render-process-gone', (_event, details) => {
    note(`renderer gone: ${details.reason}`)
    if (main && !state.disposed) showOffline(state, { title: `${config.name || APP_NAME} stopped`, reason: `The page's process ended (${details.reason}).` })
  })
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || state.disposed) return
    const failure = state.failures.get(contents.id)
    if (failure !== undefined) {
      state.failures.delete(contents.id)
      note(`[navigation] HTTP ${String(failure.status)}: ${failure.url}`)
      if (main) showFailure(state, failure)
      return
    }
    if (code === -3) return // aborted: a new navigation replaced it, or a download
    note(`[navigation] ${description} (${String(code)}): ${url}`)
    if (main) showOffline(state, { reason: description, address: url })
  })
}

// ---------------------------------------------------------------------------
// Entry, offline and failure pages

/** Any HTTP answer means the server (or its relay) is there. */
async function probe(ses, url) {
  try {
    await ses.fetch(url, { method: 'HEAD', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(5000) })
    return true
  } catch { return false }
}

async function connect(state) {
  if (state.connecting || state.disposed) return
  state.connecting = true
  clearTimeout(state.retryTimer)
  const reachable = await probe(state.session, state.url)
  state.connecting = false
  if (state.disposed || state.window.isDestroyed()) return
  if (!reachable) {
    showOffline(state, { reason: 'The server does not answer. Is Tailscale connected, and is the server running?' })
    return
  }
  state.offline = false
  const first = state.token ? `${state.url}?token=${encodeURIComponent(state.token)}` : state.url
  state.token = undefined
  void state.window.loadURL(first).catch(() => {})
}

function appPage(name, params) {
  const url = new URL(name, PAGES)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value))
  return url.href
}

function showOffline(state, { title, reason, address, retry = true }) {
  if (state.disposed || state.window.isDestroyed()) return
  state.offline = true
  clearTimeout(state.retryTimer)
  void state.window.loadURL(appPage('offline.html', {
    title: title ?? `${config.name || APP_NAME} is unreachable`,
    reason,
    address: address ?? state.url,
    retry: retry ? '1' : '0',
  })).catch(() => {})
  if (retry) state.retryTimer = setTimeout(() => void connect(state), RETRY_MS)
}

function showFailure(state, failure) {
  const phrase = String(failure.line ?? '').replace(/^HTTP\/\S+\s+\d+\s*/, '') || 'error'
  const hint = failure.status === 401 || failure.status === 403
    ? ' Is this device\'s tailnet login admitted on the server? Otherwise connect with the server\'s token (https://…/?token=…).'
    : ''
  showOffline(state, {
    title: `${config.name || APP_NAME} failed to load`,
    reason: `The server returned HTTP ${String(failure.status)} ${phrase}.${hint}`,
    address: failure.url,
    retry: false,
  })
}

// ---------------------------------------------------------------------------
// Links and forwarding

function openExternal(url) {
  note(`[open-external] ${url}`)
  if (options.holdExternal) { testHooks.externalOpens.push(url); return }
  void shell.openExternal(url).catch(error => note(`open-external failed: ${error.message}`))
}

function openPopup(state, url) {
  const popup = new BrowserWindow({
    width: 960, height: 720, autoHideMenuBar: true, title: config.name || APP_NAME,
    webPreferences: { session: state.session, preload: here('./preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webviewTag: false },
  })
  wireContents(state, popup.webContents, false)
  void popup.loadURL(url).catch(() => {})
}

/**
 * A URL a page wants opened (window.open of a foreign URL, `__DEEPSEA_APP__.openExternal`), on
 * behalf of the server at `mount` (pageServer; default: the app's own).
 */
function openFromPage(state, raw, mount = state.url) {
  let url
  try { url = new URL(String(raw)) } catch { return }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return
  if (!state.scope.contains(url) && loopbackPort(url) !== undefined) {
    void forwardLoopback(state, url.href, mount).then((local) => {
      if (local === undefined) return
      if (state.scope.contains(local)) openPopup(state, local)
      else openExternal(local)
    })
    return
  }
  // A sign-in page whose redirect goes to a loopback callback: that callback listens on the
  // server's machine, so its port is forwarded here first.
  const callback = state.scope.contains(url) ? undefined : loopbackRedirectPort(url)
  if (callback !== undefined) {
    void forwardCallback(state, callback, mount).then(() => openExternal(url.href))
    return
  }
  if (state.scope.contains(url)) openPopup(state, url.href)
  else openExternal(url.href)
}

/**
 * Forward the port a loopback URL names from the server at `mount`; resolves the URL to use
 * here (the same, or on the substitute local port), that server's own page for its own port
 * (`reserved`), or undefined when refused (an alert says why).
 */
async function forwardLoopback(state, raw, mount = state.url) {
  const port = loopbackPort(raw)
  try {
    const row = await state.forwarder.ensure(port, { mount })
    return onLocalPort(raw, row.localPort)
  } catch (error) {
    if (error instanceof ForwardError && error.code === 'reserved') {
      const url = new URL(raw)
      return new URL(`${url.pathname.replace(/^\//, '')}${url.search}`, mount).href
    }
    reportForwardFailure(state, port, error)
    return undefined
  }
}

/**
 * Forward a sign-in's callback port from the server at `mount`, on exactly that port and for one
 * use. A port taken here is the sign-in's own listener (the server is on this machine after all),
 * and any other failure leaves the sign-in's own fallback (pasting the address the browser ended
 * on), so it never fails: the page opens either way.
 */
async function forwardCallback(state, port, mount) {
  try {
    const row = await state.forwarder.ensure(port, { mount, exact: true, singleUse: true })
    note(`forward: sign-in callback 127.0.0.1:${String(row.localPort)} → port ${String(port)} via ${mount}`)
  } catch (error) {
    note(`forward: sign-in callback ${String(port)} not forwarded (${String(error.code ?? '')} ${error.message}); opening the page as it is`)
  }
}

function reportForwardFailure(state, port, error) {
  note(`forward: ${String(port)}: ${error.code ?? ''} ${error.message}`)
  const now = Date.now()
  if (now - (state.lastAlert.get(port) ?? 0) < ALERT_INTERVAL_MS) return
  state.lastAlert.set(port, now)
  alert(`Cannot open 127.0.0.1:${String(port)} on the server's machine`, describeForwardError(error), state.window)
}

// ---------------------------------------------------------------------------
// Menus and view

function currentAddress() {
  if (current === undefined) return config.url
  const url = current.window.isDestroyed() ? '' : current.window.webContents.getURL()
  return current.scope.contains(url) ? url : current.url
}

function setView(view) {
  if (config.view === view) return
  config = { ...config, view }
  writeConfig(configFile, config)
  const state = current
  if (state !== undefined && !state.window.isDestroyed()) {
    const window = state.window
    if (view === 'mobile') {
      state.desktopSize = window.getContentSize()
      window.setContentSize(MOBILE.width, MOBILE.height)
    } else {
      const [width, height] = state.desktopSize ?? [1280, 860]
      window.setContentSize(width, height)
    }
    if (state.scope.contains(window.webContents.getURL())) {
      void window.webContents.executeJavaScript(`(() => {
        const root = document.documentElement;
        if (${JSON.stringify(view)} === 'mobile') root.setAttribute('data-deepsea-view', 'mobile'); else root.removeAttribute('data-deepsea-view');
        if (globalThis.__DEEPSEA_APP__) globalThis.__DEEPSEA_APP__.view = ${JSON.stringify(view)};
      })()`).catch(() => {})
    }
  }
  rebuildMenu()
}

function reload() {
  if (current === undefined) return
  if (current.offline) void connect(current)
  else current.window.webContents.reload()
}

function rebuildMenu() {
  const rows = current?.forwarder.rows ?? []
  const label = (row) => {
    const base = row.localPort === row.remotePort ? `127.0.0.1:${String(row.remotePort)}` : `127.0.0.1:${String(row.localPort)} → remote :${String(row.remotePort)}`
    return row.connections === 0 ? base : `${base}  (${String(row.connections)} connection${row.connections === 1 ? '' : 's'})`
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Change Server…', accelerator: 'CmdOrCtrl+Shift+O', click: () => openSetup() },
      { label: 'Open in Browser', enabled: config.url !== undefined, click: () => { const url = currentAddress(); if (url) openExternal(url) } },
      { label: 'Copy Address', enabled: config.url !== undefined, click: () => { const url = currentAddress(); if (url) clipboard.writeText(url) } },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: reload },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { label: 'Desktop', type: 'radio', checked: config.view !== 'mobile', click: () => setView('desktop') },
      { label: 'Mobile', type: 'radio', checked: config.view === 'mobile', click: () => setView('mobile') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { label: 'Forwarded Ports', submenu: rows.length === 0
      ? [{ label: 'No forwarded ports', enabled: false }]
      : [
          ...rows.map(row => ({ label: label(row), submenu: [
            { label: 'Copy URL', click: () => clipboard.writeText(`http://127.0.0.1:${String(row.localPort)}/`) },
            { label: 'Close', click: () => current?.forwarder.close(row.remotePort) },
          ] })),
          { type: 'separator' },
          { label: 'Close All', click: () => current?.forwarder.closeAll() },
        ] },
  ]))
}

// ---------------------------------------------------------------------------
// The connection form

function openSetup() {
  if (setupWindow !== undefined && !setupWindow.isDestroyed()) { setupWindow.focus(); return }
  setupWindow = new BrowserWindow({
    title: `${APP_NAME}: Connect`, width: 560, height: 420, useContentSize: true, autoHideMenuBar: true,
    webPreferences: { session: session.fromPartition('setup'), preload: here('./preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  })
  const window = setupWindow
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.on('closed', () => { if (setupWindow === window) setupWindow = undefined })
  void window.loadURL(appPage('connect.html', {})).catch(() => {})
}

/** Save the server with this run's identity flags (another server drops the old one's). */
function remember(url) {
  const next = { view: config.view, url }
  if (config.url === url) { next.name = config.name; next.glyphColor = config.glyphColor }
  if (options.name !== undefined) next.name = cleanName(options.name)
  if (options.color !== undefined) next.glyphColor = options.color
  writeConfig(configFile, next)
  config = readConfig(configFile)
}

const fromAppPage = (event) => String(event.senderFrame?.url ?? '').startsWith(PAGES)

function registerIpc() {
  ipcMain.on('deepsea-client:identity', (event, href) => {
    const frame = event.senderFrame !== null && event.senderFrame?.parent !== null
    event.returnValue = current !== undefined && event.sender.session === current.session ? identityFor(current, String(href), frame) : null
  })
  ipcMain.on('deepsea-client:open-external', (event, raw) => {
    const state = current
    if (state === undefined || event.sender.session !== state.session || !state.scope.contains(event.senderFrame?.url ?? '')) return
    openFromPage(state, raw, pageServer(state, event.senderFrame))
  })
  ipcMain.handle('deepsea-client:connect', async (event, input) => {
    if (!fromAppPage(event) || setupWindow === undefined || event.sender !== setupWindow.webContents) throw new Error('not the connection form')
    try {
      const { url, token } = await parseServerInput(input, { magicDnsSuffix: () => magicDnsSuffix() })
      remember(url)
      const form = setupWindow
      await start(url, token)
      form?.close()
      return null
    } catch (error) {
      return error.message
    }
  })
  ipcMain.handle('deepsea-client:details', (event) => {
    if (!fromAppPage(event)) return {}
    return { url: config.url ?? '', version: VERSION }
  })
  ipcMain.on('deepsea-client:retry', (event) => { if (fromAppPage(event) && current !== undefined) void connect(current) })
  ipcMain.on('deepsea-client:change-server', (event) => { if (fromAppPage(event)) openSetup() })
}

// ---------------------------------------------------------------------------
// Lifecycle

async function main() {
  log = openRunLog(logDirectory(), { identity: `${ROOT_NAME} client pid ${String(process.pid)} ${APP_NAME} ${VERSION} (Electron ${process.versions.electron})` })
  registerIpc()
  rebuildMenu()
  let target
  if (options.server !== undefined) {
    try {
      target = await parseServerInput(options.server, { magicDnsSuffix: () => magicDnsSuffix() })
    } catch (error) {
      alert(`Cannot use "${options.server}"`, error.message)
    }
  } else if (!options.setup && config.url !== undefined) {
    target = { url: config.url }
  }
  if (target !== undefined) {
    remember(target.url)
    await start(target.url, target.token)
  } else {
    openSetup()
  }
}

if (options.help) {
  console.log(USAGE)
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    const window = setupWindow ?? current?.window
    if (window !== undefined && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus() }
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => stop(current))
  // Not a top-level await: Electron waits for the entry module before it becomes ready.
  app.whenReady().then(main).catch((error) => {
    note(`startup failed: ${error.stack ?? error.message}`)
    dialog.showErrorBox(APP_NAME, error.message)
    app.exit(1)
  })
}
