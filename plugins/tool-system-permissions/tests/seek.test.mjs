// One call's session against a scripted prober: the fast path, Grant and
// Deny, polling, the notice time, cancellation, and the model's text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { parsePermissions } from '../permissions.mjs'
import { createRegistry, createSeek, createSeekTool, formatSeconds, renderResult } from '../seek.mjs'
import { scriptedProber, tick, until } from './helpers.mjs'

const fast = { pollMs: 5, paneDelayMs: 0, noticeMs: 0, refineMs: 0 }
const session = (ids, prober, options = {}) => createSeek({ classes: parsePermissions(ids), prober, ...fast, ...options })
const req = (...ids) => ids.map(permission => ({ permission, justification: 'To test it.' }))
const row = (seek, id) => seek.snapshot().rows.find(r => r.id === id)

test('everything granted: one probe, no prompt, no pane, and the call returns at once', async () => {
  const prober = scriptedProber({ 'screen-recording': 'granted', accessibility: 'granted' })
  const seek = session(['screen-recording', 'accessibility'], prober)
  const value = await seek.run()
  assert.deepEqual(prober.log, ['probe screen-recording,accessibility refine'])
  assert.equal(value.outcome, 'granted')
  assert.deepEqual(value.permissions.map(p => [p.id, p.state, p.already]), [['screen-recording', 'granted', true], ['accessibility', 'granted', true]])
  assert.equal(value.subject.name, 'DeepSea Test Server')
  assert.match(renderResult(value, parsePermissions(['screen-recording', 'accessibility'])), /^All granted already: Screen Recording, Accessibility\. macOS charges your commands to "DeepSea Test Server" \(io\.example\.test\.server\)/)
})

test('missing ones wait as question marks; Grant raises macOS\'s alert, a later Grant opens the pane (and Finder while unlisted), a grant ticks, Deny crosses', async () => {
  const prober = scriptedProber({ accessibility: 'granted', 'screen-recording': 'not-determined', microphone: 'not-determined' })
  const seek = session(['accessibility', 'screen-recording', 'microphone'], prober)
  const running = seek.run()
  await until(() => row(seek, 'screen-recording').state === 'pending')
  assert.deepEqual(seek.snapshot().rows.map(r => r.state), ['granted', 'pending', 'pending'])
  await tick(20)
  assert.equal(prober.log.filter(l => /^(trigger|open|reveal)/.test(l)).length, 0, 'nothing is asked before Grant')
  assert.ok(prober.log.slice(1).every(l => l === 'probe screen-recording,microphone'), 'only the open rows are probed, unrefined while none is granting')

  assert.equal(seek.grant('screen-recording'), true)
  assert.equal(row(seek, 'screen-recording').state, 'granting')
  await until(() => prober.log.includes('trigger screen-recording not-determined'))
  await tick(20)
  assert.deepEqual(prober.log.filter(l => /^(trigger|open|reveal)/.test(l)), ['trigger screen-recording not-determined'], 'the request API alone: its alert lists the app and leads to the pane')
  seek.grant('screen-recording')
  await until(() => prober.log.includes('reveal screen-recording'))
  assert.deepEqual(prober.log.filter(l => /^(trigger|open|reveal)/.test(l)), ['trigger screen-recording not-determined', 'open screen-recording', 'reveal screen-recording'], 'a later Grant: the pane, and Finder while still unlisted; no second alert')
  await until(() => prober.log.includes('probe screen-recording,microphone refine'))

  prober.states['screen-recording'] = 'granted'
  await until(() => row(seek, 'screen-recording').state === 'granted')
  assert.equal(seek.grant('screen-recording'), false, 'a settled row takes no more clicks')

  assert.equal(seek.deny('microphone'), true)
  const value = await running
  assert.equal(value.outcome, 'not-granted')
  assert.deepEqual(value.permissions.map(p => [p.id, p.state]), [['accessibility', 'granted'], ['screen-recording', 'granted'], ['microphone', 'denied']])
  assert.equal(typeof value.permissions[1].waitedSeconds, 'number')
  const text = renderResult(value, parsePermissions(['accessibility', 'screen-recording', 'microphone']))
  assert.match(text, /- Accessibility: granted \(already\)\./)
  assert.match(text, /- Screen Recording: granted \(after \d+ s\)\./)
  assert.match(text, /- Microphone: NOT granted: the user pressed Deny\./)
  assert.match(text, /Not granted: microphone\. Do not try what needs it and do not call seek_system_permission for it again unless the user asks/)
  assert.match(text, /the DeepSea server does not need restarting/)
})

test('per class: Accessibility and Full Disk Access open the pane alone; a listed (switched-off) Screen Recording row gets the pane alone; a never-asked Input Monitoring row gets the alert', async () => {
  const prober = scriptedProber({ accessibility: 'denied', 'full-disk-access': 'not-granted', 'screen-recording': 'denied', 'input-monitoring': 'not-determined' })
  const seek = session(['accessibility', 'full-disk-access', 'screen-recording', 'input-monitoring'], prober)
  const running = seek.run()
  await until(() => row(seek, 'input-monitoring').state === 'pending')
  for (const id of ['accessibility', 'full-disk-access', 'screen-recording', 'input-monitoring']) seek.grant(id)
  await until(() => prober.log.includes('trigger input-monitoring not-determined'))
  await tick(10)
  assert.deepEqual(prober.log.filter(l => /^(trigger|open|reveal)/.test(l)).sort(), [
    'open accessibility', 'open full-disk-access', 'open screen-recording', 'trigger input-monitoring not-determined',
  ], 'no Accessibility alert; no Finder window for listed rows')
  for (const id of ['accessibility', 'full-disk-access', 'screen-recording', 'input-monitoring']) seek.deny(id)
  await running
})

test('Grant on a switched-off row opens the pane without a trigger; a row switched on without Grant ticks too', async () => {
  const prober = scriptedProber({ 'screen-recording': 'denied', camera: 'not-determined' })
  const seek = session(['screen-recording', 'camera'], prober)
  const running = seek.run()
  await until(() => row(seek, 'camera').state === 'pending')
  seek.grant('screen-recording')
  await until(() => prober.log.includes('open screen-recording'))
  assert.equal(prober.log.some(l => l.startsWith('trigger')), false)
  prober.states.camera = 'granted'
  await until(() => row(seek, 'camera').state === 'granted')
  assert.equal(row(seek, 'camera').already, undefined)
  prober.states['screen-recording'] = 'granted'
  assert.equal((await running).outcome, 'granted')
})

test('Grant again on a dialog row re-triggers and opens the pane (the dialog did not come, or was dismissed)', async () => {
  const prober = scriptedProber({ camera: 'not-determined' })
  const seek = session(['camera'], prober)
  const running = seek.run()
  await until(() => row(seek, 'camera').state === 'pending')
  seek.grant('camera')
  await until(() => prober.log.includes('trigger camera not-determined'))
  seek.grant('camera')
  await until(() => prober.log.includes('open camera'))
  assert.deepEqual(prober.log.filter(l => /^(trigger|open|stop|reveal)/.test(l)), ['trigger camera not-determined', 'stop camera', 'trigger camera not-determined', 'open camera'])
  assert.deepEqual([row(seek, 'camera').grants, row(seek, 'camera').opened], [2, 1])
  seek.deny('camera')
  await running
})

test('unattainable permissions are crosses at once; the call does not wait for them', async () => {
  const prober = scriptedProber({ camera: 'restricted', 'automation:com.example.none': 'unavailable', accessibility: 'granted' })
  const seek = session(['camera', 'automation:com.example.none', 'accessibility'], prober)
  const value = await seek.run()
  assert.deepEqual(value.permissions.map(p => p.state), ['unavailable', 'unavailable', 'granted'])
  assert.equal(prober.probes, 1)
  const text = renderResult(value, parsePermissions(['camera', 'automation:com.example.none', 'accessibility']))
  assert.match(text, /- Camera: NOT granted: Camera is restricted by a configuration profile/)
  assert.match(text, /- Automation: com.example.none: NOT granted: com.example.none \(com.example.none\) is not installed/)
})

test('notice: nothing is granted by itself; noticeAt is the last activity plus noticeMs while a row is open, and clicks and changes move it', async () => {
  const prober = scriptedProber({ 'screen-recording': 'not-determined', camera: 'not-determined' })
  const seek = session(['screen-recording', 'camera'], prober, { noticeMs: 60 })
  const running = seek.run()
  await until(() => row(seek, 'camera').state === 'pending')
  const first = seek.snapshot().noticeAt
  assert.equal(typeof first, 'number')
  assert.equal(seek.snapshot().noticeMs, 60)
  await tick(150)
  assert.deepEqual(seek.snapshot().rows.map(r => r.state), ['pending', 'pending'], 'no auto-grant')
  assert.equal(prober.log.some(l => /^(trigger|open)/.test(l)), false)
  assert.equal(seek.snapshot().noticeAt, first, 'unchanged without activity')
  seek.deny('camera')
  assert.ok(seek.snapshot().noticeAt > first, 'a click moves it')
  const afterClick = seek.snapshot().noticeAt
  await tick(20)
  prober.states['screen-recording'] = 'denied'
  await until(() => row(seek, 'screen-recording').status === 'denied')
  assert.ok(seek.snapshot().noticeAt > afterClick, 'a change moves it')
  seek.grant('screen-recording')
  assert.equal(typeof seek.snapshot().noticeAt, 'number', 'still due while a row is being granted')
  seek.deny('screen-recording')
  await running
  assert.equal(seek.snapshot().noticeAt, null)
  const quiet = session(['camera'], scriptedProber({}), { noticeMs: 0 })
  const q = quiet.run()
  await until(() => row(quiet, 'camera').state === 'pending')
  assert.equal(quiet.snapshot().noticeAt, null, 'noticeMs 0: never')
  quiet.deny('camera')
  await q
})

test('cancellation: open rows become cancelled, trigger children are stopped, and the call fails with ABORTED', async () => {
  const prober = scriptedProber({ 'screen-recording': 'not-determined', microphone: 'not-determined', accessibility: 'granted' })
  const controller = new AbortController()
  const seek = session(['accessibility', 'screen-recording', 'microphone'], prober, { signal: controller.signal })
  const running = seek.run()
  await until(() => row(seek, 'screen-recording').state === 'pending')
  seek.grant('microphone')
  await tick(10)
  controller.abort({ reason: 'stop' })
  await assert.rejects(running, (error) => error.code === 'ABORTED' && error.message === 'tool call aborted')
  assert.deepEqual(seek.snapshot().rows.map(r => r.state), ['granted', 'cancelled', 'cancelled'])
  assert.ok(prober.log.includes('stop microphone'))
  assert.equal(typeof seek.snapshot().finishedAt, 'number')
  assert.equal(seek.grant('screen-recording'), false)
})

test('a call cancelled before it starts never probes', async () => {
  const prober = scriptedProber({})
  const controller = new AbortController()
  controller.abort()
  const seek = session(['camera'], prober, { signal: controller.signal })
  await assert.rejects(seek.run(), (error) => error.code === 'ABORTED')
  assert.equal(prober.probes, 0)
})

test('refined statuses do not flicker back to a bare "not granted"; a stale entry stays stale between refinements', async () => {
  const prober = scriptedProber({
    'screen-recording': ({ refine }) => refine ? 'denied' : 'not-granted',
    microphone: ({ refine }) => refine ? 'stale' : 'not-determined',
  })
  const seek = session(['screen-recording', 'microphone'], prober, { refineMs: 1_000_000 })
  const running = seek.run()
  await until(() => prober.probes >= 4)
  assert.equal(row(seek, 'screen-recording').status, 'denied')
  assert.equal(row(seek, 'microphone').status, 'stale')
  seek.deny('screen-recording')
  seek.deny('microphone')
  const value = await running
  assert.match(renderResult(value, parsePermissions(['screen-recording', 'microphone'])), /Microphone: NOT granted: the user pressed Deny\. \(It has a stale entry: System Settings ▸ Privacy & Security ▸ Microphone has a stale "DeepSea Test Server" entry/)
})

test('Grant on a stale row removes the stale entry first, then triggers and opens the pane as for a never-asked one', async () => {
  const prober = scriptedProber({ microphone: 'stale', camera: 'not-determined' })
  prober.resetAnswer = { ok: true, command: ['/usr/bin/tccutil', 'reset', 'Microphone', 'io.example.test.server'] }
  const seek = session(['microphone', 'camera'], prober)
  const running = seek.run()
  await until(() => row(seek, 'microphone').state === 'pending')
  seek.grant('camera')
  await until(() => prober.log.includes('trigger camera not-determined'))
  assert.equal(prober.log.some(l => l.startsWith('reset')), false, 'a row not judged stale is never reset')
  seek.grant('microphone')
  await until(() => prober.log.includes('trigger microphone not-determined'))
  await tick(10)
  assert.deepEqual(prober.log.filter(l => /^(reset|trigger|open) microphone/.test(l)), ['reset microphone', 'trigger microphone not-determined'], 'after the reset it is never-asked: the dialog alone')
  assert.equal(row(seek, 'microphone').status, 'not-determined')
  // tccd's log still shows the pre-reset "Failed to match" line for a few seconds: not news.
  await tick(30)
  assert.equal(row(seek, 'microphone').status, 'not-determined')
  seek.grant('microphone')
  await until(() => prober.log.filter(l => l === 'open microphone').length === 1)
  assert.equal(prober.log.filter(l => l === 'reset microphone').length, 1, 'removed once per call')
  prober.states.microphone = 'granted'
  prober.states.camera = 'granted'
  const value = await running
  assert.deepEqual(value.permissions.map(p => [p.id, p.state, p.staleReset, p.resetCommand]), [
    ['microphone', 'granted', 'removed', '/usr/bin/tccutil reset Microphone io.example.test.server'],
    ['camera', 'granted', undefined, undefined],
  ])
  assert.deepEqual(validateJsonSchemaValue(createSeekTool({ service: () => undefined, fallbackProber: () => prober, settings: () => fast }).output.schema, value, 'value'), [])
  assert.match(renderResult(value, parsePermissions(['microphone', 'camera'])), /- Microphone: granted \(after \d+ s\)\. Removed a stale grant for it first \(`\/usr\/bin\/tccutil reset Microphone io\.example\.test\.server`\)\./)
})

test('a failed reset still asks, and the model is told how the user removes the entry by hand', async () => {
  const prober = scriptedProber({ 'screen-recording': 'stale' })
  prober.resetAnswer = { ok: false, command: ['/usr/bin/tccutil', 'reset', 'ScreenCapture', 'io.example.test.server'], error: 'exit 1' }
  const seek = session(['screen-recording'], prober)
  const running = seek.run()
  await until(() => row(seek, 'screen-recording').state === 'pending')
  seek.grant('screen-recording')
  await until(() => prober.log.includes('open screen-recording'))
  assert.deepEqual(prober.log.filter(l => /^(reset|trigger|open|reveal)/.test(l)), ['reset screen-recording', 'open screen-recording'], 'a stale row is listed: the pane alone')
  assert.equal(row(seek, 'screen-recording').status, 'stale')
  seek.deny('screen-recording')
  const text = renderResult(await running, parsePermissions(['screen-recording']))
  assert.match(text, /Screen Recording: NOT granted: the user pressed Deny\. Could not remove its stale entry \(`\/usr\/bin\/tccutil reset ScreenCapture io\.example\.test\.server` failed\): System Settings ▸ Privacy & Security ▸ Screen & System Audio Recording has a stale/)
  assert.doesNotMatch(text, /It has a stale entry/)
})

test('a failing probe leaves the rows as they were and polling goes on', async () => {
  const prober = scriptedProber({ camera: 'not-determined' })
  const original = prober.probe.bind(prober)
  let failures = 2
  prober.probe = async (...args) => { if (failures-- > 0) throw new Error('osascript failed'); return original(...args) }
  const warnings = []
  const seek = session(['camera'], prober, { logger: { info() {}, warn: m => warnings.push(m) } })
  const running = seek.run()
  await until(() => row(seek, 'camera').state === 'pending')
  prober.states.camera = 'granted'
  assert.equal((await running).outcome, 'granted')
  assert.match(warnings[0], /probe failed: osascript failed/)
})

test('the registry: a running call takes Grant and Deny, a finished one keeps its snapshot (and persists it)', async () => {
  const saved = []
  const registry = createRegistry({ load: () => [{ callId: 'old', sessionIds: ['s'], snapshot: { rows: [] } }], save: entries => saved.push(entries) })
  assert.equal(registry.get('old').running, false)
  const prober = scriptedProber({ camera: 'not-determined' })
  const seek = session(['camera'], prober)
  const tracked = registry.track('call-1', ['s'], seek)
  const running = seek.run()
  await until(() => row(seek, 'camera').state === 'pending')
  assert.equal(registry.get('call-1').running, true)
  assert.equal(registry.act('call-1', 'grant', 'nope'), false)
  assert.equal(registry.act('call-1', 'deny', 'camera'), true)
  await running
  tracked.done()
  assert.equal(registry.get('call-1').running, false)
  assert.equal(registry.get('call-1').snapshot.rows[0].state, 'denied')
  assert.equal(registry.act('call-1', 'grant', 'camera'), false)
  assert.deepEqual(saved.at(-1).map(e => e.callId), ['old', 'call-1'])
})

test('the tool: not applicable off macOS, an unknown name is INVALID_PERMISSION, values match the output schema', async () => {
  const exec = (callId, signal = new AbortController().signal) => ({ callId, agent: { id: 'session-1', session: { id: 'session-1' } }, signal })
  const linux = createSeekTool({ service: () => undefined, fallbackProber: () => { throw new Error('no prober off macOS') }, settings: () => fast, platform: 'linux' })
  const na = await linux.execute({ permissions: req('screen-recording') }, exec('c0'))
  assert.equal(na.outcome, 'not-applicable')
  assert.deepEqual(validateJsonSchemaValue(linux.output.schema, na, 'value'), [])
  assert.match(linux.output.render({ permissions: ['screen-recording'] }, na)[0].text, /^Not applicable: this server runs on linux, not macOS/)
  assert.deepEqual(linux.output.presentationMeta({}, na).deepsea, 'system-permissions')

  const registry = createRegistry()
  const prober = scriptedProber({ accessibility: 'granted', camera: 'not-determined' })
  const mac = createSeekTool({ service: () => ({ prober, registry }), fallbackProber: () => { throw new Error('unused') }, settings: () => fast, platform: 'darwin' })
  await assert.rejects(mac.execute({ permissions: req('telepathy') }, exec('c1')), (error) => error.code === 'INVALID_PERMISSION')
  const running = mac.execute({ permissions: req('accessibility', 'camera') }, exec('c2'))
  await until(() => registry.get('c2')?.snapshot.rows[1].state === 'pending')
  assert.deepEqual(registry.get('c2').sessionIds, ['session-1'])
  registry.act('c2', 'grant', 'camera')
  prober.states.camera = 'granted'
  const value = await running
  assert.deepEqual(validateJsonSchemaValue(mac.output.schema, value, 'value'), [])
  assert.equal(registry.get('c2').running, false)
})

test('durations in the model text', () => {
  assert.equal(formatSeconds(4.4), '4 s')
  assert.equal(formatSeconds(125), '2 min 5 s')
  assert.equal(formatSeconds(3780), '1 h 3 min')
})

test('one dialog: Allow / Don\'t Allow classes are asked by macOS alone; Don\'t Allow is a cross, denied in macOS\'s dialog', async () => {
  const prober = scriptedProber({ microphone: 'not-determined', camera: 'not-determined' })
  const seek = session(['microphone', 'camera'], prober)
  const running = seek.run()
  await until(() => row(seek, 'camera').state === 'pending')
  seek.grant('microphone')
  seek.grant('camera')
  await until(() => prober.log.includes('trigger camera not-determined'))
  await tick(20)
  assert.equal(prober.log.some(l => l.startsWith('open')), false, 'no pane behind macOS\'s dialog')
  prober.states.microphone = 'denied'
  await until(() => row(seek, 'microphone').state === 'denied')
  assert.equal(row(seek, 'microphone').deniedIn, 'prompt')
  prober.states.camera = 'granted'
  const value = await running
  assert.deepEqual(value.permissions.map(p => [p.id, p.state, p.deniedIn]), [['microphone', 'denied', 'prompt'], ['camera', 'granted', undefined]])
  assert.match(renderResult(value, parsePermissions(['microphone', 'camera'])), /- Microphone: NOT granted: the user denied it in macOS's own dialog \(Don't Allow\)\./)
})

test('an Automation target not running: the first Grant only triggers (launch, then macOS\'s dialog); a refusal there is a cross', async () => {
  const prober = scriptedProber({ 'automation:com.apple.systemevents': 'not-running' })
  const seek = session(['automation:system-events'], prober)
  const running = seek.run()
  await until(() => row(seek, 'automation:com.apple.systemevents').state === 'pending')
  seek.grant('automation:com.apple.systemevents')
  await until(() => prober.log.includes('trigger automation:com.apple.systemevents not-running'))
  prober.states['automation:com.apple.systemevents'] = 'not-determined'
  await until(() => row(seek, 'automation:com.apple.systemevents').status === 'not-determined')
  prober.states['automation:com.apple.systemevents'] = 'denied'
  const value = await running
  assert.deepEqual([value.permissions[0].state, value.permissions[0].deniedIn], ['denied', 'prompt'])
  assert.equal(prober.log.some(l => l.startsWith('open')), false)
})

test('Full Disk Access has no dialog: the first Grant opens the pane', async () => {
  const prober = scriptedProber({ 'full-disk-access': 'not-granted' })
  const seek = session(['full-disk-access'], prober)
  const running = seek.run()
  await until(() => row(seek, 'full-disk-access').state === 'pending')
  seek.grant('full-disk-access')
  await until(() => prober.log.includes('open full-disk-access'))
  assert.equal(prober.log.some(l => l.startsWith('trigger')), false)
  seek.deny('full-disk-access')
  await running
})

test('justifications: required, one line, at most 200 characters; carried on the rows, the value and the card\'s meta', async () => {
  const registry = createRegistry()
  const prober = scriptedProber({ 'screen-recording': 'granted', camera: 'granted' })
  const tool = createSeekTool({ service: () => ({ prober, registry }), fallbackProber: () => prober, settings: () => fast, platform: 'darwin' })
  const exec = callId => ({ callId, agent: { id: 's', session: { id: 's' } }, signal: new AbortController().signal })
  const bad = [
    // The harness checks the argument schema first (shape, required keys); the rest is ours.
    [['screen-recording'], /must be an object/],
    [[{ permission: 'screen-recording' }], /justification/],
    [[{ permission: 'screen-recording', justification: '   ' }], /needs a justification/],
    [[{ permission: 'screen-recording', justification: 'To look.\nAnd more.' }], /one sentence on one line/],
    [[{ permission: 'screen-recording', justification: 'x'.repeat(201) }], /is 201 characters; keep it to one sentence of at most 200/],
    [[{ permission: 'telepathy', justification: 'To read minds.' }], /unknown permission "telepathy"/],
    [[], /non-empty list/],
  ]
  for (const [permissions, message] of bad) {
    await assert.rejects(tool.execute({ permissions }, exec('c')), error => (error.code === 'INVALID_PERMISSION' || error.name === 'ToolArgsError') && message.test(error.message), JSON.stringify(permissions))
  }
  const value = await tool.execute({ permissions: [
    { permission: 'screen-recording', justification: '  To take screenshots of the prototype.  ' },
    { permission: 'camera', justification: 'To film the demo.' },
    { permission: 'screen', justification: 'A duplicate: the first one wins.' },
  ] }, exec('c2'))
  assert.deepEqual(value.permissions.map(p => [p.id, p.justification]), [['screen-recording', 'To take screenshots of the prototype.'], ['camera', 'To film the demo.']])
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), [])
  assert.equal(tool.output.presentationMeta({}, value).permissions[0].justification, 'To take screenshots of the prototype.')
  assert.equal(registry.get('c2').snapshot.rows[1].justification, 'To film the demo.')
  assert.match(tool.description, /Give each permission a `justification`: one sentence, shown to the user right next to the permission/)
})
