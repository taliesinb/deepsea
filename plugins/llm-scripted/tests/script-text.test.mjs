import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scriptLines } from '../src/client/script-text.ts'
import { scriptRule } from '../src/client/script-rule.ts'

test('a prompt is a script when every non-blank line is a JSON object starting with a named key', () => {
  assert.deepEqual(scriptLines('{"cmd": "say", "text": "hi"}'), ['{"cmd": "say", "text": "hi"}'])
  assert.deepEqual(scriptLines('\n  {"cmd": "say", "text": "a"}\n\n{"cmd":"tool","name":"bash"}  \n\n'), ['  {"cmd": "say", "text": "a"}', '', '{"cmd":"tool","name":"bash"}'])
  assert.deepEqual(scriptLines('{"cmd": "say", "text": "a"}\r\n{"cmd": "end"}\r\n'), ['{"cmd": "say", "text": "a"}', '{"cmd": "end"}'])
})

test('prose, near misses and invalid JSON are not scripts', () => {
  for (const text of [
    '', '   \n ', 'hello', '{like this}', '{ "cmd" }', '{"cmd": "say"} and more', 'say {"cmd": "say"}',
    '{"cmd": "say", "text": "a"}\nplain line', '{"cmd": "say", "text": "a",}', '{"cmd": "say"', '[{"cmd": "say"}]',
    '{1: 2}', '{"": 1}',
  ]) assert.equal(scriptLines(text), undefined, JSON.stringify(text))
})

test('the rule claims the whole prompt, only from its start', () => {
  const text = ' {"cmd": "say", "text": "hi"}\n{"cmd": "end"}'
  assert.deepEqual(scriptRule.match(text, 0, { read: () => undefined }), { id: 'deepsea-script', start: 0, end: text.length, data: { lines: 2 } })
  assert.equal(scriptRule.match(text, 1, { read: () => undefined }), undefined)
  assert.equal(scriptRule.match('hello', 0, { read: () => undefined }), undefined)
})
