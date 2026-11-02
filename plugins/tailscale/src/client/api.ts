/**
 * The control channel as the browser half sees it: the host's snapshots and
 * the calls that change them (`POST /deepsea-tailscale/<endpoint>`, the
 * Connection envelope). The proxy forwards the channel for operators only;
 * anyone else gets HTTP 403.
 */
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

/** The host's `status` snapshot (index.js). */
export interface TailscaleStatus {
  variant?: string
  display?: string
  /** The operator's wish (else the variant's): publish the Serve path. */
  enabled: boolean
  servePath?: string
  route: 'no-path' | 'off' | 'active' | 'stale' | 'conflict' | 'unavailable'
  detail?: string
  dnsName?: string
  mappedTarget?: string
  url?: string
  tokenUrl?: string
  qrSvg?: string
  allowedUsers: string[]
  /** This node's own login (always admitted); none on a tagged node. */
  selfLogin?: string
  selfAddresses: string[]
  proxy: { port?: number, running: boolean, error?: string }
  /** What Serve publishes: the relay or the proxy. */
  target?: string
  loopbackForward: { policy: string, open: number, path: string }
}

export interface ServerAction { id: string, label: string, danger?: boolean }
export interface ServerProcess {
  id: string
  title: string
  /** One fact per line, shown on hover over the name. */
  details: string[]
  /** The full command line, shown on hover over the PID. */
  command?: string
  pid?: number
  running: boolean
  uptimeSeconds?: number
  rssKb?: number
  actions: ServerAction[]
}
export interface ServerClient {
  key: string
  login?: string
  address: string
  self: boolean
  proxied: boolean
  admitted: string
  agent: string
  userAgent: string
  firstSeen: number
  lastSeen: number
  requests: number
  sockets: number
  lastPath?: string
  lastSession?: { method: string, sessionId?: string, cwd?: string, workspace?: string, at: number }
}
export interface ServerStatus {
  variant?: string
  tracking: boolean
  processes: ServerProcess[]
  clients: ServerClient[]
  now: number
  message?: string
}

export interface TailscaleApi {
  status(): Promise<TailscaleStatus>
  enable(): Promise<TailscaleStatus>
  disable(): Promise<TailscaleStatus>
  setUsers(list: string): Promise<TailscaleStatus>
  rotateToken(): Promise<TailscaleStatus>
  serverStatus(): Promise<ServerStatus>
  serverAct(target: string, action: string): Promise<ServerStatus>
}

export const CHANNEL = '/deepsea-tailscale'

/** What a page that is not an operator's sees instead of the sections. */
export const OPERATORS_ONLY = 'Operators only.'

export function createApi(rpc: ClientConnectionRpc): TailscaleApi {
  const raw = async (endpoint: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    let result
    try {
      result = await rpc.call(CHANNEL, endpoint, { args })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      throw new Error(/HTTP 403/.test(text) ? OPERATORS_ONLY : text)
    }
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const call = (endpoint: string, args: Record<string, unknown> = {}) => raw(endpoint, args) as Promise<TailscaleStatus>
  return {
    status: () => call('status'),
    enable: () => call('enable'),
    disable: () => call('disable'),
    setUsers: list => call('set-users', { allowedUsers: list }),
    rotateToken: () => call('rotate-token'),
    serverStatus: () => raw('server-status') as Promise<ServerStatus>,
    serverAct: (target, action) => raw('server-act', { target, action }) as Promise<ServerStatus>,
  }
}
