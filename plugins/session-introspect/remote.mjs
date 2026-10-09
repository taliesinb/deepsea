/**
 * remote.mjs: reaching another instance's transcript routes (serve.mjs on
 * that machine) over the tailnet, with nothing configured on either side.
 *
 * A `remote` spec is what an agent would type from memory:
 *
 *   node                            tailnet machine `node`, default mount /deepsea (its release variant)
 *   node/deepsea-personal           machine `node`, the variant served under /deepsea-personal
 *   node.example.ts.net/deepsea     a full DNS name works verbatim
 *   127.0.0.1:3200                  host:port (http for loopback, https otherwise; root mount)
 *   https://host/path/              a URL, verbatim
 *   (empty) | local                 the local instance
 *
 * A bare first label needs the tailnet's MagicDNS suffix: not because the
 * connection would fail (MagicDNS resolves `node` through the system
 * resolver) but because Tailscale Serve's certificate names the full
 * `node.<suffix>` and TLS verification must see that name. The suffix, and
 * whether `node` is a peer at all and online, comes from
 * `tailscale status --json`, cached for a minute; no configuration.
 *
 * Authentication is the caller machine's tailnet identity: Serve on the remote
 * injects `Tailscale-User-Login`, the remote's tailscale plugin admits
 * allowlisted logins and forwards with DSH's own session cookie. This module
 * therefore sends no credentials; a 401 is explained as an allowlist /
 * tagged-node problem, which is what it is.
 */

import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { IntrospectError } from './output.mjs'

/** Wire-protocol generation of the routes in serve.mjs; the client refuses anything else. */
export const API_VERSION = 1
export const ROUTE_PREFIX = '/api/deepsea-session-introspect/v1'
/** Tailscale Serve path of a machine's release variant (another variant `<v>` is served at /deepsea-<v>). */
export const DEFAULT_MOUNT = '/deepsea'

const MAC_APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const CLI_TIMEOUT_MS = 8000
const STATUS_TTL_MS = 60_000
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Split a `remote` spec into its parts without touching the network.
 * @param {unknown} spec
 * @returns {null | { kind: 'url', url: string } | { kind: 'host', host: string, port: number | null, mount: string, bareLabel: boolean }}
 *   `null` means the local instance.
 */
export function parseRemoteSpec(spec) {
  if (spec === undefined || spec === null) return null
  const raw = String(spec).trim()
  if (raw === '' || raw.toLowerCase() === 'local' || raw.toLowerCase() === 'self') return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url
    try { url = new URL(raw) } catch { throw new IntrospectError(`remote "${raw}" is not a valid URL.`) }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new IntrospectError(`remote "${raw}" must be http(s).`)
    if (url.search !== '' || url.hash !== '') throw new IntrospectError(`remote "${raw}" must not carry a query or fragment.`)
    return { kind: 'url', url: `${url.origin}${url.pathname.replace(/\/+$/, '')}/` }
  }
  const slash = raw.indexOf('/')
  const authority = (slash < 0 ? raw : raw.slice(0, slash)).trim()
  const rest = slash < 0 ? '' : raw.slice(slash)
  const m = /^([A-Za-z0-9_.-]+)(?::(\d{1,5}))?$/.exec(authority)
  if (!m) throw new IntrospectError(`remote "${raw}" is not a machine name, host[:port][/path] or URL.`)
  const host = m[1].toLowerCase()
  const port = m[2] === undefined ? null : Number(m[2])
  const mount = normalizeMount(rest === '' || rest === '/' ? (port === null && !host.includes('.') ? DEFAULT_MOUNT : '/') : rest)
  return { kind: 'host', host, port, mount, bareLabel: !host.includes('.') && !LOOPBACK.has(host) && port === null }
}

function normalizeMount(path) {
  const p = `/${String(path).replace(/^\/+|\/+$/g, '')}`
  return p === '/' ? '/' : p
}

/**
 * The tailnet as seen from this machine: MagicDNS names of peers, from
 * `tailscale status --json` (CLI on PATH or the macOS app's binary), cached.
 * @param {{ binary?: string, statusJson?: () => Promise<any> }} [options] - `statusJson` overrides the CLI (tests)
 */
export function createTailnet(options = {}) {
  let cached = null // { at, status }
  let binary
  async function resolveBinary() {
    if (binary !== undefined) return binary
    const candidates = [options.binary, 'tailscale', MAC_APP_BINARY].filter(Boolean)
    for (const candidate of candidates) {
      if (candidate === 'tailscale') { binary = candidate; return binary } // PATH lookup is execFile's job; a miss is reported by run()
      try { await access(candidate, constants.X_OK); binary = candidate; return binary } catch { /* next */ }
    }
    binary = null
    return binary
  }
  function run(bin, args) {
    return new Promise((resolve) => {
      execFile(bin, args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        resolve({ ok: !error, stdout: String(stdout ?? ''), error })
      })
    })
  }
  async function statusJson() {
    if (options.statusJson) return options.statusJson()
    const first = await resolveBinary()
    const order = first === 'tailscale' ? ['tailscale', MAC_APP_BINARY] : first ? [first] : []
    for (const bin of order) {
      const r = await run(bin, ['status', '--json'])
      if (r.ok) { try { return JSON.parse(r.stdout) } catch { /* fall through */ } }
      if (r.error?.code === 'ENOENT') continue
    }
    return undefined
  }
  async function status() {
    const now = Date.now()
    if (cached && now - cached.at < STATUS_TTL_MS) return cached.status
    const s = await statusJson()
    cached = { at: now, status: s }
    return s
  }
  return {
    /**
     * Resolve a bare machine label to its MagicDNS name.
     * @param {string} label e.g. `node`
     * @returns {Promise<{ fqdn: string, online: boolean, self: boolean }>}
     */
    async resolveHost(label) {
      const s = await status()
      if (s === undefined) throw new IntrospectError(`remote "${label}": cannot ask Tailscale for the tailnet (no tailscale CLI, or the daemon is not running).`, { hint: 'Use the full DNS name (node.example.ts.net/…) or a URL instead.' })
      if (s.BackendState !== 'Running') throw new IntrospectError(`remote "${label}": Tailscale is ${String(s.BackendState ?? 'not running').toLowerCase()} on this machine.`)
      const want = label.toLowerCase()
      const nodes = [s.Self, ...Object.values(s.Peer ?? {})].filter(Boolean)
      const hit = nodes.find(n => String(n.HostName ?? '').toLowerCase() === want)
        ?? nodes.find(n => String(n.DNSName ?? '').toLowerCase().split('.')[0] === want)
      if (!hit) {
        const suffix = s.MagicDNSSuffix ?? s.CurrentTailnet?.MagicDNSSuffix
        const known = nodes.map(n => String(n.DNSName ?? n.HostName ?? '').split('.')[0]).filter(Boolean).sort()
        throw new IntrospectError(`remote "${label}" is not a machine on this tailnet${suffix ? ` (${suffix})` : ''}.`, { hint: `Known machines: ${known.slice(0, 30).join(', ')}${known.length > 30 ? ', …' : ''}.` })
      }
      const fqdn = String(hit.DNSName ?? '').replace(/\.$/, '') || `${hit.HostName}.${s.MagicDNSSuffix}`
      return { fqdn, online: hit.Online !== false, self: hit === s.Self }
    },
  }
}

/**
 * Turn a parsed spec into the base URL of a DSH instance.
 * @param {ReturnType<typeof parseRemoteSpec>} parsed - non-null
 * @param {{ resolveHost: (label: string) => Promise<{ fqdn: string, online: boolean }> }} tailnet
 * @returns {Promise<{ key: string, baseUrl: string, online: boolean | null }>} `key` is the normalized spelling used in output
 */
export async function resolveRemote(parsed, tailnet) {
  if (parsed.kind === 'url') {
    const u = new URL(parsed.url)
    return { key: `${u.host}${u.pathname.replace(/\/$/, '')}`, baseUrl: parsed.url, online: null }
  }
  let host = parsed.host
  let online = null
  if (parsed.bareLabel) {
    const r = await tailnet.resolveHost(parsed.host)
    host = r.fqdn
    online = r.online
  }
  // Loopback instances are plain `dsh web` (http); everything else is behind Tailscale Serve (https).
  const scheme = LOOPBACK.has(parsed.host) ? 'http' : 'https'
  const port = parsed.port === null ? '' : `:${parsed.port}`
  const mount = parsed.mount === '/' ? '' : parsed.mount
  return { key: `${parsed.host}${port}${mount}`, baseUrl: `${scheme}://${host}${port}${mount}/`, online }
}

/**
 * HTTP client for one remote instance's transcript routes.
 * @param {{ key: string, baseUrl: string, online: boolean | null }} target
 * @param {{ timeoutMs?: number, fetch?: typeof fetch, trace?: (line: object) => void }} [options]
 */
export function createRemoteClient(target, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000
  const doFetch = options.fetch ?? globalThis.fetch
  const trace = options.trace ?? (() => {})
  let capabilities // Promise<object> once probed

  const url = (route, params) => {
    const u = new URL(`${ROUTE_PREFIX.slice(1)}/${route}`, target.baseUrl)
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) u.searchParams.set(k, String(v))
    return u
  }

  async function get(route, params, signal) {
    const u = url(route, params)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
    const onAbort = () => ac.abort(signal.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const t0 = Date.now()
    let res
    try {
      res = await doFetch(u, { method: 'GET', headers: { accept: 'application/json', 'accept-encoding': 'gzip' }, signal: ac.signal, redirect: 'manual' })
    } catch (error) {
      signal?.throwIfAborted()
      throw new IntrospectError(`remote ${target.key} is not reachable (${u.origin}): ${causeMessage(error)}.`, { hint: target.online === false ? 'Tailscale reports the machine offline.' : 'Is DeepSea running there and published on the tailnet (Settings ▸ Tailscale)?' })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const body = Buffer.from(await res.arrayBuffer())
    trace({ event: 'remote-get', remote: target.key, route, status: res.status, bytes: body.length, ms: Date.now() - t0 })
    if (res.status === 401) throw new IntrospectError(`remote ${target.key} refused this machine (401).`, { hint: 'It admits tailnet logins on its allowed-user list; add this machine\'s login there (Settings ▸ Tailscale). A tagged node carries no login and is always refused.' })
    if (res.status === 403) throw new IntrospectError(`remote ${target.key} refused the request (403, Host/Origin fence).`)
    if (res.status === 404 && route === 'capabilities') {
      // Either a DSH without this plugin, or no DSH at this mount at all (Serve
      // answers 404 for an unknown path too). The instance root tells them apart.
      const root = await probeRoot(signal)
      if (root === 404) throw new IntrospectError(`nothing is served at ${target.baseUrl} (404).`, { hint: `Check the mount path: a machine serves its release variant at ${DEFAULT_MOUNT}, another variant <v> at ${DEFAULT_MOUNT}-<v>.` })
      throw new IntrospectError(`remote ${target.key} has no transcript routes: the session-introspect plugin is not installed there, or its serve option is off.`, { hint: `Install @deepsea/session-introspect on that instance; this client needs api ${API_VERSION}.` })
    }
    if (res.status >= 300 && res.status < 400) throw new IntrospectError(`remote ${target.key} redirected (${res.status}) instead of answering; the path is probably not a DSH mount.`, { hint: `Location: ${res.headers.get('location') ?? '?'}` })
    // Node's fetch inflates a gzip body itself but keeps the Content-Encoding
    // header; a test double may hand the bytes over raw. Decide by the magic bytes.
    const text = (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString('utf8')
    let json
    try { json = JSON.parse(text) } catch {
      throw new IntrospectError(`remote ${target.key} answered ${res.status} with a non-JSON body for ${route}.`, { hint: clipText(text, 160) })
    }
    if (res.status !== 200) throw new IntrospectError(`remote ${target.key}: ${route} failed (${res.status}): ${json?.error ?? clipText(text, 200)}`)
    return json
  }

  /** Status of `GET <baseUrl>` (a DSH answers 200/3xx/401 there), or null when unreachable. */
  async function probeRoot(signal) {
    try {
      const res = await doFetch(target.baseUrl, { method: 'GET', headers: { accept: 'text/html' }, signal, redirect: 'manual' })
      await res.arrayBuffer()
      return res.status
    } catch {
      return null
    }
  }

  return {
    key: target.key,
    baseUrl: target.baseUrl,
    /** Verify the remote speaks our protocol (once per client). */
    capabilities(signal) {
      capabilities ??= get('capabilities', undefined, signal).then((caps) => {
        if (caps?.api !== API_VERSION) throw new IntrospectError(`remote ${target.key} speaks transcript api ${String(caps?.api)} but this plugin needs ${API_VERSION}; update the older side.`)
        return caps
      }).catch((error) => { capabilities = undefined; throw error })
      return capabilities
    },
    async sessions(signal) {
      await this.capabilities(signal)
      return get('sessions', undefined, signal)
    },
    async session(id, signal) {
      await this.capabilities(signal)
      return get('session', { id }, signal)
    },
  }
}

function causeMessage(error) {
  const cause = error?.cause
  const parts = [error?.message, cause?.code ?? cause?.message].filter(Boolean)
  return parts.join(': ') || String(error)
}

function clipText(s, n) {
  const one = String(s).replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}
