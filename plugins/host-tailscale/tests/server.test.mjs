/** Server section data: client tracking on a real http.Server, sniffing, agent labels; process rows and actions with an injected runner. */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { attachClientTracker, clientFacts, describeUserAgent, parseEtime, performAction, processTable, relayJob, sniffSession } from '../server.mjs'

describe('server pane helpers', () => {
  it('parses macOS ps etime', () => {
    assert.equal(parseEtime('00:14'), 14)
    assert.equal(parseEtime('01:02:03'), 3723)
    assert.equal(parseEtime('2-01:00:00'), 176400)
    assert.equal(parseEtime('garbage'), undefined)
  })
  it('labels user agents', () => {
    assert.equal(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) DeepSea/0.2.1-alpha.1'), 'DeepSea')
    assert.equal(describeUserAgent('DeepSea/0.2.1'), 'DeepSea', 'the forward WebSocket of the app')
    assert.equal(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Version/17.0 Mobile/15E148 Safari/604.1'), 'iOS Safari')
    assert.equal(describeUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'), 'Chrome')
    assert.equal(describeUserAgent('curl/8.7.1'), 'curl')
    assert.equal(describeUserAgent(undefined), '—')
  })
  it('reads identity facts from the proxy headers or the socket', () => {
    const proxied = clientFacts({ headers: { 'x-deepsea-tailscale': '1', 'x-deepsea-tailscale-admitted': 'user', 'x-deepsea-tailscale-login': 'user@example.com', 'x-forwarded-for': '100.1.2.3', 'x-deepsea-tailscale-self': '1', 'user-agent': 'DeepSea/0.2.1' }, socket: { remoteAddress: '127.0.0.1' } })
    assert.deepEqual(proxied, { proxied: true, login: 'user@example.com', admitted: 'user', address: '100.1.2.3', self: true, userAgent: 'DeepSea/0.2.1' })
    const direct = clientFacts({ headers: { 'user-agent': 'curl/8' }, socket: { remoteAddress: '::ffff:127.0.0.1' } })
    assert.deepEqual(direct, { proxied: false, login: 'local', admitted: 'local', address: '127.0.0.1', self: true, userAgent: 'curl/8' })
    const phone = clientFacts({ headers: { 'x-deepsea-tailscale': '1', 'x-deepsea-tailscale-admitted': 'cookie', 'x-forwarded-for': '100.9.9.9' }, socket: { remoteAddress: '127.0.0.1' } })
    assert.equal(phone.login, undefined)
    assert.equal(phone.self, false)
  })
  it('sniffs session ids and cwds only from session/* bodies', () => {
    assert.deepEqual(sniffSession('session/attach', JSON.stringify({ payload: { args: { sessionId: 'session-abc' } } })), { method: 'session/attach', sessionId: 'session-abc', cwd: undefined })
    assert.deepEqual(sniffSession('session/create', JSON.stringify({ payload: { args: [{ cwd: '/w' }] } })), { method: 'session/create', sessionId: undefined, cwd: '/w' })
    assert.deepEqual(sniffSession('session/prompt', JSON.stringify({ payload: { args: { request: { requestId: 'r', sessionId: 'session-p', mode: 'queue', content: [] } } } })), { method: 'session/prompt', sessionId: 'session-p', cwd: undefined }, 'typert wire shape: args keyed by parameter name')
    assert.equal(sniffSession('settings/read', JSON.stringify({ payload: { args: { sessionId: 'session-x' } } })), undefined)
    assert.equal(sniffSession('session/list', '{nope'), undefined)
  })
})

describe('client tracker on a live http.Server', () => {
  let server
  let port
  let tracker
  let clock = 1_000_000
  before(async () => {
    server = createServer((req, res) => { req.resume(); req.on('end', () => { res.end('ok') }) })
    server.on('upgrade', (req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      // http upgrade sockets are allowHalfOpen: the real ws server reads them
      // and closes on the peer's FIN; do the same here.
      socket.resume()
      socket.on('end', () => socket.destroy())
      socket.on('error', () => {})
    })
    tracker = attachClientTracker(server, { now: () => clock })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })
  after(async () => {
    tracker.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })

  const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'user-agent': 'DeepSea/0.2.1', ...headers } }, (res) => { res.resume(); res.on('end', resolve) })
    req.on('error', reject)
    req.end(body)
  })

  it('records requests, sniffs the session body without consuming it, and counts live sockets', async () => {
    const proxied = { 'x-deepsea-tailscale': '1', 'x-deepsea-tailscale-admitted': 'user', 'x-deepsea-tailscale-login': 'user@example.com', 'x-forwarded-for': '100.1.2.3' }
    await post('/api/session/attach', JSON.stringify({ type: 'client-request', payload: { args: { sessionId: 'session-abc' } } }), proxied)
    await post('/api/settings/read', '{}', proxied)
    await new Promise(resolve => setTimeout(resolve, 20))
    let [row] = tracker.snapshot()
    assert.equal(row.login, 'user@example.com')
    assert.equal(row.agent, 'DeepSea')
    assert.equal(row.requests, 2)
    assert.equal(row.lastSession.sessionId, 'session-abc')
    assert.equal(row.lastPath, '/api/settings/read')

    const socket = connect(port, '127.0.0.1')
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write(`GET /api/remote.mux HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nUser-Agent: DeepSea/0.2.1\r\n${Object.entries(proxied).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
    await new Promise(resolve => socket.once('data', resolve))
    ;[row] = tracker.snapshot()
    assert.equal(row.sockets, 1)
    socket.destroy()
    for (let i = 0; i < 50 && tracker.snapshot()[0].sockets !== 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
    ;[row] = tracker.snapshot()
    assert.equal(row.sockets, 0)
  })

  it('keeps direct loopback clients apart and expires idle rows', async () => {
    await post('/api/session/list', '{}', { 'user-agent': 'curl/8' })
    let rows = tracker.snapshot()
    assert.equal(rows.length, 2)
    const direct = rows.find(r => r.agent === 'curl')
    assert.equal(direct.login, 'local')
    assert.equal(direct.proxied, false)
    clock += 3 * 60 * 1000
    rows = tracker.snapshot()
    assert.equal(rows.length, 0, 'idle rows without sockets expire')
  })
})

/** A runner standing in for ps, pgrep, launchctl, pkill and open: records calls, answers from a table. */
function fakeRun(answers = {}) {
  const calls = []
  const run = async (binary, args) => {
    calls.push([binary, ...args])
    const key = `${binary.split('/').pop()} ${args[0]}`
    const answer = answers[key]
    return typeof answer === 'function' ? answer(args) : answer ?? { code: 1, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe('processes and actions', () => {
  const ps = { 'ps -o': args => ({ code: 0, stdout: `   01:05  2048  1 /usr/bin/thing --pid ${args.at(-1)}\n` }) }

  it('relayJob reads launchctl print (read-only): loaded and pid', async () => {
    const loaded = fakeRun({ 'launchctl print': { code: 0, stdout: 'gui/501/x = {\n\tstate = running\n\tpid = 4321\n}\n' } })
    const job = await relayJob('io.github.taliesinb.deepsea.lab.relay', loaded.run)
    if (process.platform === 'darwin') {
      assert.deepEqual(job, { loaded: true, pid: 4321 })
      assert.deepEqual(loaded.calls[0].slice(0, 2), ['/bin/launchctl', 'print'])
      assert.match(loaded.calls[0][2], /^gui\/\d+\/io\.github\.taliesinb\.deepsea\.lab\.relay$/)
    }
    assert.deepEqual(await relayJob('x', fakeRun().run), { loaded: false })
  })

  it('relayJob on Linux reads the systemd user unit: loaded while it runs, and its pid', async () => {
    const show = stdout => fakeRun({ 'systemctl --user': { code: 0, stdout } })
    const running = show('LoadState=loaded\nActiveState=active\nMainPID=4321\n')
    assert.deepEqual(await relayJob('io.github.taliesinb.deepsea.lab.relay', running.run, 'linux'), { loaded: true, pid: 4321, unit: 'io.github.taliesinb.deepsea.lab.relay.service' })
    assert.deepEqual(running.calls[0], ['systemctl', '--user', 'show', 'io.github.taliesinb.deepsea.lab.relay.service', '--property=LoadState,ActiveState,MainPID'])
    assert.deepEqual(await relayJob('x', show('LoadState=loaded\nActiveState=inactive\nMainPID=0\n').run, 'linux'), { loaded: false })
    assert.deepEqual(await relayJob('x', show('LoadState=not-found\nActiveState=inactive\nMainPID=0\n').run, 'linux'), { loaded: false })
    const rows = await processTable({ relay: { url: 'http://127.0.0.1:3203/', label: 'x', job: { loaded: true, pid: 9, unit: 'x.service' }, listening: true }, port: 3200, home: '/h', run: fakeRun(ps).run })
    assert.equal(rows[0].details[0], 'systemd unit x.service')
    const deferred = []
    const { run, calls } = fakeRun()
    await performAction({ target: 'relay', action: 'restart' }, { relayLabel: 'x', relayLoaded: true, relayListening: true, deferSelf: fn => deferred.push(fn), log: () => {}, run, platform: 'linux' })
    deferred.shift()()
    assert.deepEqual(calls.at(-1), ['systemctl', '--user', 'restart', 'x.service'])
  })

  it('rows: the relay with restart only when its job is loaded; dsh web quits, and restarts only behind a relay; the app launches or quits', async () => {
    const { run } = fakeRun({ ...ps, 'pgrep -f': { code: 0, stdout: '777\n' } })
    const rows = await processTable({
      relay: { url: 'http://127.0.0.1:3203/', port: 3203, label: 'io.github.taliesinb.deepsea.lab.relay', job: { loaded: true, pid: 55 }, listening: true },
      app: { path: '/Users/USER/Applications/DeepSea Lab.app', name: 'DeepSea Lab' },
      port: 3200, home: '/Users/USER/.deepsea/lab', run,
    })
    assert.deepEqual(rows.map(r => [r.id, r.actions.map(a => a.id)]), [['relay', ['restart']], ['dsh', ['restart', 'quit']], ['app', ['quit']]])
    assert.equal(rows[0].pid, 55)
    assert.equal(rows[0].uptimeSeconds, 65)
    assert.equal(rows[2].title, 'DeepSea Lab.app')
    const bare = await processTable({ relay: { url: 'http://127.0.0.1:41234/', port: 41234, job: { loaded: false }, listening: true }, port: 41230, home: '/h', run: fakeRun(ps).run })
    assert.deepEqual(bare.map(r => [r.id, r.actions.map(a => a.id)]), [['relay', []], ['dsh', ['restart', 'quit']]], 'a throwaway relay has no job to restart')
    const alone = await processTable({ port: 41230, home: '/h', run: fakeRun(ps).run })
    assert.deepEqual(alone.map(r => [r.id, r.actions.map(a => a.id)]), [['dsh', ['quit']]])
  })

  it('actions: kickstart -k and SIGTERM only after the answer; app launch and quit; nothing else', async () => {
    const deferred = []
    const killed = []
    const { run, calls } = fakeRun()
    const deps = { relayLabel: 'io.github.taliesinb.deepsea.lab.relay', relayLoaded: true, relayListening: true, appPath: '/Users/USER/Applications/DeepSea Lab.app', appName: 'DeepSea Lab', deferSelf: fn => deferred.push(fn), log: () => {}, run, kill: (pid, signal) => killed.push([pid, signal]), platform: 'darwin' }
    assert.equal((await performAction({ target: 'relay', action: 'restart' }, deps)).message, 'Relay restarting.')
    assert.equal(calls.length, 0, 'nothing runs before the answer')
    deferred.shift()()
    assert.deepEqual(calls.at(-1).slice(0, 3), ['/bin/launchctl', 'kickstart', '-k'])
    await performAction({ target: 'dsh', action: 'restart' }, deps)
    await performAction({ target: 'dsh', action: 'quit' }, deps)
    assert.equal(killed.length, 0)
    for (const fn of deferred.splice(0)) fn()
    assert.deepEqual(killed, [[process.pid, 'SIGTERM'], [process.pid, 'SIGTERM']])
    await performAction({ target: 'app', action: 'quit' }, deps)
    assert.deepEqual(calls.at(-1), ['/usr/bin/pkill', '-TERM', '-f', '/Users/USER/Applications/DeepSea Lab.app/Contents/MacOS/'])
    await performAction({ target: 'app', action: 'launch' }, deps)
    assert.deepEqual(calls.at(-1), ['/usr/bin/open', '/Users/USER/Applications/DeepSea Lab.app'])
    await assert.rejects(performAction({ target: 'relay', action: 'restart' }, { ...deps, relayLoaded: false }), /no relay job/)
    await assert.rejects(performAction({ target: 'dsh', action: 'restart' }, { ...deps, relayListening: false }), /no relay/)
    await assert.rejects(performAction({ target: 'relay', action: 'stop' }, deps), /unknown action/)
    await assert.rejects(performAction({ target: 'relay', action: 'install' }, deps), /unknown action/)
  })
})
