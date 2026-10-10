// node --test: the host half against a fake ctx, its routes and rows, in a scratch home.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { unzipSync } from 'fflate'
import { apply } from '../index.js'

const scratch = mkdtempSync(join(tmpdir(), 'deepsea-brand-kit-test-'))
const home = join(scratch, 'home')
const savedHome = process.env.DSH_HOME
const routes = new Map()
let inject
const logs = []
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'

before(() => {
  process.env.DSH_HOME = home
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path) } } } },
    effect(fn) { return fn() },
    on(event, fn) { if (event === 'webserver/index-inject') inject = fn },
    logger: { info: m => logs.push(m), warn: m => logs.push(`warn: ${m}`) },
  }
  apply(ctx)
})
after(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(scratch, { recursive: true, force: true })
})

const URL_BASE = 'http://deepsea.test'
async function call(path, { method = 'GET', type, body } = {}) {
  const route = routes.get(path.split('?')[0])
  assert.ok(route, `route ${path}`)
  assert.ok(route.methods.includes(method), `${method} ${path}`)
  const response = await route.fetch(new Request(`${URL_BASE}${path}`, { method, headers: type ? { 'content-type': type } : {}, body }))
  return response
}
const act = async (action, fields) => {
  const response = await call('/api/deepsea-brand-kit', { method: 'POST', type: 'application/json', body: JSON.stringify({ action, ...fields }) })
  return { status: response.status, state: await response.json() }
}
const rows = () => { const table = []; inject(table); return table }

test('the routes and the shipped look', async () => {
  assert.deepEqual([...routes.keys()].sort(), ['/api/deepsea-brand-kit', '/api/deepsea-brand-kit/asset', '/api/deepsea-brand-kit/export', '/api/deepsea-brand-kit/import', '/api/deepsea-brand-kit/upload'])
  assert.match(logs.join('\n'), /no active profile \(shipped look\); 0 profile\(s\) in .*plugins\/brand-kit/)
  const state = await (await call('/api/deepsea-brand-kit')).json()
  assert.deepEqual(state, { active: '', effective: '', profiles: [] })
  assert.deepEqual(rows(), [{ kind: 'global', name: '__DEEPSEA_BRAND_KIT__', value: { name: '', headline: '', turnStatus: '', mark: null } }])
})

test('state changes need a JSON or octet-stream body', async () => {
  for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x', undefined]) {
    assert.equal((await call('/api/deepsea-brand-kit', { method: 'POST', type, body: 'action=create&name=X' })).status, 415, String(type))
  }
  assert.equal((await call('/api/deepsea-brand-kit/upload?name=X&kind=mark&file=m.svg', { method: 'POST', type: 'text/plain', body: svg })).status, 415)
  assert.equal((await call('/api/deepsea-brand-kit/import?file=x.zip', { method: 'POST', type: 'multipart/form-data', body: 'x' })).status, 415)
  assert.ok(!existsSync(join(home, 'plugins', 'brand-kit', 'profiles', 'X')))
})

test('create, upload, save, apply: the page gets the brand', async () => {
  assert.equal((await act('create', { name: 'Acme' })).status, 200)
  const upload = await call('/api/deepsea-brand-kit/upload?name=Acme&kind=mark&file=mark.svg', { method: 'POST', type: 'application/octet-stream', body: svg })
  assert.equal((await upload.json()).uploaded, 'mark.svg')
  const saved = await act('save', { name: 'Acme', profile: { name: 'Acme', mark: 'mark.svg', headline: 'Hello', accent: '#7678ed' } })
  assert.equal(saved.status, 200)
  assert.equal((await act('save', { name: 'Acme', profile: { accent: 'blue' } })).state.error.startsWith('accent must be'), true)
  assert.equal((await act('apply', { name: 'Acme' })).state.active, 'Acme')
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'plugins', 'brand-kit', 'state.json'), 'utf8')), { active: 'Acme' })
  const [style, global] = rows()
  assert.equal(style.kind, 'style')
  assert.match(style.text, /^\/\* deepsea-brand-kit \*\//)
  assert.match(style.text, /--dsw-static-deepseek-500:#7678ed/)
  assert.deepEqual(global.value, { name: 'Acme', headline: 'Hello', turnStatus: '', mark: { url: './api/deepsea-brand-kit/asset?s=Acme&k=mark&f=mark.svg', mode: 'mask' } })
  const asset = await call('/api/deepsea-brand-kit/asset?s=Acme&k=mark&f=mark.svg')
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('content-type'), 'image/svg+xml')
  assert.equal(await asset.text(), svg)
  assert.equal((await call('/api/deepsea-brand-kit/asset?s=Acme&k=mark&f=profile.json')).status, 404)
  assert.equal((await call('/api/deepsea-brand-kit/asset?s=..&k=mark&f=mark.svg')).status, 404)
})

test('duplicate, rename, export, import, delete', async () => {
  const duplicated = await act('duplicate', { name: 'Acme' })
  assert.equal(duplicated.state.created, 'Acme copy')
  assert.equal((await act('rename', { name: 'Acme', to: 'Acme 2' })).state.active, 'Acme 2')
  const exported = await call('/api/deepsea-brand-kit/export?name=Acme%202')
  assert.equal(exported.headers.get('content-disposition'), 'attachment; filename="Acme 2.brand.zip"')
  const zip = new Uint8Array(await exported.arrayBuffer())
  assert.deepEqual(Object.keys(unzipSync(zip)).sort(), ['mark.svg', 'profile.json'])
  const imported = await call('/api/deepsea-brand-kit/import?file=Acme%202.brand.zip', { method: 'POST', type: 'application/octet-stream', body: zip })
  const state = await imported.json()
  assert.equal(state.created, 'Acme 3')
  assert.deepEqual(state.profiles.map(row => row.name), ['Acme 2', 'Acme 3', 'Acme copy'])
  assert.equal((await act('delete', { name: 'Acme 2' })).state.active, '')
  assert.equal((await call('/api/deepsea-brand-kit/export?name=nope')).status, 404)
  assert.equal((await act('frobnicate', { name: 'x' })).status, 400)
})

test('a hand-broken active profile is reported and the shipped look stands in', async () => {
  await act('apply', { name: 'Acme 3' })
  writeFileSync(join(home, 'plugins', 'brand-kit', 'profiles', 'Acme 3', 'profile.json'), '{"accent":"green"}')
  const state = await (await call('/api/deepsea-brand-kit')).json()
  assert.equal(state.active, 'Acme 3')
  assert.equal(state.effective, '')
  assert.match(state.activeError, /^Acme 3: accent must be/)
  assert.deepEqual(state.profiles.find(row => row.name === 'Acme 3').profile, { accent: 'green' })
  assert.equal(rows().length, 1)
})

test('the CLI: import a directory, apply, list, export, re-import', () => {
  const cli = new URL('../cli.mjs', import.meta.url).pathname
  const cliHome = join(scratch, 'cli-home')
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: cliHome } }).trim()
  const src = join(scratch, 'brand-src')
  mkdirSync(join(src, 'artwork'), { recursive: true })
  writeFileSync(join(src, 'mark.svg'), svg)
  writeFileSync(join(src, 'profile.json'), JSON.stringify({ name: 'Acme', mark: 'mark.svg', accent: '#7678ed' }))
  assert.match(run('import', src, '--name', 'Acme', '--apply'), /imported Acme[\s\S]*active: Acme/)
  assert.equal(run('active'), 'Acme')
  assert.equal(run('list'), '* Acme')
  assert.ok(!existsSync(join(cliHome, 'plugins', 'brand-kit', 'profiles', 'Acme', 'artwork')))
  const zip = join(scratch, 'acme.brand.zip')
  run('export', 'Acme', zip)
  assert.throws(() => run('import', zip), /a profile named "acme" already exists/) // one directory where case is ignored
  assert.match(run('import', zip, '--name', 'Copy'), /imported Copy/)
  assert.equal(run('list'), '* Acme\n  Copy')
  assert.equal(run('apply', 'none'), 'active: none (the shipped look)')
  assert.throws(() => run('import', src, '--name', 'Acme'), /already exists/)
  assert.match(run('import', src, '--name', 'Acme', '--replace'), /imported Acme/)
})
