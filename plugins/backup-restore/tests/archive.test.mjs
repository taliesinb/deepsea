import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveName, extractArchive, listBackups, makeBackup, validateArchive } from '../archive.mjs'
import { locations, openRestoreLog } from '../paths.mjs'
import { performRestore } from '../restore-worker.mjs'
import { readRestoreStatus, restoreId, writeRestoreStatus } from '../restore-status.mjs'

const scratch = []
after(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepsea-backup-restore-test-'))
  scratch.push(root)
  const home = join(root, 'home')
  const backups = join(root, 'backups')
  await mkdir(join(home, 'sessions', 'ws', 'one'), { recursive: true })
  await writeFile(join(home, 'settings.yaml'), 'original')
  await writeFile(join(home, 'sessions', 'ws', 'one', 'session.jsonl'), 'session')
  return { root, home, backups }
}

test('names have timestamp, machine, revision, counts and distinct rollback suffix', () => {
  const data = { date: new Date(2026, 8, 28, 14, 3, 4), host: 'example', commit: 'abc123', plugins: 5, workspaces: 1, sessions: 3 }
  assert.equal(archiveName({ ...data, kind: 'backup' }), 'y2026m09d28h14m03s04.hexample.fabc123.p5.w1.s3.backup.deepsea.zip')
  assert.equal(archiveName({ ...data, kind: 'rollback' }), 'hexample--y2026-m09-d28-h14-m03-s04--cabc123-p5-w1-s3.rollback.deepsea.zip')
})

test('backup captures state and restore replaces home, with rollback archive retained', async () => {
  const { home, backups } = await fixture()
  const backup = await makeBackup({ home, backups, commit: 'test' })
  assert.equal(backup.counts.sessions, 1)
  assert.equal((await listBackups(backups)).length, 1)
  await validateArchive(backups, backup.name)
  assert.equal((await stat(backup.path)).mode & 0o777, 0o600)
  const rollback = await makeBackup({ home, backups, kind: 'rollback', commit: 'test' })
  await writeFile(join(home, 'settings.yaml'), 'changed')
  await writeFile(join(home, 'new.txt'), 'remove this')
  await performRestore({ home, backups, name: backup.name, rollback: rollback.name })
  assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), 'original')
  assert.equal((await readdir(home)).includes('new.txt'), false)
  assert.equal((await listBackups(backups)).length, 2)
})

test('failed restore falls back to rollback without discarding current state before validation', async () => {
  const { home, backups } = await fixture()
  const rollback = await makeBackup({ home, backups, kind: 'rollback', commit: 'test' })
  await writeFile(join(home, 'settings.yaml'), 'interim')
  await assert.rejects(performRestore({ home, backups, name: 'missing.backup.deepsea.zip', rollback: rollback.name }))
  assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), 'original')
})

test('path traversal is refused and symlinks are retained without following targets', async () => {
  const { home, backups, root } = await fixture()
  await mkdir(backups)
  await assert.rejects(validateArchive(backups, '../other.backup.deepsea.zip'), /choose a backup/)
  await assert.rejects(validateArchive(backups, 'y2026m09d28h21m03s04.hexample.fabc123.s2.blender.workspace.deepsea.zip'), /imported with \/import-workspace/)
  await assert.rejects(validateArchive(backups, 'y2026m09d28h21m03s04.hexample.fabc123.notes.session.deepsea.zip'), /imported with \/import-session/)
  await symlink(join(home, 'settings.yaml'), join(home, 'alias'))
  const saved = await makeBackup({ home, backups, commit: 'test' })
  const stage = await mkdtemp(join(root, 'extract-'))
  const extracted = await extractArchive(backups, saved.name, stage)
  assert.equal(await readlink(join(extracted, 'alias')), join(home, 'settings.yaml'))
  assert.equal((await listBackups(backups)).length, 1)
})

test('live WAL writes are captured via SQLite backup, without WAL/SHM sidecars', async () => {
  const { home, backups, root } = await fixture()
  const path = join(home, 'state.db')
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (n INTEGER); INSERT INTO records VALUES (1);')
    assert.ok((await stat(`${path}-wal`)).size > 0)
    const saved = await makeBackup({ home, backups, commit: 'test' })
    const manifest = (await validateArchive(backups, saved.name)).manifest
    assert.equal(manifest.files.find(file => file.name === 'state.db')?.sqlite, true)
    assert.equal(manifest.files.some(file => /^state\.db-(?:wal|shm)$/.test(file.name)), false)
    const staging = await mkdtemp(join(root, 'sqlite-restore-'))
    const extracted = await extractArchive(backups, saved.name, staging)
    const restored = new DatabaseSync(join(extracted, 'state.db'))
    try { assert.deepEqual(restored.prepare('SELECT n FROM records ORDER BY n').all().map(row => row.n), [1]) }
    finally { restored.close() }
    db.exec('INSERT INTO records VALUES (2)')
    await performRestore({ home, backups, name: saved.name })
    const after = new DatabaseSync(join(home, 'state.db'))
    try { assert.deepEqual(after.prepare('SELECT n FROM records ORDER BY n').all().map(row => row.n), [1]) }
    finally { after.close() }
  } finally { db.close() }
})

test('corrupt SQLite and orphan WAL abort backup without publishing an archive', async () => {
  const { home, backups } = await fixture()
  await writeFile(join(home, 'broken.sqlite'), 'not sqlite')
  await assert.rejects(makeBackup({ home, backups, commit: 'test' }), /no valid header/)
  assert.equal((await listBackups(backups)).length, 0)
})

test('backups sit beside the home, per variant; DEEPSEA_VARIANT and the configured directory win', () => {
  const root = join(tmpdir(), 'deepsea-root')
  assert.deepEqual(locations({ env: { DSH_HOME: join(root, 'personal') } }), { home: join(root, 'personal'), variant: 'personal', backups: join(root, '_backups', 'personal') })
  assert.equal(locations({ env: { DSH_HOME: join(root, 'personal'), DEEPSEA_VARIANT: 'release' } }).backups, join(root, '_backups', 'release'))
  assert.equal(locations({ env: { DSH_HOME: join(root, 'personal') }, directory: '~/elsewhere' }).backups, join(homedir(), 'elsewhere'))
  // Without DSH_HOME, the harness default home: ~/.deepsea/release.
  assert.deepEqual(locations({ env: {} }), { home: join(homedir(), '.deepsea', 'release'), variant: 'release', backups: join(homedir(), '.deepsea', '_backups', 'release') })
  // A home in the DeepSea root: its variant as @deepsea/logs names it.
  assert.equal(locations({ env: { DSH_HOME: join(root, 'preview'), DEEPSEA_ROOT: root } }).variant, 'preview')
})

test('the restore log goes to the variant\'s plugin log directory and names the run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepsea-backup-restore-root-'))
  const logRoot = await mkdtemp(join(tmpdir(), 'deepsea-backup-restore-logs-'))
  scratch.push(root, logRoot)
  const env = { DEEPSEA_ROOT: root, DEEPSEA_LOG_ROOT: logRoot }
  const run = openRestoreLog(join(root, 'personal-3f9a1c'), 'restore a.backup.deepsea.zip', env)
  await run.line('restored a.backup.deepsea.zip')
  const dir = join(logRoot, 'io.github.taliesinb.deepsea.personal-3f9a1c', 'plugins', 'backup-restore')
  assert.equal(run.path.startsWith(`${dir}/`), true)
  const lines = (await readFile(run.path, 'utf8')).trim().split('\n')
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d io\.github\.taliesinb\.deepsea\.personal-3f9a1c backup-restore restore worker pid \d+ restore a\.backup\.deepsea\.zip$/)
  assert.match(lines[1], / restored a\.backup\.deepsea\.zip$/)
  assert.equal(await readlink(join(dir, 'latest.log')), run.path.split('/').at(-1))
})

test('sockets in the home are left out of a backup', async () => {
  const { root, home, backups } = await fixture()
  const server = createServer()
  await new Promise(resolve => server.listen(join(home, 's.sock'), resolve))
  try {
    const saved = await makeBackup({ home, backups, commit: 'test' })
    const { manifest } = await validateArchive(backups, saved.name)
    assert.equal(manifest.files.some(file => file.name === 's.sock'), false)
    const extracted = await extractArchive(backups, saved.name, await mkdtemp(join(root, 'extract-')))
    assert.equal(await readFile(join(extracted, 'settings.yaml'), 'utf8'), 'original')
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('a restore leaves nothing beside the home but the home', async () => {
  const { root, home, backups } = await fixture()
  const saved = await makeBackup({ home, backups, commit: 'test' })
  await writeFile(join(home, 'settings.yaml'), 'changed')
  await performRestore({ home, backups, name: saved.name })
  assert.deepEqual((await readdir(root)).sort(), ['backups', 'home'])
})

test('restore reports selected ZIP and rollback metadata across the home swap', async () => {
  const { home, backups } = await fixture()
  const selected = await makeBackup({ home, backups, commit: 'test' })
  const rollback = await makeBackup({ home, backups, kind: 'rollback', commit: 'test' })
  const id = restoreId()
  await writeRestoreStatus(backups, id, {
    state: 'pending', selected: { name: selected.name, counts: selected.counts, bytes: selected.bytes },
    rollback: { name: rollback.name, counts: rollback.counts, bytes: rollback.bytes },
  })
  await writeFile(join(home, 'settings.yaml'), 'changed')
  await performRestore({ home, backups, name: selected.name, rollback: rollback.name, id })
  const result = await readRestoreStatus(backups, id)
  assert.equal(result.state, 'restored')
  assert.equal(result.selected.name, selected.name)
  assert.equal(result.selected.bytes, selected.bytes)
  assert.equal(result.rollback.name, rollback.name)
  assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), 'original')
})

test('restore failure reports rollback recovery without claiming selected backup was restored', async () => {
  const { home, backups } = await fixture()
  const rollback = await makeBackup({ home, backups, kind: 'rollback', commit: 'test' })
  const id = restoreId()
  await writeRestoreStatus(backups, id, { state: 'pending', selected: { name: 'missing.backup.deepsea.zip', counts: {}, bytes: 0 }, rollback: { name: rollback.name, counts: rollback.counts, bytes: rollback.bytes } })
  await writeFile(join(home, 'settings.yaml'), 'changed')
  await assert.rejects(performRestore({ home, backups, name: 'missing.backup.deepsea.zip', rollback: rollback.name, id }))
  const result = await readRestoreStatus(backups, id)
  assert.equal(result.state, 'rolled-back')
  assert.match(result.error, /ENOENT/)
  assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), 'original')
})
