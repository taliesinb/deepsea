/**
 * This variant's Tailscale Serve path:
 *
 *   tailscale serve --bg --yes --https=443 --set-path=<path> <target>
 *   tailscale serve --https=443 --set-path=<path> off
 *
 * `<target>` is the variant's relay (`DEEPSEA_RELAY`), which hands tailnet
 * clients to the proxy, or the proxy itself when no relay started this
 * server. tailscaled strips the path before forwarding (`/deepsea-lab`,
 * `/deepsea-lab/` and `/deepsea-lab/x?y` arrive as `/`, `/` and `/x?y`), keeps
 * the tailnet `Host`, adds `x-forwarded-{for,host,proto}` and, for a request
 * from a device with a user, `Tailscale-User-Login` (client copies are
 * overwritten). Serve config lives in tailscaled and survives restarts, so
 * `serve status --json` is the truth for what is published.
 *
 * A mapping on the path belongs to this variant only when it points at this
 * variant's relay or proxy port on loopback. Any other mapping is somebody
 * else's (another variant, another account on this Mac): it is reported as a
 * conflict and never replaced or removed. Nothing here resets Serve or
 * touches Funnel.
 */
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/** Request header carrying the tailnet-verified login (lower-cased, as Node's header map has it). */
export const TAILSCALE_LOGIN_HEADER = 'tailscale-user-login'
/** Every identity or capability header Serve may inject; none reaches DSH. */
export const TAILSCALE_IDENTITY_HEADERS = new Set([
  TAILSCALE_LOGIN_HEADER,
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'tailscale-app-capabilities',
])

/** The HTTPS port Serve publishes on. */
export const SERVE_PORT = 443
const CLI_TIMEOUT_MS = 15_000
const MAC_APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

/** Run the CLI: `{ code, stdout, stderr }`, never throws. */
export function runCli(binary, args) {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? '') })
    })
  })
}

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The CLI: the configured path, else PATH, else the macOS app and the usual prefixes. */
export async function resolveTailscaleBinary(configuredPath = '') {
  const configured = String(configuredPath).trim()
  if (configured !== '') return (await executable(configured)) ? configured : undefined
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'tailscale')
    if (await executable(candidate)) return candidate
  }
  for (const candidate of [MAC_APP_BINARY, '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale', '/run/current-system/sw/bin/tailscale']) {
    if (await executable(candidate)) return candidate
  }
  return undefined
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The public URL of a Serve path, with its trailing slash (`https://node.example.ts.net/deepsea-lab/`). */
export function routeUrl(dnsName, servePath) {
  return `https://${dnsName}${servePath === '/' ? '/' : `${servePath}/`}`
}

/** `http://127.0.0.1:3203/` → `http://127.0.0.1:3203` (the form the CLI takes). */
export function targetOf(url) {
  return String(url).replace(/\/+$/, '')
}

/** Whether a mapped target is loopback on one of `ports`. */
export function isOwnTarget(target, ports) {
  try {
    const url = new URL(target)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    return url.protocol === 'http:' && loopback && ports.includes(port)
  } catch {
    return false
  }
}

function sameTarget(a, b) {
  try {
    const left = new URL(a)
    const right = new URL(b)
    return left.protocol === right.protocol && left.hostname === right.hostname && (left.port || '80') === (right.port || '80')
  } catch {
    return a === b
  }
}

/**
 * This node's own identity from `tailscale status --json`: the login Serve
 * injects for the node's requests to itself (none for a tagged node, which
 * has no user) and the node's tailnet addresses.
 * @returns {{ selfLogin?: string, selfAddresses: string[] }}
 */
export function selfIdentity(statusJson) {
  const self = statusJson?.Self ?? {}
  const addresses = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.map(String) : []
  const tags = Array.isArray(self.Tags) ? self.Tags : []
  const user = self.UserID === undefined ? undefined : statusJson?.User?.[String(self.UserID)]
  const login = tags.length === 0 && typeof user?.LoginName === 'string' && user.LoginName !== '' && user.LoginName !== 'tagged-devices'
    ? user.LoginName.toLowerCase()
    : undefined
  return { selfLogin: login, selfAddresses: addresses }
}

/** Tailscale node addresses: the IPv4 CGNAT block 100.64.0.0/10 and the IPv6 prefix fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(ip) {
  const text = String(ip ?? '').trim().replace(/^::ffff:/i, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(text)
  if (v4 !== null) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return a === 100 && b >= 64 && b <= 127
  }
  return /^fd7a:115c:a1e0:/i.test(text)
}

/**
 * @param {{ cliPath?: string, socket?: string, servePath?: string, target: () => string | undefined, ownPorts: () => number[],
 *   log?: (message: string) => void, run?: typeof runCli }} options
 *   `socket` is a tailscaled of the account's own (`--socket` on every call; default: the machine's);
 *   `target` is what to publish (the relay or proxy URL), undefined while there is nothing to publish;
 *   `ownPorts` the loopback ports a mapping of this variant may point at.
 */
export function createServeManager(options) {
  const path = options.servePath
  const socketArgs = options.socket ? [`--socket=${options.socket}`] : []
  const run = (binary, args) => (options.run ?? runCli)(binary, [...socketArgs, ...args])
  const portFlag = `--https=${String(SERVE_PORT)}`
  let binary
  let resolved = false
  const resolveBinary = async () => {
    if (!resolved) {
      binary = await resolveTailscaleBinary(options.cliPath ?? '')
      resolved = true
    }
    return binary
  }

  /**
   * @returns {Promise<{ state: 'no-path'|'off'|'active'|'stale'|'conflict'|'unavailable', detail?: string, binary?: string,
   *   dnsName?: string, backendState?: string, url?: string, mappedTarget?: string, selfLogin?: string, selfAddresses: string[] }>}
   *   `stale`: the path points at this variant, but not at today's target (the proxy after a relay arrived).
   */
  const status = async () => {
    const cli = await resolveBinary()
    const none = { selfAddresses: [] }
    if (cli === undefined) return { ...none, state: path === undefined ? 'no-path' : 'unavailable', detail: 'binary-missing' }
    const node = await run(cli, ['status', '--json'])
    const nodeJson = node.code === 0 ? parseJson(node.stdout) : undefined
    if (nodeJson === undefined) return { ...none, state: path === undefined ? 'no-path' : 'unavailable', detail: 'daemon-unreachable', binary: cli }
    const dnsName = String(nodeJson.Self?.DNSName ?? '').replace(/\.$/, '')
    const base = { binary: cli, backendState: nodeJson.BackendState, dnsName: dnsName || undefined, ...selfIdentity(nodeJson) }
    if (path === undefined) return { ...base, state: 'no-path' }
    if (dnsName !== '') base.url = routeUrl(dnsName, path)
    if (nodeJson.BackendState !== 'Running') return { ...base, state: 'unavailable', detail: 'not-running' }
    const serve = await run(cli, ['serve', 'status', '--json'])
    // An empty Serve config prints nothing, with exit 0.
    const serveJson = serve.code === 0 ? (serve.stdout.trim() === '' ? {} : parseJson(serve.stdout)) : undefined
    if (serveJson === undefined) return { ...base, state: 'unavailable', detail: 'daemon-unreachable' }
    const handlers = serveJson.Web?.[`${dnsName}:${String(SERVE_PORT)}`]?.Handlers ?? {}
    const handler = handlers[path] ?? (path === '/' ? undefined : handlers[`${path}/`])
    if (handler === undefined) return { ...base, state: 'off' }
    const mapped = typeof handler.Proxy === 'string' ? handler.Proxy : JSON.stringify(handler)
    const target = options.target()
    if (target !== undefined && sameTarget(mapped, target)) return { ...base, state: 'active', mappedTarget: mapped }
    if (isOwnTarget(mapped, options.ownPorts())) return { ...base, state: 'stale', mappedTarget: mapped }
    return { ...base, state: 'conflict', mappedTarget: mapped }
  }

  return {
    path,
    status,
    /** Publish (or re-point this variant's own stale mapping). @returns {Promise<'ok'|'no-path'|'no-target'|'unavailable'|'conflict'|'failed'|'verify-failed'>} */
    enable: async () => {
      if (path === undefined) return 'no-path'
      const target = options.target()
      if (target === undefined) return 'no-target'
      const before = await status()
      if (before.binary === undefined || before.backendState !== 'Running' || before.dnsName === undefined) return 'unavailable'
      if (before.state === 'conflict') return 'conflict'
      if (before.state === 'active') return 'ok'
      const args = ['serve', '--bg', '--yes', portFlag, ...(path === '/' ? [] : [`--set-path=${path}`]), targetOf(target)]
      const result = await run(before.binary, args)
      if (result.code !== 0) {
        options.log?.(`tailscale: tailscale serve failed (${String(result.code)}): ${result.stderr.trim() || result.stdout.trim()}`)
        return 'failed'
      }
      const after = await status()
      if (after.state !== 'active') return 'verify-failed'
      options.log?.(`tailscale: ${after.url ?? path} -> ${targetOf(target)}`)
      return 'ok'
    },
    /** Remove this variant's own mapping; another's is left alone. @returns {Promise<'ok'|'no-path'|'unavailable'|'conflict'|'failed'>} */
    disable: async () => {
      if (path === undefined) return 'no-path'
      const before = await status()
      if (before.binary === undefined || before.backendState !== 'Running') return 'unavailable'
      if (before.state === 'off') return 'ok'
      if (before.state === 'conflict') return 'conflict'
      const result = await run(before.binary, ['serve', portFlag, ...(path === '/' ? [] : [`--set-path=${path}`]), 'off'])
      if (result.code !== 0) {
        options.log?.(`tailscale: tailscale serve off failed (${String(result.code)}): ${result.stderr.trim() || result.stdout.trim()}`)
        return 'failed'
      }
      options.log?.(`tailscale: ${before.url ?? path} removed`)
      return 'ok'
    },
  }
}
