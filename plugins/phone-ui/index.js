/**
 * @deepsea/phone-ui, host half: the phone view's stylesheet and a head script.
 *
 * The client has no responsive CSS: at phone width (390-430 CSS px, the full
 * GUI or the `?embed=<sessionId>` page) a session keeps its desktop chrome:
 * the 76px header with the Chat | Trajectory tabs, an icon row under every
 * message and the composer's stats dock. This half pushes one `<style>` row
 * into the web server's `webserver/index-inject` table that, below
 * `maxWidth`, hides those and tightens what remains; the browser half
 * (src/client) replaces the composer card with a bottom tongue and a
 * full-screen text entry.
 *
 * Every rule is emitted twice: inside `@media (max-width: <maxWidth>px)` and
 * prefixed with `html[data-deepsea-view="mobile"]`, the attribute the macOS
 * app's View ▸ Mobile stamps, so the attribute alone selects the phone view
 * at any width. `:root` carries `--deepsea-phone-ui-max-width` so the browser
 * half's media query agrees with this sheet.
 *
 *   maxWidth        the media query's max-width, CSS px, integer 320-1200 (640)
 *   header          hide the session header with its view tabs; in the macOS
 *                   app, whose title bar the header is, only the tabs (true)
 *   messageActions  hide the icon rows of assistant turn tails and user /
 *                   steering bubbles (true)
 *   stats           hide the composer dock: stats pills and context meter (true)
 *   sideMargin      transcript and composer side padding, CSS px, integer 0-64;
 *                   the client's own is 32 (text) / 16 (card), and 32 leaves
 *                   both alone (8)
 *   codeHeaders     hide the code-block banner row: language and Copy (true)
 *   smallRadius     6px corners on code blocks (from 16px) and on the user's
 *                   own bubbles (from 20px) (true)
 *   compactBlocks   less padding inside the transcript's boxed blocks (true)
 *   deferHmrStream  open the client-HMR event stream after `load` (true; on
 *                   every viewport, see DEFER_HMR_STREAM_SCRIPT)
 *
 * Every hook is an unhashed attribute the client renders itself: the slot
 * outlets (`<div data-slot="<slot name>" style="display:contents">`), the
 * chat's `data-*` attributes and the code block's `md-code-block` class.
 * CSS-module classes compile to `<hash>_<local>` and are named by their
 * local only where a block has no attribute of its own, scoped under one
 * that does. The client's stylesheets come after this `<style>` in the
 * document, so each rule out-ranks the stock rule it overrides; a tie would
 * lose, in the media query only (the flag's `html[...]` adds specificity).
 */

export const name = 'deepsea-phone-ui'

export const inject = ['webServer']

export const DEFAULT_MAX_WIDTH = 640
export const MIN_MAX_WIDTH = 320
export const MAX_MAX_WIDTH = 1200
export const DEFAULT_SIDE_MARGIN = 8
/** The client's own transcript side padding (ChatView `.scroll`: composer clearance 16 + 16). */
export const STOCK_SIDE_MARGIN = 32
export const MAX_SIDE_MARGIN = 64

/** The boolean keys, each default `true`. */
export const FLAGS = Object.freeze(['header', 'messageActions', 'stats', 'codeHeaders', 'smallRadius', 'compactBlocks', 'deferHmrStream'])

/**
 * @typedef {object} PhoneUiConfig
 * @property {number} maxWidth
 * @property {boolean} header
 * @property {boolean} messageActions
 * @property {boolean} stats
 * @property {number} sideMargin
 * @property {boolean} codeHeaders
 * @property {boolean} smallRadius
 * @property {boolean} compactBlocks
 * @property {boolean} deferHmrStream
 */

/**
 * Validate a row's config and fill in the defaults.
 * @param {unknown} input - the row's config, possibly absent.
 * @returns {{ value: PhoneUiConfig } | { issues: { message: string }[] }}
 */
export function validate(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { issues: [{ message: 'config is an object' }] }
  const raw = /** @type {Record<string, unknown>} */ (input)
  const known = ['maxWidth', 'sideMargin', ...FLAGS]
  /** @type {{ message: string }[]} */
  const issues = Object.keys(raw).filter(key => !known.includes(key)).map(key => ({ message: `unknown key ${JSON.stringify(key)} (config takes ${known.join(', ')})` }))
  const int = (/** @type {string} */ key, /** @type {number} */ fallback, /** @type {number} */ min, /** @type {number} */ max) => {
    const value = raw[key] ?? fallback
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value
    issues.push({ message: `${key} is an integer ${min}-${max} (px), got ${JSON.stringify(value)}` })
    return fallback
  }
  const flag = (/** @type {string} */ key) => {
    const value = raw[key] ?? true
    if (typeof value === 'boolean') return value
    issues.push({ message: `${key} is true or false, got ${JSON.stringify(value)}` })
    return true
  }
  const value = /** @type {PhoneUiConfig} */ ({
    maxWidth: int('maxWidth', DEFAULT_MAX_WIDTH, MIN_MAX_WIDTH, MAX_MAX_WIDTH),
    sideMargin: int('sideMargin', DEFAULT_SIDE_MARGIN, 0, MAX_SIDE_MARGIN),
    ...Object.fromEntries(FLAGS.map(key => [key, flag(key)])),
  })
  return issues.length > 0 ? { issues } : { value }
}

export const Config = { '~standard': { version: 1, vendor: name, validate } }

/** The flag the macOS app's View ▸ Mobile stamps on `<html>`. */
export const MOBILE_FLAG_SELECTOR = 'html[data-deepsea-view="mobile"]'

/** The variable on `:root` that tells the browser half the width. */
export const MAX_WIDTH_VARIABLE = '--deepsea-phone-ui-max-width'

/** The transcript's own column; a step group's column carries `data-step-process-content` as well. */
const COLUMN = '[data-chat-flow]:not([data-step-process-content])'

/**
 * The header element inside its slot outlet: the session's title row and its
 * view tabs (ui-conversation ConversationHeader.tsx, ConversationSession.tsx).
 */
export const HEADER_SELECTOR = '[data-slot="conversation.header"] > header'

/**
 * The macOS app's document (`<html data-platform="darwin">`, the client's
 * macOS layout): the header is the window's title bar, holding the traffic
 * lights' strip, the closed sidebar's controls and the window drag region, so
 * there only its tabs go.
 */
export const DARWIN = 'html[data-platform="darwin"]'

/** Per hide group, the selectors that get `display:none`. */
export const SELECTORS = Object.freeze({
  header: [
    `html:not([data-platform="darwin"]) ${HEADER_SELECTOR}`,
    `${DARWIN} ${HEADER_SELECTOR} [data-conversation-tabs]`,
  ],
  messageActions: [
    // The turn tail's own actions row, its only child without `data-slot`; the
    // conversation.chat.turnTail outlet beside it stays (ui-chat TurnTailNodeView.tsx).
    '[data-turn-tail][data-actions-reveal] > div:not([data-slot])',
    // A user bubble's row is `userRow > (userStack, actions)` (ui-chat MessageItem.tsx).
    ':is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]) > [data-slot="conversation.chat.node"] > div > div:nth-child(2)',
  ],
  // The InputBar's dock wrapper, found by the dock outlet it holds; the
  // context meter beside the pills goes with it (ui-conversation InputBar.tsx).
  stats: ['[data-slot="conversation.composer.bar"] div:has(> [data-slot="conversation.composer.dock"])'],
  // The code block's sticky banner wrapper, found by the banner row it holds (ui-primitives CodeBlock.tsx).
  codeHeaders: ['[data-chat-flow] .md-code-block > div:has(> [data-code-block-banner])'],
})

/** The user / steering bubble inside `userRow > userStack` (the attachments row excluded). */
export const USER_BUBBLE_SELECTOR =
  ':is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]) > [data-slot="conversation.chat.node"] > div > div:first-child > div:not([data-message-attachments])'

/**
 * Padding inside the transcript's boxed blocks, as [selector, declarations].
 * Two cards carry no attribute of their own and are named by a CSS-module
 * local (`[class*="_<local>"]`) scoped under an attribute of their card.
 */
export const COMPACT_BLOCK_RULES = Object.freeze([
  // ui-primitives CodeBlock: `.block :where(pre) { padding: 16px }`.
  ['[data-chat-flow] .md-code-block pre', 'padding:8px 10px'],
  // ui-chat ContextInjectionRow body (system prompt, injected context): 10 16 12 12.
  ['[data-chat-flow] [data-context-injection-body]', 'padding:6px 10px 8px 8px'],
  // ui-tool tool card IN / OUT sections (ToolRow, bash-sample), inside the call's row: 12 16.
  ['[data-chat-flow] [data-chat-call-id] [class*="_ioSection"]', 'padding:8px 10px'],
  // ui-chat GenericCommandCard output (`pre.body`): 12 16.
  ['[data-chat-flow] [data-variant="others"] pre[class*="_body"]', 'padding:8px 10px'],
  // Markdown table cells: 10 16, the outer edges 0 so the table lines up with the text.
  ['[data-chat-flow] table :is(th,td)', 'padding:6px 10px'],
  ['[data-chat-flow] table :is(th,td):first-child', 'padding-left:0'],
  ['[data-chat-flow] table td:last-child', 'padding-right:0'],
  // Markdown blockquote: 14px indent beside its bar. The attribute twice:
  // `.markdown blockquote` ties a single one.
  ['[data-chat-flow][data-chat-flow] blockquote', 'padding-left:8px'],
  // User bubble: 10 16.
  [USER_BUBBLE_SELECTOR, 'padding:6px 10px'],
])

/**
 * The style row's text for a configuration.
 * @param {PhoneUiConfig} config - validated config.
 * @returns {string} CSS, '' when no rule is on.
 */
export function phoneStyle(config) {
  /** @type {{ selectors: string[], declarations: string }[]} */
  const rules = []
  const hidden = /** @type {(keyof typeof SELECTORS)[]} */ (Object.keys(SELECTORS))
    .filter(group => config[group])
    .flatMap(group => SELECTORS[group])
  if (hidden.length > 0) rules.push({ selectors: hidden, declarations: 'display:none' })
  if (config.header) {
    // The title bar without its tab row: the 76px a header with tabs keeps
    // (`.header` min-height) shrinks to the title row.
    rules.push({ selectors: [`${DARWIN} ${HEADER_SELECTOR}`], declarations: 'min-height:0;padding-bottom:10px' })
  }
  if (config.sideMargin !== STOCK_SIDE_MARGIN) {
    // ChatView's `.scroll` (the column's parent) pads
    // `calc(var(--dsh-composer-side-clearance) + 16px)`; the composer card sits
    // at the clearance itself. Both go to the same value so the card stays flush
    // with the text. Two attributes: `.body` defines the variable at class
    // specificity, and a tie would lose to the later client stylesheet.
    rules.push({ selectors: ['[data-conversation-content][data-content-phase]'], declarations: `--dsh-composer-side-clearance:${config.sideMargin}px` })
    rules.push({ selectors: [`[data-conversation-scroll] div:has(> ${COLUMN})`], declarations: `padding-left:${config.sideMargin}px;padding-right:${config.sideMargin}px` })
  }
  if (config.codeHeaders) {
    // Without the banner the <pre>'s opaque fill would square off the block's
    // top corners (it carries only the bottom radii).
    rules.push({ selectors: ['[data-chat-flow] .md-code-block pre'], declarations: 'border-top-left-radius:var(--dsl-code-block-border-radius);border-top-right-radius:var(--dsl-code-block-border-radius)' })
  }
  if (config.smallRadius) {
    // The block defines the radius variable on itself; banner, block and <pre> read it.
    rules.push({ selectors: ['[data-chat-flow] .md-code-block'], declarations: '--dsl-code-block-border-radius:6px' })
    rules.push({ selectors: [USER_BUBBLE_SELECTOR], declarations: 'border-radius:6px' })
  }
  if (config.compactBlocks) {
    for (const [selector, declarations] of COMPACT_BLOCK_RULES) rules.push({ selectors: [selector], declarations })
  }
  if (rules.length === 0) return ''
  const render = (/** @type {(selector: string) => string} */ scope) =>
    rules.map(rule => `${rule.selectors.map(scope).join(',')}{${rule.declarations}}`).join('')
  return `:root{${MAX_WIDTH_VARIABLE}:${config.maxWidth}px}@media (max-width:${config.maxWidth}px){${render(selector => selector)}}${render(onMobileFlag)}`
}

/**
 * A selector restricted to `<html data-deepsea-view="mobile">`: a selector that
 * already qualifies `html` gets the attribute on that compound.
 * @param {string} selector
 * @returns {string}
 */
export function onMobileFlag(selector) {
  return selector.startsWith('html')
    ? `${MOBILE_FLAG_SELECTOR}${selector.slice('html'.length)}`
    : `${MOBILE_FLAG_SELECTOR} ${selector}`
}

/**
 * Head script: the client-HMR `EventSource` on `/plugins/events` opens 250 ms
 * after `load` instead of during it.
 *
 * iOS Safari keeps its loading indicator running for as long as a
 * server-sent-events stream opened during the load stays open, and the
 * client-hmr plugin opens that stream in its `apply`, mid-load, so the page
 * never finished loading on an iPhone. The script wraps `EventSource`: for
 * that one URL, while `document.readyState !== 'complete'`, it returns a
 * stand-in that creates the real stream after `load` and forwards
 * add/removeEventListener, close, readyState and the on* handlers; any other
 * stream, and any created after load, is the real class. The stand-in has a
 * plain prototype: EventSource.prototype's accessors are brand-checked.
 */
export const DEFER_HMR_STREAM_SCRIPT = `(function(){
var Real = window.EventSource; if (!Real) return;
function Deferred(url, init) {
  var self = this, real = null, listeners = [], closed = false;
  self.url = String(url); self.withCredentials = !!(init && init.withCredentials); self.readyState = 0;
  self.onopen = null; self.onmessage = null; self.onerror = null;
  function attach() {
    if (closed) return;
    real = new Real(url, init);
    listeners.forEach(function (l) { real.addEventListener(l[0], l[1], l[2]) });
    ['onopen', 'onmessage', 'onerror'].forEach(function (k) {
      real[k] = function (e) { self.readyState = real.readyState; if (typeof self[k] === 'function') self[k].call(self, e) };
    });
  }
  self.addEventListener = function (t, fn, o) { if (real) real.addEventListener(t, fn, o); else listeners.push([t, fn, o]) };
  self.removeEventListener = function (t, fn, o) { if (real) real.removeEventListener(t, fn, o); else listeners = listeners.filter(function (l) { return !(l[0] === t && l[1] === fn) }) };
  self.close = function () { closed = true; self.readyState = 2; if (real) real.close() };
  self.dispatchEvent = function (e) { return real ? real.dispatchEvent(e) : false };
  window.addEventListener('load', function () { setTimeout(attach, 250) }, { once: true });
}
Deferred.CONNECTING = 0; Deferred.OPEN = 1; Deferred.CLOSED = 2;
function Shim(url, init) {
  var s = String(url);
  if (document.readyState !== 'complete' && /\\/plugins\\/events(\\?|$)/.test(s)) return new Deferred(url, init);
  return new Real(url, init);
}
Shim.prototype = Real.prototype; Shim.CONNECTING = 0; Shim.OPEN = 1; Shim.CLOSED = 2;
window.EventSource = Shim;
})();`

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 * @param {PhoneUiConfig} [config] - validated config (see {@link validate}).
 */
export function apply(ctx, config = /** @type {PhoneUiConfig} */ (/** @type {{ value: PhoneUiConfig }} */ (validate()).value)) {
  const style = phoneStyle(config)
  if (style !== '' || config.deferHmrStream) {
    ctx.on('webserver/index-inject', (table) => {
      if (style !== '') table.push({ kind: 'style', text: `/* ${name} */\n${style}` })
      if (config.deferHmrStream) table.push({ kind: 'script', placement: 'head', text: `/* ${name} */\n${DEFER_HMR_STREAM_SCRIPT}` })
    })
  }
  const groups = ['header', 'messageActions', 'stats', 'codeHeaders', 'smallRadius', 'compactBlocks']
    .filter(group => config[/** @type {keyof PhoneUiConfig} */ (group)])
  if (config.sideMargin !== STOCK_SIDE_MARGIN) groups.push(`sideMargin ${config.sideMargin}px`)
  if (config.deferHmrStream) groups.push('deferHmrStream')
  ctx.logger.info(style === '' && !config.deferHmrStream ? 'no rules' : `≤${config.maxWidth}px: ${groups.join(', ')}`)
}
