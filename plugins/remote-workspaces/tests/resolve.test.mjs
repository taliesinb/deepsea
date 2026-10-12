import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  createMagicDnsSuffixSource, expandHome, inspectPath, isPlainHttpHost, makeDirectory, normalizeRemoteInput, suffixFromKnownUrls, suffixOfStatus,
} from '../resolve.mjs'

const SUFFIX = { magicDnsSuffix: 'example.ts.net' }

describe('normalizeRemoteInput', () => {
  it('accepts the short forms and adds scheme, MagicDNS suffix, the default Serve path and the trailing slash', async () => {
    const cases = [
      ['studio', 'https://studio.example.ts.net/deepsea/'],
      ['user@studio', 'https://studio.example.ts.net/deepsea-user/'],
      ['studio/deepsea-lab', 'https://studio.example.ts.net/deepsea-lab/'],
      ['studio/', 'https://studio.example.ts.net/deepsea/'],
      ['studio.example.ts.net', 'https://studio.example.ts.net/deepsea/'],
      ['studio:8443', 'https://studio.example.ts.net:8443/'],
      ['user@studio:8443', 'https://studio.example.ts.net:8443/deepsea-user/'],
      ['studio.example.ts.net/deepsea-lab/', 'https://studio.example.ts.net/deepsea-lab/'],
      ['https://studio.example.ts.net/deepsea-lab', 'https://studio.example.ts.net/deepsea-lab/'],
      ['https://studio/deepsea/', 'https://studio.example.ts.net/deepsea/'],
      ['https://studio.example.ts.net/', 'https://studio.example.ts.net/'],
      ['box.example.com', 'https://box.example.com/'],
      ['box.example.com:8443/x', 'https://box.example.com:8443/x/'],
      ['localhost:3202/x', 'http://localhost:3202/x/'],
      ['localhost:3202', 'http://localhost:3202/'],
      ['127.0.0.1:3202', 'http://127.0.0.1:3202/'],
      ['[::1]:3200/x', 'http://[::1]:3200/x/'],
      ['192.0.2.10:3200', 'http://192.0.2.10:3200/'],
      ['http://127.0.0.1:3202', 'http://127.0.0.1:3202/'],
      ['  user@studio  ', 'https://studio.example.ts.net/deepsea-user/'],
    ]
    for (const [input, expected] of cases) assert.equal(await normalizeRemoteInput(input, SUFFIX), expected, input)
  })

  it('consults the suffix source only for dot-less hosts, and leaves such a host bare without one', async () => {
    let asked = 0
    const lazy = { magicDnsSuffix: async () => { asked += 1; return 'example.ts.net' } }
    assert.equal(await normalizeRemoteInput('https://node.example.ts.net/deepsea/', lazy), 'https://node.example.ts.net/deepsea/')
    assert.equal(await normalizeRemoteInput('localhost:3202', lazy), 'http://localhost:3202/')
    assert.equal(asked, 0)
    assert.equal(await normalizeRemoteInput('user@studio', lazy), 'https://studio.example.ts.net/deepsea-user/')
    assert.equal(asked, 1)
    assert.equal(await normalizeRemoteInput('user@studio', {}), 'https://studio/deepsea-user/')
  })

  it('rejects what is not a server address', async () => {
    for (const bad of ['', '   ', 'a b', 'ftp://x/', 'http://', ':3202']) {
      await assert.rejects(() => normalizeRemoteInput(bad, SUFFIX), undefined, JSON.stringify(bad))
    }
  })

  it('isPlainHttpHost / suffixFromKnownUrls / suffixOfStatus', () => {
    assert.equal(isPlainHttpHost('localhost'), true)
    assert.equal(isPlainHttpHost('127.0.0.1'), true)
    assert.equal(isPlainHttpHost('[::1]'), true)
    assert.equal(isPlainHttpHost('studio'), false)
    assert.equal(isPlainHttpHost('studio.example.ts.net'), false)
    assert.equal(suffixFromKnownUrls(['http://127.0.0.1:3202/', 'https://node.example.ts.net/deepsea/']), 'example.ts.net')
    assert.equal(suffixFromKnownUrls(['http://127.0.0.1:3202/', 'not a url']), undefined)
    assert.equal(suffixOfStatus({ MagicDNSSuffix: 'example.ts.net' }), 'example.ts.net')
    assert.equal(suffixOfStatus({ Self: { DNSName: 'node.example.ts.net.' } }), 'example.ts.net')
    assert.equal(suffixOfStatus(undefined), undefined)
  })
})

describe('createMagicDnsSuffixSource', () => {
  let dir
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'deepsea-remote-workspaces-cli-')) })
  after(async () => { await rm(dir, { recursive: true, force: true }) })

  it('asks the configured CLI once (cached) and never another one', async () => {
    const cli = join(dir, 'tailscale')
    const calls = join(dir, 'calls')
    await writeFile(cli, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n')\nprocess.stdout.write(JSON.stringify({ Self: { DNSName: 'node.example.ts.net.' } }))\n`)
    await chmod(cli, 0o755)
    const source = createMagicDnsSuffixSource(cli)
    assert.equal(await source(), 'example.ts.net')
    assert.equal(await source(), 'example.ts.net')
    const { readFile } = await import('node:fs/promises')
    assert.equal(await readFile(calls, 'utf8'), 'status --json\n')
  })

  it('answers undefined when the configured CLI does not exist', async () => {
    assert.equal(await createMagicDnsSuffixSource(join(dir, 'missing'))(), undefined)
  })
})

describe('inspectPath / makeDirectory', () => {
  let home
  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'deepsea-remote-workspaces-home-'))
    await mkdir(join(home, 'projects', 'alpha'), { recursive: true })
    await mkdir(join(home, 'projects', 'alps'))
    await mkdir(join(home, 'projects', '.hidden'))
    await mkdir(join(home, 'Music'))
    await writeFile(join(home, 'notes.txt'), 'x')
    await symlink(join(home, 'Music'), join(home, 'projects', 'linked'))
    await writeFile(join(home, 'projects', 'file.txt'), 'x')
  })
  after(async () => { await rm(home, { recursive: true, force: true }) })

  it('expands ~ against the given home', () => {
    assert.equal(expandHome('~', '/h'), '/h')
    assert.equal(expandHome('~/x', '/h'), '/h/x')
    assert.equal(expandHome('/x', '/h'), '/x')
    assert.equal(expandHome('~x', '/h'), '~x')
  })

  it('reports an existing directory and completes the typed last segment over its siblings', async () => {
    const info = await inspectPath('~/projects/al', { home })
    assert.equal(info.home, home)
    assert.equal(info.resolved, join(home, 'projects', 'al'))
    assert.equal(info.kind, 'missing')
    assert.equal(info.creatable, true)
    assert.deepEqual(info.entries.map(entry => entry.name), ['alpha', 'alps'])
    const exact = await inspectPath('~/projects/alpha', { home })
    assert.equal(exact.kind, 'directory')
    assert.deepEqual(exact.entries.map(entry => entry.name), ['alpha'])
  })

  it('a trailing slash lists the children: directories and directory symlinks, no files, hidden only when asked', async () => {
    const info = await inspectPath('~/projects/', { home })
    assert.equal(info.kind, 'directory')
    assert.deepEqual(info.entries.map(entry => entry.name), ['alpha', 'alps', 'linked'])
    assert.equal(info.entries[0].path, join(home, 'projects', 'alpha'))
    const hidden = await inspectPath('~/projects/.h', { home })
    assert.deepEqual(hidden.entries.map(entry => entry.name), ['.hidden'])
  })

  it('a file, and a path under a file, are not creatable', async () => {
    const file = await inspectPath('~/notes.txt', { home })
    assert.equal(file.kind, 'file')
    assert.equal(file.creatable, false)
    const under = await inspectPath('~/notes.txt/deeper/x', { home, list: false })
    assert.equal(under.kind, 'missing')
    assert.equal(under.creatable, false)
    assert.equal(under.blocker, join(home, 'notes.txt'))
  })

  it('a deep missing path under a directory is creatable and makeDirectory makes it (idempotently)', async () => {
    const info = await inspectPath('~/new/deeper', { home, list: false })
    assert.deepEqual([info.kind, info.creatable], ['missing', true])
    assert.deepEqual(await makeDirectory('~/new/deeper', home), { path: join(home, 'new', 'deeper'), created: true })
    assert.deepEqual(await makeDirectory('~/new/deeper', home), { path: join(home, 'new', 'deeper'), created: false })
    await assert.rejects(() => makeDirectory('~/notes.txt', home), /not a directory/)
  })

  it('refuses relative paths; empty means home', async () => {
    await assert.rejects(() => inspectPath('projects', { home }), /absolute/)
    assert.equal((await inspectPath('', { home, list: false })).resolved, home)
  })
})
