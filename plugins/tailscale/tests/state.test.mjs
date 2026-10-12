/** The persisted state and what the plugin takes from the variant. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { loadState, parseUserList, saveState, stateFileOf } from '../state.mjs'
import { displayNameOf, normalizeServePath, parseVariantYaml, readVariantFile, resolveSettings } from '../variant.mjs'

const dir = mkdtempSync(join(tmpdir(), 'deepsea-tailscale-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

describe('state', () => {
  it('parses comma, space and newline separated logins, lower-cased and unique', () => {
    assert.deepEqual(parseUserList('A@Example.com, b@example.org\nb@example.org;c@example.net'), ['a@example.com', 'b@example.org', 'c@example.net'])
    assert.deepEqual(parseUserList(['"bad"', '<x>', ' ok@x ']), ['ok@x'])
  })

  it('creates a tokened state on first load, owner-only, in the plugin directory; `enabled` absent until set', async () => {
    const file = stateFileOf(join(dir, 'home'))
    assert.equal(file, join(dir, 'home', 'plugins', 'tailscale', 'state.json'))
    const state = await loadState(file)
    assert.match(state.token, /^[A-Za-z0-9_-]{32}$/)
    assert.equal('enabled' in state, false)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, 'home', 'plugins', 'tailscale')).mode & 0o777, 0o700)
    await saveState(file, { ...state, enabled: false, allowedUsers: ['a@x'] })
    const again = await loadState(file)
    assert.deepEqual([again.enabled, again.allowedUsers, again.token], [false, ['a@x'], state.token])
  })

  it('re-tokens a state whose token is missing or short, and survives garbage', async () => {
    const file = join(dir, 'bad.json')
    writeFileSync(file, JSON.stringify({ token: 'short', enabled: true }))
    const state = await loadState(file)
    assert.notEqual(state.token, 'short')
    assert.equal(state.enabled, true)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, state.token)
    writeFileSync(file, '{nope')
    const warnings = []
    assert.match((await loadState(file, m => warnings.push(m))).token, /^[A-Za-z0-9_-]{32}$/)
    assert.equal(warnings.length, 1)
  })
})

describe('variant', () => {
  it('reads variant.yml as dsd writes it', () => {
    const text = '# DeepSea Lab: written by dsd\nid: lab\ndisplay: DeepSea Lab\nports: 3200\nsource: integration/base\nserve: true\nservePath: /deepsea-lab\nnote: "a # b"\n'
    assert.deepEqual(parseVariantYaml(text), { id: 'lab', display: 'DeepSea Lab', ports: 3200, source: 'integration/base', serve: true, servePath: '/deepsea-lab', note: 'a # b' })
    const home = join(dir, 'lab')
    assert.equal(readVariantFile(home), undefined, 'a home without variant.yml')
  })

  it('a named variant: proxy on its block +4, its Serve path, its relay, its own cookie', () => {
    const settings = resolveSettings({ id: 'lab', ports: 3200, serve: true, servePath: '/deepsea-lab' }, {}, { home: '/Users/USER/.deepsea/lab', env: { DEEPSEA_RELAY: 'http://127.0.0.1:3203/' } })
    assert.deepEqual(settings, {
      id: 'lab', name: 'io.github.taliesinb.deepsea.lab', display: 'DeepSea Lab', proxyPort: 3204, relayPort: 3203,
      relayUrl: 'http://127.0.0.1:3203/', servePath: '/deepsea-lab', cookieName: 'deepsea-tailscale-lab',
    })
  })

  it('serve: false, a throwaway and a stock home publish nothing; a throwaway gets a proxy only from config', () => {
    assert.equal(resolveSettings({ id: 'lab', ports: 3200, serve: false, servePath: '/deepsea-lab' }, {}, { home: '/h', env: {} }).servePath, undefined)
    const throwaway = resolveSettings({ id: 'release-3f9a1c', parent: 'release', throwaway: true }, {}, { home: '/h', env: {} })
    assert.deepEqual([throwaway.proxyPort, throwaway.servePath, throwaway.display, throwaway.cookieName], [undefined, undefined, 'DeepSea 3f9a1c', 'deepsea-tailscale-release-3f9a1c'])
    const configured = resolveSettings({ id: 'release-3f9a1c' }, { proxyPort: 41000, servePath: 'deepsea-test-ab12/' }, { home: '/h', env: {} })
    assert.deepEqual([configured.proxyPort, configured.servePath], [41000, '/deepsea-test-ab12'])
    const stock = resolveSettings(undefined, {}, { home: '/Users/USER/.dsh', env: {} })
    assert.deepEqual([stock.id, stock.proxyPort, stock.servePath, stock.cookieName], [undefined, undefined, undefined, 'deepsea-tailscale'])
  })

  it('display names and Serve paths', () => {
    assert.equal(displayNameOf('release'), 'DeepSea')
    assert.equal(displayNameOf('personal-lab'), 'DeepSea Personal Lab')
    assert.equal(displayNameOf('lab-0a1b2c'), 'DeepSea Lab 0a1b2c')
    assert.equal(normalizeServePath('deepsea/'), '/deepsea')
    assert.equal(normalizeServePath('/'), '/')
  })
})
