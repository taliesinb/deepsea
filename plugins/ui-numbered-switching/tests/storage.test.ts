import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateStorageKey, OLD_STORAGE_KEY, STORAGE_KEY } from '../src/client/storage.ts'

test('migrateStorageKey moves the pre-rename slot table once and keeps a newer one', () => {
  const entries = new Map<string, string>()
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) }, removeItem: (key: string) => { entries.delete(key) } }
  assert.equal(STORAGE_KEY, 'deepsea.ui-numbered-switching.slots')
  entries.set(OLD_STORAGE_KEY, '{"slots":["a"]}')
  migrateStorageKey(OLD_STORAGE_KEY, STORAGE_KEY, storage)
  assert.deepEqual([...entries], [[STORAGE_KEY, '{"slots":["a"]}']])
  entries.set(OLD_STORAGE_KEY, '{"slots":[]}')
  migrateStorageKey(OLD_STORAGE_KEY, STORAGE_KEY, storage)
  assert.deepEqual([...entries], [[STORAGE_KEY, '{"slots":["a"]}']])
  migrateStorageKey(OLD_STORAGE_KEY, STORAGE_KEY, undefined)
})
