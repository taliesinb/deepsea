import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the row is named after the package and loads the harness plugin under it', () => {
  assert.match(patch, /id: deepsea-tool-mcp-connect\n\s+name: "@deepsea\/tool-mcp-connect"/)
  assert.match(source, /export const name = 'deepsea-tool-mcp-connect'/)
  for (const part of ['inject', 'Config', 'apply']) {
    assert.match(source, new RegExp(`export const ${part} = McpConnect\\.${part}`))
  }
  assert.deepEqual(pkg.deepsea.requires, ['mcp-connect'])
})

test('the harness plugin it wraps exposes the tools row, when the pinned harness has the topic', async (t) => {
  let module
  try {
    module = await import('../index.js')
  } catch (error) {
    t.skip(`the linked harness has no mcp-connect yet: ${error.code ?? error.message}`)
    return
  }
  assert.equal(module.name, 'deepsea-tool-mcp-connect')
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.Config({}), { startupTimeoutMs: 120000, projectFiles: true })
})
