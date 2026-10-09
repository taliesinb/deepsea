import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { exciseParagraphs, exciseAssembly, resolveConfig } from '../excision.mjs'
import { Config, apply } from '../index.js'

const marker = 'DeepSeek Harness'
const providers = new Map([['anthropic-oauth', [marker]]])
const assembly = (sections, provider = 'anthropic-oauth') => ({
  sections: sections.map((text, index) => ({ name: `section-${index}`, text })),
  variables: { provider }, contexts: [{ name: 'context', text: marker }],
  tools: [{ name: 'fixture', description: marker, parameters: { type: 'object' } }],
})

test('excises the three requested paragraphs, not just their matching strings', () => {
  const text = [
    'You are an AI agent powered by DeepSeek Harness.',
    'You are a coding agent. Keep this paragraph.',
    'The DeepSeek Harness implementation checkout is at /opt/dsh-source.\nUse this checkout only to inspect or extend DSH itself.',
    'Keep this paragraph too.',
    'You are interacting with the user through the DeepSeek Harness Web GUI at https://app.example.invalid.\nDo not start a replacement server unless the user asks.',
    'The working directory is /workspace.',
  ].join('\n\n')
  assert.deepEqual(exciseParagraphs(text, [marker]), {
    text: 'You are a coding agent. Keep this paragraph.\n\nKeep this paragraph too.\n\nThe working directory is /workspace.', removed: 3,
  })
})

test('matching is literal and case-sensitive, not regex or whole-word matching', () => {
  const text = 'deepseek harness stays\n\nDeepSeek\nHarness stays\n\nDSH stays\n\nDeepSeek HarnessX goes\n\nA .* literal goes'
  assert.deepEqual(exciseParagraphs(text, [marker, '.*']), {
    text: 'deepseek harness stays\n\nDeepSeek\nHarness stays\n\nDSH stays', removed: 2,
  })
})

test('LF, CRLF and whitespace-only blank lines delimit whole paragraphs', () => {
  for (const newline of ['\n', '\r\n']) {
    const gap = newline + '\t  ' + newline
    assert.deepEqual(exciseParagraphs(`keep${newline}wrapped${gap}${marker}${newline}whole paragraph${gap}last`, [marker]), {
      text: `keep${newline}wrapped${gap}last`, removed: 1,
    })
  }
})

test('first, last, adjacent and all matching paragraphs are removed', () => {
  for (const [text, expected, removed] of [
    [`${marker}\n\nkeep`, 'keep', 1], [`keep\n\n${marker}`, 'keep', 1],
    [`${marker}\n\n${marker}\n\nkeep`, 'keep', 2],
    [`${marker}\n\n${marker}`, '', 2], [marker, '', 1],
  ]) assert.deepEqual(exciseParagraphs(text, [marker]), { text: expected, removed })
})

test('unmatched content and delimiters are byte-identical, including Unicode and trailing newlines', () => {
  const text = '\n\n  Café e\u0301  \r\n\t\r\nkeep {{literal}}\n'
  assert.deepEqual(exciseParagraphs(text, [marker]), { text, removed: 0 })
  assert.deepEqual(exciseParagraphs(text, []), { text, removed: 0 })
  assert.deepEqual(exciseParagraphs('', [marker]), { text: '', removed: 0 })
})

test('excision is idempotent and multiple markers count a paragraph once', () => {
  const first = exciseParagraphs(`${marker} and Other\n\nkeep\n\nOther`, [marker, 'Other'])
  assert.deepEqual(first, { text: 'keep', removed: 2 })
  assert.deepEqual(exciseParagraphs(first.text, [marker, 'Other']), { text: 'keep', removed: 0 })
})

test('paragraph matching is plain-text, including contiguous lists or fenced text', () => {
  assert.deepEqual(exciseParagraphs(`keep\n\n- ${marker}\n- same paragraph\n\nlast`, [marker]), { text: 'keep\n\nlast', removed: 1 })
  assert.deepEqual(exciseParagraphs('keep\n\n```text\nDeepSeek Harness\n```\n\nlast', [marker]), { text: 'keep\n\nlast', removed: 1 })
})

test('only selected provider transforms, without mutating shared inputs', () => {
  const source = assembly([marker, `Keep\n\n${marker}\n\nEnd`, 'Other guidance'])
  const original = structuredClone(source)
  const result = exciseAssembly(source, providers, renderPrompt)
  assert.deepEqual(source, original)
  assert.deepEqual(result.sections, [
    { name: 'section-1', text: 'Keep\n\nEnd', interpolate: false }, source.sections[2],
  ])
  assert.equal(result.sections[1], source.sections[2])
  assert.equal(result.contexts, source.contexts)
  assert.equal(result.tools, source.tools)
  assert.equal(result.variables, source.variables)
  assert.equal(result.contexts[0].text, marker)
  assert.equal(result.tools[0].description, marker)
  for (const provider of ['anthropic', 'anthropic-auth', 'Anthropic-oauth', 'openai-codex-oauth', undefined]) {
    const other = { ...source, variables: { provider } }
    assert.equal(exciseAssembly(other, providers, renderPrompt), other)
  }
})

test('no match or empty rule list preserves the original assembly object', () => {
  const source = assembly(['no branded paragraphs here', ''])
  assert.equal(exciseAssembly(source, providers, renderPrompt), source)
  assert.equal(exciseAssembly(source, new Map([['anthropic-oauth', []]]), renderPrompt), source)
})

test('render before matching; never re-interpolate surviving literal braces', () => {
  const source = assembly(['{{brand}} paragraph\n\nKeep {{literal}}'])
  source.variables.brand = marker
  source.variables.literal = '{{undefined-on-purpose}}'
  const result = exciseAssembly(source, providers, renderPrompt)
  assert.equal(result.sections[0].interpolate, false)
  assert.equal(renderPrompt(result), 'Keep {{undefined-on-purpose}}')
  assert.equal(source.sections[0].text, '{{brand}} paragraph\n\nKeep {{literal}}')
})

test('sections marked non-interpolating keep their literal contents', () => {
  const source = assembly(['{{brand}} stays\n\nDeepSeek Harness goes'])
  source.sections[0].interpolate = false
  source.variables.brand = marker
  assert.equal(renderPrompt(exciseAssembly(source, providers, renderPrompt)), '{{brand}} stays')
})

test('DSH template errors are not hidden by a matching removal rule', () => {
  const source = assembly([`${marker} {{unknown}}`])
  assert.throws(() => exciseAssembly(source, providers, renderPrompt), /unknown prompt variable/)
})

test('an entirely excised initial prompt yields no sections, retaining contexts and tools', () => {
  const source = assembly([marker, `More ${marker}`])
  const result = exciseAssembly(source, providers, renderPrompt)
  assert.deepEqual(result.sections, [])
  assert.equal(renderPrompt(result), '')
  assert.equal(result.tools, source.tools); assert.equal(result.contexts, source.contexts)
})

test('configuration has no implicit provider rules and survives Loader double resolution', () => {
  assert.deepEqual(resolveConfig(), { providers: {} })
  const raw = { providers: { 'anthropic-oauth': [marker, marker], 'custom-oauth': ['Other'] } }
  const resolved = resolveConfig(raw)
  assert.deepEqual(resolved.providers['anthropic-oauth'], [marker])
  assert.deepEqual(resolveConfig(resolved), resolved)
  raw.providers['custom-oauth'].push('later')
  assert.deepEqual(resolved.providers['custom-oauth'], ['Other'])
  assert.deepEqual(Config['~standard'].validate({ providers: {} }), { value: { providers: {} } })
})

test('invalid mappings fail without echoing configuration contents', () => {
  for (const raw of [null, [], 'bad', new Date(0), { extra: true }, { providers: null }, { providers: [] }, { providers: new Map() },
    { providers: { '': [marker] } }, { providers: { '*': [marker] } }, { providers: { ' anthropic-oauth': [marker] } },
    { providers: { route: 'secret-fixture' } }, { providers: { route: [''] } }, { providers: { route: ['\t'] } },
    { providers: { route: [42] } }, { providers: { route: [{}] } }]) {
    assert.throws(() => resolveConfig(raw), /prompt-excision:/)
    const result = Config['~standard'].validate(raw)
    assert.equal(result.issues.length, 1)
    assert.doesNotMatch(result.issues[0].message, /secret-fixture/)
  }
})

test('provider lookup has no prototype-key fallback', () => {
  const config = resolveConfig(JSON.parse('{"providers":{"__proto__":["literal"]}}'))
  const rules = new Map(Object.entries(config.providers))
  assert.deepEqual(rules.get('__proto__'), ['literal'])
  assert.equal(rules.get('constructor'), undefined)
})

test('hook delegates, uses returned provider selection, and registers as a Cordis effect', async () => {
  let listener; let options; let event
  const ctx = { on(key, callback, opts) { event = key; listener = callback; options = opts } }
  apply(ctx, { providers: { 'anthropic-oauth': [marker] } })
  assert.equal(event, 'system-prompt/assemble'); assert.deepEqual(options, { prepend: true })
  const input = assembly([marker], 'anthropic')
  const final = { ...input, variables: { provider: 'anthropic-oauth' } }
  let calls = 0
  assert.deepEqual((await listener(input, {}, async () => { calls++; return final })).sections, [])
  assert.equal(calls, 1)
  const error = new Error('assembly failed')
  await assert.rejects(listener(input, {}, async () => { throw error }), e => e === error)
})
