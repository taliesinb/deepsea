import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachmentRefs, copyAttachments, prepareDshSelection, samePath, scanDshSelection } from '../host/dsh-source.mjs'
import { dshHome, scratch } from './fixtures.mjs'

const elsewhere = '/nonexistent/active-home'

test('a home, one of its workspaces and one session classify by content and scan to the same session', async () => {
  const source = await dshHome()
  const workspaceDir = join(source.home, 'sessions', readdirSync(join(source.home, 'sessions'))[0])
  const sessionDir = join(workspaceDir, readdirSync(workspaceDir).find(name => name.startsWith('session-')))
  assert.equal((await prepareDshSelection(source.home, elsewhere)).kind, 'root')
  assert.equal((await prepareDshSelection(workspaceDir, elsewhere)).kind, 'workspace')
  assert.equal((await prepareDshSelection(sessionDir, elsewhere)).kind, 'session')
  for (const path of [source.home, workspaceDir, sessionDir]) {
    const scan = await scanDshSelection(path, elsewhere)
    const sessions = scan.workspaces.flatMap(group => group.sessions)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].id, source.id)
    assert.equal(sessions[0].title, 'Build the thing')
    assert.equal(scan.workspaces[0].dir, source.cwd)
    assert.equal(scan.workspaces[0].dirExists, true)
    await scan.selection.cleanup()
  }
})

/** A backup ZIP of `home` in one of the archive layouts, with optional extra files under the home. */
function backupOf(home, { root = 'home', manifest = 'deepsea-backup.json', format = 'deepsea-home-v1', name = 'y2026m10d09h12m00s00.hexample.fabc123.p0.w1.s1.backup.deepsea.zip', extra = {} } = {}) {
  const stage = scratch('zip-stage')
  mkdirSync(join(stage, root))
  cpSync(join(home, 'sessions'), join(stage, root, 'sessions'), { recursive: true })
  for (const [relative, data] of Object.entries(extra)) {
    mkdirSync(join(stage, root, relative, '..'), { recursive: true })
    writeFileSync(join(stage, root, relative), data)
  }
  writeFileSync(join(stage, manifest), JSON.stringify({ format, counts: {}, files: [] }))
  const zip = join(scratch('zip'), name)
  execFileSync('zip', ['-q', '-r', zip, manifest, root], { cwd: stage })
  return zip
}

test('a backup archive is read from its home/sessions/, and from the earlier dsh/ layout', async () => {
  const source = await dshHome()
  for (const layout of [{}, { root: 'dsh', manifest: 'dsh-backup.json', format: 'dsh-home-v1', name: 'y2026m10d09h12m00s00.hexample.fabc123.p0.w1.s1.backup.dsh.zip' }]) {
    const scan = await scanDshSelection(backupOf(source.home, layout), elsewhere)
    assert.equal(scan.kind, 'root')
    assert.equal(scan.selection.archive, true)
    assert.deepEqual(scan.workspaces.flatMap(group => group.sessions).map(session => session.id), [source.id])
    await scan.selection.cleanup()
  }
})

test('an archive under another name, or with the other layout\'s manifest, is refused', async () => {
  const source = await dshHome()
  const zip = backupOf(source.home, { name: 'home.zip' })
  await assert.rejects(prepareDshSelection(zip, elsewhere), /not a \.backup\.deepsea\.zip/)
  const mixed = backupOf(source.home, { format: 'dsh-home-v1' })
  await assert.rejects(prepareDshSelection(mixed, elsewhere), /invalid backup manifest/)
})

// ---- attachments ------------------------------------------------------------

const sha = data => createHash('sha256').update(data).digest('hex')
const imageRef = (data, extra = {}) => ({ attachmentId: `sha256:${sha(data)}`, mediaType: 'image/png', width: 2, height: 1, bytes: data.length, ...extra })
const fileRef = (data, name) => ({ attachmentId: `sha256:${sha(data)}`, name, bytes: data.length })
const family = (...refs) => ({
  root: { header: { id: 'session-root' }, events: [{ type: 'user/message', data: { content: refs.slice(0, 1).map(attachment => ({ type: 'image', attachment })) } }] },
  children: [{ header: { id: 'session-child' }, events: refs.slice(1).map(attachment => ({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: [{ type: 'image', attachment }] }] } } })) }],
})

/** An attachment service over a scratch directory; `renormalize` makes saveImage store under another id. */
function memoryStore({ have = [], renormalize = false } = {}) {
  const root = scratch('target-store')
  const stored = new Map()
  const keep = (id, kind) => { stored.set(id, kind); writeFileSync(join(root, id.slice(7)), kind) }
  for (const id of have) keep(id, 'present')
  const host = ref => join(root, String(ref.attachmentId).slice(7))
  return {
    stored,
    imageHostPath: host,
    fileHostPath: host,
    async saveImage({ data }) { const id = `sha256:${sha(renormalize ? Buffer.concat([Buffer.from(data), Buffer.from('x')]) : Buffer.from(data))}`; keep(id, 'image'); return { attachmentId: id } },
    async saveFile({ data, name }) { const id = `sha256:${sha(Buffer.from(data))}`; keep(id, `file:${name}`); return { attachmentId: id } },
  }
}

test('attachment references are collected from a family\'s root and descendants, once each', () => {
  const one = Buffer.from('one'), two = Buffer.from('two')
  const refs = attachmentRefs(family(imageRef(one), imageRef(two), imageRef(one)))
  assert.deepEqual(refs.map(ref => ref.attachmentId), [`sha256:${sha(one)}`, `sha256:${sha(two)}`])
})

test('images and files are copied from another home\'s store under their ids; present, missing and corrupt ones are counted', async () => {
  const home = scratch('attachments-home')
  const store = join(home, 'attachments', 'v1')
  const png = Buffer.from('png bytes'), scene = Buffer.from('{"scene":1}'), absent = Buffer.from('absent'), corrupt = Buffer.from('corrupt'), already = Buffer.from('already')
  const put = (relative, data) => { mkdirSync(join(store, relative, '..'), { recursive: true }); writeFileSync(join(store, relative), data) }
  put(`objects/${sha(png).slice(0, 2)}/${sha(png)}`, png)
  put(`files/${sha(scene).slice(0, 2)}/${sha(scene)}/a.scene.json`, scene)
  put(`objects/${sha(corrupt).slice(0, 2)}/${sha(corrupt)}`, Buffer.from('not what the id says'))
  const selection = { readAttachment: async relative => { try { return await (await import('node:fs/promises')).readFile(join(store, relative)) } catch { return undefined } } }
  const target = memoryStore({ have: [`sha256:${sha(already)}`] })
  const warnings = []
  const counts = await copyAttachments(family(imageRef(png), fileRef(scene, 'a.scene.json'), imageRef(absent), imageRef(corrupt), imageRef(already)), selection, target, { warn: message => warnings.push(message) })
  assert.deepEqual(counts, { images: 4, files: 1, copied: 2, present: 1, missing: 2, mismatched: 0 })
  assert.equal(target.stored.get(`sha256:${sha(png)}`), 'image')
  assert.equal(target.stored.get(`sha256:${sha(scene)}`), 'file:a.scene.json')
  assert.equal(target.stored.has(`sha256:${sha(corrupt)}`), false)
  assert.equal(warnings.length, 2)
})

test('an image the store re-encodes under another id is counted as mismatched, with a warning', async () => {
  const png = Buffer.from('png')
  const selection = { readAttachment: async () => png }
  const warnings = []
  const counts = await copyAttachments(family(imageRef(png)), selection, memoryStore({ renormalize: true }), { warn: message => warnings.push(message) })
  assert.equal(counts.mismatched, 1)
  assert.match(warnings[0], /will not resolve/)
})

test('a backup archive\'s attachments are read from the archive', async () => {
  const source = await dshHome()
  const png = Buffer.from('archived png'), scene = Buffer.from('archived file')
  const zip = backupOf(source.home, { extra: {
    [`attachments/v1/objects/${sha(png).slice(0, 2)}/${sha(png)}`]: png,
    [`attachments/v1/files/${sha(scene).slice(0, 2)}/${sha(scene)}/odd [name].json`]: scene,
  } })
  const scan = await scanDshSelection(zip, elsewhere)
  try {
    const target = memoryStore()
    const counts = await copyAttachments(family(imageRef(png), fileRef(scene, 'odd [name].json')), scan.selection, target)
    assert.deepEqual(counts, { images: 1, files: 1, copied: 2, present: 0, missing: 0, mismatched: 0 })
  } finally { await scan.selection.cleanup() }
})

test('a home\'s attachments are found from the home, a workspace or one session', async () => {
  const source = await dshHome()
  const png = Buffer.from('home png')
  mkdirSync(join(source.home, 'attachments', 'v1', 'objects', sha(png).slice(0, 2)), { recursive: true })
  writeFileSync(join(source.home, 'attachments', 'v1', 'objects', sha(png).slice(0, 2), sha(png)), png)
  const workspaceDir = join(source.home, 'sessions', readdirSync(join(source.home, 'sessions'))[0])
  const sessionDir = join(workspaceDir, readdirSync(workspaceDir).find(name => name.startsWith('session-')))
  for (const path of [source.home, join(source.home, 'sessions'), workspaceDir, sessionDir]) {
    const selection = await prepareDshSelection(path, elsewhere)
    assert.deepEqual(await selection.readAttachment(`objects/${sha(png).slice(0, 2)}/${sha(png)}`), png, path)
  }
})

test('the home the server runs on is refused, under any spelling', async () => {
  const source = await dshHome()
  assert.equal(await samePath(source.home, `${source.home}/.`), true)
  await assert.rejects(prepareDshSelection(source.home, `${source.home}/.`), /home the server runs on/)
})

test('a directory without sessions is refused', async () => {
  const root = scratch('empty')
  mkdirSync(join(root, 'sessions'))
  await assert.rejects(prepareDshSelection(root, elsewhere), /not a home/)
})
