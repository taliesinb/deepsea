import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../index.js'

test('the row restricts its agent scope to no global tool', () => {
  assert.equal(plugin.name, 'deepsea-no-global-tools')
  assert.deepEqual(plugin.inject, ['tools'])
  const calls = []
  const result = plugin.apply({ tools: { restrict: filter => { calls.push(filter); return () => {} } } })
  assert.equal(result, undefined, 'apply returns no effect value; restrict registers its own')
  assert.deepEqual(calls, [{ allow: [] }])
})

test('the bundle inserts the minimal-no-tools preset: complete persona plus this row', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const rows = patch.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  assert.match(rows, /- id: deepsea-preset-minimal-no-tools\n\s+name: '@deepseek-ai\/dsh-agent-preset'/)
  assert.match(rows, /\n\s+id: minimal-no-tools\n/)
  assert.match(rows, /name: '@deepseek-ai\/dsh-persona'\n\s+config:\n\s+prefix: .+\n\s+complete: true\n\s+includeRuntimeContext: false/)
  assert.match(rows, /- id: deepsea-no-global-tools\n\s+name: "@deepsea\/no-global-tools"\n?$/)
  assert.equal((rows.match(/^- insert:/gm) ?? []).length, 1, 'one insert; no profile-level row of this package')
})
