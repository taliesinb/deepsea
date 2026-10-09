/**
 * The Models page's sign-in parts. **Add login** (the page's footer): pick a
 * plan sign-in, authorize it in the user's own browser, and watch it finish;
 * the same attempts as `/login`, driven through the host half's dialog routes
 * (`api/deepsea-login/start|status|answer|cancel`). A sign-in route's provider
 * card gets its sign-in state (a dot), **Log in** / **Log out** and the account
 * (`api/deepsea-login/state|logout`): in the card's head where the page offers
 * seats there (`settings.models.provider-status|provider-actions`), else in the
 * card body (`settings.models.provider-card`).
 */
import { Button, IconPlusOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { onBrowserLink } from './browser.ts'

/** The host half's routes, relative to the page; a wire name kept from the plugin's old name, login. */
export const API = 'api/deepsea-login'

/** One row of `GET api/deepsea-login/flows`. */
export interface SignInFlow {
  readonly name: string
  readonly label: string
  readonly route?: string
  /** `subscription` for a plan, `oauth` for a pay-per-use key; absent on a DSH that does not classify. */
  readonly kind?: 'subscription' | 'oauth'
  readonly vendor?: string
  readonly active: boolean
  readonly pending: boolean
}

/** A question the flow asks before it can continue. */
interface SignInQuestion {
  readonly id: string
  readonly kind: 'select' | 'text'
  readonly message: string
  readonly placeholder?: string
  readonly options?: readonly { readonly id: string; readonly label: string }[]
}

/** One flow's sign-in as `GET api/deepsea-login/status` reports it. */
export interface SignInStatus {
  readonly flow: string
  readonly state: 'idle' | 'starting' | 'question' | 'waiting' | 'authorized' | 'failed' | 'cancelled'
  readonly url?: string
  readonly code?: string
  readonly question?: SignInQuestion
  readonly error?: string
  readonly account?: { readonly email?: string; readonly name?: string; readonly organization?: string; readonly plan?: string }
}

const PENDING = new Set<SignInStatus['state']>(['starting', 'question', 'waiting'])

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`)
  return body as T
}

const post = <T = SignInStatus>(path: string, body: object): Promise<T> =>
  request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The flows Add login offers: plans only (pay-per-use OAuth keys are not
 * plans), vendor-named, in name order. A DSH that does not classify its
 * flows offers them all. Exported for tests.
 * @param flows - the host's flow list.
 * @returns the plan flows.
 */
export function planFlows(flows: readonly SignInFlow[]): SignInFlow[] {
  const classified = flows.some(flow => flow.kind !== undefined)
  // filter() returns a fresh array, so sorting it in place touches nothing shared.
  return flows.filter(flow => !classified || flow.kind === 'subscription')
    .sort((a, b) => (a.vendor ?? a.label).localeCompare(b.vendor ?? b.label))
}

/**
 * A sign-in URL as people say it: host and path, no query (`claude.ai/oauth/authorize`). Exported for tests.
 * @param url - the URL.
 * @returns the short form, or the URL itself when it does not parse.
 */
export function shortUrl(url: string): string {
  try {
    const { hostname, pathname } = new URL(url)
    return `${hostname}${pathname}`.replace(/\/$/u, '')
  } catch {
    return url
  }
}

/** The body for one flow's sign-in state. */
function SignInBody({ flow, status, onAnswer }: {
  flow: SignInFlow
  status: SignInStatus | undefined
  onAnswer: (value: string) => void
}): ReactNode {
  const [text, setText] = useState('')
  if (status === undefined || status.state === 'starting' || status.state === 'idle') {
    return <p className="deepsea-login-plan-status">Starting…</p>
  }
  if (status.state === 'question' && status.question !== undefined) {
    const question = status.question
    return (
      <div className="deepsea-login-plan-question">
        <p className="deepsea-login-plan-question__text">{question.message}</p>
        {question.kind === 'select'
          ? (
            <div className="deepsea-login-plan-choices">
              {(question.options ?? []).map(option => (
                <Button key={option.id} variant="outline" onClick={() => { onAnswer(option.id) }}>{option.label}</Button>
              ))}
            </div>
          )
          : (
            <form
              className="deepsea-login-plan-answer"
              onSubmit={(event) => { event.preventDefault(); onAnswer(text); setText('') }}
            >
              <input
                className="deepsea-login-plan-input"
                value={text}
                placeholder={question.placeholder}
                aria-label={question.message}
                data-modal-autofocus
                onChange={(event) => { setText(event.target.value) }}
              />
              <Button type="submit" variant="primary">Continue</Button>
            </form>
          )}
      </div>
    )
  }
  if (status.state === 'waiting' && status.url !== undefined) {
    return (
      <div className="deepsea-login-plan-waiting">
        <div className="deepsea-login-plan-authorize-row">
          <a
            className="deepsea-login-plan-authorize"
            href={status.url}
            target="_blank"
            rel="noopener noreferrer"
            data-modal-autofocus
            onClick={onBrowserLink(status.url)}
          >
            Authorize in browser
          </a>
          <a className="deepsea-login-plan-link" href={status.url} target="_blank" rel="noopener noreferrer" onClick={onBrowserLink(status.url)}>
            {shortUrl(status.url)}
          </a>
        </div>
        {status.code === undefined
          ? null
          : <p className="deepsea-login-plan-code"><span>Code</span><code>{status.code}</code></p>}
        <p className="deepsea-login-plan-status" role="status">Waiting for authorization…</p>
      </div>
    )
  }
  if (status.state === 'authorized') {
    const who = status.account?.email ?? status.account?.name
    return <p className="deepsea-login-plan-status deepsea-login-plan-status--done" role="status">{who === undefined ? `Signed in to ${flow.vendor ?? flow.label}.` : `Signed in as ${who}.`}</p>
  }
  if (status.state === 'failed') return <p className="deepsea-login-plan-status deepsea-login-plan-status--error" role="alert">{status.error ?? 'Sign-in failed.'}</p>
  return <p className="deepsea-login-plan-status" role="status">Sign-in cancelled.</p>
}

/**
 * The Add login dialog: the plan list, then one flow's sign-in. With `initial`
 * (a card's Log in) it starts that flow's sign-in at once and never shows the list.
 */
function AddLoginDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: SignInFlow }): ReactNode {
  const [flows, setFlows] = useState<readonly SignInFlow[] | undefined>(undefined)
  const [listError, setListError] = useState<string | undefined>(undefined)
  const [flow, setFlow] = useState<SignInFlow | undefined>(undefined)
  const [status, setStatus] = useState<SignInStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    setFlow(undefined); setStatus(undefined); setError(undefined); setFlows(undefined); setListError(undefined)
    if (initial !== undefined) { start(initial); return }
    const controller = new AbortController()
    request<{ flows: SignInFlow[] }>(`${API}/flows`, { signal: controller.signal })
      .then((body) => { setFlows(planFlows(body.flows)) }, (failure: unknown) => { if (!controller.signal.aborted) setListError(message(failure)) })
    return () => { controller.abort() }
    // `initial` is read when the dialog opens, not followed.
  }, [open])

  // A pending sign-in is polled until it settles; the browser tab finishing it is not this page's event.
  const pending = status !== undefined && PENDING.has(status.state)
  useEffect(() => {
    if (!open || flow === undefined || !pending) return
    const timer = setInterval(() => {
      request<SignInStatus>(`${API}/status?flow=${encodeURIComponent(flow.name)}`)
        .then(setStatus, (failure: unknown) => { setError(message(failure)) })
    }, 1000)
    return () => { clearInterval(timer) }
  }, [open, flow, pending])

  const start = (picked: SignInFlow): void => {
    setFlow(picked); setStatus(undefined); setError(undefined)
    post(`${API}/start`, { flow: picked.name }).then(setStatus, (failure: unknown) => { setError(message(failure)) })
  }
  const cancel = async (): Promise<void> => {
    if (flow === undefined || !pending) return
    try { setStatus(await post(`${API}/cancel`, { flow: flow.name })) } catch (failure) { setError(message(failure)) }
  }
  const answer = (value: string): void => {
    if (flow === undefined || status?.question === undefined) return
    post(`${API}/answer`, { flow: flow.name, id: status.question.id, value }).then(setStatus, (failure: unknown) => { setError(message(failure)) })
  }
  // Closing never leaves a sign-in running behind the dialog.
  const close = (): void => { void cancel(); onClose() }
  // A card's Log in has no list to go back to.
  const back = (): void => { if (initial !== undefined) { onClose(); return } setFlow(undefined); setStatus(undefined); setError(undefined) }

  const footer = flow === undefined
    ? <Button variant="outline" onClick={close}>Cancel</Button>
    : pending || (status === undefined && error === undefined)
      ? <Button variant="outline" onClick={() => { void cancel().then(back) }}>Cancel</Button>
      : status?.state === 'authorized'
        ? <Button variant="primary" onClick={onClose}>Done</Button>
        : (
          <>
            <Button variant="outline" onClick={back}>{initial === undefined ? 'Back' : 'Cancel'}</Button>
            <Button variant="primary" onClick={() => { start(flow) }}>Try again</Button>
          </>
        )

  return (
    <Modal open={open} onClose={close} title={flow === undefined ? 'Add login' : flow.vendor ?? flow.label} closeLabel="Close" footer={footer} width={440}>
      <div className="deepsea-login-plan-dialog">
        {flow === undefined
          ? flows === undefined
            ? <p className={listError === undefined ? 'deepsea-login-plan-status' : 'deepsea-login-plan-status deepsea-login-plan-status--error'}>{listError ?? 'Loading…'}</p>
            : flows.length === 0
              ? <p className="deepsea-login-plan-status">No plans are available.</p>
              : (
                <ul className="deepsea-login-plan-flows">
                  {flows.map(candidate => (
                    <li key={candidate.name}>
                      <button type="button" className="deepsea-login-plan-flow" onClick={() => { start(candidate) }}>
                        <span className="deepsea-login-plan-flow__name">{candidate.vendor ?? candidate.label}</span>
                        {candidate.active ? <span className="deepsea-login-plan-flow__note">Signed in</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )
          : (
            <>
              {error === undefined ? null : <p className="deepsea-login-plan-status deepsea-login-plan-status--error" role="alert">{error}</p>}
              <SignInBody flow={flow} status={status} onAnswer={answer} />
            </>
          )}
      </div>
    </Modal>
  )
}

/** The Models page's add action, below the provider rows. */
export function AddLogin(): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="deepsea-login-plan-add" onClick={() => { setOpen(true) }}>
        <IconPlusOutlineRegular size={14} />
        Add login
      </button>
      <AddLoginDialog open={open} onClose={() => { setOpen(false) }} />
    </>
  )
}

/** A sign-in route's state as `GET api/deepsea-login/state` reports it. */
export interface RouteSignIn {
  /** The flow that signs the route in. */
  readonly flow?: string
  /** A usable grant is stored. */
  readonly signedIn: boolean
  /** A grant is stored at all, usable or not. */
  readonly stored?: boolean
  readonly account?: { readonly email?: string; readonly name?: string; readonly organization?: string; readonly plan?: string }
}

/**
 * A provider's plan id as a label: `claude_max` → `Max`, `claude_team` →
 * `Team`, `plus` → `Plus`. Unknown shapes pass through title-cased. Exported for tests.
 * @param plan - the plan id the provider reported.
 * @returns the label the card shows.
 */
export function planLabel(plan: string): string {
  const words = plan.replace(/^claude[_-]/u, '').split(/[_-]+/u).filter(Boolean)
  return words.length === 0 ? plan : words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * The account facts a card lists, label first, absent ones left out. Exported for tests.
 * @param state - the route's state.
 * @returns `[label, value]` pairs.
 */
export function accountFacts(state: RouteSignIn | undefined): [string, string][] {
  const account = state?.account
  if (account === undefined) return []
  const facts: [string, string | undefined][] = [
    ['Account', account.email ?? account.name],
    ['Organization', account.organization],
    ['Plan', account.plan === undefined ? undefined : planLabel(account.plan)],
  ]
  return facts.filter((fact): fact is [string, string] => fact[1] !== undefined)
}

/**
 * Which card actions a route's state offers: Log in while it holds no usable
 * grant, Log out while a grant is stored (both for a stored grant the provider
 * refused). Nothing until the state is known. Exported for tests.
 * @param state - the route's state.
 * @returns the actions, in display order.
 */
export function routeActions(state: RouteSignIn | undefined): ('login' | 'logout')[] {
  if (state === undefined || state.flow === undefined) return []
  const stored = state.stored ?? state.signedIn
  return [...state.signedIn ? [] : ['login' as const], ...stored ? ['logout' as const] : []]
}

/** One route's state, shared by the parts of its card (head seats and body) so it is fetched once. */
interface RouteEntry {
  readonly state?: RouteSignIn
  readonly error?: string
  readonly busy?: boolean
}

const routeEntries = new Map<string, RouteEntry>()
const routeListeners = new Map<string, Set<() => void>>()
const EMPTY: RouteEntry = {}

function setRoute(route: string, entry: RouteEntry): void {
  routeEntries.set(route, entry)
  for (const listener of routeListeners.get(route) ?? []) listener()
}

function loadRoute(route: string): void {
  request<RouteSignIn>(`${API}/state?route=${encodeURIComponent(route)}`)
    .then((state) => { setRoute(route, { state }) }, (failure: unknown) => {
      setRoute(route, { ...routeEntries.get(route), error: message(failure) })
    })
}

function subscribeRoute(route: string, listener: () => void): () => void {
  let listeners = routeListeners.get(route)
  if (listeners === undefined) routeListeners.set(route, listeners = new Set())
  // The first part of a card to mount reads the state afresh: the page may have been closed for a while.
  if (listeners.size === 0) loadRoute(route)
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function useRoute(route: string): RouteEntry {
  return useSyncExternalStore(
    listener => subscribeRoute(route, listener),
    () => routeEntries.get(route) ?? EMPTY,
  )
}

async function logOut(route: string, flow: string): Promise<void> {
  setRoute(route, { ...routeEntries.get(route), busy: true })
  try {
    setRoute(route, { state: await post<RouteSignIn>(`${API}/logout`, { flow }) })
  } catch (failure) {
    setRoute(route, { ...routeEntries.get(route), busy: false, error: message(failure) })
  }
}

/**
 * Which seats the page offers in the card's head (the plugin's registrations
 * there are live): what has a seat there leaves the body, which keeps the rest.
 */
const headSeats = { status: 0, actions: 0 }
const headListeners = new Set<() => void>()

/**
 * Count one head seat in for as long as its declaration lives.
 * @param seat - the seat.
 * @returns its disposer.
 */
export function holdHeadSeat(seat: keyof typeof headSeats): () => void {
  const change = (by: number): void => {
    headSeats[seat] += by
    for (const listener of headListeners) listener()
  }
  change(1)
  return () => { change(-1) }
}

function useHeadSeat(seat: keyof typeof headSeats): boolean {
  return useSyncExternalStore(
    (listener) => { headListeners.add(listener); return () => { headListeners.delete(listener) } },
    () => headSeats[seat] > 0,
  )
}

/** The card's identity, as the page's directory row gives it. */
export interface SignInRoute {
  /** The route id (`anthropic-oauth`). */
  readonly route: string
  /** The route's display name, the sign-in dialog's fallback title. */
  readonly displayName: string
  /** The provider's plain name (`Anthropic`), the sign-in dialog's title. */
  readonly vendor?: string
}

/** The sign-in state dot, as the page's credential dots are: green signed in, red not. */
export function SignInDot({ route }: SignInRoute): ReactNode {
  const { state } = useRoute(route)
  if (state === undefined) return null
  const label = state.signedIn ? 'Signed in' : 'Not signed in'
  return (
    <span
      className={`deepsea-login-route__dot deepsea-login-route__dot--${state.signedIn ? 'on' : 'off'}`}
      role="img"
      aria-label={label}
      title={label}
    />
  )
}

/** Log in / Log out, in the page's small action-button style. */
export function SignInActions({ route, displayName, vendor }: SignInRoute): ReactNode {
  const { state, busy } = useRoute(route)
  const [signingIn, setSigningIn] = useState(false)
  const flow = state?.flow
  const actions = routeActions(state)
  if (flow === undefined || actions.length === 0) return null
  const name = vendor ?? displayName
  return (
    <span className="deepsea-login-route__actions">
      {actions.map(action => action === 'login'
        ? (
          <button key={action} type="button" className="deepsea-login-route__action" aria-label={`Log in to ${name}`} disabled={busy === true} onClick={() => { setSigningIn(true) }}>
            Log in
          </button>
        )
        : (
          <button key={action} type="button" className="deepsea-login-route__action" aria-label={`Log out of ${name}`} disabled={busy === true} onClick={() => { void logOut(route, flow) }}>
            Log out
          </button>
        ))}
      <AddLoginDialog
        open={signingIn}
        initial={{ name: flow, label: displayName, ...vendor === undefined ? {} : { vendor }, active: false, pending: false }}
        onClose={() => { setSigningIn(false); loadRoute(route) }}
      />
    </span>
  )
}

/**
 * A sign-in route's part of its Models page card body: the account, and,
 * while the page has no seats in the card's head, the actions beside it and
 * "Not signed in" while there is no usable grant. Other cards of the namespace render nothing.
 */
export function SignInCard(props: SignInRoute): ReactNode {
  const { state, error } = useRoute(props.route)
  const statusInHead = useHeadSeat('status')
  const actionsInHead = useHeadSeat('actions')
  const facts = accountFacts(state)
  const status = state === undefined
    ? error ?? 'Checking sign-in…'
    : statusInHead || state.signedIn ? undefined : 'Not signed in'
  const failure = state === undefined ? undefined : error
  const actions = actionsInHead ? [] : routeActions(state)
  if (status === undefined && failure === undefined && facts.length === 0 && actions.length === 0) return null
  return (
    <div className="deepsea-login-route">
      <div className="deepsea-login-route__main">
        {status === undefined
          ? null
          : (
            <span className="deepsea-login-route__status">
              {state === undefined ? null : <SignInDot {...props} />}
              {status}
            </span>
          )}
        {failure === undefined ? null : <span className="deepsea-login-route__status deepsea-login-route__status--error" role="alert">{failure}</span>}
        {facts.length === 0 ? null : (
          <dl className="deepsea-login-route__facts">
            {facts.flatMap(([label, value]) => [
              <dt key={`${label}:t`}>{label}</dt>,
              <dd key={`${label}:d`} title={value}>{value}</dd>,
            ])}
          </dl>
        )}
      </div>
      {actionsInHead ? null : <SignInActions {...props} />}
    </div>
  )
}
