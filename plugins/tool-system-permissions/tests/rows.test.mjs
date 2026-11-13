// Both rows without a server: the root's service and routes (status, Grant
// and Deny through them, session checks, the record of finished calls) and
// the tools row (tool, prompt section, fallback), plus the package facts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as root from '../index.js'
import * as toolsRow from '../tools.js'
import { exec, fakeCtx } from './fake-ctx.mjs'
import { until } from './helpers.mjs'

const status = (ctx, query) => ctx.routes.get(root.STATUS_PATH).fetch(new Request(`http://x${root.STATUS_PATH}?${query}`))
const action = (ctx, body, type = 'application/json') => ctx.routes.get(root.ACTION_PATH).fetch(new Request(`http://x${root.ACTION_PATH}`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) }))
const req = (...ids) => ids.map(permission => ({ permission, justification: 'To test it.' }))
const testing = { platform: 'darwin', paneDelayMs: 0, refineMs: 0 }

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-tool-system-permissions-test-'))
  const stateFile = join(dir, 'state.json')
  const recordFile = join(dir, 'home', 'calls.json')
  const services = new Map()
  const host = fakeCtx(services)
  root.apply(host, { fakeStateFile: stateFile, recordFile })
  const tools = fakeCtx(services)
  toolsRow.apply(tools, toolsRow.Config({ pollSeconds: 0.2, noticeSeconds: 0.05 }), testing)
  const write = states => writeFileSync(stateFile, JSON.stringify({ states }))
  return { dir, stateFile, recordFile, host, tools, write, cleanup: () => { host.dispose(); tools.dispose(); rmSync(dir, { recursive: true, force: true }) } }
}

test('the root provides deepseaSystemPermissions and four routes; the tools row registers the tool and the prompt section', () => {
  const { host, tools, cleanup } = setup()
  try {
    assert.equal(root.name, 'deepsea-tool-system-permissions')
    assert.deepEqual(root.inject, ['connection'])
    assert.deepEqual([...host.routes.keys()], ['/api/deepsea-tool-system-permissions/status', '/api/deepsea-tool-system-permissions/action', '/api/deepsea-tool-system-permissions/running', '/api/deepsea-tool-system-permissions/panel'])
    assert.equal(host.get('deepseaSystemPermissions').prober.kind, 'fake')
    assert.equal(host.tools.get('seek_system_permission'), undefined)
    assert.equal(toolsRow.name, 'deepsea-tool-system-permissions-tools')
    assert.deepEqual(toolsRow.inject, ['tools'])
    assert.ok(tools.tools.get('seek_system_permission'))
    assert.equal(tools.routes.size, 0)
    assert.equal(tools.sections[0].name, 'tool:deepsea-tool-system-permissions')
    assert.match(tools.sections[0].text({ scope: undefined }), /call `seek_system_permission` for it first/)
    const quiet = fakeCtx()
    toolsRow.apply(quiet, toolsRow.Config({ promptHint: false }), testing)
    assert.equal(quiet.sections.length, 0)
    assert.throws(() => toolsRow.Config({ pollSeconds: 0 }))
  } finally { cleanup() }
})

test('through the routes: status of a running call, Grant reaches the fake prober, Deny ends it, the record survives', async () => {
  const { host, tools, write, recordFile, cleanup } = setup()
  try {
    write({ accessibility: 'granted' })
    const running = tools.tools.get('seek_system_permission').execute({ permissions: req('accessibility', 'screen-recording', 'microphone') }, exec('call-1'))
    await until(() => host.get('deepseaSystemPermissions').registry.get('call-1')?.snapshot.rows[1].state === 'pending')
    const live = await (await status(host, 'callId=call-1&sessionId=session-1')).json()
    assert.equal(live.running, true)
    assert.deepEqual(live.snapshot.rows.map(r => r.state), ['granted', 'pending', 'pending'])
    assert.equal(live.snapshot.subject.name, 'DeepSea Test Server')
    assert.deepEqual(live.fake.events, [])
    assert.equal((await status(host, 'callId=call-1&sessionId=session-2')).status, 403)
    assert.equal((await status(host, 'callId=call-1')).status, 400)
    assert.equal((await status(host, 'callId=nope&sessionId=session-1')).status, 404)

    assert.equal((await action(host, { action: 'grant', permission: 'screen-recording', callId: 'call-1', sessionId: 'session-1' }, 'text/plain')).status, 415)
    assert.equal((await action(host, { action: 'grant', permission: 'screen-recording', callId: 'call-1', sessionId: 'session-2' })).status, 403)
    assert.equal((await action(host, { action: 'allow', permission: 'screen-recording', callId: 'call-1', sessionId: 'session-1' })).status, 400)
    assert.equal((await action(host, { action: 'grant', permission: 'camera', callId: 'call-1', sessionId: 'session-1' })).status, 404)
    const granted = await action(host, { action: 'grant', permission: 'screen-recording', callId: 'call-1', sessionId: 'session-1' })
    assert.deepEqual(await granted.json(), { ok: true, action: 'grant' })
    await until(() => host.get('deepseaSystemPermissions').prober.events.length === 1)
    const events = (await (await status(host, 'callId=call-1&sessionId=session-1')).json()).fake.events
    assert.deepEqual(events.map(e => [e.kind, e.id]), [['trigger', 'screen-recording']], 'never asked: macOS\'s alert alone')
    write({ accessibility: 'granted', 'screen-recording': 'granted' })
    await until(() => host.get('deepseaSystemPermissions').registry.get('call-1').snapshot.rows[1].state === 'granted')
    assert.equal((await action(host, { action: 'deny', permission: 'microphone', callId: 'call-1', sessionId: 'session-1' })).status, 200)
    const value = await running
    assert.deepEqual(value.permissions.map(p => p.state), ['granted', 'granted', 'denied'])
    const after = await (await status(host, 'callId=call-1&sessionId=session-1')).json()
    assert.equal(after.running, false)
    assert.equal((await action(host, { action: 'deny', permission: 'microphone', callId: 'call-1', sessionId: 'session-1' })).status, 404)
    const record = JSON.parse(readFileSync(recordFile, 'utf8'))
    assert.deepEqual(record.calls.map(c => [c.callId, c.sessionIds, c.snapshot.rows.map(r => r.state)]), [['call-1', ['session-1'], ['granted', 'granted', 'denied']]])

    // A new root (a server restart) still answers for the finished call.
    const again = fakeCtx()
    root.apply(again, { fakeStateFile: '/nonexistent', recordFile })
    assert.equal((await (await status(again, 'callId=call-1&sessionId=session-1')).json()).snapshot.rows[2].state, 'denied')
    again.dispose()
  } finally { cleanup() }
})

test('Grant through the route on a stale row: the fake records the reset (the exact tccutil argv), then the trigger and the pane', async () => {
  const { host, tools, write, cleanup } = setup()
  try {
    write({ microphone: 'stale' })
    const running = tools.tools.get('seek_system_permission').execute({ permissions: req('microphone') }, exec('call-4'))
    await until(() => host.get('deepseaSystemPermissions').registry.get('call-4')?.snapshot.rows[0].state === 'pending')
    assert.equal(host.get('deepseaSystemPermissions').registry.get('call-4').snapshot.rows[0].status, 'stale')
    assert.equal((await action(host, { action: 'grant', permission: 'microphone', callId: 'call-4', sessionId: 'session-1' })).status, 200)
    await until(() => host.get('deepseaSystemPermissions').prober.events.length === 2)
    const events = (await (await status(host, 'callId=call-4&sessionId=session-1')).json()).fake.events
    assert.deepEqual(events.map(e => [e.kind, e.id, e.command]), [
      ['reset', 'microphone', ['/usr/bin/tccutil', 'reset', 'Microphone', 'io.github.taliesinb.deepsea.test.server']],
      ['trigger', 'microphone', undefined],
    ])
    write({ microphone: 'granted' })
    const value = await running
    assert.deepEqual([value.permissions[0].state, value.permissions[0].staleReset], ['granted', 'removed'])
  } finally { cleanup() }
})

test('a cancelled call keeps its rows in the record (its result carries no meta)', async () => {
  const { host, tools, cleanup } = setup()
  try {
    const controller = new AbortController()
    const running = tools.tools.get('seek_system_permission').execute({ permissions: req('camera') }, { ...exec('call-2'), signal: controller.signal })
    await until(() => host.get('deepseaSystemPermissions').registry.get('call-2')?.snapshot.rows[0].state === 'pending')
    controller.abort()
    await assert.rejects(running, error => error.code === 'ABORTED')
    const body = await (await status(host, 'callId=call-2&sessionId=session-1')).json()
    assert.deepEqual([body.running, body.snapshot.rows[0].state], [false, 'cancelled'])
  } finally { cleanup() }
})

test('without the root row the tool still runs, on a prober of its own', async () => {
  const ctx = fakeCtx()
  toolsRow.apply(ctx, toolsRow.Config({}), { ...testing, platform: 'linux' })
  const value = await ctx.tools.get('seek_system_permission').execute({ permissions: req('camera') }, exec('call-3'))
  assert.equal(value.outcome, 'not-applicable')
  ctx.dispose()
})

test('package: both rows in the bundle patch, the ./tools exports, the join rule, machine-wide, both titles in both languages', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, '@deepsea/tool-system-permissions')
  assert.equal(pkg.exports['./tools'], './tools.js')
  assert.equal(pkg.exports['./tools/locale/*.json'], './locale/tools/*.json')
  assert.deepEqual(pkg.deepsea.presets, { joinWith: ['@deepseek-ai/dsh-tool-bash'], module: '@deepsea/tool-system-permissions/tools' })
  assert.match(pkg.deepsea.machineWide, /macOS privacy permissions/)
  for (const file of ['index.js', 'tools.js', 'seek.mjs', 'permissions.mjs', 'macos.mjs', 'fake.mjs', 'macos/probe.jxa']) assert.ok(pkg.files.includes(file), file)
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- id: deepsea-tool-system-permissions\n\s+name: "@deepsea\/tool-system-permissions"\n/)
  assert.match(patch, /- id: deepsea-tool-system-permissions-tools\n\s+name: "@deepsea\/tool-system-permissions\/tools"\n/)
  const title = path => JSON.parse(readFileSync(new URL(`../locale/${path}.json`, import.meta.url), 'utf8')).meta.title
  assert.equal(title('en'), 'System permission controls')
  assert.equal(title('tools/en'), 'System permission tool')
  assert.ok(title('zh') && title('tools/zh') && title('zh') !== title('tools/zh'))
})

test('running and panel routes: open calls with their notice time and session line; the panel page for one call', async () => {
  const { host, tools, write, cleanup } = setup()
  try {
    // The Host services the session line comes from (shapes as in dsh-v0.2.2).
    host.services.set('workspaceRegistry', { list: async () => [{ title: 'default-workspace', sessionIds: ['session-1'] }] })
    host.services.set('sessionController', { list: async () => ({ items: [{ sessionId: 'session-1', projections: { values: { title: { title: 'Install the prototype' } } } }] }) })
    write({ accessibility: 'granted' })
    const running = tools.tools.get('seek_system_permission').execute({ permissions: req('accessibility', 'camera') }, exec('call-5'))
    await until(() => host.get('deepseaSystemPermissions').registry.get('call-5')?.snapshot.rows[1].state === 'pending')
    const list = await (await host.routes.get(root.RUNNING_PATH).fetch(new Request(`http://x${root.RUNNING_PATH}`))).json()
    assert.equal(typeof list.now, 'number')
    assert.deepEqual(list.calls.map(c => [c.callId, c.sessionId, c.open, c.total, c.noticeMs]), [['call-5', 'session-1', 1, 2, 50]])
    assert.equal(typeof list.calls[0].noticeAt, 'number')

    const panel = (query) => host.routes.get(root.PANEL_PATH).fetch(new Request(`http://x${root.PANEL_PATH}?${query}`))
    assert.equal((await panel('callId=call-5&sessionId=session-2')).status, 404)
    const page = await panel('callId=call-5&sessionId=session-1&panel=deepsea-tool-system-permissions:call-5')
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /text\/html/)
    const html = await page.text()
    assert.match(html, /<title>Install the prototype<\/title>/)
    assert.match(html, /__DEEPSEA_SYSTEM_PERMISSIONS_PANEL__ = \{"callId":"call-5","sessionId":"session-1","panelId":"deepsea-tool-system-permissions:call-5","workspace":"default-workspace","title":"Install the prototype"\}/)
    assert.match(html, /deepsea-tool-system-permissions-panel/)
    assert.doesNotMatch(html.slice(html.indexOf('<script>window.')), /<\/script>[\s\S]*<\/script>[\s\S]*<\/script>/, 'the inlined bundle cannot close its script element early')

    await action(host, { action: 'deny', permission: 'camera', callId: 'call-5', sessionId: 'session-1' })
    await running
    assert.deepEqual((await (await host.routes.get(root.RUNNING_PATH).fetch(new Request(`http://x${root.RUNNING_PATH}`))).json()).calls, [])
  } finally { cleanup() }
})

test('session info: a title in any of the projection shapes, and nothing without the services', async () => {
  assert.equal(root.titleOf({ projections: { values: { title: 'A' } } }), 'A')
  assert.equal(root.titleOf({ projections: { values: { title: { title: 'B' } } } }), 'B')
  assert.equal(root.titleOf({ title: 'C' }), 'C')
  assert.equal(root.titleOf({}), undefined)
  assert.deepEqual(await root.sessionInfo({ get: () => undefined }, 's'), {})
  assert.deepEqual(await root.sessionInfo({ get: name => name === 'workspaceRegistry' ? { list: () => [{ title: 'W', sessionIds: ['s'] }] } : undefined }, 's'), { workspace: 'W' })
})
