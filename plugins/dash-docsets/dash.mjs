/**
 * Client for the local HTTP API of Dash 8 (Settings ▸ Integration ▸ API Server).
 *
 * Facts this module is built on (measured on Dash 8.1.1):
 *
 * - The server listens on 127.0.0.1 at a per-launch port written to
 *   `~/Library/Application Support/Dash/.dash_api_server/status.json`
 *   (`{"port":53649}`). The file (and directory) only exist while the server
 *   is enabled; the preference key is `DHAPIServerEnabled` in the app's
 *   defaults domain (`com.kapeli.dash-setapp` for Setapp, `com.kapeli.dashdoc`
 *   for the direct download) and Dash picks a change up live.
 * - `GET /health` → `{"status":"ok"}`; `GET /docsets/list` → `{docsets:[{name,
 *   identifier, platform, path, full_text_search}]}` (identifiers are opaque
 *   8-letter codes); `GET /search?query&docset_identifiers&max_results&
 *   search_snippets` → `{results:[{name,type,platform,load_url,docset,
 *   description,language?,tags?}], message?}` (`[{}]` when nothing matched;
 *   often max_results+1 rows). Unknown endpoints answer 501.
 * - `load_url`s point at a SECOND server (another per-launch port) that serves
 *   the raw docset HTML. Both ports change when Dash restarts, so URLs from a
 *   search are ephemeral.
 * - Errors are HTML pages whose <h1> holds the message: 400 "Docset with
 *   identifier 'x' not found…", 403 "API access blocked due to Dash trial
 *   expiration".
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const STATUS_FILE = join(homedir(), 'Library', 'Application Support', 'Dash', '.dash_api_server', 'status.json')

/** Error thrown for every failure the model can act on; `hint` is appended to the message. */
export class DashError extends Error {
  constructor(message, { status, hint } = {}) {
    super(hint ? `${message} ${hint}` : message)
    this.name = 'DashError'
    this.status = status
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** Message text of a Dash HTML error page (`<h1>HTTP Error 400: …</h1>`), else the raw body. */
export function errorText(body) {
  const match = /<h1>([^<]*)<\/h1>/i.exec(body)
  const text = (match ? match[1] : body).replace(/^HTTP Error \d+:\s*/i, '').trim()
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/**
 * @param {object} options
 * @param {boolean} options.autoLaunch - launch Dash (hidden, in the background) when it is not running
 * @param {boolean} options.autoEnableApi - write DHAPIServerEnabled=YES when the API server is off
 * @param {string[]} options.bundleIds - candidate bundle ids, tried in order (`open -b`)
 * @param {string[]} options.defaultsDomains - defaults domains to write the preference into
 * @param {number} options.timeoutMs - per-request timeout
 * @param {(line: object) => void} [options.trace]
 */
export function createDashClient(options) {
  const trace = options.trace ?? (() => {})
  const fetchTimeout = options.timeoutMs ?? 30_000
  /** Last base URL that answered /health; re-verified cheaply on each use. */
  let cached

  async function readPort() {
    try {
      const data = JSON.parse(await readFile(STATUS_FILE, 'utf8'))
      return typeof data.port === 'number' ? data.port : undefined
    } catch {
      return undefined
    }
  }

  async function healthy(base, signal) {
    try {
      const response = await fetch(`${base}/health`, { signal: anySignal(signal, 3_000) })
      return response.ok
    } catch {
      return false
    }
  }

  async function probe(signal) {
    const port = await readPort()
    if (port === undefined) return undefined
    const base = `http://127.0.0.1:${port}`
    return (await healthy(base, signal)) ? base : undefined
  }

  async function dashRunning() {
    try {
      await run('pgrep', ['-x', 'Dash'])
      return true
    } catch {
      return false
    }
  }

  async function launchDash() {
    for (const bundleId of options.bundleIds) {
      try {
        await run('open', ['-g', '-j', '-b', bundleId])
        trace({ event: 'dash-launched', bundleId })
        return true
      } catch (error) {
        trace({ event: 'dash-launch-failed', bundleId, error: String(error) })
      }
    }
    return false
  }

  async function enableApi() {
    let written = false
    for (const domain of options.defaultsDomains) {
      try {
        await run('defaults', ['write', domain, 'DHAPIServerEnabled', '-bool', 'YES'])
        written = true
      } catch (error) {
        trace({ event: 'defaults-write-failed', domain, error: String(error) })
      }
    }
    trace({ event: 'api-enable-requested', written })
    return written
  }

  /** Poll for a healthy server for up to `ms`. */
  async function waitFor(ms, signal) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const base = await probe(signal)
      if (base !== undefined) return base
      await sleep(500)
    }
    return undefined
  }

  /**
   * Base URL of a responding API server, launching Dash and/or enabling the
   * server when allowed. Throws a DashError with instructions otherwise.
   */
  async function baseUrl(signal) {
    if (cached !== undefined && await healthy(cached, signal)) return cached
    cached = undefined
    let base = await probe(signal)
    if (base === undefined) {
      const running = await dashRunning()
      if (!running) {
        if (!options.autoLaunch) throw new DashError('Dash is not running.', { hint: 'Start Dash (or enable autoLaunch in the dash-docsets plugin config) and retry.' })
        if (!(await launchDash())) throw new DashError(`Dash could not be launched (tried bundle ids ${options.bundleIds.join(', ')}).`, { hint: 'Is Dash installed?' })
        base = await waitFor(15_000, signal)
      }
      if (base === undefined) {
        if (!options.autoEnableApi) throw new DashError('The Dash API Server is disabled.', { hint: 'Enable it in Dash ▸ Settings ▸ Integration ▸ API Server (or enable autoEnableApi in the dash-docsets plugin config) and retry.' })
        if (!(await enableApi())) throw new DashError('Could not enable the Dash API Server via `defaults write`.', { hint: 'Enable it in Dash ▸ Settings ▸ Integration ▸ API Server and retry.' })
        base = await waitFor(10_000, signal)
      }
      if (base === undefined) throw new DashError('The Dash API Server did not come up.', { hint: `Check Dash ▸ Settings ▸ Integration ▸ API Server; the port file is ${STATUS_FILE}.` })
    }
    cached = base
    trace({ event: 'api-ready', base })
    return base
  }

  async function getJson(path, params, signal) {
    const base = await baseUrl(signal)
    const url = new URL(path, base)
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) url.searchParams.set(key, String(value))
    trace({ event: 'request', url: url.toString() })
    let response
    try {
      response = await fetch(url, { signal: anySignal(signal, fetchTimeout) })
    } catch (error) {
      cached = undefined
      throw new DashError(`Request to the Dash API failed: ${String(error?.cause ?? error)}.`, { hint: 'Dash may have quit or restarted; retry.' })
    }
    if (!response.ok) {
      const text = errorText(await response.text())
      if (response.status === 403 && /trial/i.test(text)) throw new DashError(`Dash refused the request: ${text}`, { status: 403, hint: 'The Dash trial has expired; the API is available in the purchased version only.' })
      throw new DashError(`Dash answered HTTP ${response.status}: ${text}`, { status: response.status })
    }
    return response.json()
  }

  /** `GET /docsets/list` → the raw docset rows. */
  async function listDocsets(signal) {
    const data = await getJson('/docsets/list', undefined, signal)
    return Array.isArray(data.docsets) ? data.docsets : []
  }

  /** `GET /search` → `{ results, message? }` with the empty placeholder rows removed. */
  async function search({ query, identifiers, maxResults, snippets }, signal) {
    const data = await getJson('/search', {
      query,
      docset_identifiers: identifiers.join(','),
      max_results: maxResults,
      search_snippets: snippets ? 'true' : 'false',
    }, signal)
    const results = (Array.isArray(data.results) ? data.results : []).filter(row => row && typeof row === 'object' && Object.keys(row).length > 0)
    return { results, message: typeof data.message === 'string' ? data.message : undefined }
  }

  /** Raw HTML of a docset page from a `load_url` (loopback only). */
  async function fetchPage(url, signal) {
    let parsed
    try { parsed = new URL(url) } catch { throw new DashError(`"${url}" is not a URL.`) }
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new DashError('dash_get_page only loads URLs returned by dash_search (http://127.0.0.1:<port>/Dash/…).', { hint: 'For other web pages use web_fetch or a browser tool.' })
    }
    trace({ event: 'page', url })
    let response
    try {
      response = await fetch(parsed, { signal: anySignal(signal, fetchTimeout), headers: { accept: 'text/html,*/*' } })
    } catch (error) {
      throw new DashError(`Loading ${url} failed: ${String(error?.cause ?? error)}.`, { hint: 'Dash page URLs are valid only for the current Dash launch — run dash_search again to get fresh ones.' })
    }
    if (response.status === 404) throw new DashError(`Dash has no page at ${url} (HTTP 404).`, { status: 404, hint: 'Page URLs are per Dash launch; run dash_search again.' })
    if (!response.ok) {
      const text = errorText(await response.text())
      throw new DashError(`Dash answered HTTP ${response.status} for ${url}: ${text}`, { status: response.status })
    }
    const type = response.headers.get('content-type') ?? ''
    return { html: await response.text(), contentType: type, finalUrl: response.url || url }
  }

  return { baseUrl, listDocsets, search, fetchPage, probe }
}

/** Combine the caller's abort signal with a timeout (either may be absent). */
function anySignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
