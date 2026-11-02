// The window registry (windows.mjs) against fake server connections: ids, the most-recently-used
// default, reopening after the Chrome instance dies, failed opens, closing, idle closing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserSessions, selectedPageId } from '../windows.mjs'

/** A fake chrome-devtools-mcp: pages by id, `new_page` selects the new one; `refuse` makes the next open fail to load. */
function fakeChromeServer() {
  const instances = []
  const connect = async (options) => {
    let nextPage = 1
    const pages = new Map([[0, 'about:blank']])
    const instance = {
      options, pages, closed: false, calls: [], refuse: false,
      async callRaw(name, args) {
        instance.calls.push([name, args])
        if (name === 'new_page') {
          const id = nextPage++
          if (instance.refuse) {
            instance.refuse = false
            pages.set(id, 'chrome-error://chromewebdata/')
            return { isError: true, content: [{ type: 'text', text: `Error: net::ERR_CONNECTION_REFUSED at ${args.url}` }] }
          }
          pages.set(id, args.url)
          return { content: [{ type: 'text', text: `## Pages\n${[...pages].map(([pid, url]) => `${pid}: ${url === 'chrome-error://chromewebdata/' ? `Error (${url})` : `Page (${url})`}${pid === id ? ' [selected]' : ''}`).join('\n')}` }] }
        }
        if (name === 'list_pages') return { content: [{ type: 'text', text: `## Pages\n${[...pages].map(([pid, url]) => `${pid}: ${url === 'chrome-error://chromewebdata/' ? `Error (${url})` : `Page (${url})`}`).join('\n')}` }] }
        if (name === 'close_page') { pages.delete(args.pageId); return { content: [{ type: 'text', text: 'closed' }] } }
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      async callText(name, args) { return (await instance.callRaw(name, args)).content[0].text },
      async close() { if (!instance.closed) { instance.closed = true; options.onClose?.() } },
      /** The process dies underneath the plugin. */
      crash() { instance.closed = true; options.onClose?.() },
    }
    instances.push(instance)
    return instance
  }
  return { connect, instances }
}

function sessionsWith(server, extra = {}) {
  const disposed = []
  const traced = []
  const sessions = new BrowserSessions({
    connect: server.connect,
    safariSpec: () => ({ command: 'safaridriver', args: ['--mcp'], clientName: 'test' }),
    chromeSpec: (session) => ({ command: 'cdm', args: [], clientName: `test c:${session.index}`, dispose: () => { disposed.push(session.index) } }),
    timeoutMs: 1000,
    idleMs: 0,
    onIdleClose() {},
    trace: (event) => traced.push(event),
    logger: { warn() {} },
    ...extra,
  })
  return { sessions, disposed, traced }
}

const agent = (id) => ({ id, session: { header: {} } })

test('ids: numbering per session and browser, validation, the most-recently-used default', async () => {
  const server = fakeChromeServer()
  const { sessions } = sessionsWith(server)
  const a = agent('A'); const b = agent('B')
  assert.equal(sessions.session(a).index, 0)
  assert.equal(sessions.session(b).index, 1)
  const first = await sessions.resolveChrome(a)
  assert.deepEqual([first.id, first.opened], ['c:0:0', true])
  const second = await sessions.openChrome(a, 'http://x.example/')
  assert.equal(second.id, 'c:0:1')
  assert.equal(server.instances.length, 1, 'one Chrome instance per session')
  const mru = await sessions.resolveChrome(a)
  assert.deepEqual([mru.id, mru.defaulted], ['c:0:1', { count: 2, others: ['c:0:0'] }])
  await sessions.resolveChrome(a, 'c:0:0')
  assert.equal((await sessions.resolveChrome(a)).id, 'c:0:0', 'the default follows the last explicit use')
  await assert.rejects(sessions.resolveChrome(b, 'c:0:0'), /does not belong to this session \(this session is 1\)/)
  await assert.rejects(sessions.resolveChrome(a, 's:0:0'), /is a safari window; this tool drives chrome/)
  assert.throws(() => sessions.parse(a, 'safari', 'nope'), /Invalid windowId "nope"/)
  assert.deepEqual(sessions.listIds(a, 'chrome'), ['c:0:0', 'c:0:1'])
  assert.equal(selectedPageId('## Pages\n1: about:blank\n2: Example (https://example.com/) [selected]'), 2)
  assert.equal(selectedPageId('nothing'), undefined)
})

test('closing: one window keeps the instance, the last one ends it and its scratch', async () => {
  const server = fakeChromeServer()
  const { sessions, disposed } = sessionsWith(server)
  const a = agent('A')
  await sessions.openChrome(a, 'http://one.example/')
  await sessions.openChrome(a, 'http://two.example/')
  assert.deepEqual(await sessions.closeChrome(a, 'c:0:0'), ['c:0:0'])
  assert.equal(server.instances[0].closed, false)
  assert.ok(server.instances[0].calls.some(([name]) => name === 'close_page'))
  assert.deepEqual(await sessions.closeChrome(a), ['c:0:1'])
  assert.equal(server.instances[0].closed, true)
  assert.deepEqual(disposed, [0], 'the instance\'s dispose (scratch directory) ran')
  assert.deepEqual(await sessions.closeChrome(a), [])
})

test('after the instance dies, a window is reopened at its last URL under the same id', async () => {
  const server = fakeChromeServer()
  const { sessions, disposed } = sessionsWith(server)
  const a = agent('A')
  await sessions.openChrome(a, 'http://one.example/')
  sessions.noteChromeUrl(a, 'c:0:0', 'http://one.example/next')
  server.instances[0].crash()
  assert.deepEqual(disposed, [0])
  const byId = await sessions.resolveChrome(a, 'c:0:0')
  assert.deepEqual([byId.id, byId.reopened], ['c:0:0', { url: 'http://one.example/next' }])
  assert.equal(server.instances.length, 2)
  assert.equal(server.instances[1].pages.get(byId.pageId), 'http://one.example/next')
  // Without an id too.
  server.instances[1].crash()
  const byDefault = await sessions.resolveChrome(a)
  assert.deepEqual([byDefault.id, byDefault.opened, byDefault.reopened?.url], ['c:0:0', false, 'http://one.example/next'])
  // A stale page mid-call: recoverChrome reopens it once.
  const recovered = await sessions.recoverChrome(a, 'c:0:0')
  assert.equal(recovered.id, 'c:0:0')
  assert.ok(recovered.reopened)
  // Closing a lost window forgets it.
  server.instances.at(-1).crash()
  await sessions.closeChrome(a, 'c:0:0')
  await assert.rejects(sessions.resolveChrome(a, 'c:0:0'), /is not open/)
})

test('a page that fails to load opens no window and leaves no error page behind', async () => {
  const server = fakeChromeServer()
  const { sessions } = sessionsWith(server)
  const a = agent('A')
  await sessions.openChrome(a, 'http://ok.example/')
  server.instances[0].refuse = true
  await assert.rejects(sessions.openChrome(a, 'http://127.0.0.1:9/nothing'), /Chrome could not open http:\/\/127\.0\.0\.1:9\/nothing: net::ERR_CONNECTION_REFUSED.*No window was opened/)
  assert.ok(![...server.instances[0].pages.values()].includes('chrome-error://chromewebdata/'), 'the error page was closed')
  assert.deepEqual(sessions.listIds(a, 'chrome'), ['c:0:0'])
  assert.equal((await sessions.openChrome(a, 'http://ok.example/2')).id, 'c:0:1')
})

test('temporary reader pages: never a window, closed after the read; the warm instance goes with the session', async () => {
  const server = fakeChromeServer()
  const { sessions } = sessionsWith(server)
  const a = agent('A')
  const seen = await sessions.withChromeReaderPage(a, 'http://read.example/', async ({ pageId }) => server.instances[0].pages.get(pageId))
  assert.equal(seen, 'http://read.example/')
  assert.deepEqual(sessions.listIds(a, 'chrome'), [])
  assert.ok(![...server.instances[0].pages.values()].includes('http://read.example/'))
  assert.equal(server.instances[0].closed, false, 'kept warm')
  await sessions.forget(a, 'test')
  assert.equal(server.instances[0].closed, true)
})

test('Safari windows: one connection each, the most-recently-used default, close one and all', async () => {
  const server = fakeChromeServer()
  const gone = []
  const { sessions } = sessionsWith(server, { onSafariGone: (id) => gone.push(id) })
  const a = agent('A')
  const first = await sessions.resolveSafari(a)
  assert.deepEqual([first.id, first.opened], ['s:0:0', true])
  assert.equal(server.instances[0].options.safari, true)
  await sessions.openSafari(a)
  assert.equal(server.instances.length, 2)
  const newest = await sessions.resolveSafari(a)
  assert.deepEqual([newest.id, newest.defaulted], ['s:0:1', { count: 2, others: ['s:0:0'] }], 'a new window is the most recently used')
  assert.deepEqual(await sessions.closeSafari(a, 's:0:0'), ['s:0:0'])
  assert.equal((await sessions.resolveSafari(a)).id, 's:0:1')
  // A driver that exits by itself drops its window.
  server.instances[1].crash()
  assert.deepEqual(sessions.listIds(a, 'safari'), [])
  assert.deepEqual(gone, ['s:0:0', 's:0:1'])
})

test('a refused Safari launch quotes what safaridriver said', async () => {
  const sessions = new BrowserSessions({
    connect: async (options) => { options.onStderr('could not launch because it is not configured correctly or you need to authenticate'); throw new Error('Connection closed') },
    safariSpec: () => ({ command: 'safaridriver', args: ['--mcp'], clientName: 'test' }),
    chromeSpec: () => ({}), timeoutMs: 1000, idleMs: 0, onIdleClose() {}, trace() {}, logger: { warn() {} },
  })
  await assert.rejects(sessions.openSafari(agent('A')), /Connection closed — safaridriver said: could not launch because it is not configured correctly/)
})

test('idle closing closes every window and tells the agent', async () => {
  const server = fakeChromeServer()
  const notices = []
  const { sessions } = sessionsWith(server, { idleMs: 30, onIdleClose: (who, closed) => notices.push([who.id, closed]) })
  const a = agent('A')
  await sessions.openChrome(a, 'http://x.example/')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.deepEqual(notices, [['A', ['c:0:0']]])
  assert.equal(server.instances[0].closed, true)
})
