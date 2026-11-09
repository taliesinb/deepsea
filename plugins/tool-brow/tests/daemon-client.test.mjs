// The vendored socket client (daemon-client.mjs) and the link (link.mjs) against the fake daemon: where
// the socket is, starting the daemon through its command, framing of large replies, notifications,
// cancellation, the protocol check, and reconnecting.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { connect, daemonHome, socketPathOf, startCommandOf } from '../daemon-client.mjs'
import { createLink } from '../link.mjs'
import { startFakeDaemon, tempSocket } from './fake-daemon.mjs'

const FAKE_COMMAND = fileURLToPath(new URL('./fixtures/fake-brow.mjs', import.meta.url))

async function until(check, ms = 3000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('the socket the daemon itself would use; how its start command runs', () => {
  const home = '/Users/USER/Library/Application Support/io.github.taliesinb.brow' // dsd-check: allow
  assert.equal(daemonHome({}, 'darwin').endsWith('/Library/Application Support/io.github.taliesinb.brow'), true)
  assert.equal(daemonHome({ BROW_HOME: home }, 'darwin'), home)
  assert.equal(daemonHome({ XDG_STATE_HOME: '/state' }, 'linux'), '/state/brow')
  assert.equal(daemonHome({ XDG_STATE_HOME: 'state' }, 'linux').endsWith('/.local/state/brow'), true, 'a relative XDG_STATE_HOME is ignored, as the daemon ignores it')
  assert.equal(socketPathOf({}, { BROW_HOME: '/h' }), '/h/run/daemon.sock')
  assert.equal(socketPathOf({}, { BROW_HOME: '/h', BROW_SOCKET: '/s.sock' }), '/s.sock')
  assert.equal(socketPathOf({ home: '/mine' }, { BROW_SOCKET: '/s.sock' }), '/mine/run/daemon.sock')
  assert.equal(socketPathOf({ socket: '/x.sock', home: '/mine' }, {}), '/x.sock')
  assert.deepEqual(startCommandOf('brow'), { file: 'brow', args: ['start'] })
  assert.deepEqual(startCommandOf('/co/bin/brow.mjs'), { file: process.execPath, args: ['/co/bin/brow.mjs', 'start'] })
})

test('hello, requests, notifications and a reply split across many chunks', async () => {
  const temp = tempSocket()
  const big = 'x'.repeat(3_000_000)
  const daemon = await startFakeDaemon({ socket: temp.socket, onCall: () => ({ content: [{ type: 'text', text: big }], isError: false }) })
  try {
    const client = await connect({ socket: temp.socket, name: 'test', version: '1' })
    assert.equal(client.hello.pid, 4242)
    assert.deepEqual(daemon.of('hello')[0], { client: { name: 'test', version: '1' }, protocol: 1 })
    await client.request('session.open', { key: 'k' })
    const result = await client.request('tools.call', { session: 'k', name: 'browser_read' })
    assert.equal(result.content[0].text.length, big.length)
    const notices = []
    client.on('session.notice', (params) => notices.push(params))
    daemon.notice('k', 'hi')
    await until(() => notices.length === 1)
    assert.deepEqual(notices, [{ session: 'k', text: 'hi' }])
    await assert.rejects(client.request('session.update', { session: 'nope' }), { code: -32602, message: /unknown session/ })
    client.close()
  } finally { await daemon.close(); temp.remove() }
})

test('cancellation: $/cancel at once; a daemon that never answers is abandoned', async () => {
  const temp = tempSocket()
  const daemon = await startFakeDaemon({ socket: temp.socket, onCall: () => new Promise(() => {}) })
  try {
    const client = await connect({ socket: temp.socket })
    await client.request('session.open', { key: 'k' })
    const controller = new AbortController()
    const call = client.request('tools.call', { session: 'k', name: 'browser_eval' }, { signal: controller.signal, abandonMs: 50 })
    await until(() => daemon.of('tools.call').length === 1)
    controller.abort(new Error('stop'))
    await assert.rejects(call, { message: 'stop' })
    assert.equal(daemon.cancelled.length, 1)
    client.close()
  } finally { await daemon.close(); temp.remove() }
})

test('a daemon speaking another protocol is refused with what to do', async () => {
  const temp = tempSocket()
  const server = createServer((sock) => {
    sock.setEncoding('utf8')
    sock.on('data', (line) => { const { id } = JSON.parse(line); sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { protocol: 2, pid: 9, version: '9.0.0' } })}\n`) })
  })
  await new Promise(resolve => server.listen(temp.socket, resolve))
  try {
    await assert.rejects(connect({ socket: temp.socket }), { message: /speaks protocol 2, this plugin 1; update the one that is older/ })
  } finally { await new Promise(resolve => server.close(resolve)); temp.remove() }
})

test('autostart: a failing start command is reported with its output; a missing one too', async () => {
  const temp = tempSocket()
  try {
    await assert.rejects(connect({ socket: temp.socket, autostart: { command: FAKE_COMMAND, env: { ...process.env, FAKE_START_FAIL: '1' } } }),
      { message: /starting one with ".*fake-brow\.mjs start" failed: it exited with code 3: brow: cannot start: fake failure/ })
    await assert.rejects(connect({ socket: temp.socket, autostart: { command: join(temp.dir, 'no-such-brow') } }),
      { message: /failed: spawn .*no-such-brow ENOENT/ })
    await assert.rejects(connect({ socket: temp.socket }), { message: /no brow daemon is running on/ })
  } finally { temp.remove() }
})

test('link: one dial for concurrent callers; quick reconnects after a restart, hooks run again', async () => {
  const temp = tempSocket()
  let daemon = await startFakeDaemon({ socket: temp.socket })
  const connected = []
  const link = createLink({ socket: temp.socket, autostart: false, reconnectDelaysMs: [20, 50, 100] })
  link.onConnected((client, { restarted }) => connected.push({ pid: client.hello.pid, restarted }))
  try {
    const [a, b] = await Promise.all([link.ensure(), link.ensure()])
    assert.equal(a, b)
    assert.equal(daemon.of('hello').length, 1)
    await daemon.close()
    daemon = await startFakeDaemon({ socket: temp.socket, pid: 777 })
    await until(() => connected.length === 2)
    assert.deepEqual(connected, [{ pid: 4242, restarted: false }, { pid: 777, restarted: true }])
    assert.equal(link.current().hello.pid, 777)
    // After the quick reconnects give up, only a caller dials again.
    await daemon.close()
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(link.current(), undefined)
    daemon = await startFakeDaemon({ socket: temp.socket, pid: 778 })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(link.current(), undefined)
    assert.equal((await link.ensure()).hello.pid, 778)
  } finally { await link.dispose(); await daemon.close(); temp.remove() }
})
