// The notices' decisions (src/client/notice.ts, type-stripped) and the panel page's HTML (panel-page.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callIdOfPanel, decide, panelIdOf, panelSize, panelUrl } from '../src/client/notice.ts'
import { escapeHtml, panelHtml, scriptJson } from '../panel-page.mjs'

const call = (callId, noticeAt, extra = {}) => ({ callId, sessionId: 's', noticeAt, noticeMs: 60_000, open: 1, total: 2, ...extra })
const fresh = () => ({ shown: new Set(), closedAt: new Map() })

test('a waiting call is shown once its notice time has passed, once', () => {
  const state = fresh()
  assert.deepEqual(decide([call('a', 1000)], state, 999).show, [])
  assert.deepEqual(decide([call('a', 1000)], state, 1000).show.map(c => c.callId), ['a'])
  state.shown.add('a')
  assert.deepEqual(decide([call('a', 1000)], state, 5000).show, [], 'already shown (by this window or, by the app\'s event, another)')
  assert.deepEqual(decide([call('b', null)], fresh(), 1e12).show, [], 'no notice time: nothing open, or notices off')
  assert.deepEqual(decide([call('c', 1000, { open: 0 })], fresh(), 5000).show, [])
})

test('a panel the person closed comes back only after another notice period of waiting', () => {
  const state = fresh()
  state.closedAt.set('a', 10_000)
  assert.deepEqual(decide([call('a', 1000)], state, 69_999).show, [])
  assert.deepEqual(decide([call('a', 1000)], state, 70_000).show.map(c => c.callId), ['a'])
  assert.deepEqual(decide([call('a', 90_000)], state, 80_000).show, [], 'a later notice time (a click since) still rules')
})

test('a shown panel is closed when its call no longer waits', () => {
  const state = fresh()
  state.shown.add('a')
  state.shown.add('b')
  assert.deepEqual(decide([call('b', 1000)], state, 5000).close, ['a'])
})

test('panel ids, size and address', () => {
  assert.equal(panelIdOf('x-1'), 'deepsea-tool-system-permissions:x-1')
  assert.equal(callIdOfPanel('deepsea-tool-system-permissions:x-1'), 'x-1')
  assert.equal(callIdOfPanel('other:x-1'), undefined)
  assert.deepEqual(panelSize(call('a', 0, { total: 3 })), { width: 560, height: 236 })
  assert.equal(panelSize(call('a', 0, { total: 40 })).height, 680)
  assert.equal(panelUrl(call('a b', 0)), './api/deepsea-tool-system-permissions/panel?callId=a+b&sessionId=s&panel=deepsea-tool-system-permissions%3Aa+b')
})

test('the panel page escapes what it embeds', () => {
  assert.equal(escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;')
  assert.equal(scriptJson({ line: '</script><script>x' }), '{"line":"\\u003c/script>\\u003cscript>x"}')
  const html = panelHtml({ callId: 'c', sessionId: 's', panelId: 'p', workspace: 'W', title: '<T>', script: 'var a = "</script>";' })
  assert.match(html, /<title>&lt;T&gt;<\/title>/)
  assert.match(html, /var a = "<\\\/script>";/)
  assert.equal((html.match(/<\/script>/g) ?? []).length, 2)
})
