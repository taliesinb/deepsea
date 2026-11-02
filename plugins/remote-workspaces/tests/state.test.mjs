import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { loadState, normalizeState, routeIdFor, saveState, stateFileOf } from '../state.mjs'

describe('state', () => {
  it('lives under the home\'s plugins/remote-workspaces/', () => {
    assert.equal(stateFileOf('/h'), '/h/plugins/remote-workspaces/workspaces.json')
  })

  it('normalizes servers and workspaces, dropping orphans and junk', () => {
    const state = normalizeState({
      servers: [{ id: 'studio', url: 'https://studio.example.ts.net/deepsea/', label: 'Studio', token: 't1' }, { id: 'BAD ID', url: 'x' }, { id: 'studio', url: 'dup' }],
      workspaces: [
        { id: 'w1', serverId: 'studio', remoteWorkspaceId: 'ws-1', title: 'thing', remotePath: '/p', remoteTitle: 'thing', order: 2,
          cache: { sessions: [{ id: 's1', title: 'A', updatedAt: '2026-01-01T00:00:00.000Z', running: true }, { nope: 1 }], polledAt: '2026-01-02T00:00:00.000Z', gone: true } },
        { id: 'w2', serverId: 'missing', remoteWorkspaceId: 'ws-2' },
      ],
    })
    assert.equal(state.servers.length, 1)
    assert.deepEqual(state.servers[0], { id: 'studio', url: 'https://studio.example.ts.net/deepsea/', label: 'Studio', token: 't1', lastUsedAt: undefined })
    assert.equal(state.workspaces.length, 1)
    assert.deepEqual(state.workspaces[0].cache, { sessions: [{ id: 's1', title: 'A', updatedAt: '2026-01-01T00:00:00.000Z', running: true }], polledAt: '2026-01-02T00:00:00.000Z', gone: true })
    assert.equal(state.workspaces[0].remoteTitle, 'thing')
  })

  it('derives unique url-safe route ids', () => {
    assert.equal(routeIdFor('Studio Lab'), 'studio-lab')
    assert.equal(routeIdFor('studio-lab', new Set(['studio-lab'])), 'studio-lab-2')
    assert.equal(routeIdFor('***'), 'remote')
    assert.equal(routeIdFor('127.0.0.1'), '127-0-0-1')
  })

  it('round-trips through a 0600 file in a 0700 directory and treats a missing file as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepsea-remote-workspaces-state-'))
    try {
      const file = stateFileOf(root)
      assert.deepEqual(await loadState(file), { version: 1, servers: [], workspaces: [] })
      await saveState(file, { servers: [{ id: 'a', url: 'http://h/' }], workspaces: [] })
      assert.equal(((await stat(file)).mode & 0o777), 0o600)
      assert.equal(((await stat(dirname(file))).mode & 0o777), 0o700)
      const loaded = await loadState(file)
      assert.equal(loaded.servers[0].url, 'http://h/')
      assert.ok((await readFile(file, 'utf8')).endsWith('\n'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
