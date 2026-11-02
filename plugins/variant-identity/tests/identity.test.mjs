// node --test: the plugin against a fake ctx and scratch homes; no harness boot.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Config, apply } from '../index.js'
import {
  GENERIC_PRODUCT_TITLE, THROWAWAY_COLOR, displayNameOf, faviconSvg, identityStyle, parseFlatYaml,
  readVariant, resolveConfig, resolveIdentity, titleScript,
} from '../identity.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'deepsea-variant-identity-test-'))
after(() => { rmSync(scratch, { recursive: true, force: true }) })
/** A scratch home, with variant.yml when text is given. */
function home(text) {
  const dir = mkdtempSync(join(scratch, 'home-'))
  if (text !== undefined) writeFileSync(join(dir, 'variant.yml'), text)
  return dir
}

const env = { DEEPSEA_ROOT: join(scratch, 'not-the-root') }

function fakeContext() {
  const routes = new Map()
  const listeners = new Map()
  const logs = []
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    effect(fn) { return fn() },
    on(event, fn) { listeners.set(event, fn); return () => { listeners.delete(event) } },
    logger: { info: m => logs.push(m), warn: m => logs.push(`warn: ${m}`) },
  }
  return { ctx, routes, listeners, logs }
}

/** Run apply with $DSH_HOME pointing at a scratch home. */
function applyIn(dir, config) {
  const saved = { DSH_HOME: process.env.DSH_HOME, DEEPSEA_ROOT: process.env.DEEPSEA_ROOT, DEEPSEA_VARIANT: process.env.DEEPSEA_VARIANT }
  process.env.DSH_HOME = dir
  process.env.DEEPSEA_ROOT = env.DEEPSEA_ROOT
  delete process.env.DEEPSEA_VARIANT
  try {
    const fake = fakeContext()
    apply(fake.ctx, config)
    const table = []
    fake.listeners.get('webserver/index-inject')?.(table)
    return { ...fake, table }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function get(handler, method = 'GET') {
  let status
  let headers
  let body
  await handler({ method }, { writeHead(s, h) { status = s; headers = h ?? {} }, end(b) { body = b } })
  return { status, headers, body }
}

test('display names follow LAYOUT.md §1', () => {
  assert.equal(displayNameOf('release'), 'DeepSea')
  assert.equal(displayNameOf('personal'), 'DeepSea Personal')
  assert.equal(displayNameOf('my-lab'), 'DeepSea My Lab')
  assert.equal(displayNameOf('personal-3f9a1c'), 'DeepSea Personal 3f9a1c')
  assert.equal(displayNameOf('release-3f9a1c'), 'DeepSea 3f9a1c')
})

test('flat YAML as dsd writes it', () => {
  const parsed = parseFlatYaml([
    '# DeepSea Personal: written by dsd',
    'id: personal',
    'display: DeepSea Personal        # derived',
    'color: "#30A46C"                 # app glyph and title tint',
    "note: 'it''s # not a comment'",
    'throwaway: true',
    'ports: 3210',
    'not a pair',
  ].join('\n'))
  assert.deepEqual(parsed, { id: 'personal', display: 'DeepSea Personal', color: '#30A46C', note: "it's # not a comment", throwaway: true, ports: '3210' })
})

test('no variant.yml and no config: nothing injected, no routes', () => {
  const dir = home()
  assert.equal(readVariant(dir), undefined)
  const { listeners, routes, logs } = applyIn(dir, undefined)
  assert.equal(listeners.has('webserver/index-inject'), false)
  assert.equal(routes.size, 0)
  assert.match(logs.join('\n'), /nothing to show \(no variant\.yml\)/)
})

test('a named variant: display and colour from variant.yml', async () => {
  const dir = home('id: personal\ndisplay: DeepSea Personal\ncolor: "#30a46c"\n')
  const { table, routes } = applyIn(dir, undefined)
  assert.deepEqual(table.map(row => row.kind), ['style', 'script'])
  assert.match(table[0].text, /_localBuildTitle"\]::before\{content:"DeepSea Personal";font-size:12px;line-height:13px\}/)
  assert.match(table[0].text, /_fallbackBrandName"\]::before\{content:"DeepSea Personal";font-size:17px;line-height:24px\}/)
  assert.match(table[0].text, /span\[class\*="_brandMark"\],span\[class\*="_railMark"\]\{color:#30A46C\}/)
  assert.match(table[0].text, /_buildVersion"\]\{color:inherit;background:none;opacity:\.4;padding:0;border-radius:0\}/)
  assert.doesNotMatch(table[0].text, /!important/)
  assert.equal(table[1].placement, 'body')
  assert.doesNotMatch(table[1].text, /<\/script/i)
  for (const path of ['/favicon.svg', '/favicon-dark.svg']) {
    const res = await get(routes.get(path))
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'image/svg+xml')
    assert.match(res.body, /fill="#30A46C"/)
    assert.doesNotMatch(res.body, /__COLOR__/)
  }
  assert.equal((await get(routes.get('/favicon.svg'), 'POST')).status, 405)
  assert.equal((await get(routes.get('/favicon.svg'), 'HEAD')).body, undefined)
})

test('a throwaway without display or colour: derived name, the throwaway orange', () => {
  const dir = home('# DeepSea 3f9a1c: written by dsd\nid: release-3f9a1c\nparent: release\nthrowaway: true\n')
  const identity = resolveIdentity({}, readVariant(dir), dir, env)
  assert.deepEqual(identity, { display: 'DeepSea 3f9a1c', color: THROWAWAY_COLOR, versionBadge: 'subtle', notes: [] })
  const named = resolveIdentity({}, { id: 'personal-3f9a1c' }, dir, env)
  assert.equal(named.display, 'DeepSea Personal 3f9a1c')
  assert.equal(named.color, THROWAWAY_COLOR)
})

test('a named variant without colour keeps the stock whale; #000000 is stock', () => {
  assert.deepEqual(resolveIdentity({}, { id: 'release' }, '/x', env), { display: 'DeepSea', color: '', versionBadge: 'subtle', notes: [] })
  assert.equal(resolveIdentity({}, { id: 'personal', color: '#000000' }, '/x', env).color, '')
})

test('the id falls back to the home\'s name in the DeepSea root', () => {
  const identity = resolveIdentity({}, {}, join(scratch, 'root', 'lab'), { DEEPSEA_ROOT: join(scratch, 'root') })
  assert.equal(identity.display, 'DeepSea Lab')
})

test('config overrides variant.yml key by key; empty strings opt out', () => {
  const variant = { id: 'personal', display: 'DeepSea Personal', color: '#30A46C' }
  assert.equal(resolveIdentity(resolveConfig({ display: 'Lab' }), variant, '/x', env).color, '#30A46C')
  const none = resolveIdentity(resolveConfig({ display: '', color: '', versionBadge: 'stock' }), variant, '/x', env)
  assert.deepEqual(none, { display: '', color: '', versionBadge: 'stock', notes: [] })
  assert.equal(identityStyle(none), '')
  // A stock home with only a configured colour: whale and chip, no rename.
  const colourOnly = resolveIdentity(resolveConfig({ color: '#E5484D' }), undefined, '/x', env)
  assert.deepEqual(colourOnly, { display: '', color: '#E5484D', versionBadge: 'subtle', notes: [] })
  assert.doesNotMatch(identityStyle(colourOnly), /::before/)
})

test('configured identity on a stock home', () => {
  const dir = home()
  const { table, routes } = applyIn(dir, { display: 'DeepSea Lab', color: '#0090ff' })
  assert.match(table[0].text, /content:"DeepSea Lab"/)
  assert.match(table[0].text, /color:#0090FF\}/)
  assert.equal(routes.size, 2)
})

test('a bad variant.yml value is cleaned and reported, never fatal', () => {
  const identity = resolveIdentity({}, { id: 'personal', display: 'Deep"Sea</style>', color: 'green' }, '/x', env)
  assert.equal(identity.display, 'DeepSeastyle')
  assert.equal(identity.color, '')
  assert.equal(identity.notes.length, 2)
  const blank = resolveIdentity({}, { id: 'personal', display: '"""' }, '/x', env)
  assert.equal(blank.display, 'DeepSea Personal')
})

test('config validation fails loudly', () => {
  assert.throws(() => resolveConfig({ color: 'red' }), /color/)
  assert.throws(() => resolveConfig({ color: '#abc' }), /color/)
  assert.throws(() => resolveConfig({ display: 'x";}</style>' }), /display/)
  assert.throws(() => resolveConfig({ display: ' lead' }), /display/)
  assert.throws(() => resolveConfig({ versionBadge: 'loud' }), /versionBadge/)
  assert.throws(() => resolveConfig({ label: 'x' }), /unknown config key "label"/)
  assert.deepEqual(resolveConfig({ display: 'DeepSea Café', color: '#000000' }), { display: 'DeepSea Café', color: '' })
  assert.deepEqual(Config['~standard'].validate({ color: '#30a46c' }), { value: { color: '#30A46C' } })
  assert.match(Config['~standard'].validate({ color: 'x' }).issues[0].message, /color/)
  assert.deepEqual(Config['~standard'].validate(undefined), { value: {} })
})

/** Run the title script against a minimal document whose <title> mutates like a browser's. */
function runTitleScript(script, initial, app) {
  let observer
  const doc = {
    _title: initial,
    get title() { return this._title },
    set title(v) { this._title = v; observer?.() },
    querySelector: sel => (sel === 'title' ? {} : null),
  }
  const MutationObserver = class { constructor(fn) { this.fn = fn } observe() { observer = this.fn } }
  // eslint-disable-next-line no-new-func
  new Function('globalThis', 'document', 'MutationObserver', script)({ __DEEPSEA_APP__: app }, doc, MutationObserver)
  return doc
}

test('the title script puts the name in now and on every later change', () => {
  const doc = runTitleScript(titleScript('DeepSea Personal'), GENERIC_PRODUCT_TITLE)
  assert.equal(doc.title, 'DeepSea Personal')
  doc.title = `my session — ${GENERIC_PRODUCT_TITLE}`
  assert.equal(doc.title, 'my session — DeepSea Personal')
  doc.title = 'unrelated'
  assert.equal(doc.title, 'unrelated')
})

test('inside the DeepSea app the app\'s own name wins', () => {
  const doc = runTitleScript(titleScript('DeepSea Personal'), `x — ${GENERIC_PRODUCT_TITLE}`, { name: 'DeepSea 3f9a1c' })
  assert.equal(doc.title, 'x — DeepSea 3f9a1c')
  const unnamed = runTitleScript(titleScript('DeepSea Personal'), GENERIC_PRODUCT_TITLE, { name: '' })
  assert.equal(unnamed.title, 'DeepSea Personal')
})

test('favicon colouring', () => {
  assert.equal(faviconSvg('<path fill="__COLOR__"/><g fill="__COLOR__"/>', '#30A46C'), '<path fill="#30A46C"/><g fill="#30A46C"/>')
})
