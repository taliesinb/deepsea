import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanConfig, configDirectory, logDirectory, partitionOf, readConfig, writeConfig } from '../paths.mjs'
import { magicDnsSuffix, parseServerInput, Scope, suffixOfStatus } from '../resolve.mjs'

const suffix = 'example.ts.net'

test('short forms become mount URLs', async () => {
  const cases = [
    ['node', 'https://node.example.ts.net/deepsea/'],
    ['user@node', 'https://node.example.ts.net/deepsea-user/'],
    ['node/deepsea-lab', 'https://node.example.ts.net/deepsea-lab/'],
    ['node/deepsea-lab/', 'https://node.example.ts.net/deepsea-lab/'],
    ['node.example.ts.net', 'https://node.example.ts.net/deepsea/'],
    ['box.example.com', 'https://box.example.com/'],
    ['box.example.com:8443/x', 'https://box.example.com:8443/x/'],
    ['localhost:3203', 'http://localhost:3203/'],
    ['127.0.0.1:3203', 'http://127.0.0.1:3203/'],
    ['[::1]:3203', 'http://[::1]:3203/'],
    ['192.0.2.10:3200', 'http://192.0.2.10:3200/'],
    ['https://node/deepsea-x', 'https://node.example.ts.net/deepsea-x/'],
    ['https://node.example.ts.net/deepsea-x#frag', 'https://node.example.ts.net/deepsea-x/'],
    ['http://127.0.0.1:3203/x', 'http://127.0.0.1:3203/x/'],
  ]
  for (const [input, url] of cases) assert.deepEqual(await parseServerInput(input, { magicDnsSuffix: suffix }), { url }, input)
})

test('a token is split off; bad input is refused with a message', async () => {
  assert.deepEqual(await parseServerInput('https://node.example.ts.net/deepsea/?token=abc&embed=x', { magicDnsSuffix: suffix }), { url: 'https://node.example.ts.net/deepsea/', token: 'abc' })
  assert.deepEqual(await parseServerInput('node?token=abc', { magicDnsSuffix: suffix }), { url: 'https://node.example.ts.net/deepsea/', token: 'abc' })
  await assert.rejects(parseServerInput('', {}), /Type the server/)
  await assert.rejects(parseServerInput('a b', {}), /not a server/)
  await assert.rejects(parseServerInput('ftp://x/', {}), /http\(s\)/)
  await assert.rejects(parseServerInput('https://u:p@node.example.ts.net/', {}), /user name/) // dsd-check: allow
  await assert.rejects(parseServerInput('http://node.example.ts.net/deepsea/', {}), /needs https/)
  await assert.rejects(parseServerInput('node', { magicDnsSuffix: async () => undefined }), /MagicDNS/)
  await assert.rejects(parseServerInput('bad!name@node', { magicDnsSuffix: suffix }), /account name/)
  let asked = 0
  await parseServerInput('node.example.ts.net', { magicDnsSuffix: async () => { asked += 1; return suffix } })
  assert.equal(asked, 0, 'the CLI is asked only for a dot-less host')
})

test('the MagicDNS suffix from tailscale status --json', async () => {
  assert.equal(suffixOfStatus({ MagicDNSSuffix: 'example.ts.net' }), 'example.ts.net')
  assert.equal(suffixOfStatus({ Self: { DNSName: 'me.example.ts.net.' } }), 'example.ts.net')
  assert.equal(suffixOfStatus({}), undefined)
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-client-test-'))
  try {
    const cli = join(dir, 'tailscale')
    writeFileSync(cli, `#!/bin/sh\necho '{"MagicDNSSuffix":"example.ts.net."}'\n`)
    chmodSync(cli, 0o755)
    assert.equal(await magicDnsSuffix({ env: { PATH: dir } }), 'example.ts.net')
    writeFileSync(cli, '#!/bin/sh\nexit 1\n')
    assert.equal(await magicDnsSuffix({ cli }), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('scope: the mount and below, same origin only', () => {
  const scope = new Scope('https://node.example.ts.net/deepsea-x/')
  for (const url of ['https://node.example.ts.net/deepsea-x', 'https://node.example.ts.net/deepsea-x/', 'https://NODE.example.ts.net:443/deepsea-x/api/a?b']) assert.ok(scope.contains(url), url)
  for (const url of ['https://node.example.ts.net/deepsea-xy', 'https://node.example.ts.net/deepsea/', 'http://node.example.ts.net/deepsea-x/', 'https://other.example.ts.net/deepsea-x/', 'nonsense']) assert.ok(!scope.contains(url), url)
  assert.equal(scope.resolve('/x?y=1'), 'https://node.example.ts.net/deepsea-x/x?y=1')
  assert.ok(new Scope('http://127.0.0.1:3203/').contains('http://127.0.0.1:3203/anything'))
})

test('paths and the config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-client-test-'))
  try {
    const env = { XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state') }
    assert.equal(configDirectory(env), join(dir, 'config', 'io.github.taliesinb.deepsea', 'client'))
    if (process.platform === 'linux') assert.equal(logDirectory(env), join(dir, 'state', 'io.github.taliesinb.deepsea', 'client'))
    assert.equal(logDirectory({ DEEPSEA_LOG_ROOT: join(dir, 'logs') }), join(dir, 'logs', 'io.github.taliesinb.deepsea', 'client'))
    assert.match(partitionOf('https://node.example.ts.net/deepsea/'), /^persist:server-[0-9a-f]{16}$/)
    assert.notEqual(partitionOf('https://a.example.ts.net/deepsea/'), partitionOf('https://b.example.ts.net/deepsea/'))
    const file = join(configDirectory(env), 'client.json')
    assert.deepEqual(readConfig(file), { view: 'desktop' })
    writeConfig(file, { url: 'https://node.example.ts.net/deepsea/', name: 'DeepSea <Lab>', glyphColor: '#30a46c', view: 'mobile', junk: 1 })
    assert.deepEqual(readConfig(file), { url: 'https://node.example.ts.net/deepsea/', name: 'DeepSea Lab', glyphColor: '#30A46C', view: 'mobile' })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(cleanConfig({ url: 'javascript:x', glyphColor: 'red', view: 'tv' }), { view: 'desktop' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
