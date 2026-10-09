/**
 * The Models page's **Add login** action (Plans section): pick a plan sign-in,
 * authorize it in the user's own browser, and watch it finish. Same attempts
 * as `/login`, driven through the host half's dialog routes
 * (`api/deepsea-login/start|status|answer|cancel`).
 */
import { Button, IconPlusOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { onBrowserLink } from './browser.ts'

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

const post = (path: string, body: object): Promise<SignInStatus> =>
  request<SignInStatus>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

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

/** The Add login dialog: the plan list, then one flow's sign-in. */
function AddLoginDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const [flows, setFlows] = useState<readonly SignInFlow[] | undefined>(undefined)
  const [listError, setListError] = useState<string | undefined>(undefined)
  const [flow, setFlow] = useState<SignInFlow | undefined>(undefined)
  const [status, setStatus] = useState<SignInStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    setFlow(undefined); setStatus(undefined); setError(undefined); setFlows(undefined); setListError(undefined)
    const controller = new AbortController()
    request<{ flows: SignInFlow[] }>('api/deepsea-login/flows', { signal: controller.signal })
      .then((body) => { setFlows(planFlows(body.flows)) }, (failure: unknown) => { if (!controller.signal.aborted) setListError(message(failure)) })
    return () => { controller.abort() }
  }, [open])

  // A pending sign-in is polled until it settles; the browser tab finishing it is not this page's event.
  const pending = status !== undefined && PENDING.has(status.state)
  useEffect(() => {
    if (!open || flow === undefined || !pending) return
    const timer = setInterval(() => {
      request<SignInStatus>(`api/deepsea-login/status?flow=${encodeURIComponent(flow.name)}`)
        .then(setStatus, (failure: unknown) => { setError(message(failure)) })
    }, 1000)
    return () => { clearInterval(timer) }
  }, [open, flow, pending])

  const start = (picked: SignInFlow): void => {
    setFlow(picked); setStatus(undefined); setError(undefined)
    post('api/deepsea-login/start', { flow: picked.name }).then(setStatus, (failure: unknown) => { setError(message(failure)) })
  }
  const cancel = async (): Promise<void> => {
    if (flow === undefined || !pending) return
    try { setStatus(await post('api/deepsea-login/cancel', { flow: flow.name })) } catch (failure) { setError(message(failure)) }
  }
  const answer = (value: string): void => {
    if (flow === undefined || status?.question === undefined) return
    post('api/deepsea-login/answer', { flow: flow.name, id: status.question.id, value }).then(setStatus, (failure: unknown) => { setError(message(failure)) })
  }
  const back = (): void => { setFlow(undefined); setStatus(undefined); setError(undefined) }
  // Closing never leaves a sign-in running behind the dialog.
  const close = (): void => { void cancel(); onClose() }

  const footer = flow === undefined
    ? <Button variant="outline" onClick={close}>Cancel</Button>
    : pending || (status === undefined && error === undefined)
      ? <Button variant="outline" onClick={() => { void cancel().then(back) }}>Cancel</Button>
      : status?.state === 'authorized'
        ? <Button variant="primary" onClick={onClose}>Done</Button>
        : (
          <>
            <Button variant="outline" onClick={back}>Back</Button>
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

/** The Plans section's add action. */
export function AddLogin({ writable }: { writable: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="deepsea-login-plan-add" disabled={!writable} onClick={() => { setOpen(true) }}>
        <IconPlusOutlineRegular size={14} />
        Add login
      </button>
      <AddLoginDialog open={open} onClose={() => { setOpen(false) }} />
    </>
  )
}
