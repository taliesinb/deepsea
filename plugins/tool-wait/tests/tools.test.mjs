// The tools row (deepsea-tool-wait-tools): the tool and the prompt section, the
// waits it starts in the root's service (so the root's routes skip them), and
// its fallback when no root row runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as root from '../index.js'
import { Config, PROMPT_HINT, PROMPT_SECTION, apply, inject, name } from '../tools.js'
import { exec, fakeCtx } from './fake-ctx.mjs'

const control = (ctx, body) => ctx.routes.get(root.CONTROL_PATH).fetch(new Request(`http://x${root.CONTROL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

test('apply registers wait and the prompt section; promptHint: false leaves the section out', () => {
  const ctx = fakeCtx()
  apply(ctx, Config({}))
  assert.equal(name, 'deepsea-tool-wait-tools')
  assert.deepEqual(inject, ['tools'])
  assert.ok(ctx.tools.get('wait'))
  assert.equal(ctx.routes.size, 0)
  assert.equal(ctx.services.size, 0, 'provides no service')
  assert.equal(ctx.sections[0].name, PROMPT_SECTION)
  assert.equal(PROMPT_SECTION, 'tool:deepsea-tool-wait')
  assert.equal(ctx.sections[0].text({ scope: undefined }), PROMPT_HINT)
  const quiet = fakeCtx()
  apply(quiet, Config({ promptHint: false }))
  assert.equal(quiet.sections.length, 0)
})

test('maxSeconds is this row\'s config', async () => {
  const ctx = fakeCtx()
  apply(ctx, Config({ maxSeconds: 5 }))
  await assert.rejects(ctx.tools.get('wait').execute({ seconds: 6 }, exec('call-0')), (error) => error.code === 'INVALID_WAIT')
})

test('a wait started by the tools row (mounted first, as in a preset) is skipped through the root\'s control route', async () => {
  const services = new Map()
  const tools = fakeCtx(services)
  apply(tools, Config({}))
  const host = fakeCtx(services)
  root.apply(host, root.Config({}))
  const running = tools.tools.get('wait').execute({ seconds: 30, reason: 'tests' }, exec('call-1'))
  assert.equal(services.get('deepseaWait').get('call-1').reason, 'tests')
  assert.equal((await control(host, { action: 'skip', callId: 'call-1', sessionId: 'session-1' })).status, 200)
  assert.equal((await running).outcome, 'skipped')
  const aborted = tools.tools.get('wait').execute({ seconds: 30 }, exec('call-2'))
  assert.equal((await control(host, { action: 'abort', callId: 'call-2', sessionId: 'session-1' })).status, 200)
  await assert.rejects(aborted, (error) => error.code === 'USER_ABORTED_WAIT')
})

test('without the root row the tool still waits, uncontrolled; unloading the row fails those waits', async () => {
  const ctx = fakeCtx()
  apply(ctx, Config({}))
  assert.equal((await ctx.tools.get('wait').execute({ seconds: 0.01 }, exec('call-1'))).outcome, 'completed')
  const pending = ctx.tools.get('wait').execute({ seconds: 30 }, exec('call-2'))
  ctx.dispose()
  await assert.rejects(pending, (error) => error.code === 'WAIT_UNLOADED')
})

test('package: both rows in the bundle patch, the ./tools exports, the join rule and both titles', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./tools'], './tools.js')
  assert.equal(pkg.exports['./tools/locale/*.json'], './locale/tools/*.json')
  assert.deepEqual(pkg.deepsea.presets, { joinWith: ['@deepseek-ai/dsh-tool-jobs'], module: '@deepsea/tool-wait/tools' })
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- id: deepsea-tool-wait\n\s+name: "@deepsea\/tool-wait"\n/)
  assert.match(patch, /- id: deepsea-tool-wait-tools\n\s+name: "@deepsea\/tool-wait\/tools"\n/)
  const title = (path) => JSON.parse(readFileSync(new URL(`../locale/${path}.json`, import.meta.url), 'utf8')).meta.title
  assert.equal(title('en'), 'Wait controls')
  assert.equal(title('tools/en'), 'Wait tool')
  assert.ok(title('zh') && title('tools/zh') && title('zh') !== title('tools/zh'))
})
