import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Config, PROMPT_HINT, PROMPT_SECTION, apply, build } from '../index.js'
import { countOccurrences, planEdit, regionsFor } from '../edit-many.mjs'
import { buildSearchArgv, parseSearchArgs } from '../search.mjs'
import { fakeCtx, fakeExec, textOf } from './fake-ctx.mjs'

const root = mkdtempSync(join(tmpdir(), 'deepsea-fs-tools-test-'))
after(() => rmSync(root, { recursive: true, force: true }))

// A small tree: src/{a.ts,b.ts,util/c.ts}, docs/readme.md, node_modules/x/index.js, .git/HEAD
mkdirSync(join(root, 'src/util'), { recursive: true })
mkdirSync(join(root, 'docs'))
mkdirSync(join(root, 'node_modules/x'), { recursive: true })
mkdirSync(join(root, '.git'))
writeFileSync(join(root, 'src/a.ts'), 'import { foo } from "./b"\n\nexport function alpha() {\n  return foo(1)\n}\n\nexport const twice = foo(2) + foo(3)\n')
writeFileSync(join(root, 'src/b.ts'), 'export function foo(n: number) {\n  return n * 2\n}\n')
writeFileSync(join(root, 'src/util/c.ts'), 'export const C = 3 // foo\n')
writeFileSync(join(root, 'docs/readme.md'), '# Readme\n\nfoo bar\n')
writeFileSync(join(root, 'node_modules/x/index.js'), 'module.exports = "foo"\n')
writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n')

const ctx = fakeCtx({ workspaceRoot: root })
const tools = build(ctx, Config({}))
const tool = (name) => tools.find(t => t.name === name)
const exec = fakeExec('session-test', root)
const run = (name, args) => tool(name).execute(args, exec)
const text = (name, args, value) => textOf(tool(name), args, value)

test('apply registers the four tools and the prompt hint', () => {
  const c = fakeCtx({ workspaceRoot: root })
  apply(c, Config({}))
  assert.deepEqual(c.registered.map(t => t.name), ['list_dir', 'read_many', 'edit_many', 'search'])
  assert.equal(c.systemPrompt.sections.length, 1)
  assert.equal(c.systemPrompt.sections[0].name, PROMPT_SECTION)
  assert.equal(c.systemPrompt.sections[0].text({ scope: undefined }), PROMPT_HINT)
  const noHint = fakeCtx({ workspaceRoot: root })
  apply(noHint, Config({ promptHint: false }))
  assert.equal(noHint.systemPrompt.sections.length, 0)
})

// ---------------------------------------------------------------- list_dir

test('list_dir: default lists direct children of the workspace, dirs first with a slash, noise collapsed', async () => {
  const v = await run('list_dir', {})
  const t = text('list_dir', {}, v)
  assert.match(t, /^\/.*\(4 dirs, 0 files\)/)
  const names = v.roots[0].rows.map(r => r.path)
  assert.deepEqual(names, ['.git/', 'docs/', 'node_modules/', 'src/'])
  assert.ok(v.roots[0].rows.find(r => r.path === 'node_modules/').collapsed)
  assert.ok(v.roots[0].rows.find(r => r.path === '.git/').collapsed)
  assert.match(t, /node_modules\/ {2}\(not descended; pass all:true\)/)
})

test('list_dir: depth, sizes, several roots, missing root reported inline, all descends node_modules', async () => {
  const v = await run('list_dir', { paths: ['src', 'nope', 'docs/readme.md'], depth: 2, sizes: true })
  assert.equal(v.roots.length, 3)
  assert.deepEqual(v.roots[0].rows.map(r => r.path), ['util/', 'util/c.ts', 'a.ts', 'b.ts'])
  assert.equal(typeof v.roots[0].rows[1].size, 'number')
  assert.equal(v.roots[1].error, 'not found')
  assert.match(v.roots[2].error, /not a directory/)
  const t = text('list_dir', {}, v)
  assert.match(t, /c\.ts {2}\d+ B/)
  assert.match(t, /nope: not found/)
  const all = await run('list_dir', { depth: 3, all: true })
  assert.ok(all.roots[0].rows.some(r => r.path === 'node_modules/x/index.js'))
  assert.ok(all.roots[0].rows.some(r => r.path === '.git/HEAD'))
})

test('list_dir: max_entries truncates with a note; bad args rejected', async () => {
  const v = await run('list_dir', { depth: 3, all: true, max_entries: 3 })
  assert.equal(v.roots[0].rows.length, 3)
  assert.ok(v.roots[0].truncated)
  assert.match(text('list_dir', {}, v), /stopped at 3 entries/)
  await assert.rejects(run('list_dir', { depth: 0 }), /depth must be a positive integer/)
  await assert.rejects(run('list_dir', { paths: [] }), /at least one directory/)
})

// ---------------------------------------------------------------- read_many

test('read_many: several files and ranges, line-numbered, observed for the guard', async () => {
  const args = { files: [{ path: 'src/a.ts', offset: 3, limit: 3 }, { path: 'src/b.ts' }, { path: 'src/a.ts', offset: 7 }] }
  const v = await run('read_many', args)
  assert.equal(v.files.length, 3)
  assert.deepEqual(v.files[0].rows, ['3: export function alpha() {', '4:   return foo(1)', '5: }'])
  assert.equal(v.files[0].total, 7)
  assert.equal(v.files[1].rows.length, 3)
  assert.deepEqual(v.files[2].rows, ['7: export const twice = foo(2) + foo(3)'])
  const t = text('read_many', args, v)
  assert.match(t, /<path>.*src\/a\.ts<\/path>\n<type>file<\/type>\n<content> {2}\(lines 3-5 of 7\)/)
  // one observation per distinct file, with the version
  const obs = ctx.events.filter(e => e.name === 'fs/observed')
  assert.equal(obs.filter(e => e.path.endsWith('src/a.ts')).length, 1)
  assert.equal(obs.filter(e => e.path.endsWith('src/b.ts')).length, 1)
  assert.equal(obs[0].state.kind, 'present')
})

test('read_many: missing file inline (observed absent), directory rejected inline, collapse_blank, max_lines budget', async () => {
  const v = await run('read_many', { files: ['src/nope.ts', 'src', { path: 'src/a.ts' }], collapse_blank: true })
  assert.equal(v.files[0].error, 'not found')
  assert.ok(ctx.events.some(e => e.name === 'fs/observed' && e.path.endsWith('src/nope.ts') && e.state.kind === 'absent'))
  assert.match(v.files[1].error, /not a regular file/)
  assert.equal(v.files[2].rows.length, 5, 'blank lines dropped')
  assert.equal(v.files[2].rows[2], '4:   return foo(1)', 'numbers stay accurate')
  const b = await run('read_many', { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }], max_lines: 5 })
  assert.equal(b.files[0].rows.length, 5)
  assert.equal(b.files[0].omitted, 2)
  assert.equal(b.files.length, 1)
  assert.equal(b.truncatedAt, 5)
  assert.match(text('read_many', {}, b), /2 more requested lines omitted/)
  await assert.rejects(run('read_many', { files: [] }), /non-empty array/)
  await assert.rejects(run('read_many', { files: [{ path: 'x', limit: 99999 }] }), /at most 2000/)
})

// ---------------------------------------------------------------- edit_many

test('countOccurrences counts non-overlapping matches', () => {
  assert.equal(countOccurrences('aaaa', 'aa'), 2)
  assert.equal(countOccurrences('abc', 'x'), 0)
})

test('edit_many: unread file — a unique anchor goes through (and says so); a missing file is a problem; nothing written on any problem', async () => {
  const fresh = fakeCtx({ workspaceRoot: root })
  const [, , editMany] = build(fresh, Config({}))
  const b = join(root, 'src/b.ts')
  const before = readFileSync(b, 'utf8')
  try {
    await assert.rejects(
      editMany.execute({ edits: [
        { file_path: 'src/b.ts', old_string: 'n * 2', new_string: 'n * 3' },
        { file_path: 'src/c-missing.ts', old_string: 'x', new_string: 'y' },
      ] }, exec),
      (e) => {
        assert.equal(e.code, 'EDIT_MANY_INVALID')
        assert.match(e.message, /^edit_many: 1 problem, nothing written:\n {2}#2 .*c-missing\.ts": not found$/)
        return true
      },
    )
    assert.equal(readFileSync(b, 'utf8'), before, 'the valid edit is not applied while another entry has a problem')
    // the tool read b.ts: the observation is recorded, so the guard now knows the file
    const intent = await fresh.waterfall('fs/edit-intent', { targetKey: b, path: b }, exec, () => undefined)
    assert.equal(intent.version, (await fresh.fs.stat({ path: b })).version)
    // alone, the unique edit on an unread file goes through and the result says why
    const c2 = fakeCtx({ workspaceRoot: root })
    const [, , em2] = build(c2, Config({}))
    const args = { edits: [{ file_path: 'src/b.ts', old_string: 'n * 2', new_string: 'n * 3' }] }
    const v = await em2.execute(args, exec)
    assert.equal(v.applied[0].guard, 'unread')
    assert.match(textOf(em2, args, v), /src\/b\.ts: 1 edit \(line 2\) — file was not read this session; applied because every anchor matched uniquely/)
    assert.match(readFileSync(b, 'utf8'), /n \* 3/)
    
  } finally {
    writeFileSync(b, before)
  }
})

test('edit_many: unread file with an ambiguous / missing anchor — refused with the matching regions, observation recorded so the plain retry works', async () => {
  const c = fakeCtx({ workspaceRoot: root })
  const [, , editMany] = build(c, Config({}))
  const a = join(root, 'src/a.ts')
  const before = readFileSync(a, 'utf8')
  try {
    await assert.rejects(
      editMany.execute({ edits: [
        { file_path: 'src/a.ts', old_string: 'foo(', new_string: 'x(' },
        { file_path: 'src/a.ts', old_string: 'export function omega', new_string: 'y' },
      ] }, exec),
      (e) => {
        assert.equal(e.code, 'EDIT_MANY_INVALID')
        assert.match(e.message, /#1 .*appears 3 times — make it more specific or set replace_all: true \(foo\(\) \[file not read this session\]\n {4}3 matches:\n {4}3: export function alpha\(\) \{\n {4}4: {3}return foo\(1\)\n {4}5: \}\n {6}…\n {4}6: \n {4}7: export const twice = foo\(2\) \+ foo\(3\)\n {2}#2/)
        assert.match(e.message, /#2 .*old_string not found \(export function omega\) \[file not read this session\]\n {4}nearest lines \(the file is 7 lines\):\n {4}\s*1: import/)
        return true
      },
    )
    assert.equal(readFileSync(a, 'utf8'), before)
    // the regions came back and the observation was recorded: the corrected retry is authorised without a read
    assert.ok(c.events.some(e => e.name === 'fs/observed' && e.path === a))
    const v = await editMany.execute({ edits: [{ file_path: 'src/a.ts', old_string: 'export function alpha', new_string: 'export function omega' }] }, exec)
    assert.equal(v.applied[0].guard, undefined, 'after the tool\'s own read the file counts as observed')
    
  } finally {
    writeFileSync(a, before)
  }
})

test('regionsFor / planEdit: occurrences with context, nearest-line fallback, structural op translation', () => {
  const text = 'a\nfoo x\nb\nfoo y\nc\n'
  assert.match(regionsFor(text, 'foo'), /^2 matches:\n1: a\n2: foo x\n3: b\n {2}…\n3: b\n4: foo y\n5: c$/)
  assert.match(regionsFor(text, 'foo z'), /^nearest lines \(the file is 5 lines\):\n1: a\n2: foo x/)
  assert.match(regionsFor(text, 'nothing here'), /^no line resembles/)
  const after = planEdit({ index: 0, op: 'insert_after', marker: 'foo x', newString: 'NEW\n' }, text, 'f')
  assert.deepEqual([after.oldString, after.newString], ['foo x', 'foo x\nNEW'])
  const before = planEdit({ index: 0, op: 'insert_before', marker: 'y', newString: 'NEW' }, text, 'f')
  assert.deepEqual([before.oldString, before.newString], ['foo y', 'NEW\nfoo y'])
  const between = planEdit({ index: 0, op: 'replace_between', start: 'foo x', end: 'foo y', newString: '\nMID\n', inclusive: false }, text, 'f')
  assert.deepEqual([between.oldString, between.newString], ['foo x\nb\nfoo y', 'foo x\nMID\nfoo y'])
  const incl = planEdit({ index: 0, op: 'replace_between', start: 'foo x', end: 'foo y', newString: 'ONE', inclusive: true }, text, 'f')
  assert.deepEqual([incl.oldString, incl.newString], ['foo x\nb\nfoo y', 'ONE'])
  const toEnd = planEdit({ index: 0, op: 'replace_between', start: 'b\n', newString: '', inclusive: false }, text, 'f')
  assert.deepEqual([toEnd.oldString, toEnd.newString], ['b\nfoo y\nc\n', 'b\n'])
  const app = planEdit({ index: 0, op: 'append', newString: 'tail' }, 'x', 'f')
  assert.equal(app.whole, 'x\ntail\n')
  assert.match(planEdit({ index: 2, op: 'insert_after', marker: 'foo', newString: 'z' }, text, 'f').problem, /^#3 f: marker appears 2 times/)
  assert.match(planEdit({ index: 0, op: 'replace_between', start: 'a', end: 'zzz', newString: '' }, text, 'f').problem, /end marker not found after the start marker/)
})

test('edit_many: structural ops end to end (insert_after, insert_before, replace_between to EOF, append) + verify runs after a successful apply', async () => {
  const c = fakeCtx({ workspaceRoot: root })
  const [, readMany, editMany] = build(c, Config({}))
  const a = join(root, 'src/a.ts')
  const before = readFileSync(a, 'utf8')
  try {
    await readMany.execute({ files: ['src/a.ts'] }, exec)
    const args = {
      edits: [
        { file_path: 'src/a.ts', op: 'insert_after', marker: 'import { foo } from "./b"', new_string: 'import { bar } from "./c"' },
        { file_path: 'src/a.ts', op: 'insert_before', marker: 'export function alpha', new_string: '/** alpha */' },
        { file_path: 'src/a.ts', op: 'replace_between', start: 'return foo(1)\n}', new_string: '\n', inclusive: false },
        { file_path: 'src/a.ts', op: 'append', new_string: 'export const END = 1' },
      ],
      verify: { command: 'wc -l < src/a.ts && echo verified', max_lines: 5 },
    }
    const v = await editMany.execute(args, exec)
    assert.equal(readFileSync(a, 'utf8'), 'import { foo } from "./b"\nimport { bar } from "./c"\n\n/** alpha */\nexport function alpha() {\n  return foo(1)\n}\nexport const END = 1\n')
    assert.deepEqual(v.applied.map(x => x.op), ['insert_after', 'insert_before', 'replace_between', 'append'])
    assert.equal(v.verify.exitCode, 0)
    assert.match(v.verify.output, /8\nverified$/)
    assert.equal(c.shellRuns[0].workdir, root, 'verify runs in the workspace by default')
    assert.equal(c.shellRuns[0].sandboxPolicy.mode, 'workspace-write', 'verify carries the caller\'s sandbox policy')
    const t = textOf(editMany, args, v)
    assert.match(t, /^applied 4 edits in 1 file\.\n {2}.*src\/a\.ts: 4 edits \(insert_after line 1, insert_before line 4, replace_between line 6, append line 8\)\nverify `wc -l < src\/a\.ts && echo verified` → exit 0 \(2 lines\):\n\s*8\nverified$/)
    // presentation: only replace ops become diff cards; the call card notes verify
    assert.equal(editMany.output.presentationMeta(args, v).diffs.length, 0)
    assert.match(editMany.presentCall(args).title, /\+ verify$/)
    
  } finally {
    writeFileSync(a, before)
  }
})

test('edit_many: verify failure is reported, not a tool error; output is tailed; skipped on dry_run and on validation failure; workdir + timeout honoured', async () => {
  const c = fakeCtx({ workspaceRoot: root })
  const [, readMany, editMany] = build(c, Config({}))
  const b = join(root, 'src/b.ts')
  const before = readFileSync(b, 'utf8')
  await readMany.execute({ files: ['src/b.ts'] }, exec)
  const args = { edits: [{ file_path: 'src/b.ts', old_string: 'n * 2', new_string: 'n * 6' }], verify: { command: 'for i in 1 2 3 4 5 6; do echo line$i; done; echo boom >&2; exit 3', max_lines: 4, workdir: 'src' } }
  const v = await editMany.execute(args, exec)
  assert.match(readFileSync(b, 'utf8'), /n \* 6/, 'edits stay applied when the check fails')
  assert.equal(v.verify.exitCode, 3)
  assert.equal(v.verify.outputLines, 7)
  assert.equal(v.verify.truncatedLines, 3)
  assert.equal(v.verify.output, 'line4\nline5\nline6\nboom')
  assert.equal(c.shellRuns.at(-1).workdir, join(root, 'src'))
  assert.match(textOf(editMany, args, v), /verify `.*` → exit 3 \(last 4 of 7 lines\):\nline4\nline5\nline6\nboom$/)
  writeFileSync(b, before)
  await readMany.execute({ files: ['src/b.ts'] }, exec)
  const dry = await editMany.execute({ ...args, dry_run: true }, exec)
  assert.equal(dry.verify.skipped, 'dry_run')
  assert.match(textOf(editMany, args, dry), /verify skipped \(dry_run\)\.$/)
  const runsBefore = c.shellRuns.length
  await assert.rejects(editMany.execute({ edits: [{ file_path: 'src/b.ts', old_string: 'nope', new_string: 'x' }], verify: { command: 'echo ran' } }, exec), /nothing written/)
  assert.equal(c.shellRuns.length, runsBefore, 'verify does not run after a validation failure')
  const noShell = fakeCtx({ workspaceRoot: root, withShell: false })
  const [, rm2, em2] = build(noShell, Config({}))
  await rm2.execute({ files: ['src/b.ts'] }, exec)
  const v2 = await em2.execute({ edits: [{ file_path: 'src/b.ts', old_string: 'n * 2', new_string: 'n * 7' }], verify: { command: 'true' } }, exec)
  assert.match(v2.verify.skipped, /no shell service/)
  writeFileSync(b, before)
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'src/b.ts', old_string: 'a', new_string: 'b' }], verify: { command: '' } }), /verify\.command must be a non-empty string/)
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'src/b.ts', old_string: 'a', new_string: 'b' }], verify: { command: 'x', max_lines: 0 } }), /verify\.max_lines must be a positive integer/)
})

test('edit_many: read_many authorises; several edits in one file + another file; later edit sees earlier result; observed after', async () => {
  const c = fakeCtx({ workspaceRoot: root })
  const [, readMany, editMany] = build(c, Config({}))
  const a = join(root, 'src/a.ts')
  const b = join(root, 'src/b.ts')
  const aBefore = readFileSync(a, 'utf8')
  const bBefore = readFileSync(b, 'utf8')
  await readMany.execute({ files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }, exec)
  const args = { edits: [
    { file_path: 'src/a.ts', old_string: 'return foo(1)', new_string: 'return bar(1)' },
    { file_path: 'src/a.ts', old_string: 'bar(1)\n}', new_string: 'bar(1) // edited\n}' }, // matches text produced by #1
    { file_path: 'src/b.ts', old_string: 'n * 2', new_string: 'n * 3' },
    { file_path: 'src/a.ts', old_string: 'foo(', new_string: 'baz(', replace_all: true },
  ] }
  const v = await editMany.execute(args, exec)
  assert.equal(v.applied.length, 4)
  assert.equal(v.files, 2)
  assert.equal(readFileSync(a, 'utf8'), 'import { foo } from "./b"\n\nexport function alpha() {\n  return bar(1) // edited\n}\n\nexport const twice = baz(2) + baz(3)\n')
  assert.equal(readFileSync(b, 'utf8'), 'export function foo(n: number) {\n  return n * 3\n}\n')
  const t = textOf(editMany, args, v)
  assert.match(t, /^applied 4 edits in 2 files\./)
  assert.match(t, /src\/a\.ts: 3 edits \(line 4, line 4, 2× from line 7\)/)
  assert.match(t, /src\/b\.ts: 1 edit \(line 2\)/)
  // a following single edit needs no re-read: the record is fresh
  const intent = await c.waterfall('fs/edit-intent', { targetKey: a, path: a }, exec, () => undefined)
  assert.equal(intent.version, (await c.fs.stat({ path: a })).version)
  // presentation: diff cards from args
  assert.equal(editMany.presentCall(args).diffs.length, 4)
  assert.match(editMany.presentCall(args).title, /Edit 2 files \(4 edits\)/)
  assert.equal(editMany.output.presentationMeta(args, v).diffs.length, 4)
  // restore
  writeFileSync(a, aBefore)
  writeFileSync(b, bBefore)
})

test('edit_many: not-found and ambiguous old_string are collected together, nothing written; dry_run writes nothing', async () => {
  const c = fakeCtx({ workspaceRoot: root })
  const [, readMany, editMany] = build(c, Config({}))
  await readMany.execute({ files: ['src/a.ts'] }, exec)
  const before = readFileSync(join(root, 'src/a.ts'), 'utf8')
  await assert.rejects(
    editMany.execute({ edits: [
      { file_path: 'src/a.ts', old_string: 'foo(', new_string: 'x(' },
      { file_path: 'src/a.ts', old_string: 'does not exist', new_string: 'y' },
      { file_path: 'src/a.ts', old_string: 'alpha', new_string: 'beta' },
    ] }, exec),
    /2 problems, nothing written:\n {2}#1 .*appears 3 times — make it more specific or set replace_all: true.*\n {4}3 matches:\n[\s\S]*\n {2}#2 .*old_string not found \(does not exist\)\n {4}no line resembles the first line of the anchor/,
  )
  assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), before)
  const dry = await editMany.execute({ dry_run: true, edits: [{ file_path: 'src/a.ts', old_string: 'alpha', new_string: 'beta' }] }, exec)
  assert.equal(dry.dryRun, true)
  assert.match(textOf(editMany, {}, dry), /^Dry run: would apply 1 edit in 1 file\./)
  assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), before)
})

test('edit_many: a bash-side write after the read (stale) — unique anchor in the CURRENT content goes through with a note; a now-missing anchor shows the regions; nothing partial', async () => {
  const c = fakeCtx({ workspaceRoot: root })
  const [, readMany, editMany] = build(c, Config({}))
  await readMany.execute({ files: ['src/b.ts', 'src/a.ts'] }, exec)
  const b = join(root, 'src/b.ts')
  const a = join(root, 'src/a.ts')
  const original = readFileSync(b, 'utf8')
  try {
    const aBefore = readFileSync(a, 'utf8')
    c.externalWrite(b, original.replace('n * 2', 'n * 20 // touched by bash'))
    // the anchor the model remembers is gone: refused with regions, note explains why
    await assert.rejects(
      editMany.execute({ edits: [
        { file_path: 'src/a.ts', old_string: 'return foo(1)', new_string: 'return foo(0)' },
        { file_path: 'src/b.ts', old_string: 'n * 2\n', new_string: 'n * 4\n' },
      ] }, exec),
      (e) => {
        assert.equal(e.code, 'EDIT_MANY_INVALID')
        assert.match(e.message, /1 problem, nothing written:\n {2}#2 .*old_string not found \(n \* 2\\n\) \[file changed since it was read\]\n {4}nearest lines[\s\S]*2: {3}return n \* 20 \/\/ touched by bash/)
        return true
      },
    )
    assert.equal(readFileSync(a, 'utf8'), aBefore, 'the valid edit to a.ts was not applied (all-or-nothing, decided before any write)')
    // an anchor unique in the current content goes through without a re-read
    const args = { edits: [{ file_path: 'src/b.ts', old_string: 'n * 20 // touched by bash', new_string: 'n * 2' }] }
    const v = await editMany.execute(args, exec)
    assert.equal(readFileSync(b, 'utf8'), original)
    assert.equal(v.applied[0].guard, undefined, 'the refusal above already recorded the fresh observation')
    // straight stale + unique (no failed attempt in between)
    c.externalWrite(b, original.replace('n * 2', 'n * 2 // again'))
    const v2 = await editMany.execute({ edits: [{ file_path: 'src/b.ts', old_string: '// again', new_string: '' }] }, exec)
    assert.equal(v2.applied[0].guard, 'stale')
    assert.match(textOf(editMany, {}, v2), /file had changed since it was read; applied because every anchor matched uniquely/)
    assert.equal(readFileSync(b, 'utf8'), original.replace('n * 2', 'n * 2 '))
    
  } finally {
    writeFileSync(b, original)
  }
})

test('edit_many: sandbox denial outside the workspace root is the [sandbox: …] marker', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'deepsea-fs-tools-outside-'))
  const f = join(outside, 'o.txt')
  writeFileSync(f, 'hello\n')
  const c = fakeCtx({ workspaceRoot: root })
  const [, readMany, editMany] = build(c, Config({}))
  await readMany.execute({ files: [f] }, exec)
  await assert.rejects(
    editMany.execute({ edits: [{ file_path: f, old_string: 'hello', new_string: 'bye' }] }, exec),
    (e) => { assert.equal(e.code, 'FS_SANDBOX_DENIED'); assert.match(e.message, /\[sandbox: file access denied under workspace-write mode\]/); return true },
  )
  assert.equal(readFileSync(f, 'utf8'), 'hello\n')
  rmSync(outside, { recursive: true, force: true })
})

test('edit_many: without an observation policy (no listener) edits are unconditional, like edit', async () => {
  const c = fakeCtx({ workspaceRoot: root, withPolicy: false })
  const [, , editMany] = build(c, Config({}))
  const b = join(root, 'src/b.ts')
  const original = readFileSync(b, 'utf8')
  await editMany.execute({ edits: [{ file_path: 'src/b.ts', old_string: 'n * 2', new_string: 'n * 5' }] }, exec)
  assert.match(readFileSync(b, 'utf8'), /n \* 5/)
  writeFileSync(b, original)
})

test('edit_many: argument validation', async () => {
  await assert.rejects(run('edit_many', { edits: [] }), /non-empty array/)
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'a', old_string: '', new_string: 'b' }] }), /old_string must not be empty/)
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'a', old_string: 'x', new_string: 'x' }] }), /must differ/)
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'a', op: 'rotate', new_string: 'x' }] }), /op.* must be one of .*replace.*insert_after/)
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'a', op: 'insert_after', new_string: 'x' }] }), /edits\[0\]\.marker is required for op "insert_after"/)
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'a', op: 'replace_between', start: 's' }] }), /edits\[0\]\.new_string is required/)
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'a', op: 'append', new_string: '' }] }), /new_string must not be empty/)
})

// ---------------------------------------------------------------- search

test('search: argv construction keeps model values behind --flag= and --', () => {
  const input = parseSearchArgs({ text: '-foo', word: 'bar', regex: 'b.z', paths: ['-src'], include_glob: '*.ts', exclude_glob: ['*.spec.ts'], context: 0, ignore_case: true }, { maxResults: 250 })
  assert.deepEqual(buildSearchArgv(input), [
    '--no-config', '--json', '--ignore-case',
    '--glob=*.ts', '--glob=!*.spec.ts', '--regexp=-foo', '--regexp=\\bbar\\b', '--regexp=b.z', '--', '-src',
  ])
  assert.equal(input.context, 0)
  assert.throws(() => parseSearchArgs({}, { maxResults: 250 }), /one of text, word or regex is required/)
  assert.throws(() => parseSearchArgs({ text: 'x', context: -1 }, { maxResults: 250 }), /context must be an integer between 0 and 20/)
  assert.throws(() => parseSearchArgs({ text: 'x', mode: 'nope' }, { maxResults: 250 }), /mode must be/)
  assert.throws(() => parseSearchArgs({ text: 'x', exclude_regex: '(' }, { maxResults: 250 }), /exclude_regex is not a valid/)
  assert.throws(() => parseSearchArgs({ text: 'x', include_glob: '!a' }, { maxResults: 250 }), /must be positive/)
})

test('search: lines mode with context, grouped by file, N: matches and N- context, gaps marked', async () => {
  const args = { pattern: 'foo\\(', context: 1, paths: ['src'] }
  const v = await run('search', args)
  assert.equal(v.mode, 'lines')
  assert.equal(v.totalMatches, 3, 'a.ts lines 4 and 7, b.ts line 1')
  assert.deepEqual(v.files.map(f => f.path), ['src/a.ts', 'src/b.ts'], 'sorted by path')
  const a = v.files.find(f => f.path === 'src/a.ts')
  const t = text('search', args, v)
  assert.match(t, /^Found 3 matches in 2 files/)
  assert.match(t, /src\/a\.ts\n {2}3- export function alpha\(\) \{\n {2}4:   return foo\(1\)\n {2}5- \}\n {2}6- \n {2}7: export const twice = foo\(2\) \+ foo\(3\)/)
  assert.ok(a.rows.every(r => r.gap || typeof r.line === 'number'))
})

test('search: files / count modes, include + exclude globs, several patterns, exclude_pattern, no_ignore, literal', async () => {
  const files = await run('search', { pattern: 'foo', mode: 'files' })
  assert.deepEqual(files.files.map(f => f.path).sort(), ['docs/readme.md', 'src/a.ts', 'src/b.ts', 'src/util/c.ts'])
  assert.match(text('search', {}, files), /^Found \d+ matches in 4 files\ndocs\/readme\.md\nsrc\/a\.ts\n/)
  const count = await run('search', { pattern: 'foo', mode: 'count', include: ['*.ts'] })
  assert.deepEqual(count.files.map(f => `${f.path}=${f.matches}`).sort(), ['src/a.ts=3', 'src/b.ts=1', 'src/util/c.ts=1'])
  assert.match(text('search', {}, count), /3 {2}src\/a\.ts/)
  const excl = await run('search', { pattern: 'foo', mode: 'files', include: ['*.ts'], exclude: ['**/util/**'] })
  assert.deepEqual(excl.files.map(f => f.path).sort(), ['src/a.ts', 'src/b.ts'])
  const multi = await run('search', { patterns: ['Readme', 'C = 3'], mode: 'files' })
  assert.deepEqual(multi.files.map(f => f.path).sort(), ['docs/readme.md', 'src/util/c.ts'])
  const gv = await run('search', { pattern: 'foo', paths: ['src/a.ts'], exclude_pattern: 'import|twice' })
  assert.equal(gv.totalMatches, 1)
  assert.equal(gv.files[0].rows[0].line, 4)
  // node_modules is gitignored-by-convention only when a .gitignore says so: here it is not ignored, so it appears either way
  const nm = await run('search', { pattern: 'module.exports', mode: 'files', no_ignore: true })
  assert.deepEqual(nm.files.map(f => f.path), ['node_modules/x/index.js'])
  const lit = await run('search', { pattern: 'foo(1)', literal: true, mode: 'count' })
  assert.deepEqual(lit.files.map(f => f.path), ['src/a.ts'])
  const none = await run('search', { pattern: 'zzzzz' })
  assert.equal(text('search', {}, none), 'No matches found')
})

test('search: text is literal, word is whole-word, selectors OR, and typed exclusions work in every mode', async () => {
  const literal = await run('search', { text: 'foo(', paths: ['src'], mode: 'count' })
  assert.deepEqual(literal.files.map(f => `${f.path}=${f.matches}`), ['src/a.ts=2', 'src/b.ts=1'])

  const words = await run('search', { word: 'foo', include_glob: '*.ts', mode: 'files' })
  assert.deepEqual(words.files.map(f => f.path).sort(), ['src/a.ts', 'src/b.ts', 'src/util/c.ts'])

  const selected = await run('search', { text: ['Readme', 'C = 3'], mode: 'files' })
  assert.deepEqual(selected.files.map(f => f.path).sort(), ['docs/readme.md', 'src/util/c.ts'])

  const excluded = await run('search', { word: 'foo', paths: ['src/a.ts'], exclude_text: 'import', exclude_word: 'twice', mode: 'count' })
  assert.deepEqual(excluded.files.map(f => `${f.path}=${f.matches}`), ['src/a.ts=1'])

  const excludedRegex = await run('search', { text: 'FOO', ignore_case: true, paths: ['src/a.ts'], exclude_regex: 'RETURN|TWICE|IMPORT', mode: 'files' })
  assert.deepEqual(excludedRegex.files, [])
})

test('search: max_results caps matches with a note; invalid regex surfaces rg diagnostic', async () => {
  const v = await run('search', { pattern: 'foo', max_results: 2 })
  assert.equal(v.shownMatches, 2)
  assert.ok(v.truncated)
  assert.ok(v.totalMatches > 2)
  assert.match(text('search', {}, v), /showing first 2; raise max_results/)
  await assert.rejects(run('search', { pattern: 'foo(' }), (e) => { assert.equal(e.code, 'SEARCH_FAILED'); assert.match(e.message, /unclosed group|regex/i); return true })
})

test('search: grep-tool aliases are accepted but absent from the advertised schema', async () => {
  const aliased = await run('search', { pattern: 'foo(1)', literal: true, include: ['*.ts'], exclude_pattern: 'twice', case_insensitive: true, mode: 'count' })
  assert.deepEqual(aliased.files.map(f => f.path), ['src/a.ts'])
  const advertised = tool('search').parameters.properties
  assert.ok(advertised.text && advertised.regex && advertised.include_glob)
  for (const hidden of ['pattern', 'patterns', 'literal', 'case_insensitive', 'include', 'exclude', 'exclude_pattern']) {
    assert.equal(advertised[hidden], undefined)
  }
})

test('search: missing roots are skipped and named with the cwd; ~ expands; all-missing is a clear error', async () => {
  const v = await run('search', { pattern: 'foo', paths: ['src', 'nope/dir', '~/definitely-not-here-fs-tools-test'], mode: 'files' })
  assert.ok(v.totalMatches > 0)
  assert.deepEqual(v.missingPaths, ['nope/dir', '~/definitely-not-here-fs-tools-test'])
  assert.equal(v.cwd, root)
  assert.match(text('search', {}, v), /\(2 roots not found and skipped: nope\/dir, ~\/definitely-not-here-fs-tools-test — paths resolve against \/.*\)$/)
  const none = await run('search', { pattern: 'zzz-no-such-text', paths: ['src', 'nope'] })
  assert.match(text('search', {}, none), /^No matches found\n\(1 root not found and skipped: nope/)
  await assert.rejects(run('search', { pattern: 'foo', paths: ['nope', 'also/nope'] }), (e) => { assert.equal(e.code, 'SEARCH_NO_PATHS'); assert.match(e.message, /none of the paths exist \(nope, also\/nope\); paths resolve against/); return true })
})
