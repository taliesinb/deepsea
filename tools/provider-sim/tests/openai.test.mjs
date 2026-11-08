import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { createSimulator } from '../server.mjs'

const made = []
test.after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

/** A simulator on a free port with one priced OpenAI model (with a price tier) and one Codex model. */
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-provider-sim-openai-'))
  made.push(dir)
  const sim = await createSimulator({ db: join(dir, 'sim.sqlite') })
  const models = {
    openai: { id: 'gpt-5.5', name: 'GPT-5.5', cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, tiers: [{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 }] } },
    'openai-codex': { id: 'gpt-5.5', name: 'GPT-5.5', cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } },
  }
  sim.catalog.cost = (provider, id) => models[provider]?.id === id ? models[provider].cost : undefined
  sim.catalog.models = provider => models[provider] ? [models[provider]] : []
  await new Promise(resolve => sim.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${sim.server.address().port}`
  return { base, sim, close: () => new Promise(resolve => { sim.server.close(() => { sim.store.close(); resolve() }) }) }
}

const jsonPost = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const formPost = (url, fields) => fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
const user = text => [{ role: 'user', content: [{ type: 'input_text', text }] }]
const script = (...lines) => lines.map(l => JSON.stringify(l)).join('\n')
const usageScript = (input, output = 10) => script({ cmd: 'say', text: 'ok' }, { cmd: 'usage', input, output })
/** The `data:` payloads of an SSE body. */
const events = text => text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\n').find(l => l.startsWith('data: ')).slice(6)))
/** A JWT's claims, decoded as pi-ai decodes them (`atob`). */
const claimsOf = token => JSON.parse(atob(token.split('.')[1]))

test('openai API key: responses whole and streamed, reasoning, function calls, usage at catalog prices, models, and OpenAI\'s errors', async () => {
  const { base, sim, close } = await start()
  try {
    const responses = (key, body, headers = {}) => jsonPost(`${base}/api.openai.com/v1/responses`, { model: 'gpt-5.5', store: false, ...body }, key ? { authorization: `Bearer ${key}`, ...headers } : headers)
    const key = 'sk-proj-test'
    const anonymous = await responses(undefined, { input: user('say hi') })
    assert.deepEqual([anonymous.status, (await anonymous.json()).error.type], [401, 'invalid_request_error'])
    const wrong = await responses('not-a-key-at-all', { input: user('say hi') })
    const wrongBody = await wrong.json()
    assert.deepEqual([wrong.status, wrongBody.error.code], [401, 'invalid_api_key'])
    assert.match(wrongBody.error.message, /^Incorrect API key provided: not\*+-all\./)

    const whole = await responses(key, { input: user(usageScript(1000, 500)) })
    assert.match(whole.headers.get('x-request-id'), /^req_/)
    const body = await whole.json()
    assert.deepEqual([body.object, body.status, body.output.length, body.output[0].type, body.output[0].content[0].text], ['response', 'completed', 1, 'message', 'ok'])
    assert.deepEqual(body.usage, { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1500 })
    // 1000 × $5 + 500 × $30 per million tokens = 20 000 micro-dollars.
    const balance = () => sim.store.accounts('openai').find(a => a.credential === key).state.balanceMicros
    assert.equal(balance(), 10_000_000 - 20_000)
    // Above 272k input tokens the catalog's tier applies ($10 / $45), and flex halves the price, as pi-ai prices them.
    await (await responses(key, { input: user(usageScript(300_000, 1000)), service_tier: 'flex' })).json()
    assert.equal(balance(), 10_000_000 - 20_000 - (300_000 * 10 + 1000 * 45) / 2)

    // A streamed turn: reasoning summary and a function call, then its output and the reply.
    const turn = script({ cmd: 'think', text: 'checking' }, { cmd: 'tool', id: 'call_1', name: 'echo', args: { text: 'hi' } }, { cmd: 'expect', value: 'tools.call_1.text', equals: 'hi' }, { cmd: 'say', text: 'done' })
    const first = await (await responses(key, { input: user(turn), stream: true, include: ['reasoning.encrypted_content'], reasoning: { effort: 'low', summary: 'auto' } })).text()
    assert.match(first, /^event: response\.created\n/)
    const sent = events(first)
    assert.deepEqual(sent.map(e => e.sequence_number), sent.map((_, i) => i))
    assert.deepEqual(sent.map(e => e.type), ['response.created', 'response.in_progress',
      'response.output_item.added', 'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done',
      'response.output_item.added', ...sent.filter(e => e.type === 'response.function_call_arguments.delta').map(e => e.type), 'response.function_call_arguments.done', 'response.output_item.done',
      'response.completed'])
    const done = sent.at(-1).response
    const [reasoning, call] = done.output
    assert.deepEqual([reasoning.type, reasoning.summary[0].text, call.type, call.call_id, call.name, call.arguments], ['reasoning', 'checking', 'function_call', 'call_1', 'echo', '{"text":"hi"}'])
    assert.match(reasoning.encrypted_content, /^sim:/)
    assert.match(call.id, /^fc_/)
    assert.ok(done.usage.output_tokens_details.reasoning_tokens > 0)
    // The next request replays the output items and the function's output, as pi-ai does with store: false.
    const replay = [...user(turn), reasoning, { type: 'function_call', id: call.id, call_id: 'call_1', name: 'echo', arguments: call.arguments }]
    const second = await (await responses(key, { input: [...replay, { type: 'function_call_output', call_id: 'call_1', output: 'hi' }] })).json()
    assert.deepEqual(second.output.map(o => o.content?.[0].text), ['done'])
    const mismatch = await responses(key, { input: [...replay, { type: 'function_call_output', call_id: 'call_1', output: 'bye' }] })
    assert.deepEqual([mismatch.status, (await mismatch.json()).error.type], [400, 'invalid_request_error'])

    // max-tokens: an incomplete response.
    const cut = events(await (await responses(key, { input: user(script({ cmd: 'say', text: 'cut' }, { cmd: 'end', reason: 'max-tokens' })), stream: true })).text()).at(-1)
    assert.deepEqual([cut.type, cut.response.status, cut.response.incomplete_details], ['response.incomplete', 'incomplete', { reason: 'max_output_tokens' }])

    // Chat completions, and a compressed request body.
    const chat = await (await fetch(`${base}/api.openai.com/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'say from chat' }] })) })).json()
    assert.deepEqual([chat.object, chat.choices[0].message.content], ['chat.completion', 'from chat'])

    const models = await (await fetch(`${base}/api.openai.com/v1/models`, { headers: { authorization: `Bearer ${key}` } })).json()
    assert.deepEqual([models.object, models.data[0].id, models.data[0].object], ['list', 'gpt-5.5', 'model'])
    assert.equal((await fetch(`${base}/api.openai.com/v1/models/gpt-0`, { headers: { authorization: `Bearer ${key}` } })).status, 404)

    // The script's errors in OpenAI's shapes.
    const limited = await responses(key, { input: user(script({ cmd: 'error', kind: 'rate-limit', retryAfter: 7 })) })
    assert.deepEqual([limited.status, limited.headers.get('retry-after'), (await limited.json()).error.code], [429, '7', 'rate_limit_exceeded'])
    const overloaded = await responses(key, { input: user(script({ cmd: 'error', kind: 'overloaded' })) })
    assert.deepEqual([overloaded.status, (await overloaded.json()).error.type], [503, 'server_error'])
    await assert.rejects(responses(key, { input: user(script({ cmd: 'error', kind: 'network' })) }))

    // No credit left: 429 insufficient_quota.
    await jsonPost(`${base}/_sim/account`, { provider: 'openai', credential: key, state: { balanceMicros: 0 } })
    const broke = await responses(key, { input: user('say hi') })
    assert.deepEqual([broke.status, (await broke.json()).error.code], [429, 'insufficient_quota'])
  } finally { await close() }
})

test('openai Plan: authorize form, code and state, PKCE token exchange, the claims pi-ai and the harness read, refresh', async () => {
  const { base, close } = await start()
  try {
    const verifier = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz'
    const query = new URLSearchParams({ response_type: 'code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', redirect_uri: 'http://localhost:1455/auth/callback', scope: 'openid profile email offline_access',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'state-1', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'pi' })
    const page = await fetch(`${base}/auth.openai.com/oauth/authorize?${query}`)
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.match(html, /<form method="post" action="authorize"/)
    assert.match(html, /<option value="pro">Pro<\/option>/)
    const elsewhere = new URLSearchParams(query)
    elsewhere.set('redirect_uri', 'https://example.com/callback')
    assert.equal((await fetch(`${base}/auth.openai.com/oauth/authorize?${elsewhere}`)).status, 400)

    const form = fields => formPost(`${base}/auth.openai.com/oauth/authorize`, { ...Object.fromEntries(query), ...fields })
    assert.equal((await form({ email: 'not-an-email', plan: '' })).status, 400)
    const redirected = await form({ email: 'Plan@Example.com', plan: '' })
    assert.equal(redirected.status, 302)
    const callback = new URL(redirected.headers.get('location'))
    assert.deepEqual([callback.origin + callback.pathname, callback.searchParams.get('state')], ['http://localhost:1455/auth/callback', 'state-1'])

    const tokenUrl = `${base}/auth.openai.com/oauth/token`
    const exchange = { grant_type: 'authorization_code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', code: callback.searchParams.get('code'), code_verifier: verifier, redirect_uri: 'http://localhost:1455/auth/callback' }
    // A wrong PKCE verifier is refused, and the code is used up: sign in again.
    assert.equal((await formPost(tokenUrl, { ...exchange, code_verifier: 'wrong' })).status, 400)
    const again = new URL((await form({ email: 'plan@example.com', plan: '' })).headers.get('location')).searchParams.get('code')
    const granted = await (await formPost(tokenUrl, { ...exchange, code: again })).json()
    assert.deepEqual([granted.token_type, granted.expires_in, typeof granted.refresh_token, typeof granted.id_token], ['Bearer', 864000, 'string', 'string'])
    assert.equal((await formPost(tokenUrl, { ...exchange, code: again })).status, 400)

    const access = claimsOf(granted.access_token)
    const auth = access['https://api.openai.com/auth']
    assert.match(auth.chatgpt_account_id, /^[0-9a-f-]{36}$/)
    assert.deepEqual([auth.chatgpt_plan_type, access['https://api.openai.com/profile'].email, access.exp - access.iat], ['plus', 'plan@example.com', 864000])
    assert.ok(auth.chatgpt_user_id.startsWith('user-') && auth.chatgpt_account_user_id === `${auth.chatgpt_user_id}__${auth.chatgpt_account_id}`)
    const id = claimsOf(granted.id_token)
    assert.deepEqual([id.email, id['https://api.openai.com/auth'].chatgpt_plan_type, id['https://api.openai.com/auth'].organizations.length], ['plan@example.com', 'plus', 1])

    // Refresh rotates the refresh token; using one twice is OpenAI's refresh_token_reused.
    const refresh = { grant_type: 'refresh_token', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', refresh_token: granted.refresh_token }
    const refreshed = await (await formPost(tokenUrl, refresh)).json()
    assert.ok(refreshed.access_token !== granted.access_token && refreshed.refresh_token !== granted.refresh_token)
    const reused = await formPost(tokenUrl, refresh)
    assert.deepEqual([reused.status, (await reused.json()).error.code], [401, 'refresh_token_reused'])

    // The plan chosen on the form, for a new account; "Unchanged" keeps it on the next sign-in.
    const pro = new URL((await form({ email: 'pro@example.com', plan: 'pro' })).headers.get('location')).searchParams.get('code')
    assert.equal(claimsOf((await (await formPost(tokenUrl, { ...exchange, code: pro })).json()).access_token)['https://api.openai.com/auth'].chatgpt_plan_type, 'pro')
    const kept = new URL((await form({ email: 'pro@example.com', plan: '' })).headers.get('location')).searchParams.get('code')
    assert.equal(claimsOf((await (await formPost(tokenUrl, { ...exchange, code: kept })).json()).access_token)['https://api.openai.com/auth'].chatgpt_plan_type, 'pro')
  } finally { await close() }
})

test('openai Plan: device-code sign-in as pi-ai polls it', async () => {
  const { base, close } = await start()
  try {
    const device = await (await jsonPost(`${base}/auth.openai.com/api/accounts/deviceauth/usercode`, { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })).json()
    assert.match(device.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{5}$/)
    assert.equal(device.interval, '5')
    const poll = () => jsonPost(`${base}/auth.openai.com/api/accounts/deviceauth/token`, { device_auth_id: device.device_auth_id, user_code: device.user_code })
    assert.equal((await poll()).status, 403)
    assert.match(await (await fetch(`${base}/auth.openai.com/codex/device`)).text(), /name="user_code"/)
    assert.equal((await formPost(`${base}/auth.openai.com/codex/device`, { user_code: 'NOPE-NOPE0', email: 'device@example.com' })).status, 400)
    assert.equal((await formPost(`${base}/auth.openai.com/codex/device`, { user_code: device.user_code.toLowerCase(), email: 'device@example.com', plan: 'pro' })).status, 200)
    const approved = await (await poll()).json()
    assert.equal((await poll()).status, 404)
    const tokens = await (await formPost(`${base}/auth.openai.com/oauth/token`, { grant_type: 'authorization_code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', code: approved.authorization_code,
      code_verifier: approved.code_verifier, redirect_uri: 'https://auth.openai.com/deviceauth/callback' })).json()
    assert.equal(claimsOf(tokens.access_token)['https://api.openai.com/profile'].email, 'device@example.com')
  } finally { await close() }
})

test('openai Plan: Codex responses (zstd SSE), x-codex headers, wham/usage windows that fill, 429 usage_limit_reached, reset', async () => {
  const { base, close } = await start()
  try {
    const signed = await (await jsonPost(`${base}/_sim/sign-in`, { provider: 'openai', email: 'limits@example.com', plan: 'plus' })).json()
    const accountId = claimsOf(signed.access_token)['https://api.openai.com/auth'].chatgpt_account_id
    const headers = { authorization: `Bearer ${signed.access_token}`, 'chatgpt-account-id': accountId }
    const codex = (input, extra = {}) => fetch(`${base}/chatgpt.com/backend-api/codex/responses`, { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'content-encoding': 'zstd', accept: 'text/event-stream', 'openai-beta': 'responses=experimental' },
      body: zstdCompressSync(JSON.stringify({ model: 'gpt-5.5', store: false, stream: true, instructions: 'You are terse.', input, include: ['reasoning.encrypted_content'], ...extra })) })
    const usage = async () => (await fetch(`${base}/chatgpt.com/backend-api/wham/usage`, { headers })).json()

    const fresh = await usage()
    assert.deepEqual([fresh.plan_type, fresh.email, fresh.account_id, fresh.rate_limit.primary_window.used_percent, fresh.rate_limit.primary_window.limit_window_seconds, fresh.rate_limit.secondary_window.limit_window_seconds],
      ['plus', 'limits@example.com', accountId, 0, 18000, 604800])

    const reply = await codex(user('say from the plan'))
    assert.equal(reply.status, 200)
    assert.deepEqual([reply.headers.get('x-codex-primary-window-minutes'), reply.headers.get('x-codex-secondary-window-minutes'), reply.headers.get('x-codex-credits-has-credits')], ['300', '10080', 'false'])
    const sent = events(await reply.text())
    assert.deepEqual([sent.at(-1).type, sent.at(-1).response.output[0].content[0].text], ['response.completed', 'from the plan'])
    assert.equal((await codex(user('say hi'), { stream: false })).status, 400)
    assert.equal((await fetch(`${base}/chatgpt.com/backend-api/codex/responses`, { method: 'POST', headers: { ...headers, 'chatgpt-account-id': 'someone-else' }, body: '{}' })).status, 403)

    // Plus: two million tokens in five hours. 1.6 million is 80%.
    const warned = await codex(user(usageScript(1_600_000 - 10)))
    assert.deepEqual([warned.status, warned.headers.get('x-codex-primary-used-percent')], [200, '80'])
    await warned.text()
    const at80 = await usage()
    assert.deepEqual([at80.rate_limit.primary_window.used_percent, at80.rate_limit.secondary_window.used_percent, at80.rate_limit.limit_reached], [80, 8, false])
    assert.ok(at80.rate_limit.primary_window.reset_at - Date.now() / 1000 > 4.9 * 3600)

    // The request that crosses 100% is served; the next one is refused until the window resets.
    await (await codex(user(usageScript(400_000)))).text()
    const refused = await codex(user('say hi'))
    assert.equal(refused.status, 429)
    const error = (await refused.json()).error
    assert.deepEqual([error.type, error.plan_type], ['usage_limit_reached', 'plus'])
    assert.ok(error.resets_at - Date.now() / 1000 > 4.9 * 3600 && error.resets_in_seconds <= 5 * 3600)
    assert.equal(refused.headers.get('x-codex-primary-used-percent'), '100')
    assert.deepEqual([(await usage()).rate_limit.primary_window.used_percent, (await usage()).rate_limit.limit_reached], [100, true])

    // Six hours later the five-hour window is empty again; the weekly one is not.
    const started = new Date(Date.now() - 6 * 3600_000).toISOString()
    await jsonPost(`${base}/_sim/account`, { provider: 'openai', kind: 'email', credential: 'limits@example.com',
      state: { windows: { primary: { used: 2_000_000, start: started }, secondary: { used: 2_000_000, start: started } } } })
    const later = await usage()
    assert.deepEqual([later.rate_limit.primary_window.used_percent, later.rate_limit.secondary_window.used_percent], [0, 10])
    assert.equal((await codex(user('say hi'))).status, 200)

    // An expired access token, and an unknown one.
    const expired = await (await jsonPost(`${base}/_sim/sign-in`, { provider: 'openai', email: 'limits@example.com', accessSeconds: -1 })).json()
    const stale = await fetch(`${base}/chatgpt.com/backend-api/wham/usage`, { headers: { authorization: `Bearer ${expired.access_token}` } })
    assert.deepEqual([stale.status, (await stale.json()).error.code], [401, 'token_expired'])
    assert.equal((await fetch(`${base}/chatgpt.com/backend-api/wham/usage`, { headers: { authorization: 'Bearer nope' } })).status, 401)
  } finally { await close() }
})
