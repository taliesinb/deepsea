import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseKeyFile } from '../parse.mjs'

describe('parseKeyFile', () => {
  it('reads pi auth.json, mapping providers to DSH refs and skipping oauth/unknown', () => {
    const r = parseKeyFile(JSON.stringify({
      anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 },
      'zai-coding-cn': { type: 'api_key', key: ' zk ' },
      deepseek: { type: 'api_key', key: 'dk' },
      mystery: { type: 'api_key', key: 'x' },
    }))
    assert.equal(r.format, 'pi-auth')
    assert.deepEqual(r.keys, { ZAI_CODING_CN_API_KEY: 'zk', DEEPSEEK_API_KEY: 'dk' })
    assert.deepEqual(r.skipped.map(s => s.name), ['anthropic', 'mystery'])
  })
  it('reads a flat env map and a dotenv file', () => {
    assert.deepEqual(parseKeyFile('{"OPENAI_API_KEY":"o","lower":"x","EMPTY":""}'), { format: 'env-map', keys: { OPENAI_API_KEY: 'o' }, skipped: [{ name: 'lower', reason: 'not a credential name (expected UPPER_SNAKE_CASE, e.g. OPENAI_API_KEY)' }, { name: 'EMPTY', reason: 'empty value' }] })
    const d = parseKeyFile('# keys\nexport ANTHROPIC_API_KEY="sk-1"\nDEEPSEEK_API_KEY=dk # trailing\n\nbad line\n')
    assert.equal(d.format, 'dotenv')
    assert.deepEqual(d.keys, { ANTHROPIC_API_KEY: 'sk-1', DEEPSEEK_API_KEY: 'dk' })
    assert.equal(d.skipped.length, 1)
  })
  it("reads DSH's own .credentials.yaml: refs as keys, api-key records via the provider env, grants skipped", () => {
    const r = parseKeyFile([
      'version: 1', 'records:', '  client-connection/browser-session:', '    kind: grant', '    payload:', '      version: 1', '      secret: s',
      '  llm-pi-ai/anthropic:', '    kind: grant', '    payload:', '      type: oauth', '      refresh: r',
      '  llm-pi-ai/groq:', '    kind: api-key', '    key: gk',
      'refs:', '  ANTHROPIC_API_KEY: "sk-a"', '  OPENAI_API_KEY: sk-o', '  EMPTY:', '',
    ].join('\n'))
    assert.equal(r.format, 'dsh-credentials')
    assert.deepEqual(r.keys, { GROQ_API_KEY: 'gk', ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' })
    assert.deepEqual(r.skipped.map(s => s.name), ['llm-pi-ai/anthropic', 'EMPTY'])
  })
  it('rejects garbage with a user-facing message', () => {
    assert.throws(() => parseKeyFile(''), /empty/)
    assert.throws(() => parseKeyFile('{not json'), /Not valid JSON/)
    assert.throws(() => parseKeyFile('[1,2]'), /JSON object/)
    assert.throws(() => parseKeyFile('{"a":1}'), /Unrecognised JSON/)
    assert.throws(() => parseKeyFile('hello world'), /Unrecognised file/)
  })
})

describe('planImport', async () => {
  const { planImport } = await import('../index.js')
  const store = { OPENAI_API_KEY: { value: 'same-value', source: 'file' }, DEEPSEEK_API_KEY: { value: 'old', source: 'file' }, ENV_ONLY: { value: 'e', source: 'env' } }
  const credentials = {
    resolve: async ref => store[String(ref)],
    describe: async ref => ({ writable: store[String(ref)]?.source !== 'env', source: store[String(ref)]?.source }),
  }
  it('classifies new / same / different / readonly / invalid', async () => {
    const plan = await planImport(credentials, { OPENAI_API_KEY: 'same-value', DEEPSEEK_API_KEY: 'new', ANTHROPIC_API_KEY: 'a', ENV_ONLY: 'x', 'bad name': 'y', EMPTY: ' ' })
    assert.deepEqual(Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.status])),
      { OPENAI_API_KEY: 'same', DEEPSEEK_API_KEY: 'different', ANTHROPIC_API_KEY: 'new', ENV_ONLY: 'readonly', 'bad name': 'invalid', EMPTY: 'invalid' })
  })
})
