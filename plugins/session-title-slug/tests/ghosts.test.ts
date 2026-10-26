import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveGhosts, draftText } from '../src/client/ghosts.ts'

const workspaces = [
  { workspaceId: 'w1', path: '/w1', sessionIds: ['blank-a', 'real'] },
  { workspaceId: 'w2', path: '/w2', sessionIds: [] },
]

test('a blank, non-current session with a draft gets a ghost under its workspace', () => {
  const drafts: Record<string, string> = { 'blank-a': 'fix-login: x', 'blank-b': 'plain words', 'blank-c': '   ', current: 'mine: y' }
  const ghosts = deriveGhosts({
    sessions: [
      { id: 'blank-a', blank: true },
      { id: 'blank-b', blank: true, cwd: '/w2' },
      { id: 'blank-c', blank: true, cwd: '/w2' },
      { id: 'current', blank: true, cwd: '/w1' },
      { id: 'real', blank: false },
      { id: 'lost', blank: true, cwd: '/elsewhere' },
    ],
    current: 'current',
    workspaces,
  }, id => drafts[id] ?? 'lost: z', 'New Session')
  assert.deepEqual(ghosts, [
    { sessionId: 'blank-a', workspaceId: 'w1', label: 'fix-login' },
    { sessionId: 'blank-b', workspaceId: 'w2', label: 'New Session' },
  ])
})

test('draftText reads a plain or a structured draft', () => {
  assert.equal(draftText('hello'), 'hello')
  assert.equal(draftText({ text: 'with chips', references: [] }), 'with chips')
  assert.equal(draftText(null), '')
  assert.equal(draftText({ references: [] }), '')
})
