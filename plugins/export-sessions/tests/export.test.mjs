import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { exportName, makeExport, withDescendants } from '../archive.mjs'
import { findSession, findWorkspace } from '../index.js'

const scratch = []
after(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })
const digest = data => createHash('sha256').update(data).digest('hex')
const unzipFiles = path => execFileSync('unzip', ['-Z', '-1', path], { encoding: 'utf8' }).trim().split('\n').filter(entry => !entry.endsWith('/')).sort()
const manifestOf = path => JSON.parse(execFileSync('unzip', ['-p', path, 'deepsea-backup.json'], { encoding: 'utf8' }))

/** A home with two workspaces' sessions, a subagent child, an attachment store, and the persistence the server would offer over it. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deepsea-export-sessions-test-'))
  scratch.push(root)
  const home = join(root, 'home')
  const directory = join(root, 'exports')
  const put = async (relative, data) => { await mkdir(join(home, relative, '..'), { recursive: true }); await writeFile(join(home, relative), data) }
  const png = Buffer.from('png'), scene = Buffer.from('scene'), stray = Buffer.from('stray'), absent = Buffer.from('absent')
  await put('sessions/--a--/session-root/session.v4.jsonl.zstd', 'root log')
  await put('sessions/--a--/session-root/session.lock', 'lease')
  await put('sessions/--a--/session-child/session.v4.jsonl.zstd', 'child log')
  await put('sessions/--a--/session-second/session.v4.jsonl.zstd', 'second log')
  await put('sessions/--b--/session-other/session.v4.jsonl.zstd', 'other log')
  await put(`attachments/v1/objects/${digest(png).slice(0, 2)}/${digest(png)}`, png)
  await put(`attachments/v1/file-objects/${digest(scene).slice(0, 2)}/${digest(scene)}`, scene)
  await put(`attachments/v1/files/${digest(scene).slice(0, 2)}/${digest(scene)}/a.scene.json`, scene)
  await put(`attachments/v1/objects/${digest(stray).slice(0, 2)}/${digest(stray)}`, stray)
  const ref = data => ({ attachment: { attachmentId: `sha256:${digest(data)}` } })
  const events = {
    'session-root': [{ type: 'user/message', data: { content: [{ type: 'image', ...ref(png) }] } }],
    'session-child': [{ type: 'tool/result', data: { content: [{ type: 'file', ...ref(scene) }, { type: 'image', ...ref(absent) }] } }],
    'session-second': [],
    'session-other': [{ type: 'user/message', data: { content: [{ type: 'image', ...ref(stray) }] } }],
  }
  const flushed = []
  const persistence = {
    async flush() { flushed.push(true) },
    async list() { return [{ header: { id: 'session-root' } }, { header: { id: 'session-child', parentSession: 'session-root' } }, { header: { id: 'session-second' } }, { header: { id: 'session-other' } }] },
    async open(id) { return { async read() { return { events: events[id] } }, async close() {} } },
  }
  return { home, directory, persistence, flushed, png, scene }
}

test('a session export holds the session, its subagent sessions and the attachments they reference', async () => {
  const { home, directory, persistence, flushed, png, scene } = await fixture()
  const saved = await makeExport({ kind: 'session', home, directory, title: 'Fix the lamp!', roots: ['session-root'], describe: { id: 'session-root', title: 'Fix the lamp!' }, persistence, commit: 'test', date: new Date(2026, 8, 28, 21, 3, 4) })
  assert.match(saved.name, /^y2026m09d28h21m03s04\.h[\w-]+\.ftest\.s2\.Fix_the_lamp\.session\.deepsea\.zip$/)
  assert.deepEqual(saved.counts, { sessions: 2, attachments: 2 })
  assert.equal(saved.missingAttachments, 1)
  assert.equal(flushed.length, 1)
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600)
  assert.deepEqual(unzipFiles(saved.path), [
    'deepsea-backup.json',
    `home/attachments/v1/file-objects/${digest(scene).slice(0, 2)}/${digest(scene)}`,
    `home/attachments/v1/files/${digest(scene).slice(0, 2)}/${digest(scene)}/a.scene.json`,
    `home/attachments/v1/objects/${digest(png).slice(0, 2)}/${digest(png)}`,
    'home/sessions/--a--/session-child/session.v4.jsonl.zstd',
    'home/sessions/--a--/session-root/session.v4.jsonl.zstd',
  ])
  const manifest = manifestOf(saved.path)
  assert.equal(manifest.format, 'deepsea-session-v1')
  assert.deepEqual(manifest.session, { id: 'session-root', title: 'Fix the lamp!' })
  assert.equal(manifest.files.length, 5)
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.')), [], 'no staging left behind')
})

test('a workspace export holds every session of the workspace', async () => {
  const { home, directory, persistence } = await fixture()
  const saved = await makeExport({ kind: 'workspace', home, directory, title: 'blender', roots: ['session-root', 'session-second'], describe: { title: 'blender', path: '/work/blender' }, persistence, commit: 'test' })
  assert.match(saved.name, /\.s3\.blender\.workspace\.deepsea\.zip$/)
  assert.equal(manifestOf(saved.path).format, 'deepsea-workspace-v1')
  assert.deepEqual(manifestOf(saved.path).workspace, { title: 'blender', path: '/work/blender' })
  assert.deepEqual(unzipFiles(saved.path).filter(name => name.includes('/sessions/')), [
    'home/sessions/--a--/session-child/session.v4.jsonl.zstd',
    'home/sessions/--a--/session-root/session.v4.jsonl.zstd',
    'home/sessions/--a--/session-second/session.v4.jsonl.zstd',
  ])
})

test('an export refuses nothing to export, or a session without its directory', async () => {
  const { home, directory, persistence } = await fixture()
  await assert.rejects(makeExport({ kind: 'workspace', home, directory, title: 'empty', roots: [], describe: {}, persistence, commit: 'test' }), /empty has no sessions/)
  await assert.rejects(makeExport({ kind: 'session', home, directory, title: 'gone', roots: ['session-gone'], describe: {}, persistence, commit: 'test' }), /session-gone has no directory/)
})

test('descendants follow their parents; names are reduced to safe characters', () => {
  assert.deepEqual(withDescendants([{ header: { id: 'c', parentSession: 'b' } }, { header: { id: 'b', parentSession: 'a' } }, { header: { id: 'a' } }], ['a']), ['a', 'b', 'c'])
  assert.equal(exportName({ kind: 'session', date: new Date(2026, 8, 28, 21, 3, 4), host: 'my.host', commit: 'abc', sessions: 1, title: '…' }), 'y2026m09d28h21m03s04.hmy_host.fabc.s1.session.session.deepsea.zip')
})

test('a workspace is named by title, path or id; a session by id or title; shared titles are refused', () => {
  const workspaces = [{ id: 'w1', title: 'blender', path: '/work/blender' }, { id: 'w2', title: 'Notes', path: '/a/notes' }, { id: 'w3', title: 'notes', path: '/b/notes' }]
  assert.equal(findWorkspace(workspaces, 'Blender').id, 'w1')
  assert.equal(findWorkspace(workspaces, '/work/blender/').id, 'w1')
  assert.equal(findWorkspace(workspaces, 'w2').id, 'w2')
  assert.throws(() => findWorkspace(workspaces, 'notes'), /2 workspaces are called notes; name one by its path: \/a\/notes, \/b\/notes/)
  assert.throws(() => findWorkspace(workspaces, 'nope'), /no workspace nope; workspaces: blender, Notes, notes/)
  const sessions = [{ id: 'session-1', title: 'Fix the lamp' }, { id: 'session-2', title: 'Plan' }, { id: 'session-3', title: 'plan' }]
  assert.equal(findSession(sessions, 'fix the LAMP').id, 'session-1')
  assert.equal(findSession(sessions, 'session-3').id, 'session-3')
  assert.throws(() => findSession(sessions, 'plan'), /2 sessions are called plan; name one by its id: session-2, session-3/)
  assert.throws(() => findSession(sessions, 'nope'), /no session nope/)
})
