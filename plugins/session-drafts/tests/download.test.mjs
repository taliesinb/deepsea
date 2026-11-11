import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strFromU8, unzipSync } from 'fflate'
import { attachmentDisposition, draftDownload, draftMarkdown, safeFileName, uniqueNames } from '../download.mjs'

test('a draft without attachments is a Markdown file of its text', () => {
  const result = draftDownload({ document: { text: 'Fix the parser' }, attachments: [] }, '2026-11-07-2030.My session', () => { throw new Error('unused') })
  assert.equal(result.filename, '2026-11-07-2030.My session.draft.md')
  assert.equal(result.type, 'text/markdown; charset=utf-8')
  assert.equal(strFromU8(result.body), 'Fix the parser\n')
})

test('a draft with attachments is a zip of draft.md and the files, linked from the text', () => {
  const blobs = { a: new TextEncoder().encode('PNG'), b: new TextEncoder().encode('notes'), c: new TextEncoder().encode('other') }
  const draft = {
    document: { text: 'See these:' },
    attachments: [
      { blob: 'a', name: 'shot.png', type: 'image/png' },
      { blob: 'b', name: 'draft.md', type: 'text/markdown' },
      { blob: 'c', name: 'shot.png', type: 'image/png' },
    ],
  }
  const result = draftDownload(draft, 'base', blob => blobs[blob])
  assert.equal(result.filename, 'base.draft.zip')
  const files = unzipSync(result.body)
  assert.deepEqual(Object.keys(files).sort(), ['draft 2.md', 'draft.md', 'shot 2.png', 'shot.png'])
  assert.equal(strFromU8(files['shot.png']), 'PNG')
  assert.equal(strFromU8(files['draft 2.md']), 'notes')
  assert.equal(strFromU8(files['draft.md']), 'See these:\n\n![shot.png](<shot.png>)\n[draft 2.md](<draft 2.md>)\n![shot 2.png](<shot 2.png>)\n')
})

test('names lose characters file systems refuse', () => {
  assert.equal(safeFileName('a/b:c*?"<>|d', 'x'), 'a-b-c------d')
  assert.equal(safeFileName('  ..hidden  ', 'x'), 'hidden')
  assert.equal(safeFileName('///', 'x'), '---')
  assert.equal(safeFileName('', 'x'), 'x')
  assert.deepEqual(uniqueNames(['a.txt', 'A.txt', 'b'], ['b']), ['a.txt', 'A 2.txt', 'b 2'])
  assert.equal(draftMarkdown('x', [{ name: 'a [1].txt', type: 'text/plain' }]), 'x\n\n[a \\[1\\].txt](<a [1].txt>)\n')
})

test('the disposition offers the name, with an ASCII fallback', () => {
  assert.equal(attachmentDisposition('2026.Café "x".draft.md'),
    `attachment; filename="2026.Caf_ _x_.draft.md"; filename*=UTF-8''${encodeURIComponent('2026.Café "x".draft.md')}`)
})
