import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentTitlesOf, classifyTitle, slugify, styleTitle } from '../title.mjs'
import { Config, NUDGE_CONTEXT, PROMPT_SECTION, apply, createRenameTool, nudgeText, promptSection, resolveStyle, titlerSettings } from '../index.js'

test('slugify mirrors the titler\'s slug form', () => {
  assert.equal(slugify('Fix the Login Redirect loop!', 5), 'fix-the-login-redirect-loop')
  assert.equal(slugify('Fix the Login Redirect loop!', 3), 'fix-the-login')
  assert.equal(slugify('Café Ünïcode / test', 5), 'cafe-unicode-test')
  assert.equal(slugify('   ', 5), '')
})

test('styleTitle: natural collapses whitespace, slug slugs', () => {
  assert.equal(styleTitle('  Fix   login\nredirect ', { style: 'natural', maxWords: 5 }), 'Fix login redirect')
  assert.equal(styleTitle('Fix login redirect', { style: 'slug', maxWords: 5 }), 'fix-login-redirect')
})

test('agentTitlesOf reads persisted result meta only', () => {
  const events = [
    { type: 'tool/call', data: { name: 'rename_chat', arguments: '{"title":"x"}' } },
    { type: 'tool/result', data: { meta: { deepseaChatTitle: 'fix-login' } } },
    { type: 'tool/result', data: { meta: { deepseaChatTitle: null } } },
    { type: 'tool/result', data: { meta: { other: 'y' } } },
    { type: 'tool/result', data: {} },
    { type: 'session/title', data: { title: 'nope' } },
  ]
  assert.deepEqual([...agentTitlesOf(events)], ['fix-login'])
})

test('classifyTitle distinguishes none / automatic / agent / user', () => {
  const agent = new Set(['fix-login'])
  assert.equal(classifyTitle(undefined, agent), 'none')
  assert.equal(classifyTitle({ title: 'fix the', source: { kind: 'fallback' } }, agent), 'automatic')
  assert.equal(classifyTitle({ title: 'fix-login-x', source: { kind: 'provider' } }, agent), 'automatic')
  assert.equal(classifyTitle({ title: 'fix-login', source: { kind: 'user' } }, agent), 'agent')
  assert.equal(classifyTitle({ title: 'mine', source: { kind: 'user' } }, agent), 'user')
  assert.equal(classifyTitle({ title: 'mine', source: { kind: 'user' } }, new Set(), 'mine'), 'agent')
})

test('Config defaults', () => {
  const config = new Config({})
  assert.equal(config.toolName, 'rename_chat')
  assert.equal(config.style, 'inherit')
  assert.equal(config.maxWords, undefined)
  assert.equal(config.promptHint, true)
  assert.equal(config.nudge, true)
  assert.throws(() => new Config({ style: 'shouty' }))
})

/** A fake loader whose entries carry the given rows (`options.name` / `options.config`). */
const fakeLoader = (rows) => ({ entries: () => rows.map(options => ({ options })) })

test('style is inherited from the session-title-llm row, else natural; own settings win', () => {
  const noLoader = { get: () => undefined }
  assert.deepEqual(titlerSettings(noLoader), { found: false })
  assert.deepEqual(resolveStyle(noLoader, new Config({})), { toolName: 'rename_chat', style: 'natural', maxWords: 5, inherited: false })

  const slugRow = { get: (n) => (n === 'loader' ? fakeLoader([
    { name: '@deepseek-ai/dsh-persona', config: { style: 'slug' } },
    { name: '@deepseek-ai/dsh-session-title-first-prompt-llm', config: { style: 'slug', targetWords: 4 } },
  ]) : undefined) }
  assert.deepEqual(titlerSettings(slugRow), { found: true, style: 'slug', targetWords: 4 })
  assert.deepEqual(resolveStyle(slugRow, new Config({})), { toolName: 'rename_chat', style: 'slug', maxWords: 4, inherited: true })
  // Own style / maxWords override the row.
  assert.deepEqual(resolveStyle(slugRow, new Config({ style: 'natural', maxWords: 6 })), { toolName: 'rename_chat', style: 'natural', maxWords: 6, inherited: false })

  // A titler row without style (the harness default): natural, its targetWords.
  const plainRow = { get: () => fakeLoader([{ name: '@deepseek-ai/dsh-session-title-llm', config: { targetWords: 5 } }]) }
  assert.deepEqual(resolveStyle(plainRow, new Config({})), { toolName: 'rename_chat', style: 'natural', maxWords: 5, inherited: true })
})

/** A fake session + sessionTitle service pair with the real rename semantics that matter here. */
function fakeWorld({ parentSession, initial } = {}) {
  const events = []
  const session = {
    id: 'session-1',
    header: { cwd: '/tmp', ...(parentSession ? { parentSession } : {}) },
    snapshotEvents: () => events,
  }
  let current = initial
  const sessionTitle = {
    get: (s) => (s === session ? current : undefined),
    rename: (s, title) => {
      assert.equal(s, session)
      current = { title, source: { kind: 'user' }, messageSeqs: [] }
      return current
    },
  }
  /** Simulate the loop persisting the tool result with its presentationMeta. */
  const commit = (tool, args, value) => events.push({ type: 'tool/result', data: { meta: tool.output.presentationMeta(args, value) } })
  return { session, sessionTitle, events, commit, ctx: { sessionTitle, get: () => undefined, logger: { info() {} } } }
}

/** Resolved style the tool and prompt tests run under: slug, 5 words (`style: slug` on the titler row). */
const config = { toolName: 'rename_chat', style: 'slug', maxWords: 5, inherited: false }

test('rename_chat applies the slug style and records the applied title', async () => {
  const w = fakeWorld({ initial: { title: 'please fix my', source: { kind: 'fallback' } } })
  const applied = new WeakMap()
  const tool = createRenameTool(w.ctx, config, applied)
  const args = { title: 'Fix the Login Redirect Loop' }
  const value = await tool.execute(args, { agent: { session: w.session }, signal: new AbortController().signal })
  assert.deepEqual(value, { applied: true, title: 'fix-the-login-redirect-loop', requested: 'fix-the-login-redirect-loop', previous: 'please fix my', previousKind: 'automatic' })
  assert.deepEqual(tool.output.presentationMeta(args, value), { deepseaChatTitle: 'fix-the-login-redirect-loop' })
  assert.match(tool.output.render(args, value)[0].text, /renamed to "fix-the-login-redirect-loop"/)
  assert.equal(applied.get(w.session), 'fix-the-login-redirect-loop')
})

test('rename_chat renames again over its own title, but never over the user\'s', async () => {
  const w = fakeWorld({ initial: { title: 'x', source: { kind: 'fallback' } } })
  const tool = createRenameTool(w.ctx, config, new WeakMap())
  const exec = { agent: { session: w.session }, signal: new AbortController().signal }
  const first = await tool.execute({ title: 'first pass' }, exec)
  w.commit(tool, { title: 'first pass' }, first)
  // Same title again: a no-op, not an error.
  const same = await tool.execute({ title: 'First Pass' }, exec)
  assert.equal(same.applied, false)
  assert.equal(same.reason, 'unchanged')
  // A different title over our own: allowed (subject changed).
  const second = await tool.execute({ title: 'second subject' }, exec)
  assert.equal(second.applied, true)
  assert.equal(second.previousKind, 'agent')
  // The human renames in the sidebar → source user, not in our meta.
  w.sessionTitle.rename(w.session, 'my-own-name')
  const refused = await tool.execute({ title: 'override attempt' }, exec)
  assert.deepEqual(refused, { applied: false, reason: 'user-titled', title: 'my-own-name', requested: 'override-attempt' })
  assert.match(tool.output.render({}, refused)[0].text, /Do not call rename_chat again/)
  assert.deepEqual(tool.output.presentationMeta({}, refused), { deepseaChatTitle: null })
})

test('rename_chat refuses empty titles and subagent sessions', async () => {
  const w = fakeWorld()
  const tool = createRenameTool(w.ctx, config, new WeakMap())
  const exec = { agent: { session: w.session }, signal: new AbortController().signal }
  await assert.rejects(tool.execute({ title: '!!!' }, exec), { code: 'CHAT_TITLE_EMPTY' })
  const sub = fakeWorld({ parentSession: 'session-0' })
  const subTool = createRenameTool(sub.ctx, config, new WeakMap())
  await assert.rejects(subTool.execute({ title: 'child work' }, { agent: { session: sub.session }, signal: new AbortController().signal }), { code: 'CHAT_TITLE_SUBAGENT' })
  await assert.rejects(tool.execute({ title: 'x' }, { signal: new AbortController().signal }), { code: 'CHAT_TITLE_NO_SESSION' })
})

test('apply registers the tool, the section and the nudge; the nudge clears once named', async () => {
  const w = fakeWorld()
  const registered = []
  const sections = []
  const contexts = []
  const ctx = {
    ...w.ctx,
    tools: { register: (t) => registered.push(t), get: (name) => registered.find(t => t.name === name) },
    systemPrompt: {
      section: (s) => sections.push(s),
      context: (c) => contexts.push(c),
      getSectionOrder: () => 2300,
      getContextOrder: () => 115,
    },
  }
  // The raw row config; with no loader in this ctx it resolves to natural/5, so pin slug/5 explicitly.
  apply(ctx, new Config({ style: 'slug', maxWords: 5 }))
  assert.deepEqual(registered.map(t => t.name), ['rename_chat'])
  assert.deepEqual(sections.map(s => s.name), [PROMPT_SECTION])
  assert.deepEqual(contexts.map(c => c.name), [NUDGE_CONTEXT])
  assert.equal(PROMPT_SECTION, 'tool:deepsea-chat-title')
  const assemble = { agent: { session: w.session } }
  assert.equal(sections[0].text(assemble), promptSection(config))
  assert.match(sections[0].text(assemble), /when that title is wrong or generic/)
  assert.match(sections[0].text(assemble), /more accurate name suggests itself/)
  assert.ok(sections[0].text(assemble).split(/\s+/).length < 90, 'the section stays short')
  // No title yet (the automatic titler has not written): nothing to review, no line.
  assert.equal(contexts[0].text(assemble), '')
  // No agent (e.g. an agentless assembly) and subagents get nothing.
  assert.equal(sections[0].text({}), '')
  assert.equal(contexts[0].text({}), '')
  const sub = fakeWorld({ parentSession: 'p' })
  assert.equal(sections[0].text({ agent: { session: sub.session } }), '')
  // Automatic title (fallback, then provider): shown for review. Agent-applied title: silent. User title: silent.
  w.sessionTitle.get = () => ({ title: 'please fix my', source: { kind: 'fallback' } })
  assert.equal(contexts[0].text(assemble), nudgeText(config, 'automatic', { title: 'please fix my', source: { kind: 'fallback' } }))
  assert.match(contexts[0].text(assemble), /"please fix my" is a placeholder/)
  w.sessionTitle.get = () => ({ title: 'auto', source: { kind: 'provider' } })
  assert.match(contexts[0].text(assemble), /Automatic chat title: "auto"\. Keep it/)
  const sub2 = fakeWorld({ parentSession: 'p' })
  sub2.sessionTitle.get = () => ({ title: 'auto', source: { kind: 'provider' } })
  assert.equal(contexts[0].text({ agent: { session: sub2.session } }), '')
  // A scope that cannot see the tool (a no-tools preset: ctx.tools.restrict({ allow: [] })) gets neither text.
  const hidden = ctx.tools.get
  ctx.tools.get = () => undefined
  assert.equal(sections[0].text(assemble), '')
  assert.equal(contexts[0].text(assemble), '')
  ctx.tools.get = hidden
  assert.match(contexts[0].text(assemble), /Automatic chat title/)
  const value = await registered[0].execute({ title: 'named now' }, { agent: { session: w.session }, signal: new AbortController().signal })
  w.commit(registered[0], { title: 'named now' }, value)
  w.sessionTitle.get = () => ({ title: 'named-now', source: { kind: 'user' } })
  assert.equal(contexts[0].text(assemble), '')
  w.sessionTitle.get = () => ({ title: 'human-choice', source: { kind: 'user' } })
  assert.equal(contexts[0].text(assemble), '')
})
