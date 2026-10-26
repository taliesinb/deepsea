import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsd-test-'))
process.env.DEEPSEA_ROOT = join(root, 'deepsea')
process.env.DEEPSEA_LOG_ROOT = join(root, 'logs')
test.after(() => rmSync(root, { recursive: true, force: true }))

const { checkNamedId, displayName, parseThrowaway, resolveRef, writeState, writeVariant } = await import('../lib/variants.mjs')
const { formatFlatYaml, parseArgs, parseFlatYaml } = await import('../lib/util.mjs')
const { parseLock } = await import('../lib/harness.mjs')
const { openRunLog, prune } = await import('../lib/logs.mjs')
const { homeOf, logDirOf, variantName } = await import('../lib/paths.mjs')

test('variant ids: named ids are plain, throwaway ids are <parent>-<6 hex>', () => {
  for (const id of ['release', 'personal', 'my-test', 'a1']) assert.doesNotThrow(() => checkNamedId(id))
  for (const id of ['Release', 'a.b', '-x', 'x-', 'a--b', '', 'personal-3f9a1c']) assert.throws(() => checkNamedId(id), id)
  assert.deepEqual(parseThrowaway('personal-3f9a1c'), { parent: 'personal', hex: '3f9a1c' })
  assert.deepEqual(parseThrowaway('my-test-00aa11'), { parent: 'my-test', hex: '00aa11' })
  assert.equal(parseThrowaway('personal'), undefined)
  assert.equal(parseThrowaway('personal-3f9a1'), undefined)
})

test('display names leave release out', () => {
  assert.equal(displayName('release'), 'DeepSea')
  assert.equal(displayName('personal'), 'DeepSea Personal')
  assert.equal(displayName('my-test'), 'DeepSea My Test')
  assert.equal(displayName('release-3f9a1c'), 'DeepSea 3f9a1c')
  assert.equal(displayName('personal-3f9a1c'), 'DeepSea Personal 3f9a1c')
  assert.equal(variantName('personal-3f9a1c'), 'io.github.taliesinb.deepsea.personal-3f9a1c')
})

test('flat YAML round-trips the values variant.yml holds', () => {
  const config = { id: 'personal-3f9a1c', parent: 'personal', throwaway: true, port: 3210, source: 'topic/base', note: 'has spaces # and a hash', version: '1.0' }
  assert.deepEqual(parseFlatYaml(formatFlatYaml(config, 'header')), config)
  assert.deepEqual(parseFlatYaml('# c\n\nkey: value # trailing\n'), { key: 'value' })
})

test('arguments: valued flags take the next word or =value; others are booleans', () => {
  assert.deepEqual(parseArgs(['run', 'personal', '--source', 'HEAD~1', '--detach', '--timeout=30'], ['source', 'timeout']),
    { _: ['run', 'personal'], source: 'HEAD~1', detach: true, timeout: '30' })
  assert.throws(() => parseArgs(['--source'], ['source']))
})

test('harness.lock needs url and commit', () => {
  assert.deepEqual(parseLock('# c\nurl ../h\nbranch b\ncommit abc\n'), { url: '../h', branch: 'b', commit: 'abc' })
  assert.throws(() => parseLock('url ../h\n'))
})

test('references: full id, unique hex part, or the caller\'s one running throwaway', async () => {
  const { currentOwner } = await import('../lib/variants.mjs')
  const owner = currentOwner()
  for (const id of ['personal', 'personal-3f9a1c', 'release-3f0000']) {
    mkdirSync(homeOf(id), { recursive: true })
    writeVariant(id, { id, ownerSession: owner.session, ownerCheckout: owner.checkout })
  }
  assert.equal(resolveRef('personal').id, 'personal')
  assert.equal(resolveRef('9a1c').id, 'personal-3f9a1c')
  assert.throws(() => resolveRef('3f'), /several/)
  assert.throws(() => resolveRef('nope'), /no variant/)
  assert.throws(() => resolveRef(undefined), /none of your throwaways is running/)
  // A state whose pid is not the recorded process does not count as running.
  writeState('personal-3f9a1c', { pid: process.pid, signature: 'not-this-process' })
  assert.throws(() => resolveRef(undefined), /none of your throwaways is running/)
  // The command line shows the test file as it was passed (often relative); its name is enough.
  writeState('personal-3f9a1c', { pid: process.pid, signature: 'dsd.test.mjs' })
  assert.equal(resolveRef(undefined).id, 'personal-3f9a1c')
  // Another agent's running throwaway is never the default, but can be named.
  writeVariant('release-3f0000', { id: 'release-3f0000', ownerSession: 'session-another-agent', ownerCheckout: '/elsewhere' })
  writeState('release-3f0000', { pid: process.pid, signature: 'dsd.test.mjs' })
  assert.equal(resolveRef(undefined).id, 'personal-3f9a1c')
  assert.equal(resolveRef('3f00').id, 'release-3f0000')
})

test('run logs: <ts>-<pid>.log, a latest link, identity first; pruning keeps recent and newest', () => {
  const dir = join(logDirOf('personal-3f9a1c'), 'server')
  const log = openRunLog(dir, { tag: 'pending' })
  log.identify('io.github.taliesinb.deepsea.personal-3f9a1c server pid 42')
  log.rename(42)
  log.close()
  const files = readdirSync(dir)
  assert.ok(files.some(f => /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-42\.log$/.test(f)), files.join(','))
  assert.match(readlinkSync(join(dir, 'latest.log')), /-42\.log$/)
  const old = join(root, 'prune')
  mkdirSync(old)
  for (let i = 0; i < 5; i++) {
    const f = join(old, `2020-01-0${i + 1}T00-00-00-${i}.log`)
    writeFileSync(f, '')
    utimesSync(f, new Date('2020-01-01'), new Date('2020-01-01'))
  }
  writeFileSync(join(old, 'notes.txt'), '')
  prune(old, { keep: 2, days: 14 })
  assert.deepEqual(readdirSync(old).sort(), ['2020-01-04T00-00-00-3.log', '2020-01-05T00-00-00-4.log', 'notes.txt'])
})

test('check: added lines with their numbers; built-in patterns flag leaks but not the allowed forms', async () => {
  const { addedLines, scan, BUILTIN_PATTERNS } = await import('../commands/check.mjs')
  // The leaks are assembled from pieces, so this file passes the check it tests.
  const [path, address, tailnet, mail] = ['/Users/' + 'alice', ['192', '168', '1', '4'].join('.'), 'tail123' + '.ts.net', 'bob' + '@corp.io']
  const diff = ['--- a/a.md', '+++ b/a.md', '@@ -0,0 +1,7 @@',
    `+see ${path}/x and /Users/USER/ok`, `+host ${address}, loopback 127.0.0.1`, `+node.example.ts.net vs box.${tailnet}`,
    `+mail ${mail} or user@example.com`, '+pnpm@11.7.0 react@18.3.1 "@deepsea/login"', '+++ starts with two pluses', '+last'].join('\n')
  const lines = addedLines(diff)
  assert.equal(lines.length, 7)
  assert.deepEqual(lines.at(-2), { file: 'a.md', line: 6, text: '++ starts with two pluses' })
  assert.deepEqual(scan(lines, BUILTIN_PATTERNS).map(h => `${h.line}:${h.match}`), [`1:${path}`, `2:${address}`, `3:${tailnet}`, `4:${mail}`])
  assert.deepEqual(scan([{ file: 'LICENSE', line: 1, text: mail }], BUILTIN_PATTERNS), [])
})

test('gc: own stopped throwaways go; another agent\'s only after an hour; expired ones go running or not', async () => {
  const { gcReason } = await import('../commands/manage.mjs')
  const me = process.env.DSH_SESSION_ID
  process.env.DSH_SESSION_ID = 'session-me'
  try {
    const now = Date.now()
    const v = (config, running = false) => ({ id: 'none-000000', throwaway: true, running, config })
    assert.equal(gcReason(v({ ownerSession: 'session-me' })), 'stopped')
    assert.equal(gcReason(v({ ownerSession: 'session-me' }, true)), undefined)
    assert.equal(gcReason(v({ ownerSession: 'session-other' }), now), 'stopped over an hour ago')  // no activity recorded: old
    assert.equal(gcReason(v({ ownerSession: 'session-other', expires: new Date(now - 1000).toISOString() }, true), now), 'expired')
    assert.equal(gcReason({ id: 'release', throwaway: false, config: {} }), undefined)
  } finally {
    if (me === undefined) delete process.env.DSH_SESSION_ID; else process.env.DSH_SESSION_ID = me
  }
})

test('topics.txt: sections, upstream, bases and topics with parents', async () => {
  const { parseTopics } = await import('../commands/topics.mjs')
  assert.deepEqual(parseTopics('# c\n[harness]\nupstream v1 # tag\nbase topic/base\ntopic topic/a\ntopic topic/b topic/a\n\n[deepsea]\nbase topic/base\n'), {
    harness: { base: 'topic/base', upstream: 'v1', topics: [{ name: 'topic/a', parent: undefined }, { name: 'topic/b', parent: 'topic/a' }] },
    deepsea: { base: 'topic/base', upstream: undefined, topics: [] },
  })
})

test('app sources: this checkout, a path, or a commit; a missing one is refused', async () => {
  const { appSource, appDirOf, appSocketOf } = await import('../lib/app.mjs')
  const { DsdError } = await import('../lib/util.mjs')
  assert.match(appDirOf('release-3f9a1c'), /deepsea-app-release-3f9a1c$/)
  assert.match(appSocketOf('release-3f9a1c'), /release-3f9a1c\/run\/app\.sock$/)
  assert.throws(() => appSource('/nonexistent-deepsea-checkout'), /has no apps\/macos/)
  assert.throws(() => appSource('no-such-ref-for-deepsea-tests'), e => e instanceof DsdError && /no app source|has no apps\/macos/.test(e.message))
})

test('app requests: one JSON line out, one in; errors carry the app\'s code', async () => {
  const { createServer } = await import('node:net')
  const { appRequest } = await import('../lib/appsocket.mjs')
  const socket = join(mkdtempSync(join(tmpdir(), 'dsd-sock-')), 's')
  const seen = []
  const server = createServer(conn => conn.on('data', (chunk) => {
    const request = JSON.parse(chunk.toString().trim())
    seen.push(request)
    conn.write(request.op === 'hello' ? `${JSON.stringify({ id: request.id, ok: true, value: { pid: 1 } })}\n` : `${JSON.stringify({ id: request.id, ok: false, error: { code: 'offline', message: 'the offline page is showing' } })}\n`)
  }))
  await new Promise(resolve => server.listen(socket, resolve))
  try {
    assert.deepEqual(await appRequest(socket, 'hello'), { pid: 1 })
    await assert.rejects(appRequest(socket, 'eval', { js: 'return 1' }), /eval: offline: the offline page is showing/)
    assert.deepEqual(seen.map(r => [r.op, r.js]), [['hello', undefined], ['eval', 'return 1']])
    await assert.rejects(appRequest(`${socket}-missing`, 'hello'), /cannot reach the app/)
  } finally { server.close() }
})

test('integration: merges in order, reuses unchanged merges, stops at a conflict, moves a checked-out branch with its worktree', async () => {
  const { execFileSync } = await import('node:child_process')
  const { planIntegration, moveBranch } = await import('../lib/integrate.mjs')
  const repo = mkdtempSync(join(tmpdir(), 'dsd-integrate-'))
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()
  try {
    g('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'shared.txt'), 'base\n'); g('add', '.'); g('commit', '-qm', 'base')
    for (const topic of ['a', 'b']) {
      g('checkout', '-qb', `topic/${topic}`, 'main')
      writeFileSync(join(repo, `${topic}.txt`), `${topic}\n`); g('add', '.'); g('commit', '-qm', topic)
    }
    g('checkout', '-q', 'main')
    const first = planIntegration(repo, 'main', ['topic/a', 'topic/b'], 'integration/main')
    assert.equal(first.conflict, undefined)
    assert.deepEqual(first.steps.map(s => s.reused), [false, false])
    assert.equal(g('show', `${first.tip}:b.txt`), 'b')
    assert.equal(moveBranch(repo, 'integration/main', first.tip), undefined)
    const again = planIntegration(repo, 'main', ['topic/a', 'topic/b'], 'integration/main')
    assert.equal(again.tip, first.tip)
    assert.deepEqual(again.steps.map(s => s.reused), [true, true])
    // Two topics editing the same line: the plan stops at the second, nothing is moved.
    for (const topic of ['c', 'd']) {
      g('checkout', '-qb', `topic/${topic}`, 'main')
      writeFileSync(join(repo, 'shared.txt'), `${topic}\n`); g('add', '.'); g('commit', '-qm', topic)
    }
    g('checkout', '-q', 'main')
    const clash = planIntegration(repo, 'main', ['topic/c', 'topic/d'], 'integration/main')
    assert.deepEqual(clash.conflict, { topic: 'topic/d', files: ['shared.txt'] })
    assert.equal(g('rev-parse', 'integration/main'), first.tip)
    // A checked-out integration branch moves with its worktree; local changes are refused.
    g('checkout', '-q', 'integration/main')
    const next = planIntegration(repo, 'main', ['topic/a', 'topic/b', 'topic/c'], 'integration/main')
    moveBranch(repo, 'integration/main', next.tip)
    assert.equal(g('rev-parse', 'HEAD'), next.tip)
    assert.equal(g('status', '--porcelain'), '')
    writeFileSync(join(repo, 'a.txt'), 'edited\n')
    assert.throws(() => moveBranch(repo, 'integration/main', first.tip), /uncommitted changes/)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('pins: every harness commit a branch here pins is tagged once; a pin the harness lacks is reported', async () => {
  const { execFileSync } = await import('node:child_process')
  const { tagPins } = await import('../lib/harness.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'dsd-pins-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim()
  const harness = join(dir, 'harness'), checkout = join(dir, 'checkout')
  try {
    mkdirSync(harness); mkdirSync(checkout)
    g(harness, 'init', '-q', '-b', 'main')
    const commits = ['one', 'two', 'three'].map(n => { writeFileSync(join(harness, 'f'), n); g(harness, 'add', '.'); g(harness, 'commit', '-qm', n); return g(harness, 'rev-parse', 'HEAD') })
    g(checkout, 'init', '-q', '-b', 'topic/base')
    const pin = commit => { writeFileSync(join(checkout, 'harness.lock'), `url ../harness\ncommit ${commit}\n`); g(checkout, 'add', '.'); g(checkout, 'commit', '-qm', commit.slice(0, 7)) }
    pin(commits[0]); pin(commits[1])
    g(checkout, 'checkout', '-qb', 'topic/x'); pin('f'.repeat(40))
    g(checkout, 'checkout', '-q', 'topic/base')
    // The branch the pins came from moves on: the first two are no longer on it.
    g(harness, 'reset', '-q', '--hard', commits[2]); g(harness, 'checkout', '-q', '--orphan', 'other'); g(harness, 'branch', '-qD', 'main')
    const dry = tagPins({ checkout, repo: harness, dry: true })
    assert.deepEqual(dry, { tagged: [`pin/${commits[0].slice(0, 12)}`, `pin/${commits[1].slice(0, 12)}`].sort(), missing: ['f'.repeat(12)] })
    assert.equal(g(harness, 'tag', '--list', 'pin/*'), '')
    assert.deepEqual(tagPins({ checkout, repo: harness }).tagged, dry.tagged)
    assert.equal(g(harness, 'rev-parse', `pin/${commits[0].slice(0, 12)}`), commits[0])
    assert.deepEqual(tagPins({ checkout, repo: harness }), { tagged: [], missing: ['f'.repeat(12)] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('install: the relay and server only run on a node the harness supports', async () => {
  const { nodeSupported } = await import('../lib/install.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'dsd-node-'))
  try {
    const fake = (name, version) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 }); return p }
    assert.equal(nodeSupported(process.execPath), true)
    assert.equal(nodeSupported(fake('old', '16.17.0')), false)
    assert.equal(nodeSupported(fake('early22', '22.18.1')), false)
    assert.equal(nodeSupported(fake('late22', '22.19.0')), true)
    assert.equal(nodeSupported(fake('odd23', '23.11.0')), false)
    assert.equal(nodeSupported(fake('lts24', '24.1.0')), true)
    assert.equal(nodeSupported(join(dir, 'missing')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('install: the relay plist, Serve path choice (stepping aside), Dock entries', async () => {
  const { chooseServePath, dockHas, dockTile, relayPlist } = await import('../lib/install.mjs')
  const plist = relayPlist({ label: 'io.github.taliesinb.deepsea.lab.relay', programArguments: ['/a/host', '/a/node', 'x&y'], launchdLog: '/l/launchd.log' })
  assert.match(plist, /<key>Label<\/key><string>io\.github\.taliesinb\.deepsea\.lab\.relay<\/string>/)
  assert.match(plist, /<string>\/a\/host<\/string>\n {4}<string>\/a\/node<\/string>\n {4}<string>x&amp;y<\/string>/)
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/)
  assert.doesNotMatch(plist, /EnvironmentVariables/)
  const none = { mappings: {} }
  assert.equal(chooseServePath('release', 3200, none, 'me'), '/deepsea')
  assert.equal(chooseServePath('lab', 3210, none, 'me'), '/deepsea-lab')
  // Ours (pointing at this variant's relay) is not "taken"; another target is.
  assert.equal(chooseServePath('lab', 3210, { mappings: { '/deepsea-lab': 'http://127.0.0.1:3213' } }, 'me'), '/deepsea-lab')
  assert.equal(chooseServePath('lab', 3210, { mappings: { '/deepsea-lab': 'http://127.0.0.1:3203' } }, 'Me.Two'), '/deepsea-lab-me-two')
  assert.throws(() => chooseServePath('lab', 3210, { mappings: { '/deepsea-lab': 'http://127.0.0.1:3203', '/deepsea-lab-me': 'http://127.0.0.1:3303' } }, 'me'), /both taken/)
  const tile = dockTile('/Users/USER/Applications/DeepSea Lab.app')
  assert.match(tile, /file:\/\/\/Users\/USER\/Applications\/DeepSea%20Lab\.app\//)
  assert.equal(dockHas(`<plist>${tile}</plist>`, '/Users/USER/Applications/DeepSea Lab.app'), true)
  assert.equal(dockHas('<plist></plist>', '/Users/USER/Applications/DeepSea Lab.app'), false)
})

test('thin clients: the server as typed becomes its mount URL; the suffix is asked only for a short name', async () => {
  const { resolveServer } = await import('../commands/client.mjs')
  let asked = 0
  const suffix = () => { asked += 1; return 'example.ts.net' }
  assert.equal(resolveServer('node', suffix), 'https://node.example.ts.net/deepsea/')
  assert.equal(resolveServer('user@node', suffix), 'https://node.example.ts.net/deepsea-user/')
  assert.equal(resolveServer('node/deepsea-lab', suffix), 'https://node.example.ts.net/deepsea-lab/')
  assert.equal(resolveServer('node:8443', suffix), 'https://node.example.ts.net:8443/')
  assert.equal(resolveServer('https://node/deepsea-lab', suffix), 'https://node.example.ts.net/deepsea-lab/')
  assert.equal(asked, 5)
  assert.equal(resolveServer('node.example.ts.net', suffix), 'https://node.example.ts.net/deepsea/')
  assert.equal(resolveServer('https://box.example.com/x/', suffix), 'https://box.example.com/x/')
  assert.equal(resolveServer('localhost:3203', suffix), 'http://localhost:3203/')
  assert.equal(resolveServer('127.0.0.1:3203', suffix), 'http://127.0.0.1:3203/')
  assert.equal(asked, 5, 'full and loopback names need no suffix')
  assert.throws(() => resolveServer('node', () => undefined), /MagicDNS suffix is unknown/)
  for (const bad of ['', 'a b', 'user@node/x', 'https://node/?token=1', 'ftp://node/']) assert.throws(() => resolveServer(bad, suffix), undefined, bad)
})

test('install on Linux: the relay unit, its quoting, a named Serve path, the support directory', async () => {
  const { relayUnit, systemdQuote } = await import('../lib/systemd.mjs')
  const { chooseServePath, supportDirOf } = await import('../lib/install.mjs')
  assert.equal(systemdQuote('/a b/c'), '"/a b/c"')
  assert.equal(systemdQuote('50% $HOME "x" \\'), '"50%% $$HOME \\"x\\" \\\\"')
  assert.equal(systemdQuote('A=$x', { dollars: false }), '"A=$x"')
  assert.throws(() => systemdQuote('a\nb'), /line break/)
  const unit = relayUnit({ description: 'DeepSea Lab relay', programArguments: ['/s/deepsea-relay', '/b/apps/relay/relay.mjs', '--', '/n/node', 'x y'], log: '/l/relay/systemd.log' })
  assert.match(unit, /^ExecStart="\/s\/deepsea-relay" "\/b\/apps\/relay\/relay\.mjs" "--" "\/n\/node" "x y"$/m)
  assert.match(unit, /^Restart=always$/m)
  assert.match(unit, /^StandardOutput=append:\/l\/relay\/systemd\.log$/m)
  assert.match(unit, /^WantedBy=default\.target$/m)
  assert.doesNotMatch(unit, /^Environment=/m)
  assert.match(relayUnit({ description: 'd', programArguments: ['x'], log: '/l', environment: { A: '$b' } }), /^Environment="A=\$b"$/m)
  // A named path is kept unless another target holds it.
  assert.equal(chooseServePath('release', 3200, { mappings: {} }, 'me', '/deepsea-me'), '/deepsea-me')
  assert.equal(chooseServePath('release', 3200, { mappings: { '/deepsea-me': 'http://127.0.0.1:3203' } }, 'me', '/deepsea-me'), '/deepsea-me')
  assert.throws(() => chooseServePath('release', 3200, { mappings: { '/deepsea-me': 'http://127.0.0.1:3303' } }, 'me', '/deepsea-me'), /not this variant's relay/)
  assert.equal(supportDirOf('lab', 'linux', { XDG_DATA_HOME: '/x/share' }), '/x/share/io.github.taliesinb.deepsea.lab')
  assert.match(supportDirOf('lab', 'darwin'), /\/Library\/Application Support\/io\.github\.taliesinb\.deepsea\.lab$/)
})

test('a machine-given port range, the account\'s own tailscaled, units the relay needs', async () => {
  const { choosePortBlock, parsePorts, tailscaleCommand } = await import('../lib/install.mjs')
  const { relayUnit } = await import('../lib/systemd.mjs')
  const { freePort } = await import('../lib/processes.mjs')
  const { createServer } = await import('node:net')
  assert.deepEqual(parsePorts('22300-22399'), { first: 22300, last: 22399 })
  assert.deepEqual(parsePorts('22300'), { first: 22300, last: 22309 })
  for (const bad of ['22300-22305', '80-200', '65530-65600', 'x', '']) assert.throws(() => parsePorts(bad), /--ports takes/, bad)
  assert.throws(() => parsePorts('1', 'DEEPSEA_PORTS'), /DEEPSEA_PORTS takes/)
  // The first block of the range that no variant records and nothing listens on.
  const held = createServer()
  const base = await new Promise((resolve) => {
    const tryAt = (p) => { held.once('error', () => tryAt(p + 10)); held.listen(p + 2, '127.0.0.1', () => resolve(p)) }
    tryAt(41000)
  })
  try {
    assert.equal(await choosePortBlock(new Set(), { first: base, last: base + 29 }), base + 10)
    assert.equal(await choosePortBlock(new Set([base + 10]), { first: base, last: base + 29 }), base + 20)
    await assert.rejects(choosePortBlock(new Set([base + 10]), { first: base, last: base + 19 }), /no free port block in/)
    // Throwaways: free ports inside the range, skipping excluded and held ones.
    assert.equal(await freePort({ range: { first: base, last: base + 9 }, exclude: new Set([base, base + 1]) }), base + 3)
    await assert.rejects(freePort({ range: { first: base + 2, last: base + 2 } }), /no free port in/)
  } finally { held.close() }
  assert.ok((await freePort()) > 0)
  const cmd = tailscaleCommand('/run/user/1000/ts/tailscaled.sock')
  if (cmd) {
    assert.equal(cmd.at(-1), '--socket=/run/user/1000/ts/tailscaled.sock')
    assert.equal(tailscaleCommand(undefined).length, 1)
  }
  const unit = relayUnit({ description: 'd', programArguments: ['x'], log: '/l', after: ['my-tailscaled.service', 'a@b.socket'] }) // dsd-check: allow
  assert.match(unit, /^Wants=my-tailscaled\.service a@b\.socket$/m)
  assert.match(unit, /^After=my-tailscaled\.service a@b\.socket$/m)
  assert.ok(unit.indexOf('Wants=') < unit.indexOf('[Service]'))
  assert.throws(() => relayUnit({ description: 'd', programArguments: ['x'], log: '/l', after: ['x; rm'] }), /not a systemd unit name/)
  assert.doesNotMatch(relayUnit({ description: 'd', programArguments: ['x'], log: '/l' }), /^(Wants|After)=/m)
  const yaml = formatFlatYaml({ tailscaleSocket: '/run/user/1000/ts/tailscaled.sock', after: 'a.service,b.service' })
  assert.deepEqual(parseFlatYaml(yaml), { tailscaleSocket: '/run/user/1000/ts/tailscaled.sock', after: 'a.service,b.service' })
})

test('Linux: listening sockets from /proc/net/tcp, leftovers in the XDG directories, executables on PATH', async () => {
  const { listeningInodes } = await import('../lib/processes.mjs')
  const { linuxLeftovers } = await import('../lib/remove.mjs')
  const { onPath } = await import('../lib/util.mjs')
  const table = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0C83 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1003        0 4242 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0C83 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1003        0 4343 1 0000000000000000 20 4 30 10 -1
   2: 00000000:0C80 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 4444 1 0000000000000000 100 0 0 10 0`
  assert.deepEqual([...listeningInodes(table, 3203)], ['4242'])
  assert.deepEqual([...listeningInodes(table, 3200)], ['4444'])
  assert.deepEqual([...listeningInodes(table, 3299)], [])
  const dir = mkdtempSync(join(tmpdir(), 'dsd-linux-'))
  try {
    for (const d of ['share/io.github.taliesinb.deepsea.lab', 'share/io.github.taliesinb.deepsea.lab2', 'state/io.github.taliesinb.deepsea.lab', 'state/io.github.taliesinb.deepsea.lab.relay']) mkdirSync(join(dir, d), { recursive: true })
    const env = { XDG_DATA_HOME: join(dir, 'share'), XDG_STATE_HOME: join(dir, 'state') }
    assert.deepEqual(linuxLeftovers('io.github.taliesinb.deepsea.lab', 'linux', env).map(p => p.slice(dir.length + 1)).sort(),
      ['share/io.github.taliesinb.deepsea.lab', 'state/io.github.taliesinb.deepsea.lab', 'state/io.github.taliesinb.deepsea.lab.relay'])
    assert.deepEqual(linuxLeftovers('io.github.taliesinb.deepsea.lab', 'darwin', env), [])
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'tool'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(dir, 'bin', 'data'), 'x', { mode: 0o644 })
    assert.equal(onPath('tool', { PATH: `/nonexistent:${join(dir, 'bin')}` }), join(dir, 'bin', 'tool'))
    assert.equal(onPath('data', { PATH: join(dir, 'bin') }), undefined)
    assert.equal(onPath('bin', { PATH: dir }), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('components: the relay from a checkout that has it, else extracted (with packages/logs) from topic/relay', async () => {
  const { componentSource } = await import('../lib/components.mjs')
  const { DsdError } = await import('../lib/util.mjs')
  const { mainCheckout } = await import('../lib/paths.mjs')
  assert.throws(() => componentSource('relay', '/nonexistent-deepsea-checkout'), /has no apps\/relay/)
  assert.throws(() => componentSource('nope'), e => e instanceof DsdError)
  const { execFileSync } = await import('node:child_process')
  const hasBranch = (() => { try { execFileSync('git', ['-C', mainCheckout(), 'rev-parse', '--verify', 'topic/relay'], { stdio: 'ignore' }); return true } catch { return false } })()
  if (!hasBranch) return
  const relay = componentSource('relay', 'topic/relay')
  assert.match(relay.describe, /^topic\/relay \([0-9a-f]{10}\)$/)
  assert.match(relay.entry, /relay-src-[0-9a-f]{12}\/apps\/relay\/relay\.mjs$/)
  const { existsSync } = await import('node:fs')
  assert.ok(existsSync(relay.entry))
  assert.ok(existsSync(join(relay.dir, '..', '..', 'packages', 'logs', 'index.mjs')))
})

test('run: the tailscale proxy port only from a deepsea-tailscale row', async () => {
  const { proxyPortOf } = await import('../commands/run.mjs')
  assert.equal(proxyPortOf(['- id: deepsea-tailscale\n  config:\n    proxyPort: 4321\n']), 4321)
  assert.equal(proxyPortOf(['- insert:\n    - id: deepsea-tailscale\n      name: "@deepsea/tailscale"\n']), undefined)
  assert.equal(proxyPortOf(['- id: other\n  config:\n    proxyPort: 9\n- id: deepsea-tailscale\n  disabled: false\n']), undefined)
  assert.equal(proxyPortOf(['- id: "deepsea-tailscale"\n  config: \n    servePath: /x\n    proxyPort: 7000\n- id: next\n']), 7000)
})

test('logs: kinds and references, the current run, last lines, export names', async () => {
  const { currentRun, exportName, lastLines, parseLogArgs } = await import('../commands/logs.mjs')
  const ids = new Set(['release-3f9a1c', 'app'])
  assert.deepEqual(parseLogArgs([], ids), { ref: undefined, kind: 'server', plugin: undefined })
  assert.deepEqual(parseLogArgs(['relay'], ids), { ref: undefined, kind: 'relay', plugin: undefined })
  assert.deepEqual(parseLogArgs(['3f9a', 'plugin', 'billing'], ids), { ref: '3f9a', kind: 'plugin', plugin: 'billing' })
  assert.deepEqual(parseLogArgs(['app', 'dsd'], ids), { ref: 'app', kind: 'dsd', plugin: undefined })
  assert.throws(() => parseLogArgs(['x', 'plugin'], ids), /plugin <name>/)
  assert.throws(() => parseLogArgs(['x', 'nope'], ids), /no log kind/)
  const dir = join(root, 'logs-kind')
  const log = openRunLog(dir, { tag: 41, identity: 'first' })
  log.close()
  assert.equal(readlinkSync(currentRun(dir)), log.path.split('/').pop())
  assert.equal(currentRun(join(root, 'none')), undefined)
  assert.equal(lastLines('a\nb\nc\n', 2), 'b\nc\n')
  assert.equal(lastLines('a\nb', 1), 'b')
  assert.equal(lastLines('a\nb\n', 0), 'a\nb\n')
  assert.equal(exportName('release', 'app', '/x/2026-10-07T19-04-14-4410.log'), 'deepsea.release-app-2026-10-07T19-04-14.log')
  assert.equal(exportName('lab', 'plugin-browser', '/x/2026-10-07T19-04-14-4410.jsonl'), 'deepsea.lab-plugin-browser-2026-10-07T19-04-14.jsonl')
})

test('simulated accounts: a Plan fixture is signed in, its grant written as credentials-local stores it', async () => {
  const { createSimulator } = await import('../../provider-sim/server.mjs')
  const { credentialsDocument, expandAccounts, provisionAccounts } = await import('../lib/sim.mjs')
  const sim = await createSimulator({ db: join(root, 'sim.sqlite') })
  await new Promise(resolve => sim.server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${sim.server.address().port}`
    const accounts = await provisionAccounts({ url }, 'anthropic,anthropic-max-80', 'abc123')
    assert.deepEqual(accounts.map(a => [a.credential, a.route]), [['sk-ant-api03-sim-abc123', undefined], ['max80+abc123@example.com', 'anthropic-oauth']])
    const document = JSON.parse(credentialsDocument(accounts))
    const record = document.records['llm-pi-ai/anthropic-oauth']
    assert.deepEqual([document.version, record.kind, record.payload.type, Object.keys(document.records).length], [1, 'grant', 'oauth', 1])
    assert.ok(record.payload.expires > Date.now() + 50 * 60_000 && record.payload.expires < Date.now() + 56 * 60_000)
    const usage = await (await fetch(`${url}/api.anthropic.com/api/oauth/usage`, { headers: { authorization: `Bearer ${record.payload.access}`, 'anthropic-beta': 'oauth-2025-04-20' } })).json()
    assert.equal(usage.five_hour.utilization, 80)
    assert.equal(credentialsDocument(accounts.slice(0, 1)), undefined)
    // One account per slot: a later Plan of the same route replaces the earlier one.
    const replaced = await provisionAccounts({ url }, 'anthropic-max,anthropic-max-80', 'abc124')
    assert.deepEqual(replaced.map(a => a.name), ['anthropic-max-80'])
    assert.deepEqual(expandAccounts('standard,openrouter-low', { openrouter: { env: 'OPENROUTER_API_KEY', standard: true }, 'openrouter-low': { env: 'OPENROUTER_API_KEY' }, deepseek: { env: 'DEEPSEEK_API_KEY', standard: true } }), ['deepseek', 'openrouter-low'])
  } finally {
    await new Promise(resolve => sim.server.close(resolve))
    sim.store.close()
  }
})

test('topics rebase: a stack follows its rewritten parents, replaying only its own commits', async () => {
  const { restack } = await import('../lib/restack.mjs')
  const { execFileSync } = await import('node:child_process')
  const repo = mkdtempSync(join(tmpdir(), 'dsd-restack-'))
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()
  const commit = (file, text) => { writeFileSync(join(repo, file), text); g('add', file); g('commit', '-q', '-m', file) }
  try {
    g('init', '-q', '-b', 'topic/base'); commit('base.txt', 'one')
    g('checkout', '-q', '-b', 'topic/a'); commit('a.txt', 'a')
    g('checkout', '-q', '-b', 'topic/b'); commit('b.txt', 'b'); commit('b2.txt', 'b2')
    // Rewrite base (amend) and then a onto it by hand, as a fold would.
    g('checkout', '-q', 'topic/base'); writeFileSync(join(repo, 'base.txt'), 'two'); g('commit', '-q', '-a', '--amend', '-m', 'base')
    const dirty = restack(repo, [{ topic: 'topic/a', parent: 'topic/base' }, { topic: 'topic/b', parent: 'topic/a' }], { dry: true })
    assert.deepEqual(dirty.map(r => [r.topic, r.state, r.commits]), [['topic/a', 'would rebase', 1], ['topic/b', 'current', undefined]])
    const done = restack(repo, [{ topic: 'topic/a', parent: 'topic/base' }, { topic: 'topic/b', parent: 'topic/a' }])
    assert.deepEqual(done.map(r => [r.topic, r.state]), [['topic/a', 'rebased'], ['topic/b', 'rebased']])
    assert.equal(g('rev-list', '--count', 'topic/a..topic/b'), '2')
    assert.equal(g('rev-list', '--count', 'topic/base..topic/a'), '1')
    assert.equal(g('show', 'topic/b:base.txt'), 'two')
    assert.equal(g('rev-list', '--count', 'topic/b'), '4')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('--get picks a field by a dotted path; check skips lines marked dsd-check: allow', async () => {
  const { pick } = await import('../lib/util.mjs')
  const value = { id: 'release-1', summary: { text: 'hi' }, items: [{ sessionId: 'a' }, { sessionId: 'b' }] }
  assert.equal(pick(value, 'summary.text'), 'hi')
  assert.equal(pick(value, 'items.-1.sessionId'), 'b')
  assert.equal(pick(value, 'items.5.sessionId'), undefined)
  const { scan, BUILTIN_PATTERNS, ALLOW_MARK } = await import('../commands/check.mjs')
  const lines = [{ file: 't.mjs', line: 1, text: "const home = '/Users/x/projects'" }, { file: 't.mjs', line: 2, text: `const home = '/Users/x/projects' // ${ALLOW_MARK}` }] // dsd-check: allow
  assert.deepEqual(scan(lines, BUILTIN_PATTERNS).map(h => h.line), [1])
})

test('plugins become bundles of the profile: dsd owns @deepsea/*, the rest stays', async () => {
  const { installBundles } = await import('../lib/plugins.mjs')
  const { REPO } = await import('../lib/paths.mjs')
  const { readFileSync: read, lstatSync, realpathSync, existsSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'dsd-bundles-'))
  try {
    const plugin = (name) => {
      const dir = join(root, 'plugins', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepsea/${name}` }))
      return { name, dir, pkg: { name: `@deepsea/${name}` } }
    }
    const home = join(root, 'home')
    const harness = realpathSync(join(REPO, 'harness'))
    installBundles([plugin('server-log'), plugin('alpha')], home, harness)
    const manifestPath = join(home, 'profiles', 'web', 'package.json')
    let manifest = JSON.parse(read(manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles.filter(b => b.startsWith('@deepsea/')), ['@deepsea/server-log', '@deepsea/alpha'])
    assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'))
    assert.ok(lstatSync(join(home, 'profiles', 'web', 'node_modules', '@deepsea', 'alpha')).isSymbolicLink())
    // Something the person installed stays; a plugin no longer selected goes.
    manifest.dependencies['left-alone'] = '1.0.0'
    manifest.dsh.profile.bundles.push('left-alone')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    // A plugin of another scope that dsd installed is dsd's to take out again.
    const other = { name: 'other', dir: join(root, 'plugins', 'other'), pkg: { name: 'other-plugin' } }
    mkdirSync(other.dir, { recursive: true })
    installBundles([plugin('server-log'), other], home, harness)
    assert.ok(lstatSync(join(home, 'profiles', 'web', 'node_modules', 'other-plugin')).isSymbolicLink())
    installBundles([plugin('server-log')], home, harness)
    manifest = JSON.parse(read(manifestPath, 'utf8'))
    assert.deepEqual(Object.keys(manifest.dependencies), ['left-alone', '@deepsea/server-log'])
    assert.ok(manifest.dsh.profile.bundles.includes('left-alone'))
    assert.ok(!manifest.dsh.profile.bundles.includes('other-plugin'))
    assert.equal(existsSync(join(home, 'profiles', 'web', 'node_modules', '@deepsea', 'alpha')), false)
    assert.equal(existsSync(join(home, 'profiles', 'web', 'node_modules', 'other-plugin')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('gc: an installed variant\'s build and the harness build it links are in use; a collected build releases its harness', async () => {
  const { buildUsers } = await import('../commands/manage.mjs')
  const { buildsDir, homeOf } = await import('../lib/paths.mjs')
  const { symlinkSync } = await import('node:fs')
  const deepsea = join(buildsDir(), 'deepsea-aaaaaaaaaaaa')
  const old = join(buildsDir(), 'deepsea-cccccccccccc')
  const harness = join(buildsDir(), 'harness-bbbbbbbbbbbb')
  const oldHarness = join(buildsDir(), 'harness-dddddddddddd')
  for (const dir of [deepsea, old, harness, oldHarness]) mkdirSync(dir, { recursive: true })
  symlinkSync(harness, join(deepsea, 'harness'))
  symlinkSync(oldHarness, join(old, 'harness'))
  mkdirSync(homeOf('installed'), { recursive: true })
  writeVariant('installed', { id: 'installed', ports: 3290, source: 'integration/base' })
  symlinkSync(deepsea, join(homeOf('installed'), 'source'))
  const users = buildUsers(new Set(['deepsea-cccccccccccc']))
  assert.ok(users.has(deepsea), 'the installed variant\'s source build')
  assert.ok(users.has(harness), 'the harness build a kept deepsea build links')
  assert.ok(!users.has(oldHarness), 'a collected deepsea build no longer holds its harness build')
})
