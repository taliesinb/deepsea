/**
 * Remote transcripts: spec parsing, MagicDNS resolution against a fake
 * `tailscale status --json`, and an end-to-end loop over loopback — instance
 * A serves its sessions (serve.mjs routes mounted under a path prefix, as
 * Tailscale Serve would present them), instance B's tools read them with
 * `remote: "127.0.0.1:<port>/deepsea-a"`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Config, apply, build } from '../index.js'
import { API_VERSION, createRemoteClient, createTailnet, parseRemoteSpec, resolveRemote } from '../remote.mjs'
import { fakeCtx, fakeExec, textOf } from './fake-ctx.mjs'

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'))
const wae = fixture('web-automation-errors')
const self = fixture('headless-selftest')

// ------------------------------------------------------------ spec parsing

test('parseRemoteSpec: machine names, mounts, host:port, URLs, local', () => {
  assert.equal(parseRemoteSpec(undefined), null)
  assert.equal(parseRemoteSpec(''), null)
  assert.equal(parseRemoteSpec('local'), null)
  assert.deepEqual(parseRemoteSpec('node'), { kind: 'host', host: 'node', port: null, mount: '/deepsea', bareLabel: true })
  assert.deepEqual(parseRemoteSpec('node/deepsea-personal'), { kind: 'host', host: 'node', port: null, mount: '/deepsea-personal', bareLabel: true })
  assert.deepEqual(parseRemoteSpec('Node/deepsea-personal/'), { kind: 'host', host: 'node', port: null, mount: '/deepsea-personal', bareLabel: true })
  assert.deepEqual(parseRemoteSpec('node.example.ts.net/deepsea'), { kind: 'host', host: 'node.example.ts.net', port: null, mount: '/deepsea', bareLabel: false })
  // a full DNS name with no path is a root-served host, not a /deepsea guess
  assert.deepEqual(parseRemoteSpec('box.example.com'), { kind: 'host', host: 'box.example.com', port: null, mount: '/', bareLabel: false })
  assert.deepEqual(parseRemoteSpec('127.0.0.1:3082'), { kind: 'host', host: '127.0.0.1', port: 3082, mount: '/', bareLabel: false })
  assert.deepEqual(parseRemoteSpec('localhost:3082/deepsea-a'), { kind: 'host', host: 'localhost', port: 3082, mount: '/deepsea-a', bareLabel: false })
  assert.deepEqual(parseRemoteSpec('https://node.example.ts.net/deepsea-personal'), { kind: 'url', url: 'https://node.example.ts.net/deepsea-personal/' })
  assert.deepEqual(parseRemoteSpec('http://127.0.0.1:3082'), { kind: 'url', url: 'http://127.0.0.1:3082/' })
  assert.throws(() => parseRemoteSpec('ftp://x/'), /must be http\(s\)/)
  assert.throws(() => parseRemoteSpec('https://x/?token=1'), /query or fragment/)
  assert.throws(() => parseRemoteSpec('al pha'), /not a machine name/)
})

const STATUS = {
  BackendState: 'Running',
  MagicDNSSuffix: 'example.ts.net',
  Self: { HostName: 'this-node', DNSName: 'this-node.example.ts.net.', Online: true },
  Peer: {
    k1: { HostName: 'node', DNSName: 'node.example.ts.net.', Online: true },
    k2: { HostName: 'Other-Node', DNSName: 'other-node.example.ts.net.', Online: false },
  },
}

test('resolveRemote: bare labels become MagicDNS names over https; dotted hosts and loopback pass through', async () => {
  const tailnet = createTailnet({ statusJson: async () => STATUS })
  assert.deepEqual(await resolveRemote(parseRemoteSpec('node/deepsea-personal'), tailnet), { key: 'node/deepsea-personal', baseUrl: 'https://node.example.ts.net/deepsea-personal/', online: true })
  assert.deepEqual(await resolveRemote(parseRemoteSpec('node'), tailnet), { key: 'node/deepsea', baseUrl: 'https://node.example.ts.net/deepsea/', online: true })
  // HostName match is case-insensitive; the DNS label form matches too
  assert.equal((await resolveRemote(parseRemoteSpec('other-node'), tailnet)).baseUrl, 'https://other-node.example.ts.net/deepsea/')
  assert.equal((await resolveRemote(parseRemoteSpec('other-node'), tailnet)).online, false)
  assert.deepEqual(await resolveRemote(parseRemoteSpec('this-node/deepsea'), tailnet), { key: 'this-node/deepsea', baseUrl: 'https://this-node.example.ts.net/deepsea/', online: true })
  assert.deepEqual(await resolveRemote(parseRemoteSpec('node.example.ts.net/deepsea'), tailnet), { key: 'node.example.ts.net/deepsea', baseUrl: 'https://node.example.ts.net/deepsea/', online: null })
  assert.deepEqual(await resolveRemote(parseRemoteSpec('127.0.0.1:3082/deepsea-a'), tailnet), { key: '127.0.0.1:3082/deepsea-a', baseUrl: 'http://127.0.0.1:3082/deepsea-a/', online: null })
  assert.deepEqual(await resolveRemote(parseRemoteSpec('https://x.example/y/'), tailnet), { key: 'x.example/y', baseUrl: 'https://x.example/y/', online: null })
  await assert.rejects(resolveRemote(parseRemoteSpec('gamma'), tailnet), /"gamma" is not a machine on this tailnet \(example\.ts\.net\).*Known machines: node, other-node, this-node/)
})

test('resolveRemote: Tailscale unavailable or stopped is explained', async () => {
  await assert.rejects(resolveRemote(parseRemoteSpec('node'), createTailnet({ statusJson: async () => undefined })), /cannot ask Tailscale.*full DNS name/)
  await assert.rejects(resolveRemote(parseRemoteSpec('node'), createTailnet({ statusJson: async () => ({ BackendState: 'Stopped' }) })), /Tailscale is stopped/)
})

// ------------------------------------------------------ end-to-end (loopback)

/**
 * Serve a fake ctx's registered routes over HTTP under `mount`, the way
 * Tailscale Serve presents a variant at `/deepsea-<v>` (prefix stripped
 * before DSH sees the path). Unknown paths answer 404 like DSH's webserver.
 */
async function serveRoutes(ctx, mount, { admit = () => true } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (!admit(req)) { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('unauthorized'); return }
    if (!url.pathname.startsWith(`${mount}/`)) { res.writeHead(404); res.end('not found'); return }
    const path = url.pathname.slice(mount.length)
    if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>dsh</html>'); return } // the instance's index, like DSH
    const route = ctx.routes.get(path)
    if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
    const request = new Request(`http://x${path}${url.search}`, { method: req.method, headers: req.headers })
    const response = await route.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) }
}

test('end to end: instance B reads instance A\'s sessions through the served routes', async (t) => {
  // A: two sessions, one live; the plugin applied for real (tools + routes).
  const a = fakeCtx({ snapshots: [wae, self], live: new Set([self.session.id]), running: new Set([self.session.id]), cwds: { [wae.session.id]: '/home/a/projects/widgets' } })
  a.tools = { register() {} }
  apply(a, Config({}))
  assert.deepEqual([...a.routes.keys()], ['/api/deepsea-session-introspect/v1/capabilities', '/api/deepsea-session-introspect/v1/sessions', '/api/deepsea-session-introspect/v1/session'])
  const served = await serveRoutes(a, '/deepsea-a')
  t.after(served.close)

  // B: a different corpus; its tools point at A with `remote`.
  const b = fakeCtx({ snapshots: [self] })
  const { tools } = build(b, Config({}))
  const tool = (name) => tools.find(x => x.name === name)
  const exec = fakeExec(self.session.id, '/Users/USER/b')
  const remote = `127.0.0.1:${served.port}/deepsea-a`
  const run = (name, args) => tool(name).execute({ ...args, remote }, exec)

  for (const x of tools) assert.ok((x.parameters.properties ?? x.parameters).remote, `${x.name} has remote`)

  const found = await run('transcript_find', {})
  assert.equal(found.remote, remote)
  assert.equal(found.total, 2)
  assert.ok(found.sessions.every(s => s.self === false), 'no session on a remote is "this session"')
  assert.equal(found.sessions.find(s => s.id === self.session.id).live, true)
  assert.equal(found.sessions.find(s => s.id === self.session.id).running, true, 'running travels over the wire')
  assert.equal(found.sessions.find(s => s.id === wae.session.id).running, false)
  // the status view: only attached sessions, running ones marked
  const active = await run('transcript_find', { active: true })
  assert.deepEqual(active.sessions.map(s => s.id), [self.session.id])
  assert.match(textOf(tool('transcript_find'), {}, active), /running\n1 active session on 127\.0\.0\.1:\d+\/deepsea-a \(1 running a turn\)/)
  const none = await run('transcript_find', { active: true, workspace: 'widgets' })
  assert.match(textOf(tool('transcript_find'), {}, none), /^.*\nNo active sessions on 127\.0\.0\.1/)
  assert.equal(found.sessions.find(s => s.id === wae.session.id).workspace, 'widgets')
  assert.match(textOf(tool('transcript_find'), {}, found), new RegExp(`2 sessions on ${remote.replace(/[.]/g, '\\.')}`))
  assert.equal(a.calls.filter(c => c === 'listSessions').length >= 1, true)

  const outline = await run('transcript_outline', { session: 'widgets/web-automation' })
  assert.equal(outline.session.id, wae.session.id)
  assert.equal(outline.session.remote, remote)
  assert.equal(outline.turns.length, 5)
  assert.match(textOf(tool('transcript_outline'), {}, outline), new RegExp(`${remote.replace(/[.]/g, '\\.')}:widgets/web-automation-errors`))
  assert.ok(a.calls.includes(`readSession:${wae.session.id}`), 'the log was read on A')

  const ev = await run('transcript_event', { session: wae.session.id, seq: outline.turns[0].seqFrom })
  assert.equal(ev.event.seq, outline.turns[0].seqFrom)

  const stats = await run('transcript_tool_stats', { sessions: ['*'] })
  assert.equal(stats.remote, remote)
  assert.equal(stats.sessions.length, 2)
  assert.ok(stats.tools.length > 0)

  const grep = await run('transcript_grep', { pattern: 'safari', sessions: ['*'], limit: 3 })
  assert.equal(grep.hits.length, 3)
  assert.match(textOf(tool('transcript_grep'), {}, grep), /on 127\.0\.0\.1/)

  const exported = await run('transcript_export', { sessions: ['widgets/*'], limit: 2 })
  assert.equal(exported.rows.length, 2)
  assert.equal(exported.rows[0].sessionName, `${remote}:widgets/web-automation-errors`)

  // Same session id on both instances: the caches are keyed by source, so B's local copy is untouched.
  const localOutline = await tool('transcript_outline').execute({}, exec)
  assert.equal(localOutline.session.remote, null)

  await assert.rejects(run('transcript_outline', {}), /No calling session on 127\.0\.0\.1.*transcript_find remote:/)
  await assert.rejects(run('transcript_outline', { session: 'nope/x' }), /No workspace named "nope" on 127\.0\.0\.1/)
  await assert.rejects(run('transcript_event', { session: wae.session.id, seq: 999999 }), /No event with seq/)
})

test('end to end: a remote without the plugin, a refusing remote, a wrong api generation, an unreachable one', async (t) => {
  const bare = await serveRoutes(fakeCtx({ snapshots: [] }), '/deepsea-none') // no apply → no routes → 404
  t.after(bare.close)
  const b = fakeCtx({ snapshots: [self] })
  const { tools } = build(b, Config({}))
  const find = tools.find(x => x.name === 'transcript_find')
  const exec = fakeExec(self.session.id, '/Users/USER/b')
  await assert.rejects(find.execute({ remote: `127.0.0.1:${bare.port}/deepsea-none` }, exec), /has no transcript routes: the session-introspect plugin is not installed there/)
  // a wrong mount path: nothing answers at the root either
  await assert.rejects(find.execute({ remote: `127.0.0.1:${bare.port}/deepsea-typo` }, exec), /nothing is served at http:\/\/127\.0\.0\.1:\d+\/deepsea-typo\/ \(404\).*mount path/)

  const a = fakeCtx({ snapshots: [wae] })
  a.tools = { register() {} }
  apply(a, Config({}))
  const refusing = await serveRoutes(a, '/deepsea-a', { admit: () => false })
  t.after(refusing.close)
  await assert.rejects(find.execute({ remote: `127.0.0.1:${refusing.port}/deepsea-a` }, exec), /refused this machine \(401\).*allowed-user list/)

  // an unreachable port: the connection error is wrapped, not leaked as a stack
  await assert.rejects(find.execute({ remote: '127.0.0.1:1/deepsea' }, exec), /remote 127\.0\.0\.1:1\/deepsea is not reachable/)

  // api mismatch: a fake fetch answering capabilities for another generation
  const client = createRemoteClient({ key: 'x', baseUrl: 'http://x/', online: null }, {
    fetch: async () => new Response(JSON.stringify({ api: API_VERSION + 1 }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  await assert.rejects(client.capabilities(), /speaks transcript api 2 but this plugin needs 1/)
})

test('serve: a session log is gzipped when accepted and carries live; missing id / unknown id are errors', async () => {
  const a = fakeCtx({ snapshots: [wae, self], live: new Set([self.session.id]) })
  a.tools = { register() {} }
  apply(a, Config({}))
  const route = a.routes.get('/api/deepsea-session-introspect/v1/session')
  const gz = await route.fetch(new Request(`http://x/api/deepsea-session-introspect/v1/session?id=${self.session.id}`, { headers: { 'accept-encoding': 'gzip, br' } }))
  assert.equal(gz.status, 200)
  assert.equal(gz.headers.get('content-encoding'), 'gzip')
  const { gunzipSync } = await import('node:zlib')
  const body = JSON.parse(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString('utf8'))
  assert.equal(body.live, true)
  assert.equal(body.events.length, self.events.length)
  const plain = await route.fetch(new Request(`http://x/api/deepsea-session-introspect/v1/session?id=${wae.session.id}`))
  assert.equal(plain.headers.get('content-encoding'), null)
  assert.equal((await plain.json()).live, false)
  assert.equal((await route.fetch(new Request('http://x/api/deepsea-session-introspect/v1/session'))).status, 400)
  const missing = await route.fetch(new Request('http://x/api/deepsea-session-introspect/v1/session?id=session-nope'))
  assert.equal(missing.status, 404)
  const caps = await (await a.routes.get('/api/deepsea-session-introspect/v1/capabilities').fetch(new Request('http://x/api/deepsea-session-introspect/v1/capabilities'))).json()
  assert.equal(caps.api, API_VERSION)
  assert.equal(caps.plugin, '@deepsea/session-introspect')
  // serve: false registers no routes
  const quiet = fakeCtx({ snapshots: [] })
  quiet.tools = { register() {} }
  apply(quiet, Config({ serve: false }))
  assert.equal(quiet.routes.size, 0)
})
