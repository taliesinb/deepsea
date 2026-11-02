/**
 * Browser half of @deepsea/login: the card of `/login`, `/logout` and
 * `/logins` on the keyed `conversation.chat.commandview` slot. It matches the ordinary command row
 * and keeps the result visible, rendering a sign-in link as Markdown so the
 * browser URL is one click. A bare `/login` opens a picker of the sign-in
 * flows and a bare `/logout` one of the active sign-ins (`ctx.commandUi`
 * decorations over the host commands; typed arguments still go to the host).
 *
 * A `/login` result carrying a sign-in URL is opened in the user's own browser
 * as it arrives, and the card's link opens there too (browser.ts).
 *
 * Settings ▸ Models ▸ Plans gets an **Add login** button (`plans.tsx`): the
 * same sign-in attempts as `/login`, as a dialog.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import { IconApiOutlineRegular, MarkdownDelegateProvider, MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ModelsSectionActionsOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { openInBrowser } from './browser.ts'
import { AddLogin } from './plans.tsx'
import styles from './style.css'

export const name = 'deepsea-login'
export const inject = ['slots']

const labels = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied' },
  footnotes: 'Footnotes',
}

function tokens(raw: string | null): string[] {
  return raw?.trim().split(/\s+/u).filter(Boolean) ?? []
}

function isMarkdownLink(value: string): boolean {
  return /\[[^\]]+\]\(https?:\/\/[^)]+\)/u.test(value)
}

const COMMANDS = ['login', 'logout', 'logins'] as const

/**
 * The sign-in URL a `/login` result carries (its Markdown link). Exported for tests.
 * @param text - the command's result text.
 * @returns the URL, or undefined.
 */
export function signInUrl(text: string | undefined): string | undefined {
  return text === undefined ? undefined : /\]\((https?:\/\/[^)\s]+)\)/u.exec(text)?.[1]
}

/** One row of `GET api/deepsea-login/flows`. */
interface Flow {
  readonly name: string
  readonly label: string
  readonly methods: readonly { readonly id: string, readonly label: string }[]
  readonly active: boolean
  readonly pending: boolean
}

async function loadFlows(signal: AbortSignal): Promise<readonly Flow[]> {
  const response = await fetch('api/deepsea-login/flows', { signal, credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error(`sign-in flows unavailable (HTTP ${String(response.status)})`)
  return ((await response.json()) as { flows: readonly Flow[] }).flows
}

/**
 * Picker rows for `/login`: one per flow, or one per method when a flow offers
 * several; the option id is the argument line. Exported for tests.
 * @param flows - the host's flow list.
 * @returns the rows, signed-in flows marked.
 */
export function loginOptions(flows: readonly Flow[]): SelectOption[] {
  return flows.flatMap(flow => flow.methods.map(method => ({
    id: flow.methods.length > 1 ? `${flow.name} ${method.id}` : flow.name,
    label: flow.label,
    detail: [flow.name, ...flow.methods.length > 1 ? [method.label] : [], ...flow.active ? ['signed in'] : []].join(' · '),
  })))
}

/**
 * Picker rows for `/logout`: the active sign-ins. Exported for tests.
 * @param flows - the host's flow list.
 * @returns one row per signed-in flow.
 */
export function logoutOptions(flows: readonly Flow[]): SelectOption[] {
  return flows.filter(flow => flow.active).map(flow => ({ id: flow.name, label: flow.label, detail: flow.name }))
}

function LoginCommandCard({ node }: CommandRowProps) {
  const state = node.outcome === null ? 'running' : node.outcome.kind === 'error' ? 'error' : 'ok'
  const result = node.outcome?.text
  return <div className="deepsea-login-card" data-state={state}>
    <div className="deepsea-login-card__row">
      <span className="deepsea-login-card__icon">
        {state === 'error' ? <StateDot state="error" /> : <IconApiOutlineRegular size={14} />}
      </span>
      <span className="deepsea-login-card__title">{node.name ?? 'login'}</span>
      {tokens(node.args).map((token, index) => <span className="deepsea-login-card__segment" key={`${String(index)}:${token}`}>
        <span className="deepsea-login-card__separator" aria-hidden />
        <span>{token}</span>
      </span>)}
    </div>
    {result === undefined
      ? <pre className="deepsea-login-card__body">Working…</pre>
      : isMarkdownLink(result)
        ? <div className="deepsea-login-card__body deepsea-login-card__body--link">
          {/* The nearest delegate wins: this card's links go to the user's browser, not the chat's sidebar. */}
          <MarkdownDelegateProvider openExternalLink={openInBrowser}>
            <MarkdownText text={result} labels={labels} variant="compact" />
          </MarkdownDelegateProvider>
        </div>
        : <pre className="deepsea-login-card__body">{result}</pre>}
  </div>
}

/** Hang the two pickers on the host commands; absent `commandUi` (older DSH) leaves them plain. */
function decorate(ctx: Context): void {
  // A typed `/login FLOW` from this client: open the sign-in page as the result arrives.
  ctx.on('command/executed', (_sessionId, name, result) => {
    const url = name === 'login' && result.kind === 'success' ? signInUrl(result.text) : undefined
    if (url !== undefined) openInBrowser(url)
  })
  // `remote.commands` is a service of its own: reading it needs it injected beside `remote`.
  ctx.inject(['commandUi', 'sessions', 'remote', 'remote.commands'], (sub) => {
    const sessions = sub.get('sessions') as ISessions
    // The picker runs the line through the command remote itself, to read the result it opens.
    const commands = (sub as unknown as { remote: { commands: { execute(sessionId: string, line: string, attachments: readonly never[]): Promise<
      { ok: true, value?: { result: { kind: string, text?: string } } } | { ok: false, error: { message: string } }> } } }).remote.commands
    const run = async (sessionId: string, line: string): Promise<void> => {
      if (line.startsWith('/login ')) {
        const result = await commands.execute(sessionId, line, [])
        if (!result.ok) throw new Error(`${line} failed: ${result.error.message}`)
        const url = result.value?.result.kind === 'success' ? signInUrl(result.value.result.text) : undefined
        if (url !== undefined) openInBrowser(url)
        return
      }
      const live = sessions.binding(sessionId as never)?.session
      if (live === undefined) throw new Error('this session is not open yet')
      const result = await live.command(line)
      if (!result.ok) throw new Error(`${line} failed: ${result.error.message}`)
    }
    const picker = (name: 'login' | 'logout', options: (flows: readonly Flow[]) => SelectOption[], copy: { placeholder: string, empty: string, noResults: string }) =>
      sub.effect(() => sub.commandUi.decorate({
        name,
        available: () => true,
        ui: {
          kind: 'popupSelect',
          searchLabels: () => copy,
          options: async (_session, signal) => options(await loadFlows(signal)),
          onSelect: (option, session) => run(session.sessionId, `/${name} ${option.id}`),
        },
      }), `login: /${name} picker`)
    picker('login', loginOptions, { placeholder: 'Sign in to…', empty: 'No sign-in flows are available.', noResults: 'No matching sign-in flows.' })
    picker('logout', logoutOptions, { placeholder: 'Sign out of…', empty: 'No sign-ins are active.', noResults: 'No matching sign-ins.' })
  })
}

export function apply(ctx: Context): void {
  decorate(ctx)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.deepseaLogin = ''
    style.textContent = styles
    document.head.appendChild(style)
    return () => style.remove()
  })
  // Absent on a DSH whose Models page has no section seats: the commands remain.
  ctx.slots.inject('settings.models.section-actions', () => ctx.slots.register(
    { name: 'settings.models.section-actions', key: 'plans' },
    ({ writable }: ModelsSectionActionsOwnerProps) => <AddLogin writable={writable} />,
  ))
  for (const key of COMMANDS) {
    ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register(
      { name: 'conversation.chat.commandview', key },
      LoginCommandCard,
    ))
  }
}
