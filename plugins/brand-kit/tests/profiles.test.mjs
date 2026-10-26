// node --test: the profile store in scratch state directories.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { unzipSync, zipSync } from 'fflate'
import { ProfileStore, nameFromFile, resolveProfile, stateDirectory } from '../profiles.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'deepsea-brand-kit-test-'))
after(() => { rmSync(scratch, { recursive: true, force: true }) })
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
const woff = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3])
const fresh = () => new ProfileStore(mkdtempSync(join(scratch, 'state-')))

test('the state directory is the plugin\'s, in the home', () => {
  assert.equal(stateDirectory({ DSH_HOME: '/x/home' }), '/x/home/plugins/brand-kit')
  const store = new ProfileStore('/x/home/plugins/brand-kit')
  assert.equal(store.profiles, '/x/home/plugins/brand-kit/profiles')
  assert.equal(store.stateFile, '/x/home/plugins/brand-kit/state.json')
})

test('an empty store: no profiles, the shipped look', () => {
  const store = fresh()
  assert.deepEqual(store.list(), [])
  assert.equal(store.active(), '')
  assert.throws(() => store.setActive('nope'), /no profile named/)
})

test('create, upload, write, read, apply', () => {
  const store = fresh()
  store.create('Acme')
  assert.throws(() => store.create('Acme'), /already exists/)
  store.putAsset('Acme', 'mark', 'mark.svg', svg)
  store.putAsset('Acme', 'font', 'Face.woff2', woff)
  const saved = store.write('Acme', { name: 'Acme', mark: 'mark.svg', accent: '#7678ed', fonts: [{ file: 'Face.woff2', family: 'Face', weight: 300 }], brandFont: { family: 'Face' } })
  assert.equal(saved.brand.mark, join(store.profiles, 'Acme', 'mark.svg'))
  assert.equal(saved.brand.fontsDir, join(store.profiles, 'Acme'))
  assert.deepEqual(store.list(), ['Acme'])
  store.setActive('Acme')
  assert.equal(store.active(), 'Acme')
  assert.deepEqual(JSON.parse(readFileSync(store.stateFile, 'utf8')), { active: 'Acme' })
  store.setActive('')
  assert.equal(store.active(), '')
})

test('write validates before touching profile.json', () => {
  const store = fresh()
  store.create('Bad')
  store.putAsset('Bad', 'mark', 'mark.svg', svg)
  assert.throws(() => store.write('Bad', { accent: 'blue' }), /accent must be/)
  assert.equal(readFileSync(join(store.profiles, 'Bad', 'profile.json'), 'utf8'), '{}\n')
  assert.throws(() => store.write('Bad', { mark: '../x.svg' }), /file name in the profile/)
  assert.throws(() => store.write('Bad', { fonts: [{ file: 'missing.woff2', family: 'F' }] }), /font file not found/)
  assert.throws(() => store.putAsset('Bad', 'font', 'evil.svg', svg), /font file is named/)
  assert.throws(() => store.putAsset('Bad', 'mark', 'm.svg', new Uint8Array()), /empty file/)
  assert.throws(() => store.putAsset('Nope', 'mark', 'm.svg', svg), /no profile named/)
  assert.throws(() => store.write('..', {}), /profile name/)
  assert.throws(() => store.write('.hidden', {}), /profile name/)
})

test('duplicate, rename, delete keep the active pointer right', () => {
  const store = fresh()
  store.create('A')
  store.putAsset('A', 'mark', 'm.svg', svg)
  store.write('A', { name: 'A', mark: 'm.svg' })
  store.duplicate('A', store.freeName('A copy'))
  assert.ok(existsSync(join(store.profiles, 'A copy', 'm.svg')))
  assert.equal(store.read('A copy').brand.name, 'A')
  assert.equal(store.freeName('A copy'), 'A copy 2')
  assert.equal(store.freeName('B'), 'B')
  assert.equal(store.freeName('a'), 'a 2') // `A` exists: one directory where case is ignored
  assert.throws(() => store.create('a'), /already exists/)
  assert.equal(store.has('a'), false)
  store.setActive('A copy')
  store.rename('A copy', 'C')
  assert.equal(store.active(), 'C')
  assert.throws(() => store.rename('C', 'A'), /already exists/)
  store.delete('C')
  assert.deepEqual(store.list(), ['A'])
  assert.equal(store.active(), '')
})

test('export and import round trip; bad archives leave nothing behind', () => {
  const a = fresh()
  a.create('Src')
  a.putAsset('Src', 'mark', 'mark.svg', svg)
  a.putAsset('Src', 'font', 'Face.woff2', woff)
  a.write('Src', { name: 'Src', mark: 'mark.svg', fonts: [{ file: 'Face.woff2', family: 'Face' }], headline: 'Hi' })
  a.putAsset('Src', 'mark', 'old-mark.svg', svg) // no longer named: not exported
  const zip = a.exportZip('Src')
  assert.deepEqual(Object.keys(unzipSync(zip)).sort(), ['Face.woff2', 'mark.svg', 'profile.json'])
  const b = fresh()
  assert.equal(b.importZip('Dst', zip).brand.headline, 'Hi')
  assert.equal(readFileSync(join(b.profiles, 'Dst', 'Face.woff2')).length, woff.length)
  assert.throws(() => b.importZip('Dst', zip), /already exists/)
  assert.equal(b.importZip('Dst', zip, { replace: true }).name, 'Dst')
  assert.throws(() => b.importZip('Junk', new Uint8Array([1, 2, 3])), /not a zip/)
  assert.ok(!existsSync(join(b.profiles, 'Junk')))
  // profile.json naming a file the archive lacks: refused, staging removed.
  const broken = zipSync({ 'profile.json': new TextEncoder().encode(JSON.stringify({ mark: 'nope.svg' })) })
  assert.throws(() => b.importZip('Broken', broken), /mark file not found/)
  assert.ok(!existsSync(join(b.profiles, 'Broken')))
  assert.deepEqual(readdirSync(b.profiles).filter(entry => entry.startsWith('.')), [])
  // One wrapping folder is accepted; macOS metadata is skipped; anything else is refused.
  const wrapped = zipSync({ 'Acme/profile.json': new TextEncoder().encode('{"name":"Acme"}'), '__MACOSX/Acme/._profile.json': new Uint8Array([0]) })
  assert.equal(b.importZip('Wrapped', wrapped).brand.name, 'Acme')
  assert.throws(() => b.importZip('Nested', zipSync({ 'profile.json': new TextEncoder().encode('{}'), 'a/b.svg': svg })), /unexpected folder/)
  assert.throws(() => b.importZip('Script', zipSync({ 'profile.json': new TextEncoder().encode('{}'), 'x.js': svg })), /unexpected file/)
  assert.throws(() => b.importZip('Empty', zipSync({ 'mark.svg': svg })), /no profile\.json/)
})

test('a directory import takes profile.json and its files only', () => {
  const store = fresh()
  const src = mkdtempSync(join(scratch, 'src-'))
  writeFileSync(join(src, 'mark.svg'), svg)
  writeFileSync(join(src, 'notes.txt'), 'not an asset')
  writeFileSync(join(src, 'profile.json'), JSON.stringify({ name: 'Acme', mark: 'mark.svg' }))
  store.importDirectory('Acme', src)
  assert.deepEqual(readdirSync(join(store.profiles, 'Acme')).sort(), ['mark.svg', 'profile.json'])
})

test('a hand-broken profile is listed with its raw JSON and does not apply', () => {
  const store = fresh()
  store.create('Hand')
  writeFileSync(join(store.profiles, 'Hand', 'profile.json'), JSON.stringify({ accent: 'green' }))
  assert.throws(() => store.read('Hand'), /accent must be/)
  assert.deepEqual(store.rawJson('Hand'), { accent: 'green' })
  assert.deepEqual(store.list(), ['Hand'])
})

test('names from file names', () => {
  assert.equal(nameFromFile('Acme.brand.zip'), 'Acme')
  assert.equal(nameFromFile('/x/y/My Brand.zip'), 'My Brand')
  assert.equal(nameFromFile('..weird?.zip'), 'weird')
  assert.equal(nameFromFile('.zip'), 'Imported')
})

test('resolveProfile refuses a path as the mark', () => {
  assert.throws(() => resolveProfile('/tmp/x', { mark: 'a/b.svg' }), /file name in the profile/)
  assert.equal(resolveProfile('/tmp/x', { mark: 'm.svg', fonts: [{ file: 'f.woff2', family: 'F' }] }).fontsDir, '/tmp/x')
  assert.equal(resolveProfile('/tmp/x', { fontsDir: '/elsewhere' }).fontsDir, '')
})
