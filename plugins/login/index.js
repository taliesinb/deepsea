/**
 * @deepsea/login: `/login`, `/logout` and `/logins` over the provider OAuth
 * sign-ins that llm-pi-ai registers with `ctx.authorization` (harness topic
 * `pi-ai-oauth-routes`). Two halves:
 *
 *   host (this file)   the commands
 *   browser (lib/client.js, src/client/)
 *                      their card on the keyed `conversation.chat.commandview`
 *                      slot; a sign-in link renders as one click
 *
 *   /login FLOW [oauth]           start sign-in; the `<flow>-oauth` route is added once authorized
 *   /login FLOW <address>         finish it with the address a browser on another machine ended on
 *   /login                        the flows offering a sign-in (= /logins available)
 *   /logout FLOW                  delete a stored grant (and the empty route its sign-in added)
 *   /logins [list]                flows whose grant is stored
 *   /logins available [STRING]    flows offering a sign-in, optionally filtered
 *   /logins pending               attempts in flight
 *   /logins cancel [FLOW]         withdraw one or every pending attempt
 *
 * The browser half turns a bare `/login` into a picker of the flows (one row
 * per flow and method) and a bare `/logout` into a picker of the active
 * sign-ins, both read from `GET /api/deepsea-login/flows`; the placeholders
 * list the flow names. When `/login` returns a sign-in URL, the browser half
 * opens it in the user's own browser (the DeepSea app's native opener, else a
 * new tab), and the card's link opens there too, never in the sidebar browser.
 *
 * Flow names are the credential keys `llm-pi-ai/<provider>-oauth` without the
 * scope and the `-oauth` suffix. Once a sign-in is authorized its route is
 * created through `ctx.settings` in the form namespace llm-pi-ai reports for
 * it (`settingsNs`/`settingsPath` of `ctx.llm.listConfigurableProviders()`),
 * i.e. the profile entry's Config: the same write the Models page makes.
 * Prerequisite questions (account, domain, login method) go to the initiating
 * session, or to the Add login dialog; secret prompts are refused.
 */

export const name = 'deepsea-login'
export const inject = ['authorization', 'commands', 'credentials', 'settings']

/** The browser half's flow list. */
export const FLOWS_PATH = '/api/deepsea-login/flows'
/** The sign-in dialog's routes: start (POST), status (GET ?flow=), answer (POST: a question's answer or a pasted address), cancel (POST). */
export const SIGN_IN_PATHS = {
  start: '/api/deepsea-login/start',
  status: '/api/deepsea-login/status',
  answer: '/api/deepsea-login/answer',
  cancel: '/api/deepsea-login/cancel',
}

/**
 * pi-ai's OAuth providers as of 0.87.1 (llm-pi-ai registers one flow each);
 * the placeholders fall back to these when the flows are not registered yet.
 */
export const KNOWN_FLOWS = ['anthropic', 'github-copilot', 'kimi-coding', 'meta', 'openai-codex', 'openrouter', 'radius', 'xai']

const FLOW_SCOPE = 'llm-pi-ai'
const USAGE = {
  login: 'Usage: /login FLOW [METHOD]  (/login alone lists the flows)',
  logout: 'Usage: /logout FLOW  (/logins lists the active sign-ins)',
  logins: 'Usage: /logins [list] | available [STRING] | pending | cancel [FLOW]',
}
export const URL_WAIT_MS = 30_000

/** A failure this command reports as its own result text. */
export class SignInError extends Error {
  /** @param {string} message @param {string} code @param {ErrorOptions} [options] */
  constructor(message, code, options) {
    super(message, options)
    this.name = 'SignInError'
    this.code = code
  }
}

/** @param {string} key */
function providerRoute(key) {
  const prefix = `${FLOW_SCOPE}/`
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined
}

/** @param {string} key */
export function flowName(key) {
  return providerRoute(key)?.replace(/-oauth$/u, '')
}

const declined = key => new SignInError(`Authorization for ${flowName(key) ?? key} was cancelled.`, 'DECLINED')

/** @returns {string | { kind: 'error', text: string }} */
function keyFor(entries, value) {
  const match = entries.find(entry => flowName(entry.key) === value)
  return match?.key ?? { kind: 'error', text: `Unknown authorization flow ${JSON.stringify(value.replace(/-oauth$/u, ''))}. Run /logins available.` }
}

const formatList = (values, empty) => ({ kind: 'success', text: values.length === 0 ? empty : values.join('\n') })

function available(entries, filter) {
  const needle = filter?.toLocaleLowerCase()
  const names = entries.map(entry => flowName(entry.key))
    .filter(value => value !== undefined && (needle === undefined || value.toLocaleLowerCase().includes(needle)))
    .sort()
  return formatList(names, filter === undefined ? 'No sign-in flows are available.' : 'No sign-in flows match that filter.')
}

async function active(ctx, entries) {
  const names = await Promise.all(entries.map(async entry => (
    (await ctx.credentials.describeRecord(entry.key)).configured ? flowName(entry.key) : undefined
  )))
  return formatList(names.filter(value => value !== undefined).sort(), 'No sign-ins are active.')
}

function pending(entries) {
  const names = entries.filter(entry => entry.inFlight).map(entry => flowName(entry.key))
  return formatList(names.filter(value => value !== undefined).sort(), 'No sign-ins are pending.')
}

/**
 * Hold a browser-callback fallback text prompt (pi-ai's "paste the redirect URL") on the attempt
 * until an address is pasted (`attempt.paste.give`, from `/login FLOW <address>` or the dialog) or
 * it is withdrawn: the callback won, or the attempt ended.
 */
function holdPaste(attempt, signal) {
  return new Promise((resolve, reject) => {
    const withdrawn = () => new Error('authorization prompt withdrawn', { cause: signal.reason })
    if (signal.aborted) { reject(withdrawn()); return }
    const paste = { give: (value) => { if (attempt.paste === paste) attempt.paste = undefined; resolve(value) } }
    attempt.paste = paste
    signal.addEventListener('abort', () => { if (attempt.paste === paste) attempt.paste = undefined; reject(withdrawn()) }, { once: true })
  })
}

/** Keep a browser-callback fallback prompt pending until its provider withdraws it. */
function waitForCallback(signal) {
  return new Promise((_resolve, reject) => {
    const withdrawn = () => new Error('authorization prompt withdrawn', { cause: signal.reason })
    if (signal.aborted) { reject(withdrawn()); return }
    signal.addEventListener('abort', () => { reject(withdrawn()) }, { once: true })
  })
}

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Validate the answer the UI returned before handing a value to the provider. */
export function prerequisiteAnswer(value, options, text) {
  const invalid = () => new SignInError('Invalid OAuth prerequisite answer. Activate the flow again and choose one offered option or enter text when requested.', 'INVALID_ANSWER')
  if (!isRecord(value) || !Array.isArray(value.answers) || value.answers.length !== 1) throw invalid()
  const answer = value.answers[0]
  if (!isRecord(answer) || answer.id !== 'oauth-prerequisite' || !Array.isArray(answer.selected)) throw invalid()
  if (answer.selected.length === 0 && text && typeof answer.custom === 'string' && answer.custom.trim().length > 0) return answer.custom
  if (answer.selected.length !== 1 || (answer.custom !== undefined && answer.custom !== '')) throw invalid()
  const option = options.find(candidate => candidate.label === answer.selected[0])
  if (option === undefined) throw invalid()
  return option.value
}

/** Collect only non-secret prerequisites from the initiating agent's human. */
async function askPrerequisite(ctx, agent, prompt, signal) {
  if (prompt.kind === 'secret') {
    throw new SignInError('Secret prompts are not supported by /login. Use a dedicated secure authorization surface.', 'SECRET_PROMPT')
  }
  // A question racing a browser callback: held until the provider withdraws it, or until this
  // attempt ends — pi-ai withdraws it only after awaiting it, so on an llm-pi-ai without the
  // attempt-signal fix a cancel would otherwise hang the attempt and keep its callback port.
  if (prompt.signal !== undefined) return waitForCallback(AbortSignal.any([prompt.signal, signal]))
  const questions = ctx.get('userQuestions')
  if (questions === undefined) {
    throw new SignInError('This OAuth flow requires a human answer. Enable user questions in this session and activate the flow again.', 'INTERACTION_UNAVAILABLE')
  }
  const options = prompt.kind === 'select'
    ? prompt.options.map((option, index) => ({ label: `${String(index + 1)}. ${option.label}`, value: option.id }))
    : [{ label: 'Use default (empty)', value: '' }]
  let answer
  try {
    answer = await questions.ask({
      agent,
      signal,
      questions: [{ id: 'oauth-prerequisite', question: prompt.message, options: options.map(option => ({ label: option.label })), multiSelect: false }],
    })
  } catch (error) {
    throw new SignInError('The OAuth prerequisite question could not be answered. Activate the flow from an interactive live session.', 'INTERACTION_FAILED', { cause: error })
  }
  return prerequisiteAnswer(answer, options, prompt.kind === 'text')
}

/**
 * Begin one attempt; `urlReady` settles with the first notice carrying a
 * browser URL, or rejects on cancel, failure, or `urlWaitMs` without one (the
 * wait pauses while a prerequisite question is open). `ask(prompt, signal,
 * attempt)` answers the flow's own questions: in the session for /login, in
 * the dialog for the Models page. A question racing a browser callback is
 * never asked; it is held until the provider or this attempt withdraws it.
 */
function startAttempt(ctx, attempts, key, ask, urlWaitMs) {
  const controller = new AbortController()
  const urlReady = Promise.withResolvers()
  const attempt = { key, controller, urlReady, notice: undefined, settlement: undefined, failure: undefined, question: undefined, answer: undefined, paste: undefined }
  attempts.set(key, attempt)
  let timer
  let remaining = urlWaitMs
  let started = 0
  const pause = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    remaining -= Date.now() - started
  }
  const resume = () => {
    if (controller.signal.aborted || attempt.notice?.url !== undefined || attempt.settlement !== undefined) return
    started = Date.now()
    timer = setTimeout(() => {
      const error = new SignInError(`authorization for "${flowName(key) ?? key}" did not provide a browser URL`, 'NO_URL')
      attempt.failure = error.message
      urlReady.reject(error)
      controller.abort()
    }, Math.max(0, remaining))
  }
  controller.signal.addEventListener('abort', () => { pause(); urlReady.reject(declined(key)) }, { once: true })
  void urlReady.promise.then(pause, pause)
  resume()
  const begun = ctx.authorization.begin({
    key,
    method: 'oauth',
    signal: controller.signal,
    interaction: {
      notify(notice) {
        if (notice.url !== undefined || attempt.notice === undefined) attempt.notice = notice
        if (notice.url !== undefined) urlReady.resolve(notice)
      },
      async prompt(prompt) {
        if (prompt.kind === 'secret') {
          throw new SignInError('Secret prompts are not supported by /login. Use a dedicated secure authorization surface.', 'SECRET_PROMPT')
        }
        // A question racing the browser callback is never put to anyone: a text one (the redirect
        // address, for a browser on another machine) is held for a paste, any other until withdrawn.
        // pi-ai withdraws a racing question only after awaiting it, so on an llm-pi-ai without the
        // attempt-signal fix a cancel would otherwise hang the attempt and keep its callback port.
        if (prompt.signal !== undefined) {
          const racing = AbortSignal.any([prompt.signal, controller.signal])
          return prompt.kind === 'text' ? holdPaste(attempt, racing) : waitForCallback(racing)
        }
        pause()
        try { return await ask(prompt, controller.signal, attempt) } finally { resume() }
      },
    },
  })
  // Settles with the attempt's settlement once the handlers below have recorded it.
  attempt.done = begun.then((outcome) => {
    attempt.settlement = outcome.status
    pause()
    if (outcome.status === 'cancelled') urlReady.reject(declined(key))
    else if (attempt.notice?.url === undefined) urlReady.reject(new SignInError('OAuth completed without providing a browser URL.', 'NO_URL'))
  }, (error) => {
    attempt.settlement = 'failed'
    attempt.failure = error instanceof Error ? error.message : String(error)
    pause()
    urlReady.reject(error)
  }).then(() => attempt.settlement)
  return attempt
}

/**
 * Start a sign-in. Its route is added (an empty profile, when there is none)
 * only once the grant lands, so a sign-in in progress, cancelled or failed
 * shows no provider in the model picker or Settings ▸ Models.
 */
async function beginSignIn(ctx, attempts, key, ask, urlWaitMs) {
  const attempt = startAttempt(ctx, attempts, key, ask, urlWaitMs)
  void attempt.done.then(async (settlement) => {
    if (settlement !== 'authorized') return
    const location = routeLocation(ctx, providerRoute(key))
    if (routeProfile(ctx, location) === undefined) await ctx.settings.mutate(location.ns, [{ op: 'set', path: location.path, value: {} }])
  }).catch((error) => {
    ctx.logger?.warn?.(`login: signed in to ${flowName(key) ?? key}, but could not add its route: ${error instanceof Error ? error.message : String(error)}`)
  })
  return attempt
}

/** The loopback address a sign-in URL redirects to (`redirect_uri`), or undefined. Exported for tests. */
export function loopbackRedirect(url) {
  try {
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '')
    return ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) ? `${redirect.host}${redirect.pathname}` : undefined
  } catch {
    return undefined
  }
}

/** Whether a /login word is a pasted redirect address or code (`https://…`, `…?code=…`, `code#state`), not a method. */
const isPasted = word => /:\/\/|[=#]/u.test(word)

/** How long `/login FLOW <address>` waits for the sign-in to finish before answering. */
export const PASTE_WAIT_MS = 30_000

/** The result text for a browser URL: one Markdown link plus the follow-up commands. */
export function oauthLink(url, flow, code) {
  try {
    const { hostname, pathname } = new URL(url)
    const label = `${hostname}${pathname}`.replace(/\/$/u, '')
    const redirect = loopbackRedirect(url)
    return [
      `If the sign-in page didn't open, click this link: [${label}](${url})`,
      ...code === undefined ? [] : [`Code: \`${code}\``],
      // The redirect goes to this server's loopback: a browser on another machine lands on its own.
      ...redirect === undefined ? [] : [`If the browser ends on a \`${redirect}\` page that does not load, copy its address and run \`/login ${flow} <address>\`.`],
      'Provider will be added automatically.',
      `Use \`/logins cancel ${flow}\` to abort the sign-in now.`,
      `Use \`/logout ${flow}\` to sign out later.`,
    // Paragraphs: the card renders Markdown, where a single newline is a soft break.
    ].join('\n\n')
  } catch {
    // Not a URL: show the provider's text unchanged.
    return url
  }
}

/** Where llm-pi-ai keeps a route's profile: its settings form namespace and path. */
function routeLocation(ctx, route) {
  const entry = ctx.get('llm')?.listConfigurableProviders?.().find(candidate => candidate.provider === route)
  return { ns: entry?.settingsNs ?? FLOW_SCOPE, path: entry?.settingsPath ?? ['providers', route] }
}

/** The route's current profile in the resolved Config, or undefined when absent. */
function routeProfile(ctx, { ns, path }) {
  let value = ctx.settings.describe().find(descriptor => descriptor.ns === ns)?.value
  for (const step of path) value = isRecord(value) ? value[step] : undefined
  return value
}

async function activate(ctx, attempts, entries, flow, agent, method, urlWaitMs) {
  const key = keyFor(entries, flow)
  if (typeof key === 'object') return key
  if (method !== undefined && method !== 'oauth' && isPasted(method)) return paste(attempts, key, flow, method, urlWaitMs === URL_WAIT_MS ? PASTE_WAIT_MS : urlWaitMs)
  if (method !== undefined && method !== 'oauth') {
    return { kind: 'error', text: `Authorization flow ${JSON.stringify(flow)} supports only the oauth method in /login. Configure API keys in Settings > Models.` }
  }
  const route = providerRoute(key)
  const existing = attempts.get(key)
  if (existing !== undefined && existing.settlement === undefined) {
    if (existing.notice?.url !== undefined) return { kind: 'success', text: oauthLink(existing.notice.url, flow, existing.notice.code) }
    return { kind: 'success', text: `${flow} authorization is still starting.` }
  }
  const attempt = await beginSignIn(ctx, attempts, key, (prompt, signal) => askPrerequisite(ctx, agent, prompt, signal), urlWaitMs)
  try {
    const notice = await attempt.urlReady.promise
    return { kind: 'success', text: notice.url === undefined ? notice.message : oauthLink(notice.url, flow, notice.code) }
  } catch (error) {
    if (typeof error?.code === 'string') {
      return { kind: 'error', text: String(error.message).replaceAll(key, flow).replaceAll(route, flow) }
    }
    throw error
  }
}

/**
 * `/login FLOW <address>`: hand the address a browser on another machine ended on (or a code) to
 * the pending sign-in, then wait up to `waitMs` for it to finish.
 */
async function paste(attempts, key, flow, text, waitMs) {
  const attempt = attempts.get(key)
  if (attempt === undefined || attempt.settlement !== undefined) return { kind: 'error', text: `No ${flow} sign-in is waiting. Start one with /login ${flow}.` }
  if (attempt.paste === undefined) return { kind: 'error', text: `The ${flow} sign-in does not take a pasted address; finish it in the browser.` }
  attempt.paste.give(text)
  let timer
  const settlement = await Promise.race([attempt.done, new Promise((resolve) => { timer = setTimeout(resolve, waitMs, 'pending') })])
  clearTimeout(timer)
  if (settlement === 'authorized') return { kind: 'success', text: `Signed in to ${flow}.` }
  if (settlement === 'pending') return { kind: 'success', text: `Address sent to the ${flow} sign-in; it has not finished yet (/logins pending).` }
  if (settlement === 'cancelled') return { kind: 'error', text: `The ${flow} sign-in was cancelled.` }
  return { kind: 'error', text: (attempt.failure ?? `The ${flow} sign-in failed.`).replaceAll(key, flow) }
}

async function deactivate(ctx, attempts, entries, flow) {
  const key = keyFor(entries, flow)
  if (typeof key === 'object') return key
  if (!(await ctx.credentials.describeRecord(key)).configured) return { kind: 'error', text: `Not signed in to ${flow}.` }
  attempts.get(key)?.controller.abort()
  ctx.authorization.cancel(key)
  await ctx.credentials.deleteRecord(key)
  attempts.delete(key)
  // The empty profile a sign-in created goes with the sign-in; a customized route stays.
  const location = routeLocation(ctx, providerRoute(key))
  const profile = routeProfile(ctx, location)
  if (isRecord(profile) && Object.keys(profile).length === 0) await ctx.settings.mutate(location.ns, [{ op: 'unset', path: location.path }])
  return { kind: 'success', text: `Signed out of ${flow}.` }
}

function cancel(ctx, attempts, entries, flow) {
  const pendingEntries = entries.filter(entry => entry.inFlight)
  if (flow !== undefined) {
    const key = keyFor(entries, flow)
    if (typeof key === 'object') return key
    if (!pendingEntries.some(candidate => candidate.key === key)) return { kind: 'success', text: `No pending ${flow} sign-in to cancel.` }
    attempts.get(key)?.controller.abort()
    ctx.authorization.cancel(key)
    return { kind: 'success', text: `Canceled pending ${flow} sign-in.` }
  }
  if (pendingEntries.length === 0) return { kind: 'success', text: 'No pending sign-ins to cancel.' }
  const cancelled = []
  for (const entry of pendingEntries) {
    attempts.get(entry.key)?.controller.abort()
    ctx.authorization.cancel(entry.key)
    const name = flowName(entry.key)
    if (name !== undefined) cancelled.push(`Canceled pending ${name} sign-in.`)
  }
  return { kind: 'success', text: cancelled.join('\n') }
}

/** The OAuth flows llm-pi-ai registers, under their short names. */
function flowEntries(ctx) {
  return ctx.authorization.list().filter(entry => (
    flowName(entry.key) !== undefined && entry.methods.some(method => method.id === 'oauth')
  ))
}

const wordsOf = invocation => invocation.rawInput.trim().split(/\s+/u).filter(Boolean)

/** Run one `/login` invocation: sign in to FLOW, or list the flows. Exported for tests. */
export async function runLogin(ctx, attempts, invocation, urlWaitMs = URL_WAIT_MS) {
  const [flow, method, ...rest] = wordsOf(invocation)
  const entries = flowEntries(ctx)
  if (flow === undefined) return available(entries)
  if (rest.length > 0) return { kind: 'error', text: USAGE.login }
  return activate(ctx, attempts, entries, flow, invocation.agent, method, urlWaitMs)
}

/** Run one `/logout` invocation: delete FLOW's stored grant. Exported for tests. */
export async function runLogout(ctx, attempts, invocation) {
  const words = wordsOf(invocation)
  if (words.length !== 1) return { kind: 'error', text: USAGE.logout }
  return deactivate(ctx, attempts, flowEntries(ctx), words[0])
}

/** Run one `/logins` invocation: list, available, pending, cancel. Exported for tests. */
export async function runLogins(ctx, attempts, invocation) {
  const words = wordsOf(invocation)
  const [action = 'list', argument] = words
  const entries = flowEntries(ctx)
  if (action === 'list' && words.length <= 1) return active(ctx, entries)
  if (action === 'available' && words.length <= 2) return available(entries, argument)
  if (action === 'pending' && words.length === 1) return pending(entries)
  if (action === 'cancel' && words.length <= 2) return cancel(ctx, attempts, entries, argument)
  return { kind: 'error', text: USAGE.logins }
}

/** Every flow with its sign-in state and the methods this command can start. Exported for tests. */
export async function flowsReport(ctx) {
  const directory = new Map((ctx.get('llm')?.listConfigurableProviders?.() ?? []).map(entry => [entry.provider, entry]))
  const flows = await Promise.all(flowEntries(ctx).map(async entry => ({
    name: flowName(entry.key),
    label: entry.label,
    route: providerRoute(entry.key),
    // A DSH whose llm directory carries no signIn leaves both absent.
    ...signInOf(directory.get(providerRoute(entry.key))),
    methods: entry.methods.filter(method => method.id === 'oauth').map(({ id, label }) => ({ id, label })),
    active: (await ctx.credentials.describeRecord(entry.key)).configured === true,
    pending: entry.inFlight === true,
  })))
  return { flows: flows.sort((a, b) => a.name.localeCompare(b.name)) }
}

/** The llm directory's sign-in classification of a route, when it has one. */
function signInOf(entry) {
  const signIn = entry?.signIn
  return signIn === undefined ? {} : { kind: signIn.kind, vendor: signIn.vendor }
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Cookie' } })

/** The dialog's answerer: hold the question on the attempt until the answer route resolves it. */
function askInDialog(prompt, signal, attempt) {
  return new Promise((resolve, reject) => {
    const settle = () => { attempt.question = undefined; attempt.answer = undefined }
    attempt.question = {
      id: crypto.randomUUID(),
      kind: prompt.kind === 'select' ? 'select' : 'text',
      message: prompt.message,
      ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      ...prompt.kind === 'select' ? { options: prompt.options.map(({ id, label }) => ({ id, label })) } : {},
    }
    attempt.answer = (value) => { settle(); resolve(value) }
    signal.addEventListener('abort', () => { settle(); reject(declined(attempt.key)) }, { once: true })
  })
}

/**
 * One flow's sign-in as the dialog shows it. Exported for tests.
 * @returns `{ flow, state, url?, code?, message?, question?, error?, account? }`; state is
 *   idle | starting | question | waiting | authorized | failed | cancelled.
 */
export async function signInStatus(ctx, attempts, key) {
  const flow = flowName(key)
  const attempt = attempts.get(key)
  if (attempt === undefined) return { flow, state: 'idle' }
  const notice = attempt.notice
  const base = {
    flow,
    ...notice?.url === undefined ? {} : { url: notice.url },
    ...notice?.code === undefined ? {} : { code: notice.code },
    ...notice?.message === undefined ? {} : { message: notice.message },
  }
  if (attempt.settlement === 'authorized') {
    // The account is display-only and read once; a DSH without describeSignIn shows none.
    attempt.account ??= await Promise.resolve(ctx.get('llm')?.describeSignIn?.(providerRoute(key)))
      .then(state => state?.account ?? null, () => null)
    return { ...base, state: 'authorized', ...attempt.account === null ? {} : { account: attempt.account } }
  }
  if (attempt.failure !== undefined || attempt.settlement === 'failed') return { ...base, state: 'failed', error: attempt.failure ?? 'Sign-in failed.' }
  if (attempt.settlement !== undefined) return { ...base, state: 'cancelled' }
  if (attempt.question !== undefined) return { ...base, state: 'question', question: attempt.question }
  // `paste`: the flow also takes the address the browser ended on (a browser on another machine).
  return { ...base, state: notice?.url === undefined ? 'starting' : 'waiting', ...attempt.paste === undefined ? {} : { paste: true } }
}

/**
 * The dialog's routes. POSTs require a JSON body, so a cross-site form cannot
 * reach them without a CORS preflight this server never answers. Exported for tests.
 */
export function signInRoutes(ctx, attempts, urlWaitMs = URL_WAIT_MS) {
  const flowKey = (flow) => {
    const key = typeof flow === 'string' ? keyFor(flowEntries(ctx), flow) : undefined
    return typeof key === 'string' ? key : undefined
  }
  const body = async (request) => {
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return undefined
    try { const value = await request.json(); return isRecord(value) ? value : undefined } catch { return undefined }
  }
  const post = (path, handle) => ({
    path, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const value = await body(request)
      if (value === undefined) return json({ error: 'expected a JSON object' }, 400)
      const key = flowKey(value.flow)
      if (key === undefined) return json({ error: `unknown sign-in flow ${JSON.stringify(value.flow)}` }, 404)
      return handle(key, value)
    },
  })
  return [
    post(SIGN_IN_PATHS.start, async (key) => {
      const existing = attempts.get(key)
      if (existing === undefined || existing.settlement !== undefined) {
        try {
          await beginSignIn(ctx, attempts, key, askInDialog, urlWaitMs)
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }
      return json(await signInStatus(ctx, attempts, key))
    }),
    {
      path: SIGN_IN_PATHS.status, methods: ['GET'], requestBody: 'buffered',
      fetch: async (request) => {
        const key = flowKey(new URL(request.url).searchParams.get('flow'))
        return key === undefined ? json({ error: 'unknown sign-in flow' }, 404) : json(await signInStatus(ctx, attempts, key))
      },
    },
    post(SIGN_IN_PATHS.answer, async (key, value) => {
      const attempt = attempts.get(key)
      // `{ flow, paste }`: the address the browser ended on, for a flow that takes one now.
      if (value.paste !== undefined) {
        if (attempt?.paste === undefined) return json({ error: 'this sign-in does not take a pasted address now' }, 409)
        if (typeof value.paste !== 'string' || value.paste.trim() === '' || value.paste.length > 4096) return json({ error: 'invalid address' }, 400)
        attempt.paste.give(value.paste.trim())
        return json(await signInStatus(ctx, attempts, key))
      }
      const question = attempt?.question
      if (question === undefined || value.id !== question.id) return json({ error: 'no such question is open' }, 409)
      const answer = value.value
      const valid = typeof answer === 'string' && answer.length <= 512
        && (question.kind !== 'select' || question.options.some(option => option.id === answer))
      if (!valid) return json({ error: 'invalid answer' }, 400)
      attempt.answer(answer)
      return json(await signInStatus(ctx, attempts, key))
    }),
    post(SIGN_IN_PATHS.cancel, async (key) => {
      attempts.get(key)?.controller.abort()
      ctx.authorization.cancel(key)
      return json(await signInStatus(ctx, attempts, key))
    }),
  ]
}

/** Placeholder text naming the flows: the registered ones, else pi-ai's known set. */
export function flowHint(ctx) {
  const names = flowEntries(ctx).map(entry => flowName(entry.key)).sort()
  return `[${(names.length > 0 ? names : KNOWN_FLOWS).join(', ')}]`
}

export function apply(ctx) {
  const attempts = new Map()
  ctx.effect(() => () => { for (const attempt of attempts.values()) attempt.controller.abort() }, 'login: pending attempts')
  ctx.commands.register({
    name: 'login',
    description: 'Sign in to a provider plan (or another browser sign-in)',
    input: { hint: `${flowHint(ctx)} [oauth | <address>]` },
    recordInput: true,
    handler: invocation => runLogin(ctx, attempts, invocation),
  })
  ctx.commands.register({
    name: 'logout',
    description: 'Sign out of a provider: delete its stored sign-in',
    input: { hint: flowHint(ctx) },
    recordInput: true,
    handler: invocation => runLogout(ctx, attempts, invocation),
  })
  ctx.commands.register({
    name: 'logins',
    description: 'List active, available or pending sign-ins; cancel a pending one',
    input: { hint: 'list | available [STRING] | pending | cancel [FLOW]' },
    recordInput: true,
    handler: invocation => runLogins(ctx, attempts, invocation),
  })
  // DSH's own authentication guards Fetch routes; nothing secret is returned.
  ctx.inject(['connection'], web => {
    web.effect(() => web.connection.fetch.register({
      path: FLOWS_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async () => json(await flowsReport(ctx)),
    }), 'login: flows route')
    for (const route of signInRoutes(ctx, attempts)) {
      web.effect(() => web.connection.fetch.register(route), `login: ${route.path}`)
    }
  })
}
