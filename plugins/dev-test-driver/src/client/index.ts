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
  }
  ctx.effect(() => {
    window.__DEEPSEA_TEST_DRIVER__ = face
    return () => { if (window.__DEEPSEA_TEST_DRIVER__ === face) delete window.__DEEPSEA_TEST_DRIVER__ }
  }, 'dev-test-driver: page face')
}
