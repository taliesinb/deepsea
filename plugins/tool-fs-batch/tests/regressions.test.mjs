// Regression tests for the bugs found exercising the tools (numbered as in the
// bug write-up): CRLF append, line-based replace_between, problems reported
// together, merged regions, overlap warnings, anchored globs, rg -w words,
// clean regex errors, read_many ranges and budgets, the session's current
// working directory, list-valued search selectors under frozen arguments.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Config } from '../index.js'
import { planEdit, regionsFor } from '../edit-many.mjs'
import { shownPath } from '../common.mjs'
import { formatRegexError, parseSearchArgs } from '../search.mjs'
import { build, deepFreeze, fakeCtx, fakeExec, textOf } from './fake-ctx.mjs'

const root = mkdtempSync(join(tmpdir(), 'deepsea-tool-fs-batch-regress-'))
after(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, 'src/deep'), { recursive: true })
mkdirSync(join(root, '.git/hooks'), { recursive: true })
writeFileSync(join(root, 'src/a.ts'), 'export const foobar = foo(1);\n')
writeFileSync(join(root, 'src/deep/b.ts'), 'foo(1)\n')
writeFileSync(join(root, '.git/hooks/pre.sample'), 'HIT\n')
writeFileSync(join(root, '.hidden.txt'), 'HIT\n')

const exec = fakeExec('session-regress', root)
/** Fresh tools without an observation policy (edits need no prior read), optionally with a working-directory service. */
function setup(opts = {}) {
  const ctx = fakeCtx({ workspaceRoot: root, withPolicy: false, ...opts })
  const tools = build(ctx, Config({}))
  const tool = (name) => tools.find(t => t.name === name)
  const run = (name, args) => tool(name).execute(args, exec)
  const text = async (name, args) => textOf(tool(name), args, await run(name, args))
  return { ctx, tool, run, text }
}
const file = (name, content) => { const p = join(root, name); writeFileSync(p, content); return p }

// ---------------------------------------------------------------- edit_many

test('#1 append keeps a CRLF file CRLF', async () => {
  const { run } = setup()
  const p = file('crlf.txt', 'a1\r\na2\r\na3\r\n')
  await run('edit_many', { edits: [{ file_path: 'crlf.txt', op: 'append', new_string: 'NEW' }] })
  assert.equal(readFileSync(p, 'utf8'), 'a1\r\na2\r\na3\r\nNEW\r\n')
})

test('#2 replace_between works on whole lines: markers on their own lines need no \\n', async () => {
  const { run } = setup()
  const p = file('gen.txt', 'top\n# BEGIN generated\ngen_a=1\ngen_b=2\n# END generated\nbottom\n')
  await run('edit_many', { edits: [{ file_path: 'gen.txt', op: 'replace_between', start: '# BEGIN generated', end: '# END generated', new_string: 'gen_new=9' }] })
  assert.equal(readFileSync(p, 'utf8'), 'top\n# BEGIN generated\ngen_new=9\n# END generated\nbottom\n')
  // "" deletes the lines between; the marker lines stay separate lines
  await run('edit_many', { edits: [{ file_path: 'gen.txt', op: 'replace_between', start: 'BEGIN', end: 'END', new_string: '' }] })
  assert.equal(readFileSync(p, 'utf8'), 'top\n# BEGIN generated\n# END generated\nbottom\n')
  // a marker that is part of its line still means that line; callers' own \n at the edges are harmless
  await run('edit_many', { edits: [{ file_path: 'gen.txt', op: 'replace_between', start: '# BEGIN generated\n', end: '\n# END', new_string: 'x\ny\n' }] })
  assert.equal(readFileSync(p, 'utf8'), 'top\n# BEGIN generated\nx\ny\n# END generated\nbottom\n')
  // inclusive replaces the marker lines too
  await run('edit_many', { edits: [{ file_path: 'gen.txt', op: 'replace_between', start: 'BEGIN', end: 'END', inclusive: true, new_string: 'GONE' }] })
  assert.equal(readFileSync(p, 'utf8'), 'top\nGONE\nbottom\n')
  // to end of file
  await run('edit_many', { edits: [{ file_path: 'gen.txt', op: 'replace_between', start: 'GONE', new_string: 'tail' }] })
  assert.equal(readFileSync(p, 'utf8'), 'top\nGONE\ntail\n')
  // start on the last line without a newline
  const q = file('last.txt', 'a\nSTART')
  await run('edit_many', { edits: [{ file_path: 'last.txt', op: 'replace_between', start: 'START', new_string: 'after' }] })
  assert.equal(readFileSync(q, 'utf8'), 'a\nSTART\nafter\n')
  // both markers on one line: a clear problem, not a character splice
  assert.match(planEdit({ index: 0, op: 'replace_between', start: '<a>', end: '</a>', newString: 'x' }, 'p <a>old</a> q\n', 'f').problem, /same line as the start marker \(line 1\); replace_between replaces whole lines — use replace/)
  assert.match(setup().tool('edit_many').description, /replace_between.*works on whole lines.*no \\n needed/)
})

test('#3 argument problems and anchor problems are reported together, numbered #k from 1, in entry order', async () => {
  const { run } = setup()
  file('three.txt', 'one\ntwo\n')
  await assert.rejects(run('edit_many', {
    edits: [
      { file_path: 'three.txt', old_string: 'missing', new_string: 'x' },
      { file_path: 'three.txt', old_string: 'same', new_string: 'same' },
      { file_path: 'three.txt', op: 'insert_after', marker: '', new_string: 'x' },
      { file_path: 'three.txt', old_string: 'two', new_string: 'TWO' },
      { file_path: 'nope.txt', old_string: 'a', new_string: 'b' },
    ],
    verify: { command: 'true', max_lines: 0 },
  }), (e) => {
    assert.equal(e.code, 'EDIT_MANY_INVALID')
    const heads = e.message.split('\n').filter(l => /^ {2}\S/.test(l)).map(l => l.trim().split(' ')[0])
    assert.deepEqual(heads, ['#1', '#2', '#3', '#5', 'verify.max_lines'])
    assert.match(e.message, /^edit_many: 5 problems, nothing written:/)
    assert.match(e.message, /#2 three\.txt: old_string and new_string must differ/)
    assert.match(e.message, /#3 three\.txt: marker must not be empty/)
    return true
  })
  assert.equal(readFileSync(join(root, 'three.txt'), 'utf8'), 'one\ntwo\n')
})

test('#4 regions: overlapping windows merged, matched lines marked >, singular "match"', () => {
  assert.equal(regionsFor('dup\nmid\ndup\nend\n', 'dup'), '2 matches:\n> 1: dup\n  2: mid\n> 3: dup\n  4: end')
  const three = regionsFor('=\na\n=\nb\n=\n', '=')
  assert.equal(three, '3 matches:\n> 1: =\n  2: a\n> 3: =\n  4: b\n> 5: =')
  // the substring case: the marked lines show which lines matched
  assert.match(regionsFor('end\nx\nappended\n', 'end'), /> 1: end\n {2}2: x\n> 3: appended/)
  assert.match(regionsFor('a\nb\n', 'b'), /^1 match:/)
  // two occurrences on one line: one marked line, no repeat
  assert.equal(regionsFor('x\nab ab\ny\n', 'ab'), '2 matches:\n  1: x\n> 2: ab ab\n  3: y')
})

test('#5 a replace_between that swallows an earlier edit\'s result is applied with a warning', async () => {
  const { run, tool } = setup()
  const p = file('ov.txt', 'h\nS\nin\nE\nmore\n')
  const args = { edits: [
    { file_path: 'ov.txt', op: 'replace_between', start: 'S', end: 'E', inclusive: true, new_string: 'BLOCK' },
    { file_path: 'ov.txt', op: 'replace_between', start: 'h', new_string: 'rest' },
  ] }
  const v = await run('edit_many', args)
  assert.equal(readFileSync(p, 'utf8'), 'h\nrest\n')
  assert.equal(v.warnings.length, 1)
  assert.match(textOf(tool('edit_many'), args, v), /warning: #2 .*ov\.txt: replace_between replaced text written by #1 earlier in this call/)
  // a replace that names the earlier result in old_string is deliberate: no warning
  file('ov.txt', 'a\nb\n')
  const ok = await run('edit_many', { edits: [
    { file_path: 'ov.txt', old_string: 'a', new_string: 'A1' },
    { file_path: 'ov.txt', old_string: 'A1', new_string: 'A2' },
    { file_path: 'ov.txt', op: 'replace_between', start: 'A2', end: 'b', new_string: 'mid' },
  ] })
  assert.equal(ok.warnings, undefined)
  assert.equal(readFileSync(p, 'utf8'), 'A2\nmid\nb\n')
})

test('#6 insert with the marker twice on one line, end-before-start, what differs, edited-by note, append line, dry-run preview, verify status', async () => {
  const { run, text } = setup()
  const same = file('same.txt', 'ab ab\nzz\n')
  await run('edit_many', { edits: [{ file_path: 'same.txt', op: 'insert_after', marker: 'ab', new_string: 'NEW' }] })
  assert.equal(readFileSync(same, 'utf8'), 'ab ab\nNEW\nzz\n')
  file('ind.ts', 'function f() {\n    return 1\n}\nexport const BAR = 2\n')
  await assert.rejects(run('edit_many', { edits: [
    { file_path: 'ind.ts', old_string: 'BAR = 2', new_string: 'BAR = 3' },
    { file_path: 'ind.ts', old_string: '  return  1', new_string: 'x' },
    { file_path: 'ind.ts', old_string: 'EXPORT CONST BAR', new_string: 'x' },
    { file_path: 'ind.ts', old_string: 'function f() {\n    return 2\n}', new_string: 'x' },
    { file_path: 'ind.ts', op: 'replace_between', start: 'return 1', end: 'function', new_string: 'x' },
  ] }), (e) => {
    assert.match(e.message, /#2 .*old_string not found \( {2}return {2}1\) \[as edited by #1\]\n {4}nearest lines \(the file has 4 lines\); the anchor differs from line 2 in indentation\/whitespace/)
    assert.match(e.message, /#3 .*\n {4}nearest lines .*; the anchor differs from line 4 in letter case:\n[\s\S]*> 4: export const BAR = 3/)
    assert.match(e.message, /#4 .*\n {4}nearest lines .*; anchor line 2 differs from line 2:/)
    assert.match(e.message, /#5 .*end marker occurs only before the start marker \(line 1; start marker on line 2\)/)
    return true
  })
  file('one.txt', 'single')
  assert.match(await text('edit_many', { edits: [{ file_path: 'one.txt', op: 'append', new_string: 'two' }] }), /append line 2\)/)
  file('pre.txt', 'h\nS\nin\nE\nmore\n')
  const dry = await text('edit_many', { dry_run: true, edits: [{ file_path: 'pre.txt', old_string: 'in', new_string: 'IN' }, { file_path: 'pre.txt', op: 'append', new_string: 'last' }] })
  assert.match(dry, /pre\.txt after the edits \(> changed\):\n {4}2: S\n {2}> 3: IN\n {4}4: E\n {4}5: more\n {2}> 6: last$/)
  assert.equal(readFileSync(join(root, 'pre.txt'), 'utf8'), 'h\nS\nin\nE\nmore\n')
  const timed = await text('edit_many', { edits: [{ file_path: 'pre.txt', old_string: 'more', new_string: 'MORE' }], verify: { command: 'sleep 3', timeout_ms: 1500 } })
  assert.match(timed, /verify `sleep 3` → timed out after 1\.5s \(no output\)$/)
})

// ---------------------------------------------------------------- search

test('#7 a glob containing / is anchored at each directory root, absolute or relative', async () => {
  const { run } = setup()
  const abs = await run('search', { text: 'foo', paths: [root], include_glob: 'src/*.ts', mode: 'files' })
  assert.deepEqual(abs.files.map(f => f.path), ['src/a.ts'])
  const nested = await run('search', { text: 'foo', paths: ['src'], include_glob: 'deep/*.ts', mode: 'files' })
  assert.deepEqual(nested.files.map(f => f.path), ['src/deep/b.ts'])
  const outside = mkdtempSync(join(tmpdir(), 'deepsea-tool-fs-batch-outside-'))
  try {
    mkdirSync(join(outside, 'src'))
    writeFileSync(join(outside, 'src/x.ts'), 'foo\n')
    writeFileSync(join(outside, 'top.ts'), 'foo\n')
    const v = await run('search', { text: 'foo', paths: [outside], include_glob: 'src/*.ts', mode: 'files' })
    assert.deepEqual(v.files.map(f => f.path), [join(outside, 'src/x.ts')])
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('#8 word with punctuation at its edges matches as rg -w does', async () => {
  const { run } = setup()
  const v = await run('search', { word: 'foo(1)', paths: ['src'], mode: 'files' })
  assert.deepEqual(v.files.map(f => f.path), ['src/a.ts', 'src/deep/b.ts'])
  const none = await run('search', { word: 'foo', paths: ['src/a.ts'], mode: 'count' })
  assert.deepEqual(none.files.map(f => f.matches), [1], 'foobar is not the word foo; foo( is')
})

test('#9 regex errors show the caller\'s pattern and rg\'s diagnostic on their own lines', async () => {
  const { run } = setup()
  await assert.rejects(run('search', { regex: ['ok', 'a[b', 'x{2,1}'] }), (e) => {
    assert.equal(e.code, 'SEARCH_BAD_REGEX')
    assert.equal(e.message, 'search: regex "a[b" is invalid:\n    a[b\n     ^\n  error: unclosed character class\n'
      + 'regex "x{2,1}" is invalid:\n    x{2,1}\n     ^^^^^\n  error: invalid repetition count range, the start must be <= the end')
    assert.doesNotMatch(e.message, /\(\?:|paths resolve against/)
    return true
  })
  assert.match(formatRegexError('p', 'unexpected'), /regex "p" is invalid:\nunexpected/)
})

test('#10 hidden skips .git (unless named); the gap separator is always --', async () => {
  const { run, text } = setup()
  const v = await run('search', { text: 'HIT', hidden: true, mode: 'files' })
  assert.deepEqual(v.files.map(f => f.path), ['.hidden.txt'])
  const git = await run('search', { text: 'HIT', paths: ['.git'], mode: 'files' })
  assert.deepEqual(git.files.map(f => f.path), ['.git/hooks/pre.sample'])
  file('gap.txt', Array.from({ length: 30 }, (_, i) => (i === 2 || i === 25 ? 'HIT' : 'x')).join('\n') + '\n')
  const t = await text('search', { text: 'HIT', paths: ['gap.txt'], context: 1 })
  assert.match(t, /\n {3}4- x\n {2}--\n {2}25- x\n/)
})

// ---------------------------------------------------------------- read_many

test('#11 an offset past the end of the file is a clear inline error', async () => {
  const { run } = setup()
  file('six.txt', '1\n2\n3\n4\n5\n6\n')
  const v = await run('read_many', { files: [{ path: 'six.txt', offset: 50 }, { path: 'six.txt', offset: 6 }] })
  assert.equal(v.files[0].error, 'offset 50 is past the end of the file (6 lines)')
  assert.deepEqual(v.files[1].rows, ['6: 6'])
})

test('#12 the per-entry cap says where to continue', async () => {
  const { run, tool } = setup()
  file('big.txt', Array.from({ length: 2100 }, (_, i) => `l${i + 1}`).join('\n') + '\n')
  const args = { files: ['big.txt'] }
  const v = await run('read_many', args)
  assert.equal(v.files[0].cut, 'cap')
  assert.match(textOf(tool('read_many'), args, v), /\(lines 1-2000 of 2100; 2000-line entry cap; continue with offset 2001\)/)
  // an explicit limit that was honoured is not a cut
  const lim = await run('read_many', { files: [{ path: 'big.txt', limit: 10 }] })
  assert.equal(lim.files[0].cut, undefined)
})

test('#13 bad entries inline, dangling links named, CRLF noted, dot segments normalised', async () => {
  const { run, text } = setup()
  file('ok.txt', 'ok\n')
  file('crlf2.txt', 'a\r\nb\r\n')
  symlinkSync(join(root, 'missing-target'), join(root, 'dangling'))
  const v = await run('read_many', { files: [{ path: 'ok.txt', offset: 0 }, { path: 'ok.txt', limit: 0 }, { path: 'ok.txt', limit: 5000 }, 'dangling', 'crlf2.txt', 'ok.txt'] })
  assert.deepEqual(v.files.map(f => f.error ?? 'read'), [
    'offset must be a positive integer',
    'limit must be a positive integer',
    'limit must be at most 2000',
    'not found (dangling symbolic link: its target does not exist)',
    'read',
    'read',
  ])
  assert.match(await text('read_many', { files: ['crlf2.txt'] }), /\(lines 1-2 of 2; CRLF line endings\)/)
  const fs = { processPath: () => '/real/x' }
  assert.equal(shownPath(fs, { displayPath: '/w/../../tmp/x' }, 'x'), '/real/x')
  assert.equal(shownPath(fs, { displayPath: '/w/tmp/x' }, 'x'), '/w/tmp/x')
})

// ---------------------------------------------------------------- working directory

test('#14 relative paths follow the session\'s current working directory (working_directory cd), as bash does', async () => {
  const wd = { cwd: join(root, 'src') }
  const { run, ctx } = setup({ workingDirectory: wd })
  const s = await run('search', { text: 'foo', paths: ['deep'], mode: 'files' })
  assert.deepEqual(s.files.map(f => f.path), ['deep/b.ts'])
  assert.equal(s.cwd, join(root, 'src'))
  const r = await run('read_many', { files: ['deep/b.ts'] })
  assert.equal(r.files[0].path, join(root, 'src/deep/b.ts'))
  const l = await run('list_dir', {})
  assert.equal(l.roots[0].root, join(root, 'src'))
  const before = readFileSync(join(root, 'src/deep/b.ts'), 'utf8')
  try {
    await run('edit_many', { edits: [{ file_path: 'deep/b.ts', old_string: 'foo(1)', new_string: 'foo(2)' }], verify: { command: 'pwd' } })
    assert.equal(readFileSync(join(root, 'src/deep/b.ts'), 'utf8'), 'foo(2)\n')
    assert.equal(ctx.shellRuns.at(-1).workdir, join(root, 'src'), 'verify runs in the current directory by default')
  } finally {
    writeFileSync(join(root, 'src/deep/b.ts'), before)
  }
})

// ---------------------------------------------------------------- frozen arguments

test('#15 search accepts list-valued selectors although the harness deep-freezes tool arguments', async () => {
  const { run } = setup()
  // regex as a list (no aliases: the empty push still wrote `length`), in both modes
  const files = await run('search', { regex: ['foobar', 'zzz'], paths: ['src'], mode: 'files' })
  assert.deepEqual(files.files.map(f => f.path), ['src/a.ts'])
  const lines = await run('search', { regex: ['foo\\(1\\)', 'zzz'], paths: ['src'] })
  assert.equal(lines.totalMatches, 2)
  // text list with literal + pattern, and exclude_regex list with exclude_pattern: the other two pushes
  const lit = await run('search', { text: ['zzz', 'yyy'], literal: true, pattern: 'foo(1)', paths: ['src'], mode: 'files' })
  assert.deepEqual(lit.files.map(f => f.path).sort(), ['src/a.ts', 'src/deep/b.ts'])
  const excl = await run('search', { text: 'foo', paths: ['src'], exclude_regex: ['foobar'], exclude_pattern: 'zzz', mode: 'files' })
  assert.deepEqual(excl.files.map(f => f.path), ['src/deep/b.ts'])
  // the arguments are read, never written
  const args = deepFreeze({ regex: ['a'], text: ['b'], literal: true, pattern: 'c', exclude_regex: ['d'], exclude_pattern: 'e' })
  parseSearchArgs(args, { maxResults: 250 })
  assert.deepEqual(args, { regex: ['a'], text: ['b'], literal: true, pattern: 'c', exclude_regex: ['d'], exclude_pattern: 'e' })
})
