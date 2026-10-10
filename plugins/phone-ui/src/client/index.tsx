/**
 * @deepsea/phone-ui, browser half: the mobile composer.
 *
 * In the phone view (`<html data-deepsea-view="mobile">` from the macOS
 * app's View ▸ Mobile, or a viewport at most `--deepsea-phone-ui-max-width`
 * wide, which the host half publishes from its `maxWidth`) the composer card
 * is replaced by a tongue: a small grey tab flush with the bottom edge,
 * centred, with a chevron that opens a full-screen text entry and, while the
 * agent runs, a red stop square (MobileComposer.tsx).
 *
 * Mounted on `conversation.input.dock` (list, session scope), a seat inside
 * the composer stack whose components get the session's standard props
 * (`useSession`, `useInput`, `inputActions`, `sessionId`); it renders through
 * portals to <body>, so its geometry is its own. While it is active it stamps
 * `<html data-deepsea-phone-ui-composer>`, and the stylesheet below hides the
 * stock composer card under that attribute only: if this bundle is missing
 * or fails, the stock composer stays.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: `ctx.slots` (ui-renderer) and the conversation slot declarations (conversation.input.dock).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MobileComposer, type MobileComposerInjected } from './MobileComposer.tsx'

export const name = 'deepsea-phone-ui'

export const inject = ['slots', 'sessions']

/** Stamped on <html> while the mobile composer is active. */
export const COMPOSER_FLAG = 'data-deepsea-phone-ui-composer'

const STYLE = `
/* The outlet carries an inline display:contents; hide what it renders. */
html[${COMPOSER_FLAG}] [data-slot="conversation.composer.bar"] > * { display: none }
/* The tongue's height at the end of the transcript. */
html[${COMPOSER_FLAG}] [data-composer-seat] { min-height: 48px }
/* ChatView's back-to-bottom control (its sticky .toBottomSlot, which carries
   no attribute; CSS-module locals compile to <hash>_<local>): the bottom-right
   corner, level with the tongue, instead of above the composer it replaces. */
html[${COMPOSER_FLAG}] [data-conversation-scroll] [class$="_toBottomSlot"] { bottom: 8px; padding-right: 8px }
`

/**
 * @param ctx - browser-plane plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.id = 'deepsea-phone-ui-composer'
    style.textContent = STYLE
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'deepsea-phone-ui: composer stylesheet')

  const sessions = ctx.get('sessions') as ISessions
  const injected: MobileComposerInjected = {
    htmlFlag: COMPOSER_FLAG,
    cancel: (sessionId) => {
      const conversation = sessions.scope(sessionId)?.get('conversation')
      if (conversation === undefined) return Promise.resolve()
      return conversation.cancel().then(() => undefined, () => undefined)
    },
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'deepsea-phone-ui-composer',
    order: 0,
    inject: () => injected,
  }, MobileComposer))
}
