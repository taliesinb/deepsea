import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeTarget, encodeTarget, remoteKeyOfRow } from '../src/client/targets.ts'

test('local targets round-trip', () => {
  const key = encodeTarget({ kind: 'local', sessionId: 'session-abc' })
  assert.equal(key, 'local:session-abc')
  assert.deepEqual(decodeTarget(key), { kind: 'local', sessionId: 'session-abc' })
})

test('remote targets round-trip and split at the last colon', () => {
  const key = encodeTarget({ kind: 'remote', workspaceId: 'ws:with:colons', sessionId: 'session-1' })
  assert.equal(key, 'remote:ws:with:colons:session-1')
  assert.deepEqual(decodeTarget(key), { kind: 'remote', workspaceId: 'ws:with:colons', sessionId: 'session-1' })
})

test('malformed keys decode to undefined', () => {
  for (const bad of ['', 'session-abc', 'local:', 'remote:', 'remote:onlyone', 'remote::x', 'remote:ws:', 'other:x']) {
    assert.equal(decodeTarget(bad), undefined, bad)
  }
})

test('remoteKeyOfRow accepts the data-deepsea-remote-session value', () => {
  assert.equal(remoteKeyOfRow('ws1:session-9'), 'remote:ws1:session-9')
  assert.equal(remoteKeyOfRow('nocolon'), undefined)
})
