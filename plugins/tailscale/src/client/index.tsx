/**
 * Browser half of @deepsea/tailscale: the "Tailscale" and "Server" settings
 * sections, the per-session QR button, and, in the DeepSea app on a tailnet
 * page, plain clicks on loopback links handed to the app.
 *
 * Everything talks to the host half over the control channel
 * (`/deepsea-tailscale/<endpoint>`) through `ctx.connection.rpc`; the proxy
 * forwards it for operators only, so elsewhere the sections say so.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only (erased at build): merges `ctx.slots` onto the Cordis Context.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { embedPresentation } from '@deepseek-ai/dsh-client-store'
import { createApi } from './api.ts'
import { appLoopbackTarget } from './helpers.ts'
import { ServerSection } from './server-section.tsx'
import { SessionQrAction, type SessionQrInjected } from './session-qr.tsx'
import { TailscaleSection } from './tailscale-section.tsx'

export const inject = ['slots', 'connection']

export function apply(ctx: Context): void {
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  const api = createApi(rpc)
  ctx.slots.inject('settings.section', () => {
    const disposers = [
      ctx.slots.register({
        name: 'settings.section',
        id: 'deepsea-tailscale',
        order: 40,
        label: () => 'Tailscale',
        inject: () => ({ api }),
      }, TailscaleSection),
      ctx.slots.register({
        name: 'settings.section',
        id: 'deepsea-tailscale-server',
        order: 41,
        label: () => 'Server',
        inject: () => ({ api }),
      }, ServerSection),
    ]
    return () => { for (const dispose of disposers) dispose() }
  })
  // An embedded page (`?embed=<id>`: a phone's view, a framed remote session) has nothing to share on.
  if (embedPresentation() === undefined) {
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'deepsea-tailscale-session-qr',
      order: 50,
      inject: (): SessionQrInjected => ({ api, documentBase: new URL('./', document.baseURI).href }),
    }, SessionQrAction))
  }
  ctx.effect(() => installAppLoopbackLinks(), 'tailscale: loopback links in the DeepSea app')
}

/**
 * In the DeepSea app (`__DEEPSEA_APP__`) on a tailnet page (https), a plain
 * click on a loopback link must not land in the Sidebar Browser: that pane is
 * an `http://127.0.0.1` frame inside an https page, which WebKit blocks as
 * mixed content. The click is taken before Chat's handler (capture phase,
 * propagation stopped) and turned into `window.open`, which the app answers
 * by forwarding the port and opening the default browser, the ⌘-click path.
 * On a loopback page the frame works, so nothing is installed.
 */
export function installAppLoopbackLinks(): () => void {
  if (typeof document === 'undefined' || (globalThis as { __DEEPSEA_APP__?: unknown }).__DEEPSEA_APP__ === undefined || location.protocol !== 'https:') return () => {}
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (anchor === null || anchor === undefined || anchor.hasAttribute('download')) return
    const modified = event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    const target = appLoopbackTarget(anchor.href, location.origin, modified)
    if (target === undefined) return
    event.preventDefault()
    event.stopPropagation()
    window.open(target, '_blank', 'noopener,noreferrer')
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}
