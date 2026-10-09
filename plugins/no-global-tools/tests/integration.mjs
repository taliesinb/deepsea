/**
 * The row against the harness's real tool registry and agent scopes. From the
 * repository root:
 *
 *   (cd harness && node --import tsx/esm --test "$OLDPWD/plugins/no-global-tools/tests/integration.mjs")
 *
 * Every harness import is the build's source plane (Cordis included), so the
 * registry, scopes and plugin share one identity.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../../../harness/vendor/cordis/src/index.ts'
import { createScope } from '../../../harness/packages/core/scope/src/index.ts'
import SystemPrompt from '../../../harness/packages/core/system-prompt/src/index.ts'
import ToolRuntime from '../../../harness/packages/core/tools/src/index.ts'
import * as NoGlobalTools from '../index.js'

function tool(name) {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => `ran:${name}`,
  }
}

async function mount() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** An agent scope keyed by an Agent-like object, minted as the agent loop does. */
async function agentScope(ctx, id) {
  const key = { id }
  let scope
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
  return { scope, key }
}

const names = (ctx, key) => ctx.tools.schemas(key).map(t => t.name).sort()

test('mounted in an agent scope: no global tool, scoped tools kept, other agents untouched, lifted on unload', async () => {
  const ctx = await mount()
  for (const name of ['bash', 'read', 'web_fetch']) ctx.tools.register(tool(name))
  const restricted = await agentScope(ctx, 'restricted')
  const ordinary = await agentScope(ctx, 'ordinary')
  restricted.scope.ctx.tools.register(tool('preset_local'))

  const fiber = await restricted.scope.ctx.plugin(NoGlobalTools)
  assert.deepEqual(names(ctx, restricted.key), ['preset_local'])
  ctx.tools.register(tool('registered_later'))
  assert.deepEqual(names(ctx, restricted.key), ['preset_local'], 'a global tool registered later stays hidden')
  assert.deepEqual(names(ctx, ordinary.key), ['bash', 'read', 'registered_later', 'web_fetch'])
  assert.deepEqual(names(ctx), ['bash', 'read', 'registered_later', 'web_fetch'])

  await fiber.dispose()
  assert.deepEqual(names(ctx, restricted.key), ['bash', 'preset_local', 'read', 'registered_later', 'web_fetch'])
})

test('outside an agent scope it refuses, so a profile row fails instead of masking every agent', async () => {
  const ctx = await mount()
  ctx.tools.register(tool('bash'))
  assert.throws(() => NoGlobalTools.apply(ctx), /requires a scoped context/)
  assert.deepEqual(names(ctx), ['bash'])
})
