import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowKey } from '../src/client/badges.ts'

const row = (attributes: Record<string, string>) => ({ getAttribute: (name: string) => attributes[name] ?? null })

test('a local row is keyed by its data-row-key', () => {
  assert.equal(rowKey(row({ 'data-row-key': 'session:session-abc' })), 'local:session-abc')
})

test('a remote row is keyed by data-deepsea-remote-session, which wins', () => {
  assert.equal(rowKey(row({ 'data-deepsea-remote-session': 'ws1:session-9' })), 'remote:ws1:session-9')
  assert.equal(rowKey(row({ 'data-deepsea-remote-session': 'ws1:session-9', 'data-row-key': 'session:x' })), 'remote:ws1:session-9')
  assert.equal(rowKey(row({ 'data-deepsea-remote-session': 'nocolon' })), undefined)
})

test('rows without a session identity get no key', () => {
  assert.equal(rowKey(row({})), undefined)
  assert.equal(rowKey(row({ 'data-row-key': 'workspace:w1' })), undefined)
  assert.equal(rowKey(row({ 'data-row-key': 'session:' })), undefined)
})
