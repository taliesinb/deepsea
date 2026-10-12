/** The browser half's pure helpers (src/client/helpers.ts, run with Node's type stripping). */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { addressVariants, ago, appLoopbackTarget, commandLines, isLoopbackBase, isLoopbackHostname, sessionLink, sessionLinkFacts } from '../src/client/helpers.ts'

describe('client helpers', () => {
  it('loopback links: taken in the app only for plain clicks on another origin\'s loopback URL', () => {
    const page = 'https://node.example.ts.net'
    assert.equal(appLoopbackTarget('http://127.0.0.1:5173/x', page, false), 'http://127.0.0.1:5173/x')
    assert.equal(appLoopbackTarget('http://app.localhost:3000/', page, false), 'http://app.localhost:3000/')
    assert.equal(appLoopbackTarget('http://127.0.0.1:5173/', page, true), undefined, 'modified clicks take the app\'s own path')
    assert.equal(appLoopbackTarget('https://example.com/', page, false), undefined)
    assert.equal(appLoopbackTarget('mailto:x@example.com', page, false), undefined)
    assert.equal(appLoopbackTarget('http://127.0.0.1:3200/', 'http://127.0.0.1:3200', false), undefined, 'same origin')
    assert.ok(isLoopbackHostname('[::1]') && isLoopbackHostname('0.0.0.0') && !isLoopbackHostname('node.example.ts.net'))
  })

  it('session links: the host\'s URL and token when published, else the document\'s own directory, never loopback', () => {
    const status = { url: 'https://node.example.ts.net/deepsea-lab/', tokenUrl: 'https://node.example.ts.net/deepsea-lab/?token=T0K', route: 'active' }
    assert.deepEqual(sessionLinkFacts(status, 'http://127.0.0.1:3200/'), { base: 'https://node.example.ts.net/deepsea-lab/', token: 'T0K', source: 'host' })
    assert.deepEqual(sessionLinkFacts(undefined, 'https://node.example.ts.net/deepsea-lab/'), { base: 'https://node.example.ts.net/deepsea-lab/', source: 'document' })
    assert.equal(sessionLinkFacts({ ...status, route: 'off' }, 'http://127.0.0.1:3200/').source, 'none')
    assert.equal(sessionLinkFacts(undefined, 'http://localhost:3203/').base, undefined)
    assert.equal(sessionLink('https://n/deepsea/', 'session-1', 'T'), 'https://n/deepsea/?token=T&embed=session-1')
    assert.equal(sessionLink('https://n/deepsea/', 'session-1', undefined), 'https://n/deepsea/?embed=session-1')
    assert.ok(isLoopbackBase('not a url'))
  })

  it('addresses, durations and command lines', () => {
    assert.deepEqual(addressVariants({ dnsName: 'node.example.ts.net', servePath: '/deepsea-lab', selfAddresses: ['fd7a:115c:a1e0::1', '100.100.100.1'] }), [
      { label: 'tailnet', url: 'https://node.example.ts.net/deepsea-lab/' },
      { label: 'short name', url: 'https://node/deepsea-lab/' },
      { label: 'tailnet IP', url: 'https://100.100.100.1/deepsea-lab/' },
    ])
    assert.deepEqual(addressVariants({ dnsName: 'node.example.ts.net', selfAddresses: [] }), [])
    assert.deepEqual([ago(5000), ago(95_000), ago(7_300_000), ago(200 * 3_600_000)], ['5s', '1m 35s', '2h 1m', '8d 8h'])
    assert.deepEqual(commandLines('/usr/bin/node /x/relay.mjs --variant lab --listen 127.0.0.1:3203 -- /usr/bin/node bin.ts'),
      ['/usr/bin/node', '/x/relay.mjs', '--variant lab', '--listen 127.0.0.1:3203', '--', '/usr/bin/node bin.ts'])
  })
})
