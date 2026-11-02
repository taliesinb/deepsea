'use strict'
/*
 * The one preload of every window (sandboxed, context-isolated), run at
 * document start in every frame:
 *
 *   - the app's own pages (pages/*.html, file:) get `window.deepseaClient`:
 *     connect, retry, change server, details;
 *   - a page of the server (in scope, checked by the main process) gets the
 *     app identity in its own world, as the macOS app's document-start
 *     scripts set it: `globalThis.__DEEPSEA_APP__ = { name, glyphColor, view,
 *     openExternal }`, `<html data-deepsea-view="mobile">` in the mobile view,
 *     and, when a name or colour is set, the style that renames the sidebar
 *     wordmark and colours the whale (the macOS app's desktop-branding.js).
 *     `openExternal` reaches the main process through the one bridged
 *     function `__DEEPSEA_APP_NATIVE__.openExternal`, which accepts http,
 *     https and mailto only;
 *   - a frame of the server's origin (a remote session framed through
 *     remote-workspaces) gets only `openExternal`, which the main process
 *     answers on behalf of that frame's own server.
 *
 * Anything else (another site, a loopback preview) gets nothing.
 */
const { contextBridge, ipcRenderer, webFrame } = require('electron')

/**
 * Runs in the page's own world (serialized: self-contained). Leaves the
 * server's own branding (@deepsea/variant-identity) alone when no name or
 * colour is set.
 */
function applyIdentity(identity) {
  const label = String(identity.name ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim()
  const colour = String(identity.glyphColor ?? '').toUpperCase()
  const hex = /^#[0-9A-F]{6}$/.test(colour) && colour !== '#000000' ? colour : ''
  const view = identity.view === 'mobile' ? 'mobile' : 'desktop'
  const native = globalThis.__DEEPSEA_APP_NATIVE__
  globalThis.__DEEPSEA_APP__ = Object.assign(globalThis.__DEEPSEA_APP__ || {}, {
    name: label,
    glyphColor: hex,
    view,
    openExternal: (url) => { try { native.openExternal(String(url)) } catch { /* bridge gone */ } },
  })
  const rules = []
  if (label) {
    rules.push(
      'span[class*="_localBuildTitle"],span[class*="_fallbackBrandName"]{display:flex!important;font-size:0!important}',
      `span[class*="_localBuildTitle"]::before{content:"${label}"!important;font-size:12px!important;line-height:13px!important}`,
      `span[class*="_fallbackBrandName"]::before{content:"${label}"!important;font-size:17px!important;line-height:24px!important}`,
      'span[class*="_buildVersion"]{color:inherit!important;background:none!important;opacity:.4!important;padding:0!important;border-radius:0!important}',
    )
  }
  if (hex) rules.push(`span[class*="_brandMark"],span[class*="_railMark"]{color:${hex}!important}`)
  const install = () => {
    const root = document.documentElement
    if (!root) return false
    if (view === 'mobile') root.setAttribute('data-deepsea-view', 'mobile')
    else root.removeAttribute('data-deepsea-view')
    if (rules.length > 0) {
      const style = document.getElementById('deepsea-app-identity') || document.createElement('style')
      style.id = 'deepsea-app-identity'
      style.textContent = rules.join('\n')
      ;(document.head || root).appendChild(style)
    }
    return true
  }
  // At document start the root element may not exist yet: install the moment
  // the parser inserts it (before the first paint), and again into <head>.
  if (!install()) {
    new MutationObserver((_records, observer) => { if (install()) observer.disconnect() }).observe(document, { childList: true })
  }
  document.addEventListener('DOMContentLoaded', install, { once: true })
}

/** A framed page of the server: `openExternal` only (runs in the page's own world, serialized). */
function applyOpener() {
  const native = globalThis.__DEEPSEA_APP_NATIVE__
  globalThis.__DEEPSEA_APP__ = Object.assign(globalThis.__DEEPSEA_APP__ || {}, {
    openExternal: (url) => { try { native.openExternal(String(url)) } catch { /* bridge gone */ } },
  })
}

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('deepseaClient', {
    connect: (input) => ipcRenderer.invoke('deepsea-client:connect', String(input)),
    details: () => ipcRenderer.invoke('deepsea-client:details'),
    retry: () => ipcRenderer.send('deepsea-client:retry'),
    changeServer: () => ipcRenderer.send('deepsea-client:change-server'),
  })
} else {
  const identity = ipcRenderer.sendSync('deepsea-client:identity', location.href)
  if (identity) {
    contextBridge.exposeInMainWorld('__DEEPSEA_APP_NATIVE__', {
      openExternal: (url) => ipcRenderer.send('deepsea-client:open-external', String(url)),
    })
    const install = identity.frame ? applyOpener : applyIdentity
    if (typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install, args: [identity] })
    } else {
      void webFrame.executeJavaScript(`(${install.toString()})(${JSON.stringify(identity)})`)
    }
  }
}
