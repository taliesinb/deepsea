import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SLUG_CHARS, parseSlug } from '../slug.mjs'

test('matches the documented forms', () => {
  assert.equal(parseSlug('foo-bar-baz: rename the widget'), 'foo-bar-baz')
  assert.equal(parseSlug('fix_login2: the form'), 'fix_login2')
  assert.equal(parseSlug('  padded: text'), 'padded')
  assert.equal(parseSlug('single: word'), 'single')
  assert.equal(parseSlug('foo-bar:\nnext line'), 'foo-bar')
  // Colon at the end of the text: the preview may appear before the space is typed.
  assert.equal(parseSlug('foo-bar:'), 'foo-bar')
})

test('rejects prose, URLs and non-slug characters', () => {
  assert.equal(parseSlug('Note: something'), undefined)
  assert.equal(parseSlug('TODO: something'), undefined)
  assert.equal(parseSlug('http://example.com'), undefined)
  assert.equal(parseSlug('foo:bar baz'), undefined)
  assert.equal(parseSlug('foo bar: baz'), undefined)
  assert.equal(parseSlug('-lead: x'), undefined)
  assert.equal(parseSlug(': empty'), undefined)
  assert.equal(parseSlug(''), undefined)
  assert.equal(parseSlug('plain text without a slug'), undefined)
  assert.equal(parseSlug('/command foo: bar'), undefined)
})

test('caps the length', () => {
  assert.equal(parseSlug(`${'a'.repeat(MAX_SLUG_CHARS)}: x`), 'a'.repeat(MAX_SLUG_CHARS))
  assert.equal(parseSlug(`${'a'.repeat(MAX_SLUG_CHARS + 1)}: x`), undefined)
})
