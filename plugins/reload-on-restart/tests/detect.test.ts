// node --test: the decision and the wrapper against a fake ctx.modules.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classify, graphRows } from '../src/client/detect.ts'
import { install } from '../src/client/index.ts'

// Revs as the host makes them: 12 hex digits of a bundle file's metadata hash.
const boot = [
  { id: '@deepseek-ai/dsh-typert-registry', rev: '3b1f0c9e7a42' },
  { id: '@deepseek-ai/dsh-api-gateway', rev: '9d02e6b4c1f8' },
  { id: '@deepsea/settings-shortcut', rev: 'c7a5e1d03b96' },
]
const known = () => new Map(boot.map(row => [row.id, row.rev]))
const graph = (entries: unknown) => ({ rev: '0f1e2d3c4b5a', entries, batches: [] })
const rebuiltAll = () => boot.map((row, i) => ({ id: row.id, rev: `e0e0e0e0e0e${String(i)}` }))

test('graphRows reads {entries:[{id,rev}]} and ignores anything else', () => {
  assert.deepEqual(graphRows(graph([...boot, { id: 3 }, null, { id: 'x' }])), boot)
  assert.deepEqual(graphRows(undefined), [])
  assert.deepEqual(graphRows({ entries: 'nope' }), [])
})

test('the same graph (the first frame after boot, or a restart on the same files) is unchanged', () => {
  assert.deepEqual(classify(known(), boot), { kind: 'unchanged', common: 3 })
})

test('every rev new at once is a restart on new code', () => {
  assert.deepEqual(classify(known(), rebuiltAll()), { kind: 'restart', changed: 3 })
})

test('one rebuilt bundle is partial, not a restart', () => {
  const rows = boot.map(row => row.id === '@deepsea/settings-shortcut' ? { ...row, rev: '5a5a5a5a5a5a' } : row)
  assert.deepEqual(classify(known(), rows), { kind: 'partial', changed: 1, common: 3 })
})

test('rows only added or removed leave the verdict unchanged', () => {
  assert.deepEqual(classify(known(), [...boot, { id: '@deepsea/phone-ui', rev: '1234567890ab' }]), { kind: 'unchanged', common: 3 })
  assert.deepEqual(classify(known(), boot.slice(0, 2)), { kind: 'unchanged', common: 2 })
})

test('no rows in common is unrelated, never a reload', () => {
  assert.deepEqual(classify(known(), [{ id: 'other', rev: 'z' }]), { kind: 'unrelated' })
  assert.deepEqual(classify(new Map(), boot), { kind: 'unrelated' })
})

function fakeModules() {
  const calls: string[] = []
  const entries = {
    async sync(_graph: unknown) { calls.push('sync') },
    async reload(id: string, rev: string) { calls.push(`reload ${id} ${rev}`) },
  }
  return { modules: { manifest: { modules: boot }, entries }, calls, entries }
}

test('install: a restart frame reloads the page once and never reaches entries.sync', async () => {
  const { modules, calls } = fakeModules()
  let reloads = 0
  const warn = console.warn
  const warnings: string[] = []
  console.warn = (message: string) => { warnings.push(message) }
  try {
    install(modules, () => { reloads += 1 })
    await modules.entries.sync(graph(rebuiltAll()))
    await modules.entries.sync(graph(rebuiltAll()))
  } finally {
    console.warn = warn
  }
  assert.equal(reloads, 1)
  assert.deepEqual(calls, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^\[deepsea-reload-on-restart\] every client bundle changed revision \(3\)/)
})

test('install: unchanged and partial frames pass through and keep the table current', async () => {
  const { modules, calls, entries } = fakeModules()
  let reloads = 0
  const info = console.info
  console.info = () => {}
  try {
    const installed = install(modules, () => { reloads += 1 })
    await modules.entries.sync(graph(boot))
    const partial = boot.map(row => row.id === '@deepsea/settings-shortcut' ? { ...row, rev: '5a5a5a5a5a5a' } : row)
    await modules.entries.sync(graph(partial))
    assert.equal(installed.known.get('@deepsea/settings-shortcut'), '5a5a5a5a5a5a')
    // The same rows again are unchanged now, not a restart.
    await modules.entries.sync(graph(partial))
    assert.equal(reloads, 0)
    assert.deepEqual(calls, ['sync', 'sync', 'sync'])
    // A rebuilt frame keeps the table current too.
    await modules.entries.reload('@deepseek-ai/dsh-api-gateway', '6b6b6b6b6b6b')
    assert.equal(installed.known.get('@deepseek-ai/dsh-api-gateway'), '6b6b6b6b6b6b')
    assert.equal(calls.at(-1), 'reload @deepseek-ai/dsh-api-gateway 6b6b6b6b6b6b')
    installed.dispose()
    assert.equal(typeof entries.sync, 'function')
    await modules.entries.sync(graph(boot.map(row => ({ ...row, rev: 'ffffffffffff' }))))
    assert.equal(reloads, 0, 'after dispose the wrapper is gone')
    assert.equal(calls.at(-1), 'sync')
  } finally {
    console.info = info
  }
})

test('install: every row rebuilt one by one is hot reload throughout, never a restart', async () => {
  const { modules } = fakeModules()
  let reloads = 0
  const installed = install(modules, () => { reloads += 1 })
  // The host announces each rebuild with a rebuilt frame, then the whole graph.
  const current = boot.map(row => ({ ...row }))
  for (const [i, row] of rebuiltAll().entries()) {
    current[i] = row
    await modules.entries.reload(row.id, row.rev)
    await modules.entries.sync(graph(current.map(r => ({ ...r }))))
  }
  assert.equal(reloads, 0)
  assert.deepEqual([...installed.known.values()], rebuiltAll().map(row => row.rev))
})
