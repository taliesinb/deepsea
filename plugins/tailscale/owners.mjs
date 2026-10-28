/**
 * Who drives which session: the `deepseaSessionOwners` service.
 *
 * DSH itself is single-user: a session carries no person. Through the tailnet
 * proxy, though, every request arrives with the Serve-verified login of the
 * person behind the browser (`x-deepsea-tailscale-login`), and every
 * `POST /api/session/<method>` body names the session it acts on. This module
 * joins the two and keeps the result in
 * `$DSH_HOME/plugins/tailscale/session-owners.json` (0600), so other host
 * plugins can attribute a session, and what its agent does, to a tailnet
 * user although the whole server runs as one account and one tailnet node.
 *
 *   sessions[id] = { owner: { login, at, method }   first prompt (else first request) with an identity
 *                    actor: { login, at, method }   most recent prompt
 *                    logins: { [login]: count } }
 *
 * The identity of one request, in order: the proxied login; this node's own
 * login for direct loopback requests and for this node's own proxied ones;
 * the literal `token` for cookie or QR clients (admitted, but nobody knows
 * who). Attribution, not authorization: it records who asked and grants
 * nothing.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const VERSION = 1
/** Methods that mean "this person is driving the agent" (owner/actor), as opposed to merely looking. */
const DRIVING = new Set(['session/prompt', 'session/updateQueue', 'session/fork', 'session/selectModel', 'session/rename'])
export const TOKEN_LOGIN = 'token'

/**
 * The identity a request carries, from the tracker's clientFacts.
 * @param {{ proxied: boolean, login?: string, self: boolean }} facts
 * @param {string | undefined} selfLogin - this node's own tailnet login, when known.
 */
export function loginOf(facts, selfLogin) {
  if (facts.proxied) {
    if (facts.login !== undefined && facts.login !== '') return facts.login
    return facts.self && selfLogin !== undefined ? selfLogin : TOKEN_LOGIN
  }
  return selfLogin ?? 'local'
}

/** `user@example.com` → `user`; lowercase, [a-z0-9._-] only. */
export function shortLogin(login) {
  const local = String(login ?? '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return local === '' ? undefined : local.slice(0, 32)
}

export class SessionOwners {
  /**
   * @param {{ file: string, now?: () => number, log?: (message: string) => void }} options
   */
  constructor(options) {
    this.file = options.file
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    /** @type {{ version: number, sessions: Record<string, { owner?: object, actor?: object, logins: Record<string, number> }> } | undefined} */
    this.state = undefined
    this.loaded = this.load()
    this.timer = undefined
    this.dirty = false
  }

  async load() {
    let raw
    try { raw = JSON.parse(await readFile(this.file, 'utf8')) } catch { raw = undefined }
    const sessions = {}
    if (typeof raw?.sessions === 'object' && raw.sessions !== null) {
      for (const [id, record] of Object.entries(raw.sessions)) {
        if (typeof record !== 'object' || record === null) continue
        sessions[id] = { owner: record.owner, actor: record.actor, logins: typeof record.logins === 'object' && record.logins !== null ? record.logins : {} }
      }
    }
    this.state = { version: VERSION, sessions }
    return this.state
  }

  /** Record one request: `login` acted on `sessionId` through `method`. Synchronous; persisted shortly after. */
  record(sessionId, login, method) {
    if (this.state === undefined || typeof sessionId !== 'string' || sessionId === '' || login === undefined) return
    const record = this.state.sessions[sessionId] ??= { logins: {} }
    record.logins[login] = (record.logins[login] ?? 0) + 1
    const stamp = { login, at: this.now(), method }
    if (DRIVING.has(method)) {
      if (record.owner === undefined || !DRIVING.has(record.owner.method)) record.owner = stamp
      record.actor = stamp
    } else if (record.owner === undefined) {
      record.owner = stamp
    }
    this.schedule()
  }

  /** Attribution of one session, or undefined when it was never seen. */
  of(sessionId) {
    const record = this.state?.sessions[sessionId]
    if (record === undefined) return undefined
    return {
      owner: record.owner?.login,
      actor: record.actor?.login ?? record.owner?.login,
      first: record.owner,
      last: record.actor,
      logins: { ...record.logins },
    }
  }

  /** Every attributed session: `{ sessionId, owner, actor, logins }`. */
  list() {
    return Object.entries(this.state?.sessions ?? {}).map(([sessionId, r]) => ({ sessionId, owner: r.owner?.login, actor: r.actor?.login ?? r.owner?.login, logins: { ...r.logins } }))
  }

  schedule() {
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 1000)
    this.timer.unref?.()
  }

  async flush() {
    if (!this.dirty || this.state === undefined) return
    this.dirty = false
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
      await rename(tmp, this.file)
    } catch (error) {
      this.log(`tailscale: session owners not saved: ${String(error?.message ?? error)}`)
    }
  }

  async dispose() {
    clearTimeout(this.timer)
    this.timer = undefined
    await this.flush()
  }
}
