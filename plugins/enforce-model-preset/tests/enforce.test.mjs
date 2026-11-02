import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply, install, isLocked, matchRule, name, resolveConfig } from '../index.js'

const DEFAULT_RULES = [
  { provider: 'apple', preset: 'minimal-no-tools' },
  { provider: 'lmstudio', preset: 'minimal' },
  { provider: '*', preset: 'standard' },
]
const settle = () => new Promise(resolve => setImmediate(resolve))

/**
 * A Cordis-shaped stand-in: sessions with a preset and a turn boundary, live
 * agents, a default model, and an agentPresets.select that refuses started
 * sessions the way DSH does.
 */
function fakeContext({ defaultModel = { provider: 'scripted', model: 'script' } } = {}) {
  const listeners = []
  const lines = []
  const selects = []
  const sessions = new Map()
  const ctx = {
    lines, selects, sessions,
    logger: { info: m => lines.push(['info', m]), warn: m => lines.push(['warn', m]) },
    on(event, callback) { listeners.push([event, callback]) },
    emit(event, ...args) { for (const [key, callback] of listeners) if (key === event) callback(...args) },
    agents: { get: id => sessions.get(id)?.agent },
    agentDefaultModel: { currentSelection: () => { if (defaultModel instanceof Error) throw defaultModel; return defaultModel } },
    sessionProjections: {
      stateOf(session, key) {
        const record = sessions.get(session.id)
        if (key === 'agentPreset') return record.preset
        if (key === 'turnBoundary') return { openTurnStartSeq: null, lastTurn: record.turns }
        throw new Error(`unexpected projection ${key}`)
      },
    },
    agentPresets: {
      async select(agent, preset) {
        selects.push([agent.session.id, preset])
        const record = sessions.get(agent.session.id)
        if (record.turns > 0) throw Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' })
        if (preset === 'unknown') throw new Error('Unknown agent preset: unknown')
        record.preset = preset
        return preset
      },
    },
  }
  ctx.addSession = (id, { preset = 'standard', turns = 0, depth = 0 } = {}) => {
    const session = { id, header: depth > 0 ? { delegationDepth: depth } : {} }
    const agent = { id, session }
    sessions.set(id, { preset, turns, agent })
    return agent
  }
  return ctx
}

const selection = (provider, model = 'm') => ({ type: 'model/selection', data: { provider, model } })

test('configuration: rules in order, strict fields, the Cordis wrapper', () => {
  assert.equal(name, 'deepsea-enforce-model-preset')
  assert.deepEqual(resolveConfig(), { rules: [], trace: false })
  const resolved = resolveConfig({ rules: DEFAULT_RULES, trace: true })
  assert.deepEqual(resolved, { rules: DEFAULT_RULES, trace: true })
  assert.deepEqual(resolveConfig(resolved), resolved)
  assert.equal(Config['~standard'].vendor, name)
  for (const [input, pattern] of [
    [{ rule: [] }, /expected only rules and trace/], [{ rules: {} }, /rules must be a list/],
    [{ trace: 'yes' }, /trace must be true or false/], [{ rules: [null] }, /rules\[0\] must be a mapping/],
    [{ rules: [{ provider: 'apple', preset: 'x', models: 'y' }] }, /unknown field models/],
    [{ rules: [{ preset: 'x' }] }, /provider must be/], [{ rules: [{ provider: 'a', model: '' , preset: 'x' }] }, /model must be/],
    [{ rules: [{ provider: 'a' }] }, /preset must be/],
  ]) {
    assert.throws(() => resolveConfig(input), pattern)
    assert.equal(Config['~standard'].validate(input).issues.length, 1)
  }
})

test('rules: first match wins; provider and model wildcards', () => {
  const rules = [{ provider: 'apple', model: 'foundation', preset: 'a' }, { provider: 'apple', model: '*', preset: 'b' }, { provider: '*', preset: 'c' }]
  assert.equal(matchRule(rules, { provider: 'apple', model: 'foundation' }).preset, 'a')
  assert.equal(matchRule(rules, { provider: 'apple', model: 'other' }).preset, 'b')
  assert.equal(matchRule(rules, { provider: 'openai', model: 'x' }).preset, 'c')
  assert.equal(matchRule(rules.slice(0, 2), { provider: 'openai', model: 'x' }), undefined)
  assert.equal(isLocked({ code: 'agent-preset/locked' }), true)
  assert.equal(isLocked(new Error('agent-preset/locked: This session has already started')), true)
  assert.equal(isLocked(new Error('Unknown agent preset: x')), false)
})

test('a blank session selecting a mapped model is switched; one already on the preset is left alone', async () => {
  const ctx = fakeContext()
  install(ctx, { rules: DEFAULT_RULES })
  const { session } = ctx.addSession('s1')
  ctx.emit('session/event', session, selection('apple', 'foundation'))
  await settle()
  assert.deepEqual(ctx.selects, [['s1', 'minimal-no-tools']])
  assert.equal(ctx.sessions.get('s1').preset, 'minimal-no-tools')
  ctx.emit('session/event', session, selection('apple', 'foundation'))
  await settle()
  assert.equal(ctx.selects.length, 1, 'already on the target preset')
  ctx.emit('session/event', session, selection('openai', 'gpt'))
  await settle()
  assert.equal(ctx.sessions.get('s1').preset, 'standard', 'the catch-all restores standard')
  ctx.emit('session/event', session, { type: 'request/header', data: { header: { config: { provider: 'apple', model: 'x' } } } })
  await settle()
  assert.equal(ctx.selects.length, 2, 'only model selections are enforced')
  assert.ok(ctx.lines.some(([level, m]) => level === 'info' && m.includes('→ preset "minimal-no-tools"')))
})

test('started sessions and subagents keep their composition; other refusals are reported', async () => {
  const ctx = fakeContext()
  install(ctx, { rules: [{ provider: 'apple', preset: 'minimal-no-tools' }, { provider: 'bad', preset: 'unknown' }] })
  const started = ctx.addSession('started', { turns: 1 })
  ctx.emit('session/event', started.session, selection('apple'))
  await settle()
  assert.deepEqual(ctx.selects, [['started', 'minimal-no-tools']])
  assert.equal(ctx.sessions.get('started').preset, 'standard')
  assert.equal(ctx.lines.filter(([level]) => level === 'warn').length, 0, 'the lock is the intended outcome')

  const child = ctx.addSession('child', { depth: 1 })
  ctx.emit('session/event', child.session, selection('apple'))
  ctx.emit('agent/created', { agent: child })
  await settle()
  assert.equal(ctx.selects.length, 1, 'subagents are never touched')

  const blank = ctx.addSession('blank')
  ctx.emit('session/event', blank.session, selection('bad'))
  await settle()
  assert.match(ctx.lines.find(([level]) => level === 'warn')[1], /could not switch session "blank" to preset "unknown": .*Unknown agent preset/)

  ctx.sessions.set('gone', { preset: 'standard', turns: 0, agent: undefined })
  ctx.emit('session/event', { id: 'gone', header: {} }, selection('apple'))
  await settle()
  assert.equal(ctx.selects.length, 2, 'no live agent, nothing to switch')
})

test('a session created on a mapped default model is switched at creation, unless it has started', async () => {
  const ctx = fakeContext({ defaultModel: { provider: 'apple', model: 'foundation' } })
  install(ctx, { rules: DEFAULT_RULES })
  ctx.emit('agent/created', { agent: ctx.addSession('fresh') })
  ctx.emit('agent/created', { agent: ctx.addSession('resumed', { turns: 3 }) })
  await settle()
  assert.deepEqual(ctx.selects, [['fresh', 'minimal-no-tools']])

  const unmapped = fakeContext({ defaultModel: { provider: 'openai', model: 'gpt' } })
  install(unmapped, { rules: [{ provider: 'apple', preset: 'minimal-no-tools' }] })
  unmapped.emit('agent/created', { agent: unmapped.addSession('s') })
  const broken = fakeContext({ defaultModel: new Error('no default') })
  install(broken, { rules: DEFAULT_RULES })
  broken.emit('agent/created', { agent: broken.addSession('s') })
  await settle()
  assert.deepEqual([...unmapped.selects, ...broken.selects], [])
})

test('no rules: nothing is installed; apply returns no effect value', () => {
  const ctx = fakeContext()
  assert.equal(apply(ctx, {}), undefined)
  assert.match(ctx.lines[0][1], /nothing to enforce/)
})

test('trace: JSONL in the variant log directory, one file per server process, only when configured', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'deepsea-enforce-model-preset-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A variant home in a DeepSea root: the trace goes to <log root>/<variant name>/plugins/<name>/.
  const env = { DEEPSEA_ROOT: join(root, '.deepsea'), DEEPSEA_LOG_ROOT: join(root, 'Logs') }
  const home = join(root, '.deepsea', 'test-variant')
  mkdirSync(home, { recursive: true })
  const dir = join(root, 'Logs', 'io.github.taliesinb.deepsea.test-variant', 'plugins', 'enforce-model-preset')

  const quiet = fakeContext({ defaultModel: { provider: 'apple', model: 'foundation' } })
  install(quiet, { rules: DEFAULT_RULES }, { home, env })
  quiet.emit('agent/created', { agent: quiet.addSession('s0') })
  await settle()
  assert.throws(() => readdirSync(dir), /ENOENT/, 'off by default')

  const ctx = fakeContext({ defaultModel: { provider: 'apple', model: 'foundation' } })
  install(ctx, { rules: DEFAULT_RULES, trace: true }, { home, env })
  ctx.emit('agent/created', { agent: ctx.addSession('s1') })
  await settle()
  const files = readdirSync(dir).filter(f => f !== 'latest.jsonl')
  assert.equal(files.length, 1)
  assert.match(files[0], new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-${process.pid}\\.jsonl$`))
  const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines.map(line => line.event), ['start', 'agent-created', 'default-selection', 'enforce', 'selected'])
  assert.equal(lines[0].variant, 'io.github.taliesinb.deepsea.test-variant')
  assert.equal(lines[0].plugin, '@deepsea/enforce-model-preset@0.1.0')
  assert.deepEqual(lines[2].rule, { provider: 'apple', preset: 'minimal-no-tools' })
  assert.deepEqual(lines[3], { t: lines[3].t, event: 'enforce', session: 's1', current: 'standard', target: 'minimal-no-tools' })

  // Any other home: <home>/logs/plugins/<name>/.
  const plain = join(root, 'plain-home')
  const other = fakeContext({ defaultModel: { provider: 'apple', model: 'foundation' } })
  install(other, { rules: DEFAULT_RULES, trace: true }, { home: plain, env: {} })
  other.emit('agent/created', { agent: other.addSession('s2') })
  await settle()
  assert.equal(readdirSync(join(plain, 'logs', 'plugins', 'enforce-model-preset')).filter(f => f.endsWith('.jsonl') && f !== 'latest.jsonl').length, 1)
})
