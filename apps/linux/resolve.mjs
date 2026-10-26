/**
 * Which server: what may be typed (the connection form, the command line),
 * the MagicDNS suffix that completes a short name, and the scope rule that
 * tells the server's own pages from everything else.
 *
 *   host                         →  https://host.<magic-dns-suffix>/deepsea/
 *   user@host                    →  https://host.<magic-dns-suffix>/deepsea-user/
 *   host/deepsea-lab             →  https://host.<magic-dns-suffix>/deepsea-lab/
 *   host.example.ts.net          →  https://host.example.ts.net/deepsea/
 *   box.example.com:8443/x       →  https://box.example.com:8443/x/
 *   localhost:3203, 127.0.0.1:3203, [::1]:3203, 192.0.2.10:3200  →  http:// added
 *   https://…[?token=…]          →  kept (trailing slash added); the token is split off
 *
 * The same short forms as the add-remote modal of @deepsea/remote-workspaces
 * (its resolve.mjs): a tailnet host without a path gets `/deepsea/`, the
 * release variant's Serve path; `user@host` is that account's release
 * variant on a shared machine (LAYOUT.md §1, §7). The suffix matters because
 * the Serve certificate names the full MagicDNS name.
 */
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/** The release variant's Tailscale Serve path. */
export const DEFAULT_SERVE_PATH = '/deepsea/'
const CLI_TIMEOUT_MS = 5000

/** `localhost`, loopback and IP literals speak plain http (a server's own port, a LAN box). */
export function isPlainHttpHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true
  if (/^127\./.test(host)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  return host.includes(':')
}

/** A MagicDNS name, short (`studio`) or full (`studio.example.ts.net`). */
function isTailnetHost(host) {
  return !isPlainHttpHost(host) && (!host.includes('.') || /\.ts\.net$/i.test(host))
}

/**
 * Turn what was typed into the server's canonical mount URL (http(s), no
 * query, trailing slash) and the standing token it carried, if any; throws
 * with a message the form can show.
 * @param {string} text
 * @param {{ magicDnsSuffix?: string | (() => Promise<string | undefined>) }} [options]
 *   the tailnet suffix for dot-less hosts, or a function asked only when one is typed
 * @returns {Promise<{ url: string, token?: string }>}
 */
export async function parseServerInput(text, options = {}) {
  const suffixFor = async (host) => {
    if (host.includes('.') || isPlainHttpHost(host)) return undefined
    const suffix = typeof options.magicDnsSuffix === 'function' ? await options.magicDnsSuffix() : options.magicDnsSuffix
    if (!suffix) throw new Error(`Cannot complete "${host}": no MagicDNS suffix (is Tailscale connected?). Type the full name.`)
    return String(suffix).replace(/^\.|\.$/g, '')
  }
  let input = String(text ?? '').trim()
  if (input === '') throw new Error('Type the server.')
  if (/\s/.test(input)) throw new Error(`"${input}" is not a server address.`)

  let url
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    try { url = new URL(input) } catch { throw new Error(`"${input}" is not a URL.`) }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The server URL must be http(s).')
    if (url.username || url.password) throw new Error('The server URL must not carry a user name or password.')
    const suffix = await suffixFor(url.hostname)
    if (suffix !== undefined) url.hostname = `${url.hostname}.${suffix}`
  } else {
    const sugar = /^([^@/:\s]+)@([^@/\s]+)$/.exec(input)
    if (sugar !== null) {
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(sugar[1])) throw new Error(`"${sugar[1]}" is not an account name.`)
      input = `${sugar[2]}/deepsea-${sugar[1].toLowerCase()}`
    }
    const slash = input.search(/[/?#]/)
    let authority = slash === -1 ? input : input.slice(0, slash)
    let rest = slash === -1 ? '' : input.slice(slash)
    if (authority === '') throw new Error(`"${input}" has no host.`)
    const hostMatch = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority)
    if (hostMatch === null) throw new Error(`"${authority}" is not a host[:port].`)
    let host = hostMatch[1]
    const port = hostMatch[2]
    if (rest === '' || rest.startsWith('?') || rest.startsWith('#')) rest = `${port === undefined && isTailnetHost(host) ? DEFAULT_SERVE_PATH : '/'}${rest}`
    const plain = isPlainHttpHost(host)
    const suffix = await suffixFor(host)
    if (suffix !== undefined) host = `${host}.${suffix}`
    authority = port === undefined ? host : `${host}:${port}`
    try { url = new URL(`${plain ? 'http' : 'https'}://${authority}${rest}`) } catch { throw new Error(`"${input}" is not a server address.`) }
  }
  if (url.protocol === 'http:' && !isPlainHttpHost(url.hostname)) throw new Error(`${url.hostname} needs https:// (plain http is for loopback and IP addresses).`)
  const token = url.searchParams.get('token') ?? undefined
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return token ? { url: url.toString(), token } : { url: url.toString() }
}

// ---------------------------------------------------------------------------
// MagicDNS suffix

async function executable(path) {
  try { await access(path, constants.X_OK); return true } catch { return false }
}

/** The Tailscale CLI: PATH first, then the usual system locations. */
export async function tailscaleBinary(env = process.env) {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (dir !== '' && await executable(join(dir, 'tailscale'))) return join(dir, 'tailscale')
  }
  for (const candidate of ['/run/current-system/sw/bin/tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale']) {
    if (await executable(candidate)) return candidate
  }
  return undefined
}

/** The suffix in a `tailscale status --json` answer: `MagicDNSSuffix`, else the tail of `Self.DNSName`. */
export function suffixOfStatus(json) {
  const suffix = String(json?.MagicDNSSuffix ?? '').replace(/^\.|\.$/g, '')
  if (suffix !== '') return suffix
  const self = String(json?.Self?.DNSName ?? '').replace(/\.$/, '')
  const dot = self.indexOf('.')
  return dot === -1 ? undefined : self.slice(dot + 1)
}

/**
 * The tailnet's MagicDNS suffix from `tailscale status --json`; undefined
 * when the CLI or the daemon is unavailable. Asked only for a dot-less host.
 * @param {{ cli?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export async function magicDnsSuffix(options = {}) {
  const cli = options.cli ?? await tailscaleBinary(options.env)
  if (cli === undefined) return undefined
  const json = await new Promise((resolve) => {
    execFile(cli, ['status', '--json'], { timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) { resolve(undefined); return }
      try { resolve(JSON.parse(String(stdout))) } catch { resolve(undefined) }
    })
  })
  return suffixOfStatus(json)
}

// ---------------------------------------------------------------------------
// Scope

/**
 * The server's own pages: same scheme, host and port as the mount URL and
 * inside its path (`/deepsea-lab` and everything under `/deepsea-lab/`).
 */
export class Scope {
  /** @param {string | URL} mount the canonical mount URL (trailing slash) */
  constructor(mount) {
    this.mount = new URL(String(mount))
    this.port = effectivePort(this.mount)
  }

  /** @param {string | URL} value */
  contains(value) {
    let url
    try { url = new URL(String(value)) } catch { return false }
    if (url.protocol !== this.mount.protocol || url.hostname.toLowerCase() !== this.mount.hostname.toLowerCase() || effectivePort(url) !== this.port) return false
    const prefix = this.mount.pathname
    return url.pathname === prefix.slice(0, -1) || url.pathname.startsWith(prefix)
  }

  /** A path relative to the mount (`api/x?y`) as an absolute URL inside it. */
  resolve(relative) {
    return new URL(String(relative).replace(/^\/+/, ''), this.mount).toString()
  }
}

function effectivePort(url) {
  return url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
}
