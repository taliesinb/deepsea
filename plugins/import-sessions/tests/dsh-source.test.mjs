import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareDshSelection, samePath, scanDshSelection } from '../host/dsh-source.mjs'
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

test('a backup archive is read from its dsh/sessions/', async () => {
  const source = await dshHome()
  const stage = scratch('zip-stage')
  mkdirSync(join(stage, 'dsh'))
  cpSync(join(source.home, 'sessions'), join(stage, 'dsh', 'sessions'), { recursive: true })
  writeFileSync(join(stage, 'dsh-backup.json'), JSON.stringify({ format: 'dsh-home-v1', counts: {}, files: [] }))
  const zip = join(scratch('zip'), 'y2026m10d09h12m00s00.hexample.fabc123.p0.w1.s1.backup.dsh.zip')
  execFileSync('zip', ['-q', '-r', zip, 'dsh-backup.json', 'dsh'], { cwd: stage })
  const scan = await scanDshSelection(zip, elsewhere)
  assert.equal(scan.kind, 'root')
  assert.equal(scan.selection.archive, true)
  assert.deepEqual(scan.workspaces.flatMap(group => group.sessions).map(session => session.id), [source.id])
  await scan.selection.cleanup()
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
