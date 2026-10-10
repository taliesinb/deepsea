import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { filterSessionPickerItems, relativeSessionAge, sessionLabelSegments, sessionPickerItems } from '../src/client/catalog.ts'
import { encodeSessionReferenceUri, formatSessionReferenceMention } from '../src/client/mention.ts'

const retainedBy = {}
const sessions = {
  ids: ['current', 'recent', 'older', 'child', 'blank', 'archived', 'loose'],
  byId: {
    current: row('current', 'Current', 100),
    recent: row('recent', 'Foo Release', 90),
    older: row('older', 'Bar Design', 20),
    child: { ...row('child', 'Research worker', 99), origin: 'subagent' as const },
    blank: { ...row('blank', 'Blank', 98), blank: true },
    archived: row('archived', 'Archived', 97),
    loose: { ...row('loose', 'Loose Run', 50), cwd: '/tmp/unregistered-work' },
  },
  phase: 'ready' as const,
  subagentsByParent: {},
  jobsBySession: {},
} as unknown as SessionListState

const workspaces = {
  items: [
    { workspaceId: 'w1', title: 'Foo Workspace', path: '/foo', sessionIds: ['current', 'recent'], createdAt: '', updatedAt: '' },
    { workspaceId: 'w2', title: 'Other', path: '/other', sessionIds: ['older', 'child', 'blank', 'archived'], createdAt: '', updatedAt: '' },
  ],
  archivedSessionIds: ['archived'],
  state: 'idle', phase: 'ready', error: null,
} as unknown as WorkspaceSnapshot

function row(id: string, displayTitle: string, updatedAt: number) {
  return { id, displayTitle, running: false, retainedBy, blank: false, updatedAt }
}

test('catalog excludes current, subagent, blank, and archived sessions and sorts by recency', () => {
  assert.deepEqual(sessionPickerItems(sessions, workspaces, 'current').map(item => item.qualifiedName), [
    'Foo Workspace/Foo Release',
    'unregistered-work/Loose Run',
    'Other/Bar Design',
  ])
})

test('filter supports full qualified substring and split workspace/session matching', () => {
  const items = sessionPickerItems(sessions, workspaces, 'current')
  assert.deepEqual(filterSessionPickerItems(items, 'foo').map(item => item.sessionId), ['recent'])
  assert.deepEqual(filterSessionPickerItems(items, 'other/bar').map(item => item.sessionId), ['older'])
  assert.deepEqual(filterSessionPickerItems(items, '/run').map(item => item.sessionId), ['loose'])
  assert.deepEqual(filterSessionPickerItems(items, 'foo/').map(item => item.sessionId), ['recent'])
})

test('label segments read workspace / session with a quiet separator', () => {
  assert.deepEqual(sessionLabelSegments('Foo Workspace', 'Foo Release'), [
    { text: 'Foo Workspace' },
    { text: ' / ', dim: true },
    { text: 'Foo Release' },
  ])
})

test('relative age labels use the compact vocabulary of the @ picker', () => {
  const now = 1_000_000_000
  assert.equal(relativeSessionAge(now - 10_000, now), 'now')
  assert.equal(relativeSessionAge(now - 2 * 60_000, now), '2min')
  assert.equal(relativeSessionAge(now - 4 * 60 * 60_000, now), '4h')
  assert.equal(relativeSessionAge(now - 3 * 24 * 60 * 60_000, now), '3d')
})

test('mention uses the canonical browser-safe dsh-session encoding and escaped label', () => {
  assert.equal(encodeSessionReferenceUri('ordinary'), 'dsh-session:Im9yZGluYXJ5Ig')
  assert.equal(formatSessionReferenceMention('ordinary', 'Foo]/Run'), '@[Foo\\]/Run](dsh-session:Im9yZGluYXJ5Ig)')
})
