import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BillingStatus, type BillingSnapshot } from '../client.tsx'
import styles from '../client.css'
// DSH's real theme tokens, so colours (ring track/fill, labels, borders) match production.
import theme from '../../../harness/packages/client/ui-theme/src/styles/design-platform.css'

const style = document.createElement('style')
style.textContent = theme + styles + `
:root{--dsw-elevation-prominent:0 4px 24px #0003}
body{margin:24px;font-family:system-ui;background:#f7f8fa;color:#232632}*{box-sizing:border-box}
.fixture-controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:440px;align-items:center}.fixture-case{background:#3a6df0;color:#fff;border:0;border-radius:4px}.fixture-controls button{padding:5px 8px}
.fixture-dock{display:flex;gap:12px;align-items:center;justify-content:center;min-width:0;max-width:760px;margin:auto}
.fixture-dock>[data-slot]{display:contents}.fixture-stat{white-space:nowrap;border:0;background:none;padding:1px 8px;color:#797d87;font:13px/20px system-ui;flex-shrink:0}.fixture-title{font-size:16px}
.fixture-context{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary)}.fixture-ctx-track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2}.fixture-ctx-fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2;stroke-linecap:round}
@media(prefers-color-scheme:dark){body{background:#181b22;color:#ddd}}
`
document.head.appendChild(style)
if (matchMedia('(prefers-color-scheme: dark)').matches) document.body.setAttribute('data-ds-dark-theme', '')

// Mock cases: each returns the snapshot the host would send.
const CASES = ['api-one', 'sub-one', 'sub-then-or', 'or-then-sub', 'multi', 'codex', 'sub-extra', 'sub-stale', 'unpriced', 'local', 'all-subs', 'current-failed', 'empty', 'storage-error', 'forbidden', 'delayed', 'wrong-session'] as const
type Scenario = typeof CASES[number]
type Source = BillingSnapshot['sources'][number]
const requests: { sessionId: string; url: string; aborted: boolean; scenario: Scenario }[] = []
let scenario: Scenario = 'sub-then-or'
let update: ((next: Scenario, id?: string) => void) | undefined
let mount: ((value: boolean) => void) | undefined
let hide: ((value: boolean) => void) | undefined

const minutes = (n: number) => new Date(Date.now() - n * 60000).toISOString()
const inMinutes = (n: number) => new Date(Date.now() + n * 60000).toISOString()
const anthropicSub = (extra: Partial<Source> = {}): Source => ({ key: 'anthropic-oauth-global/anthropic', name: 'Anthropic', icon: 'subscription', connection: 'anthropic-oauth-global', connectionLabel: 'Anthropic OAuth',
  requests: 5, model: 'claude-opus-5-5', lastAt: minutes(2), equivalent: [{ currency: 'USD', amount: '4.2' }],
  quota: { at: minutes(3), windows: [{ label: '5h', usedPercent: 8, resetAt: inMinutes(119) }, { label: '7d', usedPercent: 31, resetAt: inMinutes(5 * 1440 + 23 * 60) }] },
  account: { email: 'user@example.com', name: 'Example User', organization: 'Example Org', plan: 'claude_team' }, ...extra })
const openrouterAnthropic = (extra: Partial<Source> = {}): Source => ({ key: 'openrouter-global/anthropic', name: 'Anthropic', icon: 'openrouter', connection: 'openrouter-global', connectionLabel: 'OpenRouter',
  requests: 27, model: '~anthropic/claude-opus-latest', lastAt: minutes(40), cost: [{ kind: 'reported', currency: 'USD', amount: '2.994085' }], ...extra })
const deepseek = (extra: Partial<Source> = {}): Source => ({ key: 'deepseek-official-global/deepseek', name: 'DeepSeek', icon: 'api', connection: 'deepseek-official-global', connectionLabel: 'DeepSeek',
  requests: 3, model: 'deepseek-flash', lastAt: minutes(90), cost: [{ kind: 'estimated', currency: 'USD', amount: '0.0312' }], ...extra })
const codexSub = (extra: Partial<Source> = {}): Source => ({ key: 'openai-codex-oauth-global/openai', name: 'OpenAI', icon: 'subscription', connection: 'openai-codex-oauth-global', connectionLabel: 'Codex',
  requests: 9, model: 'gpt-5.6-terra', lastAt: minutes(1), equivalent: [{ currency: 'USD', amount: '1.87' }],
  quota: { at: minutes(0.2), windows: [{ label: '5h', usedPercent: 42, resetAt: inMinutes(200) }, { label: '7d', usedPercent: 12, resetAt: inMinutes(3 * 1440) }], credits: { hasCredits: true, unlimited: false, balance: '2.50' } },
  account: { email: 'user@example.com', plan: 'plus' }, ...extra })
function sourcesFor(name: Scenario): Source[] {
  switch (name) {
    case 'api-one': return [deepseek({ lastAt: minutes(0.3) })]
    case 'sub-one': return [anthropicSub()]
    case 'sub-then-or': return [anthropicSub(), openrouterAnthropic({ counts: { failed: 1 } })]
    case 'or-then-sub': return [openrouterAnthropic({ lastAt: minutes(0.5) }), anthropicSub({ lastAt: minutes(60) })]
    case 'multi': return [openrouterAnthropic({ lastAt: minutes(0.5), cost: [{ kind: 'reported', currency: 'USD', amount: '1.24' }, { kind: 'estimated', currency: 'USD', amount: '0.04' }] }), anthropicSub({ lastAt: minutes(30) }), codexSub({ lastAt: minutes(120) }), deepseek({ counts: { unpriced: 1 } })]
    case 'codex': return [codexSub()]
    case 'sub-extra': return [anthropicSub({ quota: { at: minutes(1), extra: true, windows: [] } })]
    case 'sub-stale': return [anthropicSub({ quota: { at: minutes(190), stale: true, windows: [{ label: '5h', usedPercent: 64, resetAt: inMinutes(10) }, { label: '7d', usedPercent: 31 }] } })]
    case 'unpriced': return [deepseek({ name: 'Gateway', connectionLabel: 'Custom gateway', key: 'gateway-global/gateway', connection: 'gateway-global', model: 'house-model-2', cost: [{ kind: 'reported', currency: 'USD', amount: '0.12' }], requests: 4, lastAt: minutes(4), counts: { unpriced: 3 } })]
    case 'local': return [{ key: 'lmstudio-global/lmstudio', name: 'LM Studio', icon: 'local', connection: 'lmstudio-global', connectionLabel: 'LM Studio', model: 'qwen3.5-4b', requests: 2, lastAt: minutes(4) }, deepseek({ lastAt: minutes(30) })]
    case 'current-failed': return [openrouterAnthropic({ lastAt: minutes(0.2), counts: { failed: 1, incomplete: 1 } }), anthropicSub({ lastAt: minutes(20) })]
    case 'all-subs': return [codexSub(), anthropicSub({ lastAt: minutes(50) })]
    case 'storage-error': return [deepseek({ lastAt: minutes(1) })]
    default: return []
  }
}
function makeSnapshot(sessionId: string): BillingSnapshot {
  const sources = sourcesFor(scenario)
  return { version: 2, sessionId: scenario === 'wrong-session' ? 'somebody-else' : sessionId, sources,
    counts: { requests: sources.reduce((n, s) => n + s.requests, 0), pending: scenario === 'multi' ? 1 : 0 }, persistence: scenario === 'storage-error' ? 'error' : 'ok', now: new Date().toISOString() }
}

// Only fixture data, never provider credentials or model inference.
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href)
  if (url.pathname !== '/fixture/api/deepsea-billing/snapshot') throw new Error('Endpoint is not document-relative')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const request = { sessionId, url: url.pathname, aborted: false, scenario }
  requests.push(request)
  if (scenario === 'delayed') return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { request.aborted = true; reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })
  return new Response(JSON.stringify(makeSnapshot(sessionId)), { status: scenario === 'forbidden' ? 403 : 200, headers: { 'content-type': 'application/json' } })
}
function Fixture() {
  const [selection, setSelection] = useState({ id: 'fixture-a', revision: 0 })
  const [mounted, setMounted] = useState(true)
  const [hidden, setHidden] = useState(false)
  update = (next, id = 'fixture-a') => { scenario = next; setSelection(s => ({ id, revision: s.revision + 1 })) }
  mount = setMounted
  hide = setHidden
  return <><h1 className="fixture-title">Billing fixture</h1><div className="fixture-controls">
    {CASES.map(name => <button key={name} className="fixture-case" onClick={() => { update?.(name); setTimeout(() => document.querySelector<HTMLButtonElement>('.deepsea-billing-pill')?.click(), 300) }}>{name}</button>)}
    <button onClick={() => hide?.(!hidden)}>Hide dock</button><button onClick={() => mount?.(!mounted)}>Unmount</button>
  </div><div className="fixture-dock" style={{ display: hidden ? 'none' : undefined }}>
    <span data-slot="conversation.composer.dock"><button className="fixture-stat" id="stats">2 turns</button><button className="fixture-stat" id="tokens">96% cache</button>
      {mounted && <BillingStatus key={`${selection.id}:${selection.revision}`} sessionId={selection.id} running />}
    </span><button className="fixture-stat fixture-context" id="context"><svg viewBox="0 0 14 14" width="14" height="14" aria-hidden><circle className="fixture-ctx-track" cx="7" cy="7" r={5.5} /><circle className="fixture-ctx-fill" cx="7" cy="7" r={5.5} strokeDasharray={`${2 * Math.PI * 5.5 * 78 / 100} ${2 * Math.PI * 5.5}`} transform="rotate(-90 7 7)" /></svg> 78%</button>
  </div></>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

const until = async (condition: () => boolean) => {
  const started = performance.now()
  while (!condition()) {
    if (performance.now() - started > 2500) throw new Error('Fixture condition timed out')
    await new Promise(requestAnimationFrame)
  }
}
const trigger = () => document.querySelector<HTMLButtonElement>('.deepsea-billing-pill')
const label = () => trigger()?.getAttribute('aria-label') ?? ''
const dialog = () => document.querySelector('[role="dialog"]')?.textContent ?? ''
const open = async () => { trigger()?.click(); await until(() => document.activeElement?.getAttribute('role') === 'dialog') }
const close = async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await until(() => !document.querySelector('[role="dialog"]')) }
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const fixture = {
  requests,
  select: (next: Scenario, id?: string) => update?.(next, id),
  async run() {
    const passed: string[] = []
    // A fresh session id, so the label checked below cannot be the page-load instance's.
    update?.('sub-then-or', 'fixture-run')
    await until(() => requests.some(r => r.sessionId === 'fixture-run') && label().includes('Anthropic plan · 7d 31% used'))
    assert(trigger()?.querySelector('circle[cx="10"][cy="7.2"]') && !trigger()?.querySelector('.deepsea-billing-note'), 'Subscription pill with no warning for earlier sources')
    await open()
    assert(dialog().includes('Anthropic plan') && dialog().includes('Example Org') && dialog().includes('Total'), 'Card heading, account and sources table')
    await close()
    assert(document.activeElement === trigger(), 'Escape must restore trigger focus')
    passed.push('plan pill, card, Escape restoration')
    update?.('current-failed')
    await until(() => label().includes('1 request failed'))
    assert(trigger()?.querySelector('.deepsea-billing-note'), 'Current source gaps show the pill note')
    passed.push('current source gaps are warnings')
    update?.('delayed', 'fixture-b')
    await until(() => requests.some(r => r.sessionId === 'fixture-b'))
    assert(!trigger()?.querySelector('svg'), 'Previous session leaked while next snapshot pending')
    passed.push('no prior-session snapshot flash')
    hide?.(true)
    await until(() => requests.some(r => r.sessionId === 'fixture-b' && r.aborted))
    passed.push('hidden dock aborts in-flight fetch')
    hide?.(false)
    update?.('forbidden', 'fixture-c')
    await until(() => label() === 'Billing: Billing unavailable')
    passed.push('403 drops previous account data')
    update?.('wrong-session')
    await until(() => requests.at(-1)?.scenario === 'wrong-session' && label() === 'Billing: Billing unavailable')
    passed.push('wrong-session response rejected')
    update?.('storage-error')
    await until(() => label().includes('Not saved'))
    await open()
    assert(dialog().includes('Not saved'), 'Storage failure is a card warning')
    await close()
    passed.push('storage failure warns')
    update?.('delayed', 'fixture-d')
    await until(() => requests.some(r => r.sessionId === 'fixture-d'))
    mount?.(false)
    await until(() => requests.some(r => r.sessionId === 'fixture-d' && r.aborted))
    passed.push('unmount aborts in-flight fetch')
    mount?.(true)
    update?.('sub-then-or')
    return passed
  },
}
Object.assign(window, { billingFixture: fixture })
