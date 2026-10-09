/**
 * The two rows: the package root (deepsea-tool-transcripts, global) serves the
 * routes and registers no tool; the tools row (deepsea-tool-transcripts-tools,
 * joins the presets) registers the seven tools and no route. Both from one
 * package: exports, bundle patch, join rule, titles.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as root from '../index.js'
import * as tools from '../tools.js'
import { fakeCtx } from './fake-ctx.mjs'

const withTools = (ctx) => { const registered = []; ctx.tools = { register(tool) { registered.push(tool.name) } }; return registered }

test('the root row serves the routes and registers no tool', () => {
  const ctx = fakeCtx({ snapshots: [] })
  const registered = withTools(ctx)
  root.apply(ctx, root.Config({}))
  assert.equal(root.name, 'deepsea-tool-transcripts')
  assert.deepEqual(root.inject, ['sessionQuery'])
  assert.deepEqual([...ctx.routes.keys()], ['/api/deepsea-session-introspect/v1/capabilities', '/api/deepsea-session-introspect/v1/sessions', '/api/deepsea-session-introspect/v1/session'])
  assert.deepEqual(registered, [])
  // A tools config left on this row from before the split validates and is ignored.
  assert.doesNotThrow(() => root.Config({ scope: 'workspace', maxChars: 5000 }))
})

test('the tools row registers the seven tools and no route', () => {
  const ctx = fakeCtx({ snapshots: [] })
  const registered = withTools(ctx)
  tools.apply(ctx, tools.Config({}))
  assert.equal(tools.name, 'deepsea-tool-transcripts-tools')
  assert.deepEqual(tools.inject, ['tools', 'sessionQuery'])
  assert.deepEqual(registered, ['transcript_find', 'transcript_outline', 'transcript_read', 'transcript_tool_stats', 'transcript_grep', 'transcript_event', 'transcript_export'])
  assert.equal(ctx.routes.size, 0)
  // Mounted once per preset: a second mount registers no route either, so nothing collides.
  tools.apply(ctx, tools.Config({}))
  assert.equal(ctx.routes.size, 0)
})

test('package: both rows in the bundle patch, the ./tools exports, the join rule and both titles', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./tools'], './tools.js')
  assert.equal(pkg.exports['./tools/locale/*.json'], './locale/tools/*.json')
  assert.deepEqual(pkg.deepsea.presets, { joinWith: ['@deepseek-ai/dsh-tool-subagent'], module: '@deepsea/tool-transcripts/tools' })
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- id: deepsea-tool-transcripts\n\s+name: "@deepsea\/tool-transcripts"\n/)
  assert.match(patch, /- id: deepsea-tool-transcripts-tools\n\s+name: "@deepsea\/tool-transcripts\/tools"\n/)
  const title = (path) => JSON.parse(readFileSync(new URL(`../locale/${path}.json`, import.meta.url), 'utf8')).meta.title
  assert.equal(title('en'), 'Transcript sharing')
  assert.equal(title('tools/en'), 'Transcript tools')
  assert.ok(title('zh') && title('tools/zh') && title('zh') !== title('tools/zh'))
})
