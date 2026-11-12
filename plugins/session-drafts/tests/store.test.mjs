import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DraftStore } from '../store.mjs'
import { parseAttachments, parseDocument } from '../document.mjs'
import { conversationPosition } from '../index.js'

const scratch = () => mkdtempSync(join(tmpdir(), 'deepsea-session-drafts-test-'))
const SESSION = 'session-1'

test('drafts are created, listed newest first, updated, and survive a new store', (t) => {
  const directory = scratch()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let clock = Date.parse('2026-11-07T20:00:00Z')
  const store = new DraftStore(directory, { now: () => new Date(clock) })
  const first = store.create(SESSION, { document: { text: 'one', references: [] }, attachments: [], position: { turn: 2, running: false } })
  clock += 1000
  const second = store.create(SESSION, { document: { text: 'two', references: [] }, attachments: [], position: null })
  assert.deepEqual(store.snapshot(SESSION).drafts.map(draft => draft.id), [second.id, first.id])
  clock += 1000
  const updated = store.update(SESSION, first.id, { document: { text: 'one, edited', references: [] }, attachments: [] })
  assert.equal(updated.revision, 2)
  assert.equal(updated.createdAt, first.createdAt)
  assert.notEqual(updated.updatedAt, first.updatedAt)
  assert.equal(store.update(SESSION, 'missing', { document: { text: '', references: [] }, attachments: [] }), undefined)

  const reopened = new DraftStore(directory)
  const drafts = reopened.snapshot(SESSION).drafts
  assert.equal(drafts.length, 2)
  assert.equal(drafts.find(draft => draft.id === first.id).document.text, 'one, edited')
  assert.deepEqual(drafts.find(draft => draft.id === first.id).position, { turn: 2, running: false })
  assert.equal(JSON.parse(readFileSync(join(directory, SESSION, 'drafts.json'), 'utf8')).v, 1)
})

test('blobs are content-addressed and collected once no draft lists them', (t) => {
  const directory = scratch()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new DraftStore(directory)
  const bytes = new TextEncoder().encode('image bytes')
  const { blob, size } = store.putBlob(SESSION, bytes)
  assert.match(blob, /^[0-9a-f]{64}$/)
  assert.equal(size, bytes.byteLength)
  assert.deepEqual(store.putBlob(SESSION, bytes), { blob, size })
  const path = store.blobPath(SESSION, blob)
  assert.ok(path !== undefined && existsSync(path))
  assert.equal(store.blobPath(SESSION, '../drafts.json'), undefined)

  const draft = store.create(SESSION, { document: { text: 'x', references: [] }, attachments: [{ blob, name: 'a.png', type: 'image/png', size }], position: null })
  // An hour-old upload no draft lists is removed; a listed one is kept.
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(path, old, old)
  store.collect(SESSION)
  assert.ok(existsSync(path))
  store.remove(SESSION, draft.id)
  assert.ok(!existsSync(path))
})

test('fresh unlisted uploads are kept for a draft being created', (t) => {
  const directory = scratch()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new DraftStore(directory)
  const { blob } = store.putBlob(SESSION, new Uint8Array([1, 2, 3]))
  store.create(SESSION, { document: { text: 'other', references: [] }, attachments: [], position: null })
  assert.ok(store.blobPath(SESSION, blob) !== undefined)
})

test('session ids that are not plain names are refused', () => {
  const store = new DraftStore(scratch())
  assert.throws(() => store.get('../escape'), /invalid session id/)
})

test('documents: chips, a command chip and quotes are kept; inconsistent spans are refused', () => {
  const limits = { maxChars: 1000 }
  const text = '/goal fix @src/a.ts now'
  const reference = { source: 'file', ref: 'src/a.ts', offset: 10, length: 9, label: 'a.ts', clipboardText: '@src/a.ts', appearance: 'file' }
  const parsed = parseDocument({ text, references: [reference], command: { token: '/goal ' } }, limits)
  assert.deepEqual(parsed, { document: { text, references: [reference], command: { token: '/goal ' } } })
  assert.ok('error' in parseDocument({ text, references: [{ ...reference, offset: 9 }] }, limits))
  assert.ok('error' in parseDocument({ text, references: [], command: { token: '/plan ' } }, limits))
  assert.ok('error' in parseDocument({ text: 'x'.repeat(1001), references: [] }, limits))
  assert.ok('error' in parseDocument({ text: 'q', references: [], quotes: [{ offset: 0, length: 5, text: 'q' }] }, limits))
  assert.deepEqual(parseDocument({ text: 'plain', references: [], quotes: [] }, limits), { document: { text: 'plain', references: [] } })
})

test('attachments must name uploaded blobs', () => {
  const blob = 'a'.repeat(64)
  const options = { maxAttachments: 2, exists: candidate => candidate === blob }
  assert.deepEqual(parseAttachments([{ blob, name: 'a.png', type: 'image/png', size: 3 }], options),
    { attachments: [{ blob, name: 'a.png', type: 'image/png', size: 3 }] })
  assert.ok('error' in parseAttachments([{ blob: 'b'.repeat(64), name: 'b', type: '', size: 1 }], options))
  assert.ok('error' in parseAttachments([{}, {}, {}], options))
})

test('the conversation position is the last turn started, and whether it still runs', () => {
  assert.deepEqual(conversationPosition([]), { turn: 0, running: false })
  assert.deepEqual(conversationPosition([{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1 } }]), { turn: 1, running: false })
  assert.deepEqual(conversationPosition([{ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } }, { type: 'step/start', data: { step: 1 } }]), { turn: 2, running: true })
})
