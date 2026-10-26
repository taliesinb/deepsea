import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLogin, runLogout, runLogins, prerequisiteAnswer, oauthLink, loopbackRedirect, flowName, flowsReport, flowHint, KNOWN_FLOWS, FLOWS_PATH, SIGN_IN_PATHS, signInRoutes } from '../index.js'

const KEY = 'llm-pi-ai/anthropic-oauth'
const URL = 'https://claude.ai/oauth/authorize?code=true&state=x'

/** A fake context: authorization flows driven by `run`, settings as one llm-pi-ai form. */
function fixture({ providers = {}, run, configured = new Set(), questions, account } = {}) {
  const state = { providers: structuredClone(providers), mutations: [], deleted: [], cancelled: [], inFlight: new Set() }
  const entries = [
    { key: KEY, label: 'Anthropic OAuth', methods: [{ id: 'oauth' }] },
    { key: 'llm-pi-ai/openai-codex-oauth', label: 'ChatGPT OAuth', methods: [{ id: 'oauth' }] },
    { key: 'deepseek-account/platform', label: 'DeepSeek', methods: [{ id: 'oauth' }] },
    { key: 'llm-pi-ai/legacy', label: 'Key only', methods: [{ id: 'api-key' }] },
  ]
  const ctx = {
    get: name => ({ userQuestions: questions, llm: {
      listConfigurableProviders: () => [{ provider: 'anthropic-oauth', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic-oauth'],
        signIn: { kind: 'subscription', vendor: 'Anthropic' } }],
      describeSignIn: async route => (route === 'anthropic-oauth' && account !== undefined ? { signedIn: true, account } : undefined),
    } })[name],
    authorization: {
      list: () => entries.map(entry => ({ ...entry, inFlight: state.inFlight.has(entry.key) })),
      cancel: key => { state.cancelled.push(key) },
      begin: async (request) => {
        state.inFlight.add(request.key)
        try { return await run(request) } finally { state.inFlight.delete(request.key) }
      },
    },
    credentials: {
      describeRecord: async key => ({ configured: configured.has(key) }),
      deleteRecord: async (key) => { state.deleted.push(key); configured.delete(key) },
    },
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: state.providers } }],
      mutate: async (ns, ops) => {
        state.mutations.push({ ns, ops })
        for (const op of ops) {
          const route = op.path[1]
          if (op.op === 'set') state.providers[route] = op.value
          else delete state.providers[route]
        }
      },
    },
  }
  return { ctx, state, attempts: new Map() }
}

const invocation = rawInput => ({ rawInput, agent: { id: 'agent' } })
const login = (f, rawInput, wait) => runLogin(f.ctx, f.attempts, invocation(rawInput), wait)
const logout = (f, rawInput) => runLogout(f.ctx, f.attempts, invocation(rawInput))
const logins = (f, rawInput) => runLogins(f.ctx, f.attempts, invocation(rawInput))

test('flow names drop the credential scope and one -oauth suffix', () => {
  assert.equal(flowName(KEY), 'anthropic')
  assert.equal(flowName('other/x-oauth'), undefined)
})

test('available lists only llm-pi-ai OAuth flows, optionally filtered; /login alone lists them too', async () => {
  const f = fixture()
  assert.deepEqual(await logins(f, 'available'), { kind: 'success', text: 'anthropic\nopenai-codex' })
  assert.deepEqual(await logins(f, 'available ANTH'), { kind: 'success', text: 'anthropic' })
  assert.equal((await logins(f, 'available zzz')).text, 'No sign-in flows match that filter.')
  assert.deepEqual(await login(f, ''), { kind: 'success', text: 'anthropic\nopenai-codex' })
})

test('activate returns the sign-in link and adds the route through the settings form once authorized', async () => {
  let release
  const f = fixture({ run: request => {
    request.interaction.notify({ message: 'open', url: URL })
    return new Promise((resolve) => { release = resolve })
  } })
  const result = await login(f, 'anthropic')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^If the sign-in page didn't open, click this link: \[claude\.ai\/oauth\/authorize\]\(https:\/\/claude\.ai/)
  // No route while the sign-in is pending: the model picker and Settings show nothing yet.
  assert.deepEqual(f.state.mutations, [])
  // A second activate while the attempt is pending repeats the link instead of starting another.
  assert.equal((await login(f, 'anthropic')).text, result.text)
  assert.equal((await logins(f, 'pending')).text, 'anthropic')
  release({ status: 'authorized' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(f.state.mutations, [{ ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'anthropic-oauth'], value: {} }] }])
})

test('an existing route is reused and never overwritten', async () => {
  const f = fixture({ providers: { 'anthropic-oauth': { displayName: 'Mine' } }, run: async (request) => {
    request.interaction.notify({ message: 'open', url: URL })
    return { status: 'authorized' }
  } })
  assert.equal((await login(f, 'anthropic')).kind, 'success')
  assert.deepEqual(f.state.mutations, [])
})

test('a failed attempt reports in flow terms and adds no route', async () => {
  const f = fixture({ run: async () => {
    throw Object.assign(new Error(`attempt for ${KEY} already in flight`), { code: 'ALREADY_IN_FLIGHT' })
  } })
  const result = await login(f, 'anthropic')
  assert.deepEqual(result, { kind: 'error', text: 'attempt for anthropic already in flight' })
  assert.deepEqual(f.state.providers, {})
  assert.deepEqual(f.state.mutations, [])
})

test('no browser URL within the wait fails and cleans up', async () => {
  const f = fixture({ run: request => new Promise((resolve) => {
    request.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true })
  }) })
  const result = await login(f, 'anthropic', 20)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /did not provide a browser URL/)
  assert.deepEqual(f.state.providers, {})
})

test('unknown flows, non-oauth methods and bad grammar are refused', async () => {
  const f = fixture()
  assert.match((await login(f, 'nope')).text, /Unknown authorization flow "nope"\. Run \/logins available/)
  assert.match((await login(f, 'anthropic api-key')).text, /supports only the oauth method/)
  assert.match((await login(f, 'anthropic oauth extra')).text, /^Usage: \/login /)
  assert.match((await logout(f, '')).text, /^Usage: \/logout /)
  assert.match((await logout(f, 'anthropic openai-codex')).text, /^Usage: \/logout /)
  assert.match((await logins(f, 'list extra')).text, /^Usage: \/logins /)
  assert.match((await logins(f, 'activate anthropic')).text, /^Usage: \/logins /)
})

test('cancel withdraws pending attempts', async () => {
  const f = fixture({ run: request => new Promise((resolve) => {
    request.interaction.notify({ message: 'open', url: URL })
    request.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true })
  }) })
  assert.equal((await logins(f, 'cancel')).text, 'No pending sign-ins to cancel.')
  await login(f, 'anthropic')
  assert.equal((await logins(f, 'cancel openai-codex')).text, 'No pending openai-codex sign-in to cancel.')
  assert.equal((await logins(f, 'cancel anthropic')).text, 'Canceled pending anthropic sign-in.')
  assert.deepEqual(f.state.cancelled, [KEY])
})

test('/logins lists the stored grants; /logout deletes one with the empty route a sign-in created', async () => {
  const f = fixture({ configured: new Set([KEY]), providers: { 'anthropic-oauth': {} } })
  assert.equal((await logins(f, '')).text, 'anthropic')
  assert.equal((await logins(f, 'list')).text, 'anthropic')
  assert.equal((await logout(f, 'openai-codex')).text, 'Not signed in to openai-codex.')
  assert.equal((await logout(f, 'anthropic')).text, 'Signed out of anthropic.')
  assert.deepEqual(f.state.deleted, [KEY])
  assert.deepEqual(f.state.providers, {})
  assert.equal((await logins(f, '')).text, 'No sign-ins are active.')
  // A route the user customized stays, without its grant.
  const custom = fixture({ configured: new Set([KEY]), providers: { 'anthropic-oauth': { models: [{ id: 'claude-sonnet-4-5' }] } } })
  assert.equal((await logout(custom, 'anthropic')).text, 'Signed out of anthropic.')
  assert.deepEqual(Object.keys(custom.state.providers), ['anthropic-oauth'])
})

test('only an authorized sign-in adds its route', async () => {
  for (const ending of ['cancelled', 'failed', 'authorized']) {
    let end
    const f = fixture({ run: request => new Promise((resolve, reject) => {
      request.interaction.notify({ message: 'open', url: URL })
      end = () => ending === 'failed' ? reject(new Error('provider refused')) : resolve({ status: ending })
    }) })
    assert.equal((await login(f, 'anthropic')).kind, 'success')
    assert.deepEqual(f.state.providers, {})
    end()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(f.state.providers, ending === 'authorized' ? { 'anthropic-oauth': {} } : {}, ending)
  }
  // A route that existed before the sign-in is never removed.
  const kept = fixture({ providers: { 'anthropic-oauth': {} }, run: request => new Promise((resolve) => {
    request.interaction.notify({ message: 'open', url: URL })
    request.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true })
  }) })
  await login(kept, 'anthropic')
  await logins(kept, 'cancel anthropic')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(kept.state.providers, { 'anthropic-oauth': {} })
})

test('prerequisite questions go to the session; secret prompts are refused', async () => {
  const asked = []
  const questions = { ask: async (request) => {
    asked.push(request.questions[0])
    return { answers: [{ id: 'oauth-prerequisite', selected: ['2. Console'] }] }
  } }
  let chosen
  const f = fixture({ questions, run: async (request) => {
    chosen = await request.interaction.prompt({ kind: 'select', message: 'Which account?', options: [{ id: 'max', label: 'Max' }, { id: 'console', label: 'Console' }] })
    request.interaction.notify({ message: 'open', url: URL })
    return { status: 'authorized' }
  } })
  assert.equal((await login(f, 'anthropic')).kind, 'success')
  assert.equal(chosen, 'console')
  assert.equal(asked[0].question, 'Which account?')

  const secret = fixture({ questions, run: request => request.interaction.prompt({ kind: 'secret', message: 'Paste key' }) })
  assert.match((await login(secret, 'anthropic')).text, /Secret prompts are not supported/)
})

test('prerequisite answers must be one offered option or typed text where allowed', () => {
  const options = [{ label: 'Use default (empty)', value: '' }]
  assert.equal(prerequisiteAnswer({ answers: [{ id: 'oauth-prerequisite', selected: [], custom: 'acme' }] }, options, true), 'acme')
  assert.equal(prerequisiteAnswer({ answers: [{ id: 'oauth-prerequisite', selected: ['Use default (empty)'] }] }, options, true), '')
  assert.throws(() => prerequisiteAnswer({ answers: [{ id: 'oauth-prerequisite', selected: [], custom: 'acme' }] }, options, false), /Invalid OAuth prerequisite answer/)
  assert.throws(() => prerequisiteAnswer({ answers: [] }, options, true), /Invalid/)
})

test('a non-URL notice passes through unchanged', () => {
  assert.equal(oauthLink('not a url', 'anthropic'), 'not a url')
  assert.match(oauthLink(URL, 'anthropic', 'ABCD'), /\nCode: `ABCD`\n/)
})

test('the sign-in link names the follow-up commands', () => {
  const text = oauthLink(URL, 'anthropic')
  assert.match(text, /Use `\/logins cancel anthropic` to abort the sign-in now\./)
  assert.match(text, /Use `\/logout anthropic` to sign out later\./)
})

test('apply registers /login, /logout and /logins, placeholders naming the flows, and the flows route', async () => {
  const { apply } = await import('../index.js')
  const f = fixture()
  const registered = [], routes = []
  apply({ ...f.ctx, effect(setup) { setup?.() },
    commands: { register: command => { registered.push(command) } },
    inject(names, callback) { if (names.includes('connection')) callback({ effect: setup => setup(), connection: { fetch: { register: route => { routes.push(route); return () => {} } } } }) } })
  assert.deepEqual(registered.map(c => c.name), ['login', 'logout', 'logins'])
  assert.equal(registered[0].input.hint, '[anthropic, openai-codex] [oauth | <address>]')
  assert.equal(registered[1].input.hint, '[anthropic, openai-codex]')
  assert.deepEqual(routes.map(r => [r.path, r.methods]), [
    [FLOWS_PATH, ['GET']], [SIGN_IN_PATHS.start, ['POST']], [SIGN_IN_PATHS.status, ['GET']],
    [SIGN_IN_PATHS.answer, ['POST']], [SIGN_IN_PATHS.cancel, ['POST']],
  ])
  const response = await routes[0].fetch(new Request('http://localhost/api/deepsea-login/flows'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await response.json()).flows.map(flow => flow.name), ['anthropic', 'openai-codex'])
})

test('the flow list carries labels, the oauth method, and sign-in state', async () => {
  const f = fixture({ configured: new Set([KEY]) })
  assert.deepEqual(await flowsReport(f.ctx), { flows: [
    { name: 'anthropic', label: 'Anthropic OAuth', route: 'anthropic-oauth', kind: 'subscription', vendor: 'Anthropic',
      methods: [{ id: 'oauth', label: undefined }], active: true, pending: false },
    { name: 'openai-codex', label: 'ChatGPT OAuth', route: 'openai-codex-oauth', methods: [{ id: 'oauth', label: undefined }], active: false, pending: false },
  ] })
})

test("placeholders fall back to pi-ai's known flows before llm-pi-ai registers any", () => {
  assert.equal(flowHint({ authorization: { list: () => [] } }), `[${KNOWN_FLOWS.join(', ')}]`)
})

test('cancelling withdraws a racing callback question even when the provider has not', async () => {
  let questionSettled
  const f = fixture({ run: request => new Promise((resolve) => {
    request.interaction.notify({ message: 'open', url: URL })
    // pi-ai's shape: the question's own signal is never aborted before the answer.
    const never = new AbortController()
    questionSettled = request.interaction.prompt({ kind: 'text', message: 'Paste the code', signal: never.signal })
      .then(() => 'answered', () => 'withdrawn')
    request.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true })
  }) })
  await login(f, 'anthropic')
  assert.equal((await logins(f, 'cancel anthropic')).text, 'Canceled pending anthropic sign-in.')
  assert.equal(await questionSettled, 'withdrawn')
})

/** pi-ai's loopback flow: the link, then a text question racing the browser callback on its own signal. */
const LOOPBACK_URL = 'https://claude.ai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback&state=x'
const ADDRESS = 'http://localhost:53692/callback?code=abc&state=x'
function racingFlow() {
  const flow = { pasted: undefined, callback: undefined }
  flow.run = request => new Promise((resolve) => {
    request.interaction.notify({ message: 'open', url: LOOPBACK_URL })
    const racing = new AbortController()
    flow.callback = () => { racing.abort(); resolve({ status: 'authorized' }) }
    request.interaction.prompt({ kind: 'text', message: 'Paste the redirect URL', signal: racing.signal })
      .then((value) => { flow.pasted = value; resolve(value === ADDRESS ? { status: 'authorized' } : Promise.reject(new Error('Invalid authorization code'))) }, () => {})
    request.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true })
  })
  return flow
}

test('a loopback redirect: the link says how to finish from another machine', () => {
  assert.equal(loopbackRedirect(LOOPBACK_URL), 'localhost:53692/callback')
  assert.equal(loopbackRedirect(URL), undefined)
  assert.equal(loopbackRedirect('https://x.example/a?redirect_uri=https%3A%2F%2Fapp.example%2Fcb'), undefined)
  assert.match(oauthLink(LOOPBACK_URL, 'anthropic'), /If the browser ends on a `localhost:53692\/callback` page that does not load, copy its address and run `\/login anthropic <address>`\./)
  assert.doesNotMatch(oauthLink(URL, 'anthropic'), /does not load/)
})

test('/login FLOW <address> finishes a pending sign-in with the address the browser ended on', async () => {
  const flow = racingFlow()
  const f = fixture({ run: flow.run })
  assert.match((await login(f, 'anthropic')).text, /\/login anthropic <address>/)
  await tick()
  assert.deepEqual(await login(f, `anthropic ${ADDRESS}`), { kind: 'success', text: 'Signed in to anthropic.' })
  assert.equal(flow.pasted, ADDRESS)
  await tick()
  assert.deepEqual(f.state.providers, { 'anthropic-oauth': {} })
  // Nothing is waiting any more.
  assert.deepEqual(await login(f, `anthropic ${ADDRESS}`), { kind: 'error', text: 'No anthropic sign-in is waiting. Start one with /login anthropic.' })
})

test('a wrong address fails the sign-in; once the callback wins, a paste is refused', async () => {
  const bad = fixture({ run: racingFlow().run })
  await login(bad, 'anthropic')
  await tick()
  assert.deepEqual(await login(bad, 'anthropic code#other'), { kind: 'error', text: 'Invalid authorization code' })

  const flow = racingFlow()
  const f = fixture({ run: flow.run })
  await login(f, 'anthropic')
  await tick()
  flow.callback()
  await tick()
  assert.match((await login(f, `anthropic ${ADDRESS}`)).text, /No anthropic sign-in is waiting/)
  // A flow with no paste question refuses an address; a method word is still a method.
  const plain = fixture({ run: request => new Promise(() => { request.interaction.notify({ message: 'open', url: URL }) }) })
  await login(plain, 'anthropic')
  assert.deepEqual(await login(plain, `anthropic ${ADDRESS}`), { kind: 'error', text: 'The anthropic sign-in does not take a pasted address; finish it in the browser.' })
  assert.match((await login(plain, 'anthropic api-key')).text, /supports only the oauth method/)
})

/** The dialog's routes over one fixture, called like the browser does. */
function dialog(f, wait) {
  const routes = new Map(signInRoutes(f.ctx, f.attempts, wait).map(route => [route.path, route]))
  const post = async (path, body, type = 'application/json') => {
    const response = await routes.get(path).fetch(new Request(`http://localhost${path}`, {
      method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }
  const status = async flow => (await (await routes.get(SIGN_IN_PATHS.status).fetch(new Request(`http://localhost${SIGN_IN_PATHS.status}?flow=${flow}`))).json())
  return { post, status }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('the dialog starts a sign-in, shows its page and code while waiting, and reports the account once authorized', async () => {
  let finish
  const f = fixture({
    account: { email: 'user@example.com', plan: 'claude_max' },
    run: request => new Promise((resolve) => {
      request.interaction.notify({ message: 'open', url: URL, code: 'WXYZ-1234' })
      finish = () => resolve({ status: 'authorized' })
    }),
  })
  const d = dialog(f)
  assert.deepEqual(await d.status('anthropic'), { flow: 'anthropic', state: 'idle' })
  const started = await d.post(SIGN_IN_PATHS.start, { flow: 'anthropic' })
  assert.equal(started.status, 200)
  assert.deepEqual(started.body, { flow: 'anthropic', state: 'waiting', url: URL, code: 'WXYZ-1234', message: 'open' })
  // No route until the grant lands.
  assert.deepEqual(f.state.providers, {})
  // Starting again while it is pending reuses the attempt.
  assert.equal((await d.post(SIGN_IN_PATHS.start, { flow: 'anthropic' })).body.url, URL)
  finish()
  await tick()
  assert.deepEqual(f.state.providers, { 'anthropic-oauth': {} })
  assert.deepEqual(await d.status('anthropic'), {
    flow: 'anthropic', state: 'authorized', url: URL, code: 'WXYZ-1234', message: 'open', account: { email: 'user@example.com', plan: 'claude_max' },
  })
})

test('the dialog answers the questions a flow asks, refusing stale or invalid answers', async () => {
  let asked
  const f = fixture({ run: async (request) => {
    asked = await request.interaction.prompt({ kind: 'select', message: 'Select login method:', options: [{ id: 'browser', label: 'Browser' }, { id: 'device', label: 'Device code' }] })
    request.interaction.notify({ message: 'open', url: URL })
    return new Promise(() => {})
  } })
  const d = dialog(f)
  const started = await d.post(SIGN_IN_PATHS.start, { flow: 'anthropic' })
  // The flow asks at once, so the start answer already carries the question.
  assert.equal(started.body.state, 'question')
  const question = started.body.question
  assert.deepEqual((await d.status('anthropic')).question, question)
  assert.deepEqual({ ...question, id: undefined }, {
    id: undefined, kind: 'select', message: 'Select login method:', options: [{ id: 'browser', label: 'Browser' }, { id: 'device', label: 'Device code' }],
  })
  assert.equal((await d.post(SIGN_IN_PATHS.answer, { flow: 'anthropic', id: 'stale', value: 'browser' })).status, 409)
  assert.equal((await d.post(SIGN_IN_PATHS.answer, { flow: 'anthropic', id: question.id, value: 'other' })).status, 400)
  const answered = await d.post(SIGN_IN_PATHS.answer, { flow: 'anthropic', id: question.id, value: 'device' })
  assert.equal(answered.status, 200)
  await tick()
  assert.equal(asked, 'device')
  assert.equal((await d.status('anthropic')).state, 'waiting')
})

test('cancelling from the dialog ends the attempt; a sign-in without a page fails; neither adds a route', async () => {
  const f = fixture({ run: request => new Promise((resolve) => {
    request.interaction.notify({ message: 'open', url: URL })
    request.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true })
  }) })
  const d = dialog(f)
  await d.post(SIGN_IN_PATHS.start, { flow: 'anthropic' })
  const cancelled = await d.post(SIGN_IN_PATHS.cancel, { flow: 'anthropic' })
  await tick()
  assert.deepEqual(f.state.cancelled, ['llm-pi-ai/anthropic-oauth'])
  assert.equal((await d.status('anthropic')).state, 'cancelled')
  assert.equal(cancelled.status, 200)

  const silent = fixture({ run: request => new Promise((resolve) => {
    request.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true })
  }) })
  const s = dialog(silent, 5)
  await s.post(SIGN_IN_PATHS.start, { flow: 'anthropic' })
  await new Promise(resolve => setTimeout(resolve, 30))
  const failed = await s.status('anthropic')
  assert.equal(failed.state, 'failed')
  assert.match(failed.error, /did not provide a browser URL/)
  assert.deepEqual(silent.state.providers, {})
})

test('the dialog offers the paste while the flow takes one, and refuses it otherwise', async () => {
  const flow = racingFlow()
  const f = fixture({ run: flow.run })
  const d = dialog(f)
  await d.post(SIGN_IN_PATHS.start, { flow: 'anthropic' })
  await tick()
  assert.equal((await d.status('anthropic')).paste, true)
  assert.equal((await d.post(SIGN_IN_PATHS.answer, { flow: 'anthropic', paste: '' })).status, 400)
  assert.equal((await d.post(SIGN_IN_PATHS.answer, { flow: 'anthropic', paste: 7 })).status, 400)
  assert.equal((await d.post(SIGN_IN_PATHS.answer, { flow: 'anthropic', paste: ` ${ADDRESS} ` })).status, 200)
  await tick()
  assert.equal(flow.pasted, ADDRESS)
  const after = await d.status('anthropic')
  assert.equal(after.state, 'authorized')
  assert.equal('paste' in after, false)
  assert.equal((await d.post(SIGN_IN_PATHS.answer, { flow: 'anthropic', paste: ADDRESS })).status, 409)
})

test('the dialog routes refuse non-JSON bodies and unknown flows', async () => {
  const d = dialog(fixture({ run: () => new Promise(() => {}) }))
  assert.equal((await d.post(SIGN_IN_PATHS.start, 'flow=anthropic', 'application/x-www-form-urlencoded')).status, 400)
  assert.equal((await d.post(SIGN_IN_PATHS.start, { flow: 'nope' })).status, 404)
  assert.equal((await d.post(SIGN_IN_PATHS.start, { flow: 'legacy' })).status, 404)
})
