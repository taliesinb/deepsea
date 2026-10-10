import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, SOURCE_NAME, TRIGGER } from '../src/client/index.ts'
import { encodeSessionReferenceUri } from '../src/client/mention.ts'

function fakeContext() {
  const sources: any[] = []
  const effects: (() => void)[] = []
  const services: Record<string, unknown> = {
    inputTriggers: { registerSource: (source: unknown) => { sources.push(source); return () => { sources.splice(sources.indexOf(source), 1) } } },
    sessions: { list: { getSnapshot: () => ({
      ids: ['s-current', 's-other'],
      byId: {
        's-current': { id: 's-current', displayTitle: 'Current', blank: false, updatedAt: 2, retainedBy: {} },
        's-other': { id: 's-other', displayTitle: 'Other', blank: false, updatedAt: 1, retainedBy: {} },
      },
    }) } },
    workspaces: { list: { getSnapshot: () => ({
      items: [{ workspaceId: 'w', title: 'widgets', path: '/w', sessionIds: ['s-current', 's-other'] }],
      archivedSessionIds: [],
    }) } },
  }
  const ctx = {
    get: (name: string) => services[name],
    effect: (fn: () => () => void) => { effects.push(fn()) },
  }
  return { ctx, sources, dispose: () => { for (const d of effects) d() } }
}

test('registers one % source whose chips it owns', async () => {
  const { ctx, sources, dispose } = fakeContext()
  apply(ctx as never)
  assert.equal(sources.length, 1)
  const [source] = sources
  assert.equal(source.trigger, TRIGGER)
  assert.equal(source.name, SOURCE_NAME)
  const candidates = await source.candidates({ sessionId: 's-current' }, { query: '', signal: new AbortController().signal })
  assert.deepEqual(candidates.map((c: { name: string }) => c.name), ['widgets/Other'])
  assert.deepEqual(candidates[0].labelSegments, [{ text: 'widgets' }, { text: ' / ', dim: true }, { text: 'Other' }])
  const outcome = source.onPick({ candidate: candidates[0] })
  const mention = `@[widgets/Other](${encodeSessionReferenceUri('s-other')})`
  assert.deepEqual(outcome, { insert: { source: SOURCE_NAME, ref: mention, label: 'widgets/Other', appearance: 'session', clipboardText: mention } })
  assert.equal(await source.codec.serialize(mention), mention)
  assert.equal(source.onPick({ candidate: { value: 'not json' } }), undefined)
  dispose()
  assert.equal(sources.length, 0)
})

test('an aborted request lists nothing', async () => {
  const { ctx, sources } = fakeContext()
  apply(ctx as never)
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await sources[0].candidates({ sessionId: 's-current' }, { query: '', signal: controller.signal }), [])
})
