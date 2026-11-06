import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { DestinationContribution, DestinationGroup } from '../src/client/face.ts'
import {
  activityLine, addContribution, answerFromHost, blockersFrom, contributedGroups, copyTitle, owningWorkspace, rehomeSummary,
  resolveDestination, runContributed, workspaceLabel,
} from '../src/client/model.ts'

const workspaces = [
  { workspaceId: 'w1', title: 'Alpha', path: '/p/alpha', sessionIds: ['s1'] },
  { workspaceId: 'w2', title: '', path: '/p/beta', sessionIds: [] },
]

const snapshot = <T>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} })

function contribution(id: string, groups: DestinationGroup[], run: DestinationContribution['run'] = async () => ({ ok: true }), order?: number): DestinationContribution {
  return { id, groups: snapshot(groups), run, ...(order === undefined ? {} : { order }) }
}

test('destinations resolve against the current lists and vanish when no longer offered', () => {
  const remote = contribution('r', [
    { id: 'host-a', label: 'Host A', entries: [{ key: 'x', title: 'X', path: '/x' }] },
    { id: 'empty', label: 'Empty', entries: [] },
  ])
  const groups = contributedGroups([remote])
  assert.deepEqual(groups.map(group => group.group.id), ['host-a'])
  assert.equal(resolveDestination(undefined, workspaces, groups), undefined)
  assert.deepEqual(resolveDestination({ kind: 'local', workspaceId: 'w2' }, workspaces, groups), { kind: 'local', workspace: workspaces[1] })
  assert.equal(resolveDestination({ kind: 'local', workspaceId: 'gone' }, workspaces, groups), undefined)
  assert.deepEqual(resolveDestination({ kind: 'path', path: '  /new  ' }, workspaces, groups), { kind: 'path', path: '/new' })
  assert.equal(resolveDestination({ kind: 'path', path: ' ' }, workspaces, groups), undefined)
  assert.equal(resolveDestination({ kind: 'external', groupId: 'host-a', key: 'x' }, workspaces, groups)?.kind, 'external')
  assert.equal(resolveDestination({ kind: 'external', groupId: 'host-a', key: 'y' }, workspaces, groups), undefined)
  assert.equal(owningWorkspace(workspaces, 's1')?.workspaceId, 'w1')
  assert.equal(workspaceLabel(workspaces[1]!), 'beta')
})

test('host answers: success, a live refusal with its work, and any other refusal', () => {
  assert.deepEqual(answerFromHost({ ok: true, value: { sessionId: 's', workspaceId: 'w' } }), { ok: true, sessionId: 's', workspaceId: 'w' })
  assert.deepEqual(
    answerFromHost({ ok: false, error: { code: 'session/move-live', message: 'busy', details: { blockers: [{ kind: 'job', items: [{ id: 'j', label: 'build' }] }] } } }),
    { ok: false, code: 'session/move-live', message: 'busy', blockers: [{ kind: 'job', items: [{ id: 'j', label: 'build' }] }] },
  )
  assert.deepEqual(answerFromHost({ ok: false, error: { code: 'session/move-missing', message: 'no' } }), { ok: false, code: 'session/move-missing', message: 'no' })
  assert.deepEqual(blockersFrom(undefined), [{ kind: 'turn' }])
  assert.deepEqual(blockersFrom({ blockers: [{ kind: 'turn' }, 7, null] }), [{ kind: 'turn' }])
})

test('activity lines name the work', () => {
  assert.equal(activityLine({ kind: 'turn' }), 'A turn in progress')
  assert.equal(activityLine({ kind: 'job', items: [{ id: 'j1', label: 'build' }] }), 'A background job: build')
  assert.equal(activityLine({ kind: 'subagent', items: [{ id: 'a' }, { id: 'b', label: 'Explorer' }] }), 'Subagents: a, Explorer')
  assert.equal(activityLine({ kind: 'mystery' }), 'mystery')
})

test('a contributed destination runs through its contributor; refusals and failures become answers', async () => {
  const groups: DestinationGroup[] = [{ id: 'host-a', label: 'Host A', entries: [{ key: 'x', title: 'X' }] }]
  const requests: unknown[] = []
  const ok = contribution('r', groups, async (request) => { requests.push(request); return { ok: true, summary: 'Moved to X' } })
  const destination = resolveDestination({ kind: 'external', groupId: 'host-a', key: 'x' }, workspaces, contributedGroups([ok]))
  assert.ok(destination?.kind === 'external')
  const base = { action: 'move' as const, sessionId: 's1', sourceTitle: 'T', notify: true }
  assert.deepEqual(await runContributed([ok], destination, base), { ok: true, summary: 'Moved to X' })
  assert.deepEqual(requests, [{ ...base, groupId: 'host-a', destinationKey: 'x' }])
  const live = contribution('r', groups, async () => ({ ok: false, code: 'session/copy-live', message: 'running' }))
  assert.deepEqual(await runContributed([live], destination, base), { ok: false, code: 'session/copy-live', message: 'running', blockers: [{ kind: 'turn' }] })
  const thrown = contribution('r', groups, async () => { throw new Error('offline') })
  assert.deepEqual(await runContributed([thrown], destination, base), { ok: false, code: 'deepsea-session-move/destination-failed', message: 'offline' })
  assert.equal((await runContributed([], destination, base)).ok, false)
})

test('contributions are unique and ordered; titles and summaries read as written', () => {
  const a = contribution('a', [], undefined, 10)
  const b = contribution('b', [], undefined, 1)
  assert.deepEqual(addContribution(addContribution([], a), b).map(c => c.id), ['b', 'a'])
  assert.throws(() => addContribution([a], contribution('a', [])), /duplicate/)
  assert.equal(copyTitle('Plan'), 'Plan (copy)')
  assert.equal(copyTitle(''), '')
  assert.equal(rehomeSummary(1, []), 'Moved 1 session.')
  assert.equal(rehomeSummary(3, [{ reason: 'missing' }]), 'Moved 3 sessions, skipped 1.')
  assert.equal(rehomeSummary(2, [{ reason: 'live' }, { reason: 'error' }]), 'Moved 2 sessions, skipped 2 (1 with work in flight, not interrupted).')
})
