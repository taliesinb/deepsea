// edit_many op "create": a new file, never an overwrite, inside the batch's
// all-or-nothing validation, dry_run and verify; later entries may edit it.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Config, PROMPT_HINT } from '../index.js'
import { build, fakeCtx, fakeExec, outsideDir, textOf } from './fake-ctx.mjs'

const root = mkdtempSync(join(tmpdir(), 'deepsea-tool-fs-batch-create-'))
after(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(root, 'src/old.ts'), 'export const OLD = 1\n')

let sessions = 0
/** Fresh tools and a fresh session; the observation policy is on unless `withPolicy: false`. */
function setup(opts = {}) {
  const ctx = fakeCtx({ workspaceRoot: root, ...opts })
  const tools = build(ctx, Config({}))
  const tool = (name) => tools.find(t => t.name === name)
  const exec = fakeExec(`session-create-${++sessions}`, root)
  const run = (name, args) => tool(name).execute(args, exec)
  const text = async (name, args) => textOf(tool(name), args, await run(name, args))
  return { ctx, tool, run, text, exec }
}
const at = (name) => join(root, name)
const read = (name) => readFileSync(at(name), 'utf8')
const problems = (re) => (e) => { assert.equal(e.code, 'EDIT_MANY_INVALID'); assert.match(e.message, re); return true }

test('create: a new file with its parent directories; a missing final newline added; "" makes an empty file; needs no read', async () => {
  const { text } = setup()
  const out = await text('edit_many', { edits: [
    { file_path: 'new/deep/a.ts', op: 'create', new_string: 'export const A = 1\nexport const B = 2' },
    { file_path: 'new/empty/__init__.py', op: 'create', new_string: '' },
    { file_path: 'new/b.txt', op: 'create', new_string: 'b\n' },
  ] })
  assert.equal(read('new/deep/a.ts'), 'export const A = 1\nexport const B = 2\n')
  assert.equal(read('new/empty/__init__.py'), '')
  assert.equal(read('new/b.txt'), 'b\n')
  assert.match(out, /applied 3 edits in 3 files/)
  assert.match(out, /a\.ts: 1 edit \(create, 2 lines\)$/m)
  assert.match(out, /__init__\.py: 1 edit \(create, empty\)$/m)
  assert.doesNotMatch(out, /not read this session/)
})

test('create: refuses an existing file, directory, symlink and dangling symlink, reported with the other problems; nothing written', async () => {
  const { run } = setup()
  mkdirSync(at('adir'), { recursive: true })
  symlinkSync(at('src/old.ts'), at('link-ok'))
  symlinkSync(at('nowhere.txt'), at('link-dangling'))
  await assert.rejects(run('edit_many', { edits: [
    { file_path: 'fresh.txt', op: 'create', new_string: 'x' },
    { file_path: 'src/old.ts', op: 'create', new_string: 'overwrite?' },
    { file_path: 'adir', op: 'create', new_string: 'x' },
    { file_path: 'link-ok', op: 'create', new_string: 'x' },
    { file_path: 'link-dangling', op: 'create', new_string: 'x' },
    { file_path: 'src/old.ts', old_string: 'NOPE', new_string: 'x' },
  ] }), (e) => {
    problems(/^edit_many: 5 problems, nothing written/)(e)
    assert.match(e.message, /#2 \S+old\.ts: already exists \(a file\); create never overwrites/)
    assert.match(e.message, /#3 \S+adir: already exists \(a directory\)/)
    assert.match(e.message, /#4 \S+: already exists \(a file\)/)
    assert.match(e.message, /#5 \S+link-dangling: already exists \(a symbolic link to a missing target\)/)
    // a later entry on a path whose create failed is not checked against the file that is there
    assert.match(e.message, /#6 \S+old\.ts: not checked: the create in #2 failed/)
    return true
  })
  assert.equal(existsSync(at('fresh.txt')), false)
  assert.equal(read('src/old.ts'), 'export const OLD = 1\n')
  assert.equal(existsSync(at('nowhere.txt')), false)
})

test('create: a refused create of an unread file records no observation (the model never saw it)', async () => {
  const { run, text } = setup()
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'src/old.ts', op: 'create', new_string: 'x' }] }), /already exists/)
  // still unread: an edit goes through only on a unique anchor, and says the file was not read
  const out = await text('edit_many', { edits: [{ file_path: 'src/old.ts', old_string: 'OLD = 1', new_string: 'OLD = 2' }] })
  assert.match(out, /not read this session/)
  writeFileSync(at('src/old.ts'), 'export const OLD = 1\n')
})

test('a file observed absent (read_many) and created since by someone else is treated as changed since read, not "not found"', async () => {
  const { run, text } = setup()
  await run('read_many', { files: ['later.txt'] })
  writeFileSync(at('later.txt'), 'made by bash\n')
  const out = await text('edit_many', { edits: [{ file_path: 'later.txt', old_string: 'bash', new_string: 'hand' }] })
  assert.match(out, /file had changed since it was read; applied because every anchor matched uniquely/)
  assert.equal(read('later.txt'), 'made by hand\n')
})
test('create: two creates of the same path (any spelling) are an error', async () => {
  const { run } = setup()
  await assert.rejects(run('edit_many', { edits: [
    { file_path: 'twice.txt', op: 'create', new_string: 'one' },
    { file_path: 'src/../twice.txt', op: 'create', new_string: 'two' },
  ] }), problems(/#2 \S+twice\.txt: #1 already creates this file in this call/))
  assert.equal(existsSync(at('twice.txt')), false)
})

test('create: all-or-nothing — a problem in another entry means no file and no parent directory', async () => {
  const { run } = setup()
  await assert.rejects(run('edit_many', { edits: [
    { file_path: 'aon/dir/new.ts', op: 'create', new_string: 'export {}' },
    { file_path: 'src/old.ts', old_string: 'MISSING', new_string: 'x' },
  ] }), problems(/1 problem, nothing written/))
  assert.equal(existsSync(at('aon')), false)
})

test('create: later entries edit the created text (and anchor problems in it say so); the observation lets a later call edit it', async () => {
  const { run, text } = setup()
  const out = await text('edit_many', { edits: [
    { file_path: 'chain.ts', op: 'create', new_string: 'import a\n\nexport const X = 1\n' },
    { file_path: 'chain.ts', op: 'insert_after', marker: 'import a', new_string: 'import b' },
    { file_path: 'chain.ts', old_string: 'X = 1', new_string: 'X = 2' },
    { file_path: 'chain.ts', op: 'append', new_string: 'export const Y = 3' },
  ] })
  assert.equal(read('chain.ts'), 'import a\nimport b\n\nexport const X = 2\nexport const Y = 3\n')
  assert.match(out, /chain\.ts: 4 edits \(create, 3 lines, insert_after line 2, line 4, append line 5\)/)
  // next call: observed at its created version, no "not read" note
  const next = await text('edit_many', { edits: [{ file_path: 'chain.ts', old_string: 'Y = 3', new_string: 'Y = 4' }] })
  assert.doesNotMatch(next, /not read/)
  // an anchor that is not in the created text
  await assert.rejects(run('edit_many', { edits: [
    { file_path: 'chain2.ts', op: 'create', new_string: 'one\n' },
    { file_path: 'chain2.ts', old_string: 'two', new_string: 'three' },
  ] }), problems(/#2 \S+chain2\.ts: old_string not found .*\[as edited by #1\]/))
  assert.equal(existsSync(at('chain2.ts')), false)
})

test('create: an edit of the path before its create is "not found" and says to put the create first; append points to create', async () => {
  const { run } = setup()
  await assert.rejects(run('edit_many', { edits: [
    { file_path: 'order.ts', op: 'append', new_string: 'x' },
    { file_path: 'order.ts', op: 'create', new_string: 'y' },
  ] }), problems(/#1 "\S+order\.ts": not found \(append needs an existing file; use op "create" for a new one\) \(#2 creates it later in this call; entries apply in order, so put the create first\)/))
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'missing.ts', op: 'append', new_string: 'x' }] }),
    problems(/not found \(append needs an existing file; use op "create" for a new one\)$/m))
  assert.equal(existsSync(at('order.ts')), false)
})

test('create: dry_run writes nothing and previews the new lines; verify is skipped there and runs after a real create', async () => {
  const { text } = setup()
  const dry = await text('edit_many', { dry_run: true, verify: { command: 'cat v.txt' }, edits: [{ file_path: 'v/v.txt', op: 'create', new_string: 'l1\nl2' }] })
  assert.equal(existsSync(at('v')), false)
  assert.match(dry, /Dry run: would apply 1 edit in 1 file/)
  assert.match(dry, /v\.txt after the edits \(> changed\):\n  > 1: l1\n  > 2: l2/)
  assert.match(dry, /verify skipped \(dry_run\)/)
  const empty = await text('edit_many', { dry_run: true, edits: [{ file_path: 'v/e.txt', op: 'create', new_string: '' }] })
  assert.match(empty, /\(empty file\)/)
  const real = await text('edit_many', { verify: { command: 'cat v/v.txt' }, edits: [{ file_path: 'v/v.txt', op: 'create', new_string: 'l1\nl2' }] })
  assert.match(real, /verify `cat v\/v\.txt` → exit 0 \(2 lines\):\nl1\nl2/)
})

test('create: CRLF new_string makes a CRLF file and later edits keep it; LF stays LF', async () => {
  const { run } = setup({ withPolicy: false })
  await run('edit_many', { edits: [
    { file_path: 'crlf.txt', op: 'create', new_string: 'a\r\nb' },
    { file_path: 'crlf.txt', op: 'append', new_string: 'c' },
  ] })
  assert.equal(read('crlf.txt'), 'a\r\nb\r\nc\r\n')
  await run('edit_many', { edits: [{ file_path: 'lf.txt', op: 'create', new_string: 'a\nb' }] })
  assert.equal(read('lf.txt'), 'a\nb\n')
})

test('create: the new file gets the umask mode, not the backend\'s owner-only 0600', { skip: process.platform === 'win32' }, async () => {
  const { run } = setup()
  await run('edit_many', { edits: [{ file_path: 'mode/m.sh', op: 'create', new_string: 'echo hi' }] })
  assert.equal(statSync(at('mode/m.sh')).mode & 0o777, 0o666 & ~process.umask())
})

test('create: the sandbox refuses it at validation like every write (outside the writable roots, read-only mode); nothing created, no parent directories', async () => {
  const outside = outsideDir()
  try {
    const { run } = setup()
    await assert.rejects(run('edit_many', { edits: [{ file_path: join(outside, 'sub/o.txt'), op: 'create', new_string: 'x' }] }),
      (e) => {
        assert.equal(e.code, 'FS_SANDBOX_DENIED')
        assert.match(e.message, /^edit_many: 1 problem, nothing written:\n {2}#1 \S+o\.txt: \[sandbox: file access denied under workspace-write mode\] outside the writable roots\n/)
        assert.match(e.message, /use the built-in edit\/write tool with sandbox_permissions/)
        return true
      })
    assert.equal(existsSync(join(outside, 'sub')), false)
    const ro = setup({ mode: 'read-only' })
    await assert.rejects(ro.run('edit_many', { edits: [{ file_path: 'ro/deep/ro.txt', op: 'create', new_string: 'x' }] }),
      (e) => { assert.equal(e.code, 'FS_SANDBOX_DENIED'); assert.match(e.message, /#1 \S+ro\.txt: \[sandbox: file access denied under read-only mode\] read-only mode allows no file writes/); return true })
    assert.equal(existsSync(at('ro')), false)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('create: a parent that is a file is a validation problem', async () => {
  const { run } = setup()
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'src/old.ts/inner.ts', op: 'create', new_string: 'x' }] }),
    problems(/#1 \S+inner\.ts: "\S+old\.ts" is not a directory \(file\)/))
})

test('create: a file that appears between validation and apply is not overwritten', async () => {
  const { ctx, run } = setup()
  // validation probes the missing path with lstat; something else creates it right after
  const lstat = ctx.fs.lstat
  ctx.fs.lstat = async (...a) => { const r = await lstat(...a); writeFileSync(at('race.txt'), 'theirs\n'); return r }
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'race.txt', op: 'create', new_string: 'ours' }] }),
    (e) => { assert.equal(e.code, 'FS_ALREADY_EXISTS'); assert.match(e.message, /already exists \(it appeared after validation\); nothing overwritten/); return true })
  assert.equal(read('race.txt'), 'theirs\n')
})

test('create: the diff card shows it as a new file; the prompt hint and schema name it', async () => {
  const { tool, run } = setup()
  const args = { edits: [{ file_path: 'card.ts', op: 'create', new_string: 'x' }] }
  const value = await run('edit_many', args)
  assert.deepEqual(tool('edit_many').output.presentationMeta(args, value).diffs, [{ path: 'card.ts', oldText: null, newText: 'x' }])
  assert.match(PROMPT_HINT, /create a new file/)
  assert.ok(tool('edit_many').parameters.properties.edits.items.properties.op.enum.includes('create'))
  assert.match(tool('edit_many').description, /"create" \{ new_string \} makes a new file/)
})
