/**
 * Opening a sign-in page in the user's own browser. A sign-in page needs the
 * browser holding the provider session, and its redirect reaches a loopback
 * callback, so neither the chat's sidebar browser nor an app window will do.
 */
import type { MouseEvent } from 'react'

/** The native opener the DeepSea app sets on the page (`__DEEPSEA_APP__.openExternal`). */
type Opener = (url: string) => void

/** The app's opener in this document, or in the top one when this is a same-origin frame (a framed remote session). */
export function appOpener(): Opener | undefined {
  const frames: Window[] = [window]
  try { if (window.top !== null && window.top !== window) frames.push(window.top) } catch { /* cross-origin top */ }
  for (const frame of frames) {
    try {
      const app = (frame as Window & { __DEEPSEA_APP__?: { openExternal?: Opener } }).__DEEPSEA_APP__
      if (typeof app?.openExternal === 'function') return url => { app.openExternal?.(url) }
    } catch { /* cross-origin frame */ }
  }
  return undefined
}

/**
 * Open a URL in the user's own browser: the app's native opener (no click
 * needed), else a new tab, which a browser may block once the click that ran
 * the command is too long ago; the card's link remains for that.
 * @param url - http(s) URL.
 */
export function openInBrowser(url: string): void {
  const open = appOpener()
  if (open !== undefined) { open(url); return }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Click handler for a link that opens in the user's browser: in a plain
 * browser the link itself opens a new tab (a real click, so never blocked);
 * in the app, `open` through its native opener.
 */
export function onBrowserLink(url: string) {
  return (event: MouseEvent<HTMLAnchorElement>): void => {
    const open = appOpener()
    if (open === undefined) return
    event.preventDefault()
    open(url)
  }
}
