/**
 * The browser half's pure parts: the `deepseaRemoteWorkspaces` service as
 * numbered-switching reads it, the row identity it parses, the framed
 * drafts and the slug convention.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFace, SERVICE, type FaceModel } from '../src/client/face.ts'
import { framedDraftOf, slugConvention } from '../src/client/drafts.ts'
import { NEW_SESSION_LABEL, workspaceLabel } from '../src/client/labels.ts'
import type { RemoteWorkspace } from '../src/client/api.ts'
import type { RuntimeState, ViewState } from '../src/client/store.ts'

function store<T>(value: T) {
  const listeners = new Set<() => void>()
  return {
    value,
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of listeners) listener() },
    listeners,
  }
}

function workspace(id: string, cache: RemoteWorkspace['cache']): RemoteWorkspace {
  return { id, serverId: 'studio', remoteWorkspaceId: `remote-${id}`, title: id, remotePath: `/p/${id}`, createdAt: '2026-01-01T00:00:00.000Z', order: 0, cache }
}

function model(view: ViewState, runtime: Pick<RuntimeState, 'loaded' | 'snapshot'>) {
  const viewStore = store(view)
  const runtimeStore = store(runtime)
  const face: FaceModel = {
    view: viewStore,
    runtime: runtimeStore,
    workspace: id => runtimeStore.getSnapshot().snapshot?.workspaces.find(candidate => candidate.id === id),
  }
  return { face, viewStore, runtimeStore }
}

test('the service name is the contract numbered-switching injects', () => {
  assert.equal(SERVICE, 'deepseaRemoteWorkspaces')
})

test('getSelection is the remote session on screen, undefined while a local view shows', () => {
  const selected = { workspaceId: 'rws-a', sessionId: 'session-1' }
  const { face, viewStore } = model({ expanded: {}, selected, remoteActive: true }, { loaded: true, snapshot: undefined })
  const service = createFace(face, () => {})
  assert.deepEqual(service.getSelection(), selected)
  viewStore.set({ expanded: {}, selected, remoteActive: false })
  assert.equal(service.getSelection(), undefined)
})

test('has: unknown is not gone; false only on positive evidence', () => {
  const polled = workspace('rws-a', { sessions: [{ id: 'session-1', title: 'one' }], blankIds: ['session-blank'], polledAt: '2026-01-02T00:00:00.000Z' })
  const unpolled = workspace('rws-b', { sessions: [] })
  const gone = workspace('rws-c', { sessions: [{ id: 'session-9', title: 'x' }], gone: true })
  const before = createFace(model({ expanded: {} }, { loaded: false, snapshot: undefined }).face, () => {})
  assert.equal(before.has({ workspaceId: 'rws-zzz', sessionId: 'session-1' }), true, 'before the first snapshot')
  const { face } = model({ expanded: {}, selected: { workspaceId: 'rws-a', sessionId: 'session-new' } }, {
    loaded: true, snapshot: { servers: [], workspaces: [polled, unpolled, gone] },
  })
  const service = createFace(face, () => {})
  assert.equal(service.has({ workspaceId: 'rws-a', sessionId: 'session-1' }), true, 'listed')
  assert.equal(service.has({ workspaceId: 'rws-a', sessionId: 'session-blank' }), true, 'a known blank')
  assert.equal(service.has({ workspaceId: 'rws-a', sessionId: 'session-new' }), true, 'the selection itself')
  assert.equal(service.has({ workspaceId: 'rws-a', sessionId: 'session-2' }), false, 'fetched and not listed')
  assert.equal(service.has({ workspaceId: 'rws-b', sessionId: 'session-2' }), true, 'never polled')
  assert.equal(service.has({ workspaceId: 'rws-c', sessionId: 'session-9' }), false, 'workspace gone on the remote')
  assert.equal(service.has({ workspaceId: 'rws-x', sessionId: 'session-1' }), false, 'workspace no longer in the sidebar')
})

test('open is what a row click does; subscribe follows both stores and unsubscribes from both', () => {
  const opened: unknown[] = []
  const { face, viewStore, runtimeStore } = model({ expanded: {} }, { loaded: true, snapshot: undefined })
  const service = createFace(face, selection => opened.push(selection))
  service.open({ workspaceId: 'rws-a', sessionId: 'session-1' })
  assert.deepEqual(opened, [{ workspaceId: 'rws-a', sessionId: 'session-1' }])
  let calls = 0
  const stop = service.subscribe(() => { calls += 1 })
  viewStore.set({ expanded: { x: true } })
  runtimeStore.set({ loaded: true, snapshot: { servers: [], workspaces: [] } })
  assert.equal(calls, 2)
  stop()
  assert.equal(viewStore.listeners.size + runtimeStore.listeners.size, 0)
})

test('row identity: `<workspaceId>:<sessionId>` with no colon in either id, so a last-colon split recovers both', () => {
  // Workspace ids are `rws-<base64url>` (state.mjs generateId), session ids `session-<uuid>`.
  const value = 'rws-Ab_9-xY:session-0f8e7d6c-1234-4abc-9def-001122334455'
  const cut = value.lastIndexOf(':')
  assert.deepEqual([value.slice(0, cut), value.slice(cut + 1)], ['rws-Ab_9-xY', 'session-0f8e7d6c-1234-4abc-9def-001122334455'])
})

test('framedDraftOf reads the embedded page\'s namespaced draft, string or structured', () => {
  const items = new Map<string, string>([
    ['embed:session-1:dsh.conversation.session-1', JSON.stringify({ draft: 'fix-it: now', view: null })],
    ['embed:session-2:dsh.conversation.session-2', JSON.stringify({ draft: { text: 'tidy-up: go', references: [] } })],
    ['embed:session-3:dsh.conversation.session-3', 'not json'],
    ['dsh.conversation.session-4', JSON.stringify({ draft: 'outer page' })],
  ])
  const storage = { getItem: (key: string) => items.get(key) ?? null }
  assert.equal(framedDraftOf('session-1', storage), 'fix-it: now')
  assert.equal(framedDraftOf('session-2', storage), 'tidy-up: go')
  assert.equal(framedDraftOf('session-3', storage), '')
  assert.equal(framedDraftOf('session-4', storage), '', 'only the embedded page\'s namespace')
})

test('labels read like the shell\'s own', () => {
  assert.equal(NEW_SESSION_LABEL, 'New Session')
  assert.equal(workspaceLabel('default-workspace'), 'Default workspace')
  assert.equal(workspaceLabel('alpha'), 'alpha')
})

test('slugConvention reads __DEEPSEA_SESSION_TITLE_SLUG__ only when it has parseSlug', () => {
  assert.equal(slugConvention({}), undefined)
  assert.equal(slugConvention({ __DEEPSEA_SESSION_TITLE_SLUG__: {} }), undefined)
  const convention = { parseSlug: (text: string) => /^([a-z0-9-]+):\s/.exec(text)?.[1] }
  assert.equal(slugConvention({ __DEEPSEA_SESSION_TITLE_SLUG__: convention })?.parseSlug('fix-it: now'), 'fix-it')
})
