// node --test: the host half against a fake ctx, no server needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMPACT_BLOCK_RULES, Config, DEFAULT_MAX_WIDTH, DEFAULT_SIDE_MARGIN, DEFER_HMR_STREAM_SCRIPT, FLAGS, MAX_MAX_WIDTH, MAX_SIDE_MARGIN,
  DARWIN, HEADER_SELECTOR, MIN_MAX_WIDTH, MOBILE_FLAG_SELECTOR, SELECTORS, STOCK_SIDE_MARGIN, USER_BUBBLE_SELECTOR, apply, name, onMobileFlag, phoneStyle, validate,
} from '../index.js'

function fakeContext() {
  const listeners = new Map()
  const logs = []
  const ctx = {
    on(event, fn) {
      listeners.set(event, fn)
      return () => { listeners.delete(event) }
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn: ${m}`) },
  }
  return { ctx, listeners, logs }
}

const ALL_ON = {
  maxWidth: DEFAULT_MAX_WIDTH, sideMargin: DEFAULT_SIDE_MARGIN,
  header: true, messageActions: true, stats: true, codeHeaders: true, smallRadius: true, compactBlocks: true, deferHmrStream: true,
}
const value = (input) => {
  const result = validate(input)
  assert.ok('value' in result, JSON.stringify(result))
  return result.value
}

test('defaults: 640px, every group on, 8px side margin', () => {
  assert.deepEqual(value(undefined), ALL_ON)
  assert.deepEqual(value({}), ALL_ON)
  const css = phoneStyle(ALL_ON)
  assert.match(css, /^:root\{--deepsea-phone-ui-max-width:640px\}@media \(max-width:640px\)\{/)
  for (const selector of Object.values(SELECTORS).flat()) assert.ok(css.includes(selector), selector)
  assert.match(css, /\{display:none\}/)
  assert.match(css, /\[data-conversation-content\]\[data-content-phase\]\{--dsh-composer-side-clearance:8px\}/)
  assert.ok(css.includes('[data-conversation-scroll] div:has(> [data-chat-flow]:not([data-step-process-content])){padding-left:8px;padding-right:8px}'))
  assert.match(css, /\.md-code-block pre\{border-top-left-radius/)
  assert.match(css, /\.md-code-block\{--dsl-code-block-border-radius:6px\}/)
  assert.ok(css.includes(`${USER_BUBBLE_SELECTOR}{border-radius:6px}`))
  for (const [selector, declarations] of COMPACT_BLOCK_RULES) assert.ok(css.includes(`${selector}{${declarations}}`), selector)
})

test('compactBlocks off keeps the client\'s own padding', () => {
  const css = phoneStyle({ ...ALL_ON, compactBlocks: false })
  assert.doesNotMatch(css, /padding:8px 10px|\[data-context-injection-body\]|_ioSection/)
  assert.ok(css.includes(`${USER_BUBBLE_SELECTOR}{border-radius:6px}`), 'radius group untouched')
})

test('every rule twice: inside the media query and under html[data-deepsea-view="mobile"]', () => {
  assert.equal(MOBILE_FLAG_SELECTOR, 'html[data-deepsea-view="mobile"]')
  const css = phoneStyle(ALL_ON).replace(/^:root\{[^}]*\}/, '')
  const close = css.indexOf('}}')
  assert.ok(close > 0, 'media block closes')
  const inMedia = css.slice(0, close + 2)
  const flagged = css.slice(close + 2)
  assert.ok(!inMedia.includes(MOBILE_FLAG_SELECTOR))
  assert.ok(flagged.startsWith(MOBILE_FLAG_SELECTOR))
  const count = text => (text.match(/\{/g) ?? []).length
  assert.equal(count(flagged), count(inMedia) - 1)
  for (const selector of [...Object.values(SELECTORS).flat(), USER_BUBBLE_SELECTOR, '[data-conversation-content][data-content-phase]']) {
    assert.ok(flagged.includes(onMobileFlag(selector)), selector)
  }
  // A comma list is scoped per selector, not once for the list.
  assert.ok(flagged.includes(`,${onMobileFlag(SELECTORS.messageActions[0])}`))
})

test('onMobileFlag: a selector qualifying html gets the attribute on that compound', () => {
  assert.equal(onMobileFlag('[data-chat-flow] blockquote'), 'html[data-deepsea-view="mobile"] [data-chat-flow] blockquote')
  assert.equal(onMobileFlag('html:not([data-platform="darwin"]) header'), 'html[data-deepsea-view="mobile"]:not([data-platform="darwin"]) header')
  assert.equal(onMobileFlag(`${DARWIN} header`), 'html[data-deepsea-view="mobile"][data-platform="darwin"] header')
})

test('header: hidden in a browser; in the macOS app (darwin) only its tabs, the title bar stays', () => {
  const css = phoneStyle(ALL_ON)
  assert.ok(css.includes(`html:not([data-platform="darwin"]) ${HEADER_SELECTOR}`))
  assert.ok(css.includes(`${DARWIN} ${HEADER_SELECTOR} [data-conversation-tabs]`))
  assert.ok(css.includes(`${DARWIN} ${HEADER_SELECTOR}{min-height:0;padding-bottom:10px}`))
  const off = phoneStyle({ ...ALL_ON, header: false })
  assert.ok(!off.includes(HEADER_SELECTOR))
})

test('sideMargin: integer 0-64; the client\'s own 32 emits no padding rules', () => {
  assert.equal(value({ sideMargin: 0 }).sideMargin, 0)
  assert.equal(value({ sideMargin: MAX_SIDE_MARGIN }).sideMargin, MAX_SIDE_MARGIN)
  for (const bad of [-1, MAX_SIDE_MARGIN + 1, 8.5, '8']) {
    assert.match(validate({ sideMargin: bad }).issues?.[0].message ?? '', /sideMargin is an integer/, String(bad))
  }
  const css = phoneStyle({ ...ALL_ON, sideMargin: STOCK_SIDE_MARGIN })
  assert.doesNotMatch(css, /side-clearance|div:has\(> \[data-chat-flow\]/)
})

test('codeHeaders off keeps the banner and adds no pre radius; smallRadius off keeps 12px / 22px', () => {
  const noHeaders = phoneStyle({ ...ALL_ON, codeHeaders: false })
  assert.ok(!noHeaders.includes(SELECTORS.codeHeaders[0]))
  assert.doesNotMatch(noHeaders, /pre\{border-top/)
  assert.doesNotMatch(phoneStyle({ ...ALL_ON, smallRadius: false }), /border-radius:6px/)
})

test('config: maxWidth integer 320-1200, flags boolean, unknown keys and other values are issues', () => {
  assert.equal(value({ maxWidth: MIN_MAX_WIDTH }).maxWidth, MIN_MAX_WIDTH)
  assert.equal(value({ maxWidth: MAX_MAX_WIDTH }).maxWidth, MAX_MAX_WIDTH)
  for (const bad of [MIN_MAX_WIDTH - 1, MAX_MAX_WIDTH + 1, 400.5, '640', NaN]) {
    assert.match(validate({ maxWidth: bad }).issues?.[0].message ?? '', /maxWidth is an integer/, String(bad))
  }
  for (const key of FLAGS) {
    assert.equal(value({ [key]: false })[key], false)
    assert.match(validate({ [key]: 'yes' }).issues?.[0].message ?? '', new RegExp(`${key} is true or false`))
  }
  assert.match(validate({ maxwidth: 480 }).issues?.[0].message ?? '', /unknown key "maxwidth"/)
  assert.equal(validate({ maxWidth: 1, header: 'x' }).issues?.length, 2, 'every issue at once')
})

test('Config is a standard schema whose vendor is the loader row id', () => {
  assert.equal(name, 'deepsea-phone-ui')
  assert.equal(Config['~standard'].vendor, name)
  assert.deepEqual(Config['~standard'].validate({ stats: false }), { value: { ...ALL_ON, stats: false } })
})

test('groups switch off independently', () => {
  const css = phoneStyle({ ...ALL_ON, messageActions: false })
  assert.ok(css.includes(SELECTORS.header[0]))
  assert.ok(css.includes(SELECTORS.stats[0]))
  for (const selector of SELECTORS.messageActions) assert.ok(!css.includes(selector), selector)
})

test('apply pushes one style row and the head script into the index-inject table', () => {
  const { ctx, listeners, logs } = fakeContext()
  apply(ctx, value({ maxWidth: 480 }))
  const table = []
  listeners.get('webserver/index-inject')(table)
  assert.equal(table.length, 2)
  assert.equal(table[0].kind, 'style')
  assert.match(table[0].text, /^\/\* deepsea-phone-ui \*\//)
  assert.match(table[0].text, /max-width:480px/)
  assert.deepEqual([table[1].kind, table[1].placement], ['script', 'head'])
  assert.equal(table[1].text.replace(/^\/\* deepsea-phone-ui \*\/\n/, ''), DEFER_HMR_STREAM_SCRIPT)
  assert.match(logs[0], /≤480px: header, messageActions, stats, codeHeaders, smallRadius, compactBlocks, sideMargin 8px, deferHmrStream/)
})

test('the head script parses and wraps only the /plugins/events stream', () => {
  assert.doesNotThrow(() => new Function(DEFER_HMR_STREAM_SCRIPT))
  assert.match(DEFER_HMR_STREAM_SCRIPT, /\/\\\/plugins\\\/events\(\\\?\|\$\)\//)
  assert.match(DEFER_HMR_STREAM_SCRIPT, /addEventListener\('load'/)
})

test('the head script defers the stream while loading and hands out the real class after', () => {
  const created = []
  class Real {
    constructor(url) { this.url = url; this.listeners = []; created.push(this) }
    addEventListener(type, fn) { this.listeners.push([type, fn]) }
    removeEventListener() {}
    close() { this.closed = true }
  }
  const loadListeners = []
  const timers = []
  const window = {
    EventSource: Real,
    addEventListener: (type, fn) => { if (type === 'load') loadListeners.push(fn) },
  }
  const document = { readyState: 'loading' }
  new Function('window', 'document', 'setTimeout', DEFER_HMR_STREAM_SCRIPT)(window, document, (fn) => { timers.push(fn) })
  const onMessage = () => {}
  const hmr = new window.EventSource('./plugins/events')
  hmr.addEventListener('message', onMessage)
  assert.equal(created.length, 0, 'no stream during the load')
  const other = new window.EventSource('./api/other')
  assert.ok(other instanceof Real, 'other streams are real at once')
  for (const fn of loadListeners) fn()
  for (const fn of timers) fn()
  const real = created.find(s => s.url === './plugins/events')
  assert.ok(real, 'the stream opens after load')
  assert.deepEqual(real.listeners, [['message', onMessage]])
  document.readyState = 'complete'
  assert.ok(new window.EventSource('./plugins/events') instanceof Real, 'after load the class is the real one')
})

test('no rules and no script: no listener', () => {
  const { ctx, listeners, logs } = fakeContext()
  const off = { header: false, messageActions: false, stats: false, codeHeaders: false, smallRadius: false, compactBlocks: false, sideMargin: STOCK_SIDE_MARGIN, deferHmrStream: false }
  const config = value(off)
  apply(ctx, config)
  assert.equal(phoneStyle(config), '')
  assert.equal(listeners.has('webserver/index-inject'), false)
  assert.match(logs[0], /no rules/)
})
