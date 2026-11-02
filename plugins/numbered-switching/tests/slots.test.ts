import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSlotState, holderOf, prune, restoreSlotState, slotOf, touch } from '../src/client/slots.ts'

function seq(ids: string[], count = 5) {
  return ids.reduce((state, id) => touch(state, id), createSlotState(count))
}

test('novel sessions fill slots in order', () => {
  const s = seq(['a', 'b', 'c'])
  assert.deepEqual(s.slots, ['a', 'b', 'c', undefined, undefined])
  assert.equal(slotOf(s, 'b'), 2)
  assert.equal(holderOf(s, 3), 'c')
  assert.equal(holderOf(s, 4), undefined)
})

test('revisiting a holder keeps its number and only bumps recency', () => {
  const s = seq(['a', 'b', 'c', 'a'])
  assert.deepEqual(s.slots, ['a', 'b', 'c', undefined, undefined])
  assert.ok(s.lastUsed['a'] > s.lastUsed['c'])
})

test('a sixth session evicts the least recently used holder, numbers stay put', () => {
  // Fill 1..5, then revisit b and a: c is now the LRU.
  const s = seq(['a', 'b', 'c', 'd', 'e', 'b', 'a'])
  const next = touch(s, 'f')
  assert.deepEqual(next.slots, ['a', 'b', 'f', 'd', 'e'])
  assert.equal(next.lastUsed['c'], undefined)
  // The other holders kept their numbers.
  assert.equal(slotOf(next, 'a'), 1)
  assert.equal(slotOf(next, 'e'), 5)
})

test('eviction always picks the oldest, across repeated rounds', () => {
  let s = seq(['a', 'b', 'c'], 3)
  s = touch(s, 'd') // evicts a (slot 1)
  assert.deepEqual(s.slots, ['d', 'b', 'c'])
  s = touch(s, 'e') // evicts b (slot 2)
  assert.deepEqual(s.slots, ['d', 'e', 'c'])
  s = touch(s, 'c') // bump c; now d is oldest
  s = touch(s, 'f')
  assert.deepEqual(s.slots, ['f', 'e', 'c'])
})

test('prune frees slots of dead sessions and leaves the rest in place', () => {
  const s = seq(['a', 'b', 'c'])
  const pruned = prune(s, id => id !== 'b')
  assert.deepEqual(pruned.slots, ['a', undefined, 'c', undefined, undefined])
  assert.equal(pruned.lastUsed['b'], undefined)
  // The freed slot is reused before any eviction.
  assert.deepEqual(touch(pruned, 'z').slots, ['a', 'z', 'c', undefined, undefined])
  // No change → same object (cheap subscription no-op).
  assert.equal(prune(s, () => true), s)
})

test('restoreSlotState accepts its own JSON and rejects junk', () => {
  const s = seq(['a', 'b'])
  const restored = restoreSlotState(JSON.parse(JSON.stringify(s)), 5)
  assert.deepEqual(restored, s)
  assert.equal(restoreSlotState(null, 5), undefined)
  assert.equal(restoreSlotState({ slots: 'nope' }, 5), undefined)
  // Coerces to the slot count in force and drops stamps of non-holders.
  const wide = restoreSlotState({ slots: ['a', 'b', 'c', 'd', 'e', 'f'], lastUsed: { a: 1, zz: 9 }, tick: 9 }, 3)
  assert.deepEqual(wide?.slots, ['a', 'b', 'c'])
  assert.deepEqual(wide?.lastUsed, { a: 1 })
})

test('slot count is clamped to 1..9', () => {
  assert.equal(createSlotState(0).slots.length, 1)
  assert.equal(createSlotState(42).slots.length, 9)
})
