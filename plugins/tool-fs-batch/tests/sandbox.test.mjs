// edit_many and the sandbox: every target is checked against the decision its
// write will meet during validation, so a refused path is reported with the
// call's other problems and nothing is written; the backend's fence at write
// time stays, and a refusal there names what was already written.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { Config } from '../index.js'
import { build, fakeCtx, fakeExec, outsideDir, textOf } from './fake-ctx.mjs'

const root = mkdtempSync(join(tmpdir(), 'deepsea-tool-fs-batch-sandbox-'))
const outside = outsideDir()
after(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const A = 'alpha one\n'
const B = 'beta two\n'
const C = 'gamma three\n'
const at = (name) => join(root, name)
const out = (name) => join(outside, name)
const read = (p) => readFileSync(p, 'utf8')
beforeEach(() => {
  mkdirSync(root, { recursive: true })
  writeFileSync(at('a.txt'), A)
  writeFileSync(at('b.txt'), B)
  writeFileSync(at('c.txt'), C)
  writeFileSync(out('b.txt'), B)
  rmSync(out('new'), { recursive: true, force: true })
})

let sessions = 0
/** Fresh tools and session, without the read-before-edit policy (the sandbox is the subject here). */
function setup(opts = {}) {
  const ctx = fakeCtx({ workspaceRoot: root, withPolicy: false, ...opts })
  const tools = build(ctx, Config({}))
  const tool = (name) => tools.find(t => t.name === name)
  const exec = fakeExec(`session-sandbox-${++sessions}`, root)
  const run = (args) => tool('edit_many').execute(args, exec)
  return { ctx, tool, run }
}
const untouched = () => {
  assert.equal(read(at('a.txt')), A)
  assert.equal(read(at('b.txt')), B)
  assert.equal(read(at('c.txt')), C)
  assert.equal(read(out('b.txt')), B)
}

test('workspace-write: the second of three entries outside the writable roots is refused at validation; nothing written', async () => {
  const { run } = setup()
  await assert.rejects(run({ edits: [
    { file_path: 'a.txt', old_string: 'one', new_string: '1' },
    { file_path: out('b.txt'), old_string: 'two', new_string: '2' },
    { file_path: 'c.txt', op: 'append', new_string: 'more' },
  ] }), (e) => {
    assert.equal(e.code, 'FS_SANDBOX_DENIED')
    assert.match(e.message, /^edit_many: 1 problem, nothing written:\n {2}#2 \S+b\.txt: \[sandbox: file access denied under workspace-write mode\] outside the writable roots\n/)
    assert.match(e.message, /For a one-off escalation use the built-in edit\/write tool with sandbox_permissions\.$/)
    assert.doesNotMatch(e.message, /stopped at|Already written/)
    return true
  })
  untouched()
})

test('read-only: every file is refused once, at its first entry; nothing written', async () => {
  const { run } = setup({ mode: 'read-only' })
  await assert.rejects(run({ edits: [
    { file_path: 'a.txt', old_string: 'one', new_string: '1' },
    { file_path: 'b.txt', old_string: 'two', new_string: '2' },
    { file_path: 'a.txt', op: 'append', new_string: 'more' },
  ] }), (e) => {
    assert.equal(e.code, 'FS_SANDBOX_DENIED')
    assert.match(e.message, /^edit_many: 2 problems, nothing written:\n {2}#1 \S+a\.txt: \[sandbox: file access denied under read-only mode\] read-only mode allows no file writes\n {2}#2 \S+b\.txt: \[sandbox: file access denied under read-only mode\] read-only mode allows no file writes\n/)
    assert.doesNotMatch(e.message, /#3/)
    return true
  })
  untouched()
})

test('a refused create between two allowed entries: no file, no parent directory, nothing else written', async () => {
  const { run } = setup()
  await assert.rejects(run({ edits: [
    { file_path: 'a.txt', old_string: 'one', new_string: '1' },
    { file_path: out('new/deep/n.txt'), op: 'create', new_string: 'x' },
    { file_path: 'new-inside.txt', op: 'create', new_string: 'y' },
  ] }), (e) => { assert.equal(e.code, 'FS_SANDBOX_DENIED'); assert.match(e.message, /#2 \S+n\.txt: \[sandbox: file access denied under workspace-write mode\]/); return true })
  untouched()
  assert.equal(existsSync(out('new')), false)
  assert.equal(existsSync(at('new-inside.txt')), false)
})

test('a refusal is reported together with the other validation problems, in entry order', async () => {
  const { run } = setup()
  await assert.rejects(run({ edits: [
    { file_path: 'a.txt', old_string: 'NOPE', new_string: 'x' },
    { file_path: out('b.txt'), old_string: 'two', new_string: '2' },
    { file_path: 'c.txt', op: 'create', new_string: 'overwrite?' },
    { file_path: 'b.txt', old_string: 'two' },
    { file_path: out('b.txt'), old_string: 'MISSING', new_string: 'x' },
  ] }), (e) => {
    assert.equal(e.code, 'EDIT_MANY_INVALID')
    assert.match(e.message, /^edit_many: 5 problems, nothing written:/)
    const tags = [...e.message.matchAll(/^ {2}#(\d) /gm)].map(m => Number(m[1]))
    assert.deepEqual(tags, [1, 2, 3, 4, 5])
    assert.match(e.message, /#1 \S+a\.txt: old_string not found/)
    assert.match(e.message, /#2 \S+b\.txt: \[sandbox: file access denied under workspace-write mode\] outside the writable roots/)
    assert.match(e.message, /#3 \S+c\.txt: already exists/)
    assert.match(e.message, /#4 b\.txt: new_string is required/)
    // the refused file's later entry is still validated (once refused is enough)
    assert.match(e.message, /#5 \S+b\.txt: old_string not found/)
    assert.equal(e.message.match(/\[sandbox:/g).length, 1)
    assert.match(e.message, /sandbox_permissions\.$/)
    return true
  })
  untouched()
})

test('dry_run reports a refusal like any other problem', async () => {
  const { run } = setup()
  await assert.rejects(run({ dry_run: true, edits: [{ file_path: out('b.txt'), op: 'append', new_string: 'x' }] }),
    (e) => { assert.equal(e.code, 'FS_SANDBOX_DENIED'); assert.match(e.message, /#1 \S+b\.txt: \[sandbox:/); return true })
  untouched()
})

test('a refusal only at write time (the policy changed after validation) names the entries and files already written', async () => {
  const { ctx, run } = setup()
  ctx.refuseAtWrite.add(at('b.txt'))
  await assert.rejects(run({ edits: [
    { file_path: 'a.txt', old_string: 'one', new_string: '1' },
    { file_path: 'a.txt', op: 'append', new_string: 'more' },
    { file_path: 'b.txt', old_string: 'two', new_string: '2' },
    { file_path: 'c.txt', op: 'append', new_string: 'more' },
  ] }), (e) => {
    assert.equal(e.code, 'FS_SANDBOX_DENIED')
    assert.match(e.message, /^edit_many stopped at edit #3: \[sandbox: file access denied under workspace-write mode\] "\S+b\.txt": outside the writable roots\./)
    assert.match(e.message, /\nAlready written, kept \(not rolled back\): #1 \S+a\.txt:1, #2 \S+a\.txt:2 — 1 file changed: \S+a\.txt\. Not applied: #3, #4\.$/)
    return true
  })
  assert.equal(read(at('a.txt')), 'alpha 1\nmore\n')
  assert.equal(read(at('b.txt')), B)
  assert.equal(read(at('c.txt')), C)
})

test('a refusal at the first write says nothing was written', async () => {
  const { ctx, run } = setup()
  ctx.refuseAtWrite.add(at('a.txt'))
  await assert.rejects(run({ edits: [
    { file_path: 'a.txt', old_string: 'one', new_string: '1' },
    { file_path: 'b.txt', old_string: 'two', new_string: '2' },
  ] }), /\nNothing was written\. Not applied: #1, #2\.$/)
  untouched()
})

test('danger-full-access, and a backend that never confines: no refusal, the outside write goes through', async () => {
  for (const opts of [{ mode: 'danger-full-access' }, { confining: false }]) {
    const { run } = setup(opts)
    await run({ edits: [{ file_path: out('b.txt'), old_string: 'two', new_string: '2' }] })
    assert.equal(read(out('b.txt')), 'beta 2\n')
    writeFileSync(out('b.txt'), B)
  }
})

for (const [label, checkWrite] of [['a backend that cannot decide (checkWrite answers unknown)', 'unknown'], ['a harness without ctx.fs.checkWrite', false]]) {
  test(`${label}: left to the write, which still refuses and names what was written`, async () => {
    const { run } = setup({ checkWrite })
    await assert.rejects(run({ edits: [
      { file_path: 'a.txt', old_string: 'one', new_string: '1' },
      { file_path: out('b.txt'), old_string: 'two', new_string: '2' },
    ] }), (e) => { assert.equal(e.code, 'FS_SANDBOX_DENIED'); assert.match(e.message, /stopped at edit #2: .*\nAlready written, kept \(not rolled back\): #1 \S+a\.txt:1 — 1 file changed/s); return true })
    assert.equal(read(out('b.txt')), B)
    writeFileSync(at('a.txt'), A)
  })
}

test('the check asks ctx.fs.checkWrite once per file, with the policy and signal the writes carry', async () => {
  const { ctx, run } = setup()
  await run({ dry_run: true, edits: [
    { file_path: 'a.txt', old_string: 'one', new_string: '1' },
    { file_path: 'a.txt', op: 'append', new_string: 'more' },
    { file_path: 'made.txt', op: 'create', new_string: 'm' },
  ] })
  assert.deepEqual(ctx.checkWriteCalls, [
    { path: at('a.txt'), signal: undefined, policy: { mode: 'workspace-write', workspaceRoot: root } },
    { path: at('made.txt'), signal: undefined, policy: { mode: 'workspace-write', workspaceRoot: root } },
  ])
  untouched()
})

test('what the write would throw while deciding (an invalid extra root) is reported with its code; nothing written', async () => {
  const { ctx, run } = setup()
  const resolve = ctx.get('sandboxPolicy').resolve
  const original = ctx.get
  ctx.get = (name) => name === 'sandboxPolicy' ? { resolve: () => ({ ...resolve(), additionalWritableRoots: ['relative'] }) } : original(name)
  await assert.rejects(run({ edits: [{ file_path: 'a.txt', old_string: 'one', new_string: '1' }] }), (e) => {
    assert.equal(e.code, 'EDIT_MANY_INVALID')
    assert.match(e.message, /#1 \S+a\.txt: .*relative/)
    return true
  })
  untouched()
})

test('allowed writes inside the workspace pass the check and apply', async () => {
  const { tool, run } = setup()
  const args = { edits: [{ file_path: 'a.txt', old_string: 'one', new_string: '1' }, { file_path: 'made.txt', op: 'create', new_string: 'm' }] }
  assert.match(textOf(tool('edit_many'), args, await run(args)), /applied 2 edits in 2 files/)
  assert.equal(read(at('a.txt')), 'alpha 1\n')
  rmSync(at('made.txt'))
})
