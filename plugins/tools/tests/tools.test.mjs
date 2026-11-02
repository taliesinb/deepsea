import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DESCRIPTION_CAP, countLine, decodeListing, encodeListing, firstSentence, globToRegExp, paramEntries,
  parsePatterns, selectTools, toolEntry, truncate, typeLabel,
} from '../listing.mjs'
import { apply, presentationOf, runTools } from '../index.js'

const TOOLS = [
  {
    name: 'transcript_grep',
    description: 'Regular-expression search over the text of one or many sessions. Returns excerpts.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session spelling.' },
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        kinds: { type: 'array', items: { enum: ['user', 'assistant'] } },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'wait',
    description: 'Pause for a fixed time, then return.\nUse this instead of sleep.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How long to wait, in seconds.' },
        reason: { type: 'string' },
      },
      required: ['seconds'],
    },
  },
  { name: 'chrome_wait_for', description: 'Wait until a condition holds in the page.', parameters: { type: 'object', properties: {} } },
  { name: 'session_info', description: 'Facts about the current screenshot session.', parameters: {} },
]

const listingOf = result => decodeListing(result.text)
const names = listing => listing.tools.map(tool => tool.name)

test('truncate ends cut text in an ellipsis', () => {
  assert.equal(truncate('abc', 5), 'abc')
  assert.equal(truncate('abcdef', 5), 'abcd…')
})

test('firstSentence: first non-empty line, first sentence, abbreviations and dotted tokens kept', () => {
  assert.equal(firstSentence('\n  Pause for a fixed time, then return. Then more.\nnext line'), 'Pause for a fixed time, then return.')
  assert.equal(firstSentence('Read index.js and v0.5 files. More.'), 'Read index.js and v0.5 files.')
  assert.equal(firstSentence('Match tools (e.g. chrome_*) by name. More.'), 'Match tools (e.g. chrome_*) by name.')
  assert.equal(firstSentence('No full stop here'), 'No full stop here')
  assert.equal(firstSentence('Really?  Yes.'), 'Really?')
  assert.equal(firstSentence(undefined), '')
})

test('typeLabel covers enum, arrays, unions and missing types', () => {
  assert.equal(typeLabel({ type: 'string' }), 'string')
  assert.equal(typeLabel({ enum: ['a', 'b'] }), 'a|b')
  assert.equal(typeLabel({ type: 'array', items: { type: 'string' } }), 'string[]')
  assert.equal(typeLabel({ type: 'array' }), 'any[]')
  assert.equal(typeLabel({ type: ['string', 'null'] }), 'string|null')
  assert.equal(typeLabel({ oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }), 'string|string[]')
  assert.equal(typeLabel({}), 'any')
})

test('paramEntries: required first, then schema order, with type and description', () => {
  assert.deepEqual(paramEntries(TOOLS[0].parameters), [
    { name: 'pattern', type: 'string', required: true, description: 'JavaScript regular expression.' },
    { name: 'session', type: 'string', required: false, description: 'Session spelling.' },
    { name: 'kinds', type: 'user|assistant[]', required: false, description: '' },
  ])
  assert.deepEqual(paramEntries({}), [])
  assert.deepEqual(paramEntries(undefined), [])
})

test('toolEntry: summary is the first sentence, description capped', () => {
  const entry = toolEntry(TOOLS[1])
  assert.equal(entry.summary, 'Pause for a fixed time, then return.')
  assert.equal(entry.description, 'Pause for a fixed time, then return.\nUse this instead of sleep.')
  assert.equal(toolEntry({ name: 'big', description: 'x'.repeat(DESCRIPTION_CAP + 50) }).description.length, DESCRIPTION_CAP)
  assert.deepEqual(toolEntry({ name: 'bare' }), { name: 'bare', summary: '', description: '', params: [] })
})

test('parsePatterns splits on whitespace including the leading separator', () => {
  assert.deepEqual(parsePatterns(''), [])
  assert.deepEqual(parsePatterns('   '), [])
  assert.deepEqual(parsePatterns(' *session*  chrome_'), ['*session*', 'chrome_'])
})

test('globToRegExp is anchored, case-insensitive, and escapes regex characters', () => {
  assert.ok(globToRegExp('*session*').test('transcript_SESSION_find'))
  assert.ok(globToRegExp('wai?').test('wait'))
  assert.ok(!globToRegExp('wait').test('wait_for'))
  assert.ok(!globToRegExp('a.b').test('axb'))
})

test('selectTools: glob, name substring, description fallback, OR, exact', () => {
  const pick = result => result.matched.map(tool => tool.name)
  assert.deepEqual(pick(selectTools(TOOLS, [])), TOOLS.map(tool => tool.name))
  assert.deepEqual(pick(selectTools(TOOLS, ['*wait*'])), ['wait', 'chrome_wait_for'])
  assert.deepEqual(pick(selectTools(TOOLS, ['WAIT'])), ['wait', 'chrome_wait_for'])
  assert.equal(selectTools(TOOLS, ['WAIT']).exact?.name, 'wait')
  assert.equal(selectTools(TOOLS, ['*wait']).exact, undefined)
  assert.deepEqual(pick(selectTools(TOOLS, ['screenshot'])), ['session_info'])
  assert.deepEqual(pick(selectTools(TOOLS, ['session'])), ['session_info'])
  assert.deepEqual(pick(selectTools(TOOLS, ['transcript_*', 'info'])), ['transcript_grep', 'session_info'])
  assert.deepEqual(pick(selectTools(TOOLS, ['nothing'])), [])
})

test('encodeListing / decodeListing round-trip; other text decodes to undefined', () => {
  const listing = { v: 1, total: 4, patterns: ['*a*'], tools: [toolEntry(TOOLS[1])] }
  const text = encodeListing(listing)
  assert.equal(text.split('\n')[0], '1 of 4 tools matching *a*')
  assert.deepEqual(decodeListing(text), listing)
  assert.equal(decodeListing('No tools match zzz (4 visible).'), undefined)
  assert.equal(decodeListing('39 tools\nname  args  description'), undefined)
  assert.equal(decodeListing('x\n{"v":2,"tools":[]}'), undefined)
  assert.equal(decodeListing(undefined), undefined)
})

test('countLine notes ptc only', () => {
  assert.equal(countLine(4, 4, [], 'ptc'), '4 tools (ptc: the model is sent run_code only)')
  assert.equal(countLine(4, 4, [], 'both'), '4 tools')
  assert.equal(countLine(1, 1, []), '1 tool')
})

test('runTools: sorted listing, focus on exact or single match, error on none', () => {
  assert.deepEqual(runTools([], ''), { kind: 'success', text: 'No tools visible to this agent.' })
  const all = listingOf(runTools(TOOLS, ''))
  assert.deepEqual(names(all), ['chrome_wait_for', 'session_info', 'transcript_grep', 'wait'])
  assert.equal(all.total, 4)
  assert.equal(all.focus, undefined)
  assert.equal(all.mode, undefined)
  // Exact name: every name containing it is listed, the exact one focused.
  const wait = listingOf(runTools(TOOLS, ' wait'))
  assert.deepEqual(names(wait), ['chrome_wait_for', 'wait'])
  assert.equal(wait.focus, 'wait')
  // A single match is focused too.
  assert.equal(listingOf(runTools(TOOLS, ' *grep')).focus, 'transcript_grep')
  assert.equal(listingOf(runTools(TOOLS, ' *wait*')).focus, undefined)
  assert.equal(listingOf(runTools(TOOLS, '', 'ptc')).mode, 'ptc')
  assert.deepEqual(runTools(TOOLS, ' zzz'), { kind: 'error', text: 'No tools match zzz (4 visible).' })
})

test('presentationOf reads the private modeFor defensively', () => {
  assert.equal(presentationOf({}, {}), undefined)
  assert.equal(presentationOf({ modeFor: () => { throw new Error('x') } }, {}), undefined)
  const agent = {}
  assert.equal(presentationOf({ modeFor: scope => (scope === agent ? 'ptc' : 'native') }, agent), 'ptc')
})

test('apply registers /tools and lists the calling agent\'s scope', async () => {
  let registered
  const seen = []
  const agent = { id: 'agent-1' }
  const ctx = {
    commands: { register: definition => { registered = definition; return () => {} } },
    tools: { schemas: scope => { seen.push(scope); return TOOLS }, modeFor: () => 'native' },
  }
  apply(ctx)
  assert.equal(registered.name, 'tools')
  const result = await registered.handler({ agent, rawInput: ' *wait*' })
  assert.equal(seen[0], agent)
  assert.equal(result.kind, 'success')
  assert.equal(result.text.split('\n')[0], '2 of 4 tools matching *wait*')
  assert.equal(listingOf(result).mode, 'native')
})
