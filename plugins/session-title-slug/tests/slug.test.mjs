import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SLUG_CHARS, parseSlug, stripSlug } from '../slug.mjs'

test('stripSlug removes the prefix and the whitespace around it', () => {
  assert.equal(stripSlug('test-opus-5-5: hello do you read me?'), 'hello do you read me?')
  assert.equal(stripSlug('  foo:\n\n  next line'), 'next line')
  assert.equal(stripSlug('foo:'), '')
  assert.equal(stripSlug('Note: prose'), undefined)
  assert.equal(stripSlug('foo:bar'), undefined)
  assert.equal(stripSlug(`${'a'.repeat(MAX_SLUG_CHARS + 1)}: x`), undefined)
})

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
