/**
 * @deepsea/import-api-keys, host half.
 *
 * `/import-api-keys` is a browser command (src/client): it opens the file
 * picker, parses the file (parse.mjs) and writes the keys through DSH's own
 * `remote.credentials.set`. The host half exists for the one thing the wire
 * API deliberately cannot do: say whether a candidate value DIFFERS from what
 * is stored. `describe` never returns values, so the browser posts the
 * candidates once to `POST /deepsea-import-api-keys/plan` and gets back, per
 * name, `new` | `same` | `different` | `readonly` (a value supplied by the
 * process environment shadows the store, so a write would not take) |
 * `invalid`. Nothing is written here; the confirm step in the browser applies
 * through the sanctioned write path, and every consumer re-resolves its
 * credentials per request, so imported keys work at once.
 *
 * The route sits behind DSH's own request gate (`connection.requestRejection`:
 * the Host/Origin fence and the browser-session cookie) and takes the
 * Connection JSON envelope, so any admitted connection reaches it.
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'deepsea-import-api-keys'
export const inject = ['webServer', 'connection', 'credentials']

/** The plan route's prefix (document-relative in the browser). */
export const CHANNEL = '/deepsea-import-api-keys'
const MAX_BODY = 256 * 1024
const MAX_KEYS = 200
const REF = /^[A-Z][A-Z0-9_]*$/

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Compare candidates against the store. Exported for tests.
 * @param {{ resolve(ref: any): Promise<{ value: string, source: string } | undefined>, describe(ref: any): Promise<{ writable: boolean, source?: string }> }} credentials
 * @param {Record<string, string>} keys
 */
export async function planImport(credentials, keys) {
  const plan = {}
  const entries = Object.entries(keys ?? {})
  if (entries.length > MAX_KEYS) throw new Error(`too many keys (${entries.length} > ${MAX_KEYS})`)
  for (const [name, value] of entries) {
    if (!REF.test(name) || typeof value !== 'string' || value.trim() === '') { plan[name] = { status: 'invalid' }; continue }
    const ref = credentialRef(name)
    const [current, info] = await Promise.all([credentials.resolve(ref), credentials.describe(ref)])
    if (info.writable === false) { plan[name] = { status: 'readonly', source: info.source }; continue }
    if (current === undefined) { plan[name] = { status: 'new' }; continue }
    plan[name] = { status: current.value === value.trim() ? 'same' : 'different', source: current.source }
  }
  return plan
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = new URL(req.url ?? '/', 'http://x').pathname.slice(CHANNEL.length + 1)
      if (req.method !== 'POST' || endpoint !== 'plan') { res.writeHead(404); res.end('not found'); return }
      let message
      try { message = JSON.parse(await readBody(req, MAX_BODY)) } catch { res.writeHead(400); res.end('body is not JSON'); return }
      if (typeof message !== 'object' || message === null || message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) {
        res.writeHead(400); res.end('invalid client-request envelope'); return
      }
      let result
      try {
        const keys = message.payload?.args?.keys
        if (typeof keys !== 'object' || keys === null) throw new Error('args.keys must be an object')
        result = { ok: true, value: { plan: await planImport(ctx.credentials, keys) } }
      } catch (error) {
        result = { ok: false, error: { code: 'deepsea-import-api-keys/plan-failed', message: String(error?.message ?? error), details: {} } }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
    },
  }), 'import-api-keys: plan route')
}
