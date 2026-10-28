/**
 * @deepsea/transcript-grace-margin: empty space under the last row of a
 * session's transcript, so the bottom of a long, active session reads as the
 * end of it.
 *
 * The client stops the last row 16px above the sticky composer, and the
 * composer seat's 36px fade band covers most of that, so the transcript looks
 * as if it continued under the composer. This plugin pads the message column
 * by `margin` px (default 160) after its last row.
 *
 * One `<style>` row through the web server's `webserver/index-inject` table;
 * no browser half. The hooks are unhashed data attributes the client renders
 * itself (its CSS-module classes compile to `<hash>_<local>` names):
 *
 *   [data-conversation-scroll]   the active-phase scroller (ui-conversation
 *                                ConversationContent.tsx)
 *   [data-chat-flow]             the message column inside it (ui-chat
 *                                ChatView.tsx); a step group's own column
 *                                carries `data-step-process-content` as well
 *                                and is left alone
 *
 * The padding is part of the column's box, so it counts in the scroller's
 * `scrollHeight` and in the size ChatView's ResizeObserver reports: following
 * the live tail (`scrollTop = scrollHeight`), the at-bottom test and the
 * back-to-bottom control (sticky to the scroller, after the column) land on
 * the padded end. The hero (blank session) layout renders no chat column, so
 * it keeps its geometry.
 *
 *   margin   px of empty space after the last row, integer 0-600 (0: no rule).
 */

export const name = 'deepsea-transcript-grace-margin'

export const inject = ['webServer']

export const DEFAULT_MARGIN = 160
export const MAX_MARGIN = 600

/** The top-level message column of the active-phase scroller. */
export const COLUMN_SELECTOR = '[data-conversation-scroll] [data-chat-flow]:not([data-step-process-content])'

/**
 * Validate a row's config and fill in the default.
 * @param {unknown} input - the row's config, possibly absent.
 * @returns {{ value: { margin: number } } | { issues: { message: string }[] }}
 */
export function validate(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { issues: [{ message: 'config is an object' }] }
  const unknown = Object.keys(input).filter(key => key !== 'margin')
  if (unknown.length > 0) return { issues: [{ message: `config takes only "margin" (got ${unknown.map(key => JSON.stringify(key)).join(', ')})` }] }
  const margin = /** @type {{ margin?: unknown }} */ (input).margin ?? DEFAULT_MARGIN
  if (typeof margin !== 'number' || !Number.isInteger(margin) || margin < 0 || margin > MAX_MARGIN) {
    return { issues: [{ message: `margin is an integer 0-${MAX_MARGIN} (px), got ${JSON.stringify(margin)}` }] }
  }
  return { value: { margin } }
}

export const Config = { '~standard': { version: 1, vendor: name, validate } }

/**
 * The style row's text for a configuration.
 * @param {{ margin: number }} config - validated config.
 * @returns {string} CSS, '' when margin is 0.
 */
export function graceStyle(config) {
  if (config.margin === 0) return ''
  return `${COLUMN_SELECTOR}{padding-bottom:${config.margin}px}`
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 * @param {{ margin: number }} [config] - validated config (see {@link validate}).
 */
export function apply(ctx, config = { margin: DEFAULT_MARGIN }) {
  const style = graceStyle(config)
  if (style !== '') {
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'style', text: `/* ${name} */\n${style}` })
    })
  }
  ctx.logger.info(style === '' ? 'margin 0: no rule' : `${config.margin}px under the last row`)
}
