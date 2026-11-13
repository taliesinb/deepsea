// The real prober without running anything: its commands, the probe
// script's output, tccd's log (msgID join, stale entries), triggers and panes;
// and the fake prober's state file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROBE_SCRIPT, RESETTABLE_SUBJECT, createMacProber, parseTccLog, refineResults, resetCommand, tccPredicate, tccutilService } from '../macos.mjs'
import { createFakeProber } from '../fake.mjs'
import { parsePermissions } from '../permissions.mjs'
import { until } from './helpers.mjs'

const event = (eventMessage) => JSON.stringify({ eventMessage, processImagePath: '/System/Library/PrivateFrameworks/TCC.framework/Support/tccd' })
const LOG = [
  event('REQUEST: tccd_uid=0, sender_pid=4242, sender_uid=501, function=TCCAccessRequest, msgID=4242.1'),
  event('AUTHREQ_CTX: msgID=4242.1, function=<private>, service=kTCCServiceScreenCapture, preflight=yes, query=1'),
  event('AUTHREQ_RESULT: msgID=4242.1, authValue=0, authReason=4, authVersion=1, desired_auth=0, error=(null),'),
  event('AUTHREQ_CTX: msgID=4242.2, function=<private>, service=kTCCServiceAccessibility, preflight=yes, query=1'),
  event('AUTHREQ_RESULT: msgID=4242.2, authValue=1, authReason=5, authVersion=1, desired_auth=0, error=(null),'),
  event('AUTHREQ_CTX: msgID=999.1, function=<private>, service=kTCCServiceCamera, preflight=yes, query=1'),
  event('AUTHREQ_RESULT: msgID=999.1, authValue=2, authReason=4, authVersion=1, desired_auth=0, error=(null),'),
  event('Failed to match existing code requirement for subject io.example.server and service kTCCServiceMicrophone\n\tcdhash H"aa"\n\tcdhash H"bb"'),
  event('Failed to match existing code requirement for subject io.example.other and service kTCCServiceCamera\n\tcdhash H"aa"\n\tcdhash H"bb"'),
  'Filtering the log data using "process == tccd"',
  '{ not json',
].join('\n')

test('tccd log: authValues joined to services by the probe\'s own msgIDs, stale entries of its subject only', () => {
  const parsed = parseTccLog(LOG, { pid: 4242, bundleId: 'io.example.server' })
  assert.deepEqual(parsed.authValues, { kTCCServiceScreenCapture: 0, kTCCServiceAccessibility: 1 })
  assert.deepEqual([...parsed.stale], ['kTCCServiceMicrophone'])
})

test('refinement: a bare "not granted" becomes denied or not-determined, stale wins over every no, never over granted', () => {
  const classes = parsePermissions(['screen-recording', 'accessibility', 'microphone', 'camera'])
  const refined = refineResults(
    { 'screen-recording': { status: 'not-granted' }, accessibility: { status: 'not-granted' }, microphone: { status: 'not-determined', code: 0 }, camera: { status: 'granted' } },
    classes,
    { authValues: { kTCCServiceScreenCapture: 0, kTCCServiceAccessibility: 1 }, stale: new Set(['kTCCServiceMicrophone', 'kTCCServiceCamera']) },
  )
  assert.deepEqual(Object.fromEntries(Object.entries(refined).map(([k, v]) => [k, v.status])), { 'screen-recording': 'denied', accessibility: 'not-determined', microphone: 'stale', camera: 'granted' })
  const unchanged = refineResults({ 'screen-recording': { status: 'not-granted' } }, classes.slice(0, 1), { authValues: { kTCCServiceScreenCapture: 2 }, stale: new Set() })
  assert.equal(unchanged['screen-recording'].status, 'not-granted', 'tccd saying allowed does not overrule a preflight that said no')
})

test('the log predicate names the probe and the subject', () => {
  assert.equal(tccPredicate(4242, 'io.example.server'), 'process == "tccd" AND (eventMessage CONTAINS "msgID=4242." OR eventMessage BEGINSWITH "Failed to match existing code requirement for subject io.example.server ")')
  assert.equal(tccPredicate(1), 'process == "tccd" AND (eventMessage CONTAINS "msgID=1.")')
})

function fakeExec(answers) {
  const calls = []
  const exec = async (file, args) => {
    calls.push([file, ...args])
    const answer = answers(file, args)
    if (answer instanceof Error) throw answer
    return answer ?? ''
  }
  return { exec, calls }
}

test('probe: one fresh osascript per probe, refined from the log only when asked and something is missing', async () => {
  const probeOut = JSON.stringify({ pid: 4242, subject: { pid: 1, app: '/A/Server.app', bundleId: 'io.example.server', name: 'Server' }, results: { 'screen-recording': { status: 'not-granted' }, accessibility: { status: 'not-granted' } } })
  const { exec, calls } = fakeExec(file => file === 'osascript' ? probeOut : file === 'log' ? LOG : '')
  const prober = createMacProber({ exec })
  const classes = parsePermissions(['screen-recording', 'accessibility', 'camera'])
  const plain = await prober.probe(classes)
  assert.deepEqual(calls[0], ['osascript', '-l', 'JavaScript', PROBE_SCRIPT, 'probe', 'screen-recording', 'accessibility', 'camera'])
  assert.equal(calls.length, 1)
  assert.equal(plain.results.camera.status, 'unknown', 'a class the script did not answer is unknown')
  const refined = await prober.probe(classes, { refine: true })
  assert.equal(calls[2][0], 'log')
  assert.deepEqual(calls[2].slice(1, 6), ['show', '--last', '2s', '--style', 'ndjson'])
  assert.equal(calls[2][7], tccPredicate(4242, 'io.example.server'))
  assert.equal(refined.results['screen-recording'].status, 'denied')
  assert.equal(refined.results.accessibility.status, 'not-determined')
  assert.equal(refined.subject.name, 'Server')
})

test('probe: an unreadable log only warns', async () => {
  const warnings = []
  const { exec } = fakeExec(file => file === 'osascript' ? JSON.stringify({ pid: 1, subject: {}, results: { camera: { status: 'denied' } } }) : new Error('log: not permitted'))
  const prober = createMacProber({ exec, logger: { warn: m => warnings.push(m) } })
  const answer = await prober.probe(parsePermissions(['camera']), { refine: true })
  assert.equal(answer.results.camera.status, 'denied')
  assert.match(warnings[0], /reading tccd's log failed: log: not permitted/)
})

function fakeSpawn() {
  const children = []
  const spawn = (file, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.exitCode = null
    child.killed = false
    child.kill = () => { child.killed = true; child.exitCode = 0 }
    children.push({ file, args, child })
    return child
  }
  return { spawn, children }
}

test('trigger: a child kept alive for the asynchronous prompts, killed on stop; a stopped Automation trigger never starts', async () => {
  const { exec, calls } = fakeExec(() => '')
  const { spawn, children } = fakeSpawn()
  const prober = createMacProber({ exec, spawn })
  const [mic] = parsePermissions(['microphone'])
  const handle = prober.trigger(mic, { status: 'not-determined' })
  assert.deepEqual([children[0].file, ...children[0].args], ['osascript', '-l', 'JavaScript', PROBE_SCRIPT, 'trigger', 'microphone', '600'])
  handle.stop()
  assert.equal(children[0].child.killed, true)

  const [events] = parsePermissions(['automation:system-events'])
  const launched = prober.trigger(events, { status: 'not-running' })
  await until(() => children.length === 2)
  assert.deepEqual(calls[0], ['open', '-g', '-j', '-b', 'com.apple.systemevents'])
  assert.deepEqual(children[1].args.slice(3), ['trigger', 'automation:com.apple.systemevents', '600'])
  launched.stop()

  const early = prober.trigger(events, { status: 'not-running' })
  early.stop()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(children.length, 2, 'stopped before the launch finished: no prompt')
})

test('openPane: the pane URL only (no Finder window for Full Disk Access: its row is listed already)', async () => {
  const { exec, calls } = fakeExec(() => '')
  const prober = createMacProber({ exec })
  const [screen, fda] = parsePermissions(['screen-recording', 'full-disk-access'])
  await prober.openPane(screen, { subject: { app: '/A/Server.app' } })
  await prober.openPane(fda, { subject: { app: '/A/Server.app' } })
  assert.deepEqual(calls, [
    ['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'],
    ['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'],
  ])
})

test('the fake prober reads its state file at every probe and only records triggers and panes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-tool-system-permissions-test-'))
  try {
    const file = join(dir, 'state.json')
    const prober = createFakeProber(file)
    const classes = parsePermissions(['screen-recording', 'camera'])
    let answer = await prober.probe(classes)
    assert.deepEqual(Object.values(answer.results).map(r => r.status), ['not-determined', 'not-determined'], 'no file: nothing granted')
    assert.equal(answer.subject.name, 'DeepSea Test Server')
    writeFileSync(file, JSON.stringify({ subject: { name: 'Other' }, states: { 'screen-recording': 'granted', camera: 'nonsense' } }))
    answer = await prober.probe(classes)
    assert.deepEqual(Object.values(answer.results).map(r => r.status), ['granted', 'not-determined'])
    assert.equal(answer.subject.name, 'Other')
    prober.trigger(classes[1]).stop()
    await prober.openPane(classes[1])
    assert.deepEqual(prober.events.map(e => [e.kind, e.id, e.url]), [['trigger', 'camera', undefined], ['open', 'camera', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera']])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reset command: one service, the server host\'s bundle id only, tccutil\'s own service names', () => {
  const server = { bundleId: 'io.github.taliesinb.deepsea.release.server' }
  const names = Object.fromEntries(parsePermissions(['screen-recording', 'accessibility', 'microphone', 'camera', 'input-monitoring', 'full-disk-access', 'automation:finder'])
    .map(cls => [cls.id, resetCommand(cls, server)]))
  assert.deepEqual(names, {
    'screen-recording': ['/usr/bin/tccutil', 'reset', 'ScreenCapture', 'io.github.taliesinb.deepsea.release.server'],
    accessibility: ['/usr/bin/tccutil', 'reset', 'Accessibility', 'io.github.taliesinb.deepsea.release.server'],
    microphone: ['/usr/bin/tccutil', 'reset', 'Microphone', 'io.github.taliesinb.deepsea.release.server'],
    camera: ['/usr/bin/tccutil', 'reset', 'Camera', 'io.github.taliesinb.deepsea.release.server'],
    'input-monitoring': ['/usr/bin/tccutil', 'reset', 'ListenEvent', 'io.github.taliesinb.deepsea.release.server'],
    'full-disk-access': ['/usr/bin/tccutil', 'reset', 'SystemPolicyAllFiles', 'io.github.taliesinb.deepsea.release.server'],
    'automation:com.apple.finder': ['/usr/bin/tccutil', 'reset', 'AppleEvents', 'io.github.taliesinb.deepsea.release.server'],
  })
  const [camera] = parsePermissions(['camera'])
  assert.ok(RESETTABLE_SUBJECT.test('io.github.taliesinb.deepsea.personal-3f9a1c.server'))
  for (const bundleId of [undefined, '', 'com.apple.Terminal', 'io.github.taliesinb.deepsea.release', 'io.github.taliesinb.deepsea', 'io.github.taliesinb.deepsea.release.server.evil', 'x.io.github.taliesinb.deepsea.release.server']) {
    assert.equal(resetCommand(camera, { bundleId }), undefined, String(bundleId))
  }
  assert.equal(resetCommand({ service: 'kTCCServiceAll' }, server), undefined, 'never a blanket reset')
  assert.equal(tccutilService('kTCCServiceScreenCapture'), 'ScreenCapture')
})

test('resetStale runs exactly that command (here: a fake exec), and refuses any other app', async () => {
  const { exec, calls } = fakeExec(() => '')
  const prober = createMacProber({ exec })
  const [mic] = parsePermissions(['microphone'])
  assert.deepEqual(await prober.resetStale(mic, { subject: { bundleId: 'io.github.taliesinb.deepsea.rebase.server' } }),
    { ok: true, command: ['/usr/bin/tccutil', 'reset', 'Microphone', 'io.github.taliesinb.deepsea.rebase.server'] })
  assert.deepEqual(calls, [['/usr/bin/tccutil', 'reset', 'Microphone', 'io.github.taliesinb.deepsea.rebase.server']])
  const refused = await prober.resetStale(mic, { subject: { bundleId: 'com.apple.Terminal' } })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /not a DeepSea server host: com.apple.Terminal/)
  assert.equal(calls.length, 1, 'nothing run for another app')
  const failing = createMacProber({ exec: async () => { throw new Error('tccutil: exit 1') }, logger: { warn() {} } })
  const failed = await failing.resetStale(mic, { subject: { bundleId: 'io.github.taliesinb.deepsea.release.server' } })
  assert.deepEqual([failed.ok, failed.error], [false, 'tccutil: exit 1'])
})

test('the fake prober records the reset it would run, and a stale class then reads as not-determined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-tool-system-permissions-test-'))
  try {
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({ states: { microphone: 'stale' } }))
    const prober = createFakeProber(file)
    const [mic] = parsePermissions(['microphone'])
    const { subject } = await prober.probe([mic])
    assert.equal((await prober.probe([mic])).results.microphone.status, 'stale')
    const result = await prober.resetStale(mic, { subject })
    assert.deepEqual(result.command, ['/usr/bin/tccutil', 'reset', 'Microphone', 'io.github.taliesinb.deepsea.test.server'])
    assert.deepEqual(prober.events.map(e => [e.kind, e.id, e.command]), [['reset', 'microphone', result.command]])
    assert.equal((await prober.probe([mic])).results.microphone.status, 'not-determined')
    writeFileSync(file, JSON.stringify({ states: { microphone: 'granted' } }))
    assert.equal((await prober.probe([mic])).results.microphone.status, 'granted')
    writeFileSync(file, JSON.stringify({ states: { microphone: 'stale' } }))
    assert.equal((await prober.probe([mic])).results.microphone.status, 'stale', 'stale again only after the file changed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
