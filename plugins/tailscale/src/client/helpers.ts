/**
 * Pure helpers of the browser half (no React, no shell modules), so they run
 * under `node --test` as they are.
 */

/** Hosts that name a loopback service: on the server's machine, from the viewer's point of view. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host.startsWith('127.') || host === '[::1]' || host === '::1'
    || host === '0.0.0.0' || host.endsWith('.localhost')
}

/**
 * What a click on a link should do in the DeepSea app on a tailnet page:
 * the loopback URL to `window.open` (the app forwards the port and opens the
 * default browser), or undefined to leave the click alone.
 * @param anchorHref - the anchor's resolved href
 * @param pageOrigin - `location.origin` of the GUI
 * @param modified - a non-primary button or any modifier key (those take the app's own path already)
 */
export function appLoopbackTarget(anchorHref: string, pageOrigin: string, modified: boolean): string | undefined {
  if (modified) return undefined
  let url: URL
  try { url = new URL(anchorHref) } catch { return undefined }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.origin === pageOrigin) return undefined
  return isLoopbackHostname(url.hostname) ? url.href : undefined
}

/** `http://127.0.0.1:3203/`-style bases a phone could never reach. */
export function isLoopbackBase(base: string): boolean {
  try {
    return isLoopbackHostname(new URL(base).hostname)
  } catch {
    return true
  }
}

/** What the session QR panel needs: the public base URL and, when readable, the standing token. */
export interface SessionLinkFacts {
  /** The GUI's public directory URL, with its trailing slash. */
  base?: string
  /** The standing token; undefined when this page may not read it or nothing is published. */
  token?: string
  /** Why there is no usable base. */
  problem?: string
  source: 'host' | 'document' | 'none'
}

/** The facts of `status` the session link uses (a structural subset of TailscaleStatus). */
export interface LinkStatus {
  url?: string
  tokenUrl?: string
  route: string
}

/**
 * The link facts from the host's status (or its refusal) and the document's own directory.
 * @param status - the host snapshot, or undefined when the control channel refused or failed.
 * @param documentBase - `new URL('./', document.baseURI).href`.
 */
export function sessionLinkFacts(status: LinkStatus | undefined, documentBase: string): SessionLinkFacts {
  if (status !== undefined && status.url !== undefined && status.route === 'active') {
    const base = status.url.endsWith('/') ? status.url : `${status.url}/`
    let token: string | undefined
    if (status.tokenUrl !== undefined) {
      try { token = new URL(status.tokenUrl).searchParams.get('token') ?? undefined } catch { token = undefined }
    }
    return { base, token, source: 'host' }
  }
  if (!isLoopbackBase(documentBase)) return { base: documentBase, source: 'document' }
  return { source: 'none', problem: status === undefined ? 'No tailnet address.' : 'Not published on the tailnet.' }
}

/** The link to one session: `?embed=<sessionId>`, with the standing token first when given. */
export function sessionLink(base: string, sessionId: string, token: string | undefined): string {
  const params = new URLSearchParams()
  if (token !== undefined) params.set('token', token)
  params.set('embed', sessionId)
  return `${base}?${params.toString()}`
}

/** `95` → `1m 35s`, `7300` → `2h 1m`. */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
  const hours = Math.floor(seconds / 3600)
  if (hours < 48) return `${String(hours)}h ${String(Math.floor((seconds % 3600) / 60))}m`
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`
}

/**
 * A `ps` command line as display lines: the binary first, then one argument
 * per line with its value (`--listen 127.0.0.1:3203`); a new path starts a
 * new line, and so does whatever follows `--`. Only ever splits on spaces.
 */
export function commandLines(command: string): string[] {
  const tokens = command.trim().split(' ').filter(Boolean)
  const lines: string[] = []
  for (const [index, token] of tokens.entries()) {
    const last = lines[lines.length - 1]
    if (index === 0 || last === undefined || last === '--') lines.push(token)
    else if (token.startsWith('-')) lines.push(token)
    else if (/^--?[\w-]+$/.test(last)) lines[lines.length - 1] = `${last} ${token}`
    else if (token.startsWith('/') || token.startsWith('~')) lines.push(token)
    else lines[lines.length - 1] = `${last} ${token}`
  }
  return lines
}

/** The ways to reach a published Serve path: the full name, the short name and the tailnet address. */
export function addressVariants(status: { dnsName?: string, servePath?: string, selfAddresses: string[] }): Array<{ label: string, url: string }> {
  if (status.dnsName === undefined || status.servePath === undefined) return []
  const path = status.servePath === '/' ? '/' : `${status.servePath}/`
  const out = [{ label: 'tailnet', url: `https://${status.dnsName}${path}` }]
  const short = status.dnsName.split('.')[0]
  if (short !== '' && short !== status.dnsName) out.push({ label: 'short name', url: `https://${short}${path}` })
  const ipv4 = status.selfAddresses.find(address => /^\d+\.\d+\.\d+\.\d+$/.test(address))
  if (ipv4 !== undefined) out.push({ label: 'tailnet IP', url: `https://${ipv4}${path}` })
  return out
}
