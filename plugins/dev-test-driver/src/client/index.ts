/**
 * The browser half of `dsd drive`: what only the page can do, on
 * `window.__DEEPSEA_TEST_DRIVER__` for the app's automation channel to call
 * (`dsd drive open-session`). Loaded only in throwaways, like the server half.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only (erased): merges `ctx.uiWorkspace` into the Context.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

export const name = 'deepsea-dev-test-driver'
export const inject = ['uiWorkspace']

/** What the automation channel calls. */
export interface TestDriverPage {
  /** Show a session in the main view, as a click on its sidebar row does. */
  openSession(sessionId: string): { opened: string }
  /**
   * Open (or close) every disclosure of a Turn in the shown session, as clicks would: the
   * completed-Turn control, its process groups, and every row inside them.
   */
  expand(options: ExpandOptions): Promise<ExpandResult>
}

/** Which Turns `expand` acts on, and in which direction. */
export interface ExpandOptions {
  /** One Turn; default the last Turn on the page. */
  turn?: number
  /** Every Turn on the page. */
  all?: boolean
  /** Close instead of open. */
  collapse?: boolean
}

/** What `expand` did. */
export interface ExpandResult {
  turns: number[]
  /** Controls clicked. */
  clicked: number
}

const settle = () => new Promise(resolve => setTimeout(resolve, 120))

/** The disclosure controls of one Turn, the completed-Turn control first. */
function turnControls(turn: number): HTMLElement[] {
  const control = [...document.querySelectorAll<HTMLElement>(`[data-turn-process="${turn}"]`)]
  const inside = [...document.querySelectorAll<HTMLElement>(`[data-chat-turn="${turn}"]`)]
    .flatMap(member => [...member.querySelectorAll<HTMLElement>('button[aria-expanded], [role="button"][aria-expanded]')])
  return [...new Set([...control, ...inside])]
}

/** Open or close Turns' disclosures in passes, since opening one reveals the next level. */
async function expandTurns(options: ExpandOptions): Promise<ExpandResult> {
  const present = [...new Set([...document.querySelectorAll<HTMLElement>('[data-chat-turn]')]
    .map(element => Number(element.dataset.chatTurn)).filter(Number.isFinite))].sort((a, b) => a - b)
  const turns = options.all === true ? present : [options.turn ?? present.at(-1)].filter(t => t !== undefined)
  const want = options.collapse === true ? 'true' : 'false'
  let clicked = 0
  for (let pass = 0; pass < 8; pass++) {
    const pending = turns.flatMap(turnControls).filter(element => element.getAttribute('aria-expanded') === want
      && !(element instanceof HTMLButtonElement && element.disabled) && element.closest('[hidden]') === null)
    // Closing goes innermost first, so the Turn control folds last.
    const ordered = options.collapse === true ? pending.reverse() : pending
    if (ordered.length === 0) break
    for (const element of ordered) element.click()
    clicked += ordered.length
    await settle()
  }
  return { turns, clicked }
}

declare global {
  // A wire name kept from the plugin's old name (test-driver): the app's automation channel calls it.
  interface Window { __DEEPSEA_TEST_DRIVER__?: TestDriverPage }
}

export function apply(ctx: Context): void {
  const face: TestDriverPage = {
    openSession(sessionId) {
      ctx.uiWorkspace.openSession(sessionId as Parameters<typeof ctx.uiWorkspace.openSession>[0])
      return { opened: sessionId }
    },
    expand: expandTurns,
  }
  ctx.effect(() => {
    window.__DEEPSEA_TEST_DRIVER__ = face
    return () => { if (window.__DEEPSEA_TEST_DRIVER__ === face) delete window.__DEEPSEA_TEST_DRIVER__ }
  }, 'dev-test-driver: page face')
}
