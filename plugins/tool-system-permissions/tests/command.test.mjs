// /system-permissions: status, remove (the exact tccutil argv, this server host only), add (a seek due
// in the panel at once), through the root row with the fake prober.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as root from '../index.js'
import { ADD_JUSTIFICATION, automationClasses, COMMAND_NAME, createCommand, resetClasses, statusWord, textTable } from '../command.mjs'
import { fakeCtx } from './fake-ctx.mjs'
import { until } from './helpers.mjs'

function setup(states = {}, subject) {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-tool-system-permissions-test-'))
  const stateFile = join(dir, 'state.json')
  const write = (s, sub = subject) => writeFileSync(stateFile, JSON.stringify({ states: s, ...sub ? { subject: sub } : {} }))
  write(states)
  const host = fakeCtx()
  root.apply(host, { fakeStateFile: stateFile, recordFile: join(dir, 'calls.json'), platform: 'darwin' })
  const command = host.registeredCommands.get(COMMAND_NAME)
  const run = (rawInput, commandId = 'cmd-1') => command.handler({ commandId, agent: { id: 'session-1', session: { id: 'session-1' } }, rawInput, attachments: [], signal: new AbortController().signal })
  return { host, command, run, write, prober: host.get('deepseaSystemPermissions').prober, cleanup: () => { host.dispose(); rmSync(dir, { recursive: true, force: true }) } }
}

test('the root row registers /system-permissions with its hint', () => {
  const { command, cleanup } = setup()
  try {
    assert.equal(command.name, 'system-permissions')
    assert.deepEqual(command.input, { hint: '[status | add | remove]' })
  } finally { cleanup() }
})

test('status (also bare): every class in four words, System Events always, other targets only when they say something', async () => {
  const { run, cleanup } = setup({
    ...Object.fromEntries(automationClasses().map(c => [c.id, 'not-running'])),
    'screen-recording': 'granted', accessibility: 'denied', microphone: 'stale', camera: 'not-determined',
    'full-disk-access': 'not-granted', 'automation:com.apple.Safari': 'granted', 'automation:com.apple.finder': 'not-running',
  })
  try {
    const result = await run(' status ')
    assert.equal(result.kind, 'success')
    assert.equal(result.text, [
      'DeepSea Test Server (io.github.taliesinb.deepsea.test.server)',
      '',
      'permission                         status',
      '---------------------------------  -----------',
      'screen-recording                   granted',
      'accessibility                      denied',
      'microphone                         stale',
      'camera                             not asked',
      'input-monitoring                   not asked',
      'full-disk-access                   denied',
      'automation:com.apple.systemevents  not running',
      'automation:com.apple.Safari        granted',
    ].join('\n'))
    assert.equal((await run('')).text, result.text)
  } finally { cleanup() }
})

test('remove: the seven services, exactly /usr/bin/tccutil reset <Service> <this server host>, recorded by the fake', async () => {
  const { run, prober, cleanup } = setup()
  try {
    const result = await run('remove')
    assert.equal(result.kind, 'success')
    const argv = prober.events.filter(e => e.kind === 'reset').map(e => e.command)
    assert.deepEqual(argv, ['ScreenCapture', 'Accessibility', 'Microphone', 'Camera', 'ListenEvent', 'SystemPolicyAllFiles', 'AppleEvents']
      .map(service => ['/usr/bin/tccutil', 'reset', service, 'io.github.taliesinb.deepsea.test.server']))
    assert.match(result.text, /^Removed: every privacy grant and row of DeepSea Test Server \(io\.github\.taliesinb\.deepsea\.test\.server\), with \/usr\/bin\/tccutil reset <Service> io\.github\.taliesinb\.deepsea\.test\.server\./)
    assert.match(result.text, /\nScreenCapture {9}reset\n/)
    assert.deepEqual(resetClasses().map(c => c.service.replace('kTCCService', '')), ['ScreenCapture', 'Accessibility', 'Microphone', 'Camera', 'ListenEvent', 'SystemPolicyAllFiles', 'AppleEvents'])
  } finally { cleanup() }
})

test('remove refuses any app that is not a DeepSea server host, and reports tccutil failures', async () => {
  const { run, prober, cleanup } = setup({}, { name: 'Terminal', bundleId: 'com.apple.Terminal' })
  try {
    const refused = await run('remove')
    assert.equal(refused.kind, 'error')
    assert.match(refused.text, /^Not removed: this server runs under com\.apple\.Terminal, not a DeepSea server host/)
    assert.equal(prober.events.length, 0)
  } finally { cleanup() }
  const failing = createCommand({ platform: 'darwin', registry: undefined, prober: {
    probe: async () => ({ subject: { name: 'S', bundleId: 'io.github.taliesinb.deepsea.rebase.server' }, results: {} }),
    resetStale: async cls => cls.id === 'camera' ? { ok: false, error: 'tccutil: Failed to reset Camera\nmore' } : { ok: true },
  } })
  const result = await failing.handler({ rawInput: 'remove', commandId: 'c', agent: {} })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^Removed with 1 failure:/)
  assert.match(result.text, /\nCamera +failed: tccutil: Failed to reset Camera\n/)
})

test('add: a seek for every class and System Events, justified by the command, due in the panel at once; the reply names the call', async () => {
  const { host, run, write, cleanup } = setup({ accessibility: 'granted' })
  try {
    const before = Date.now()
    const result = await run('add', 'cmd-7')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /^Asking for 7 permissions: screen-recording, accessibility, microphone, camera, input-monitoring, full-disk-access, automation:com\.apple\.systemevents\.\ncall: command-cmd-7$/)
    const registry = host.get('deepseaSystemPermissions').registry
    await until(() => registry.get('command-cmd-7')?.snapshot.rows[2].state === 'pending')
    const entry = registry.get('command-cmd-7')
    assert.deepEqual(entry.sessionIds, ['session-1'])
    assert.ok(entry.snapshot.rows.every(r => r.justification === ADD_JUSTIFICATION))
    assert.ok(entry.snapshot.noticeAt >= before && entry.snapshot.noticeAt <= Date.now(), 'due at once')
    const list = await (await host.routes.get(root.RUNNING_PATH).fetch(new Request(`http://x${root.RUNNING_PATH}`))).json()
    assert.deepEqual(list.calls.map(c => [c.callId, c.sessionId, c.open]), [['command-cmd-7', 'session-1', 6]])
    write(Object.fromEntries(['screen-recording', 'accessibility', 'microphone', 'camera', 'input-monitoring', 'full-disk-access', 'automation:com.apple.systemevents'].map(id => [id, 'granted'])))
    await until(() => registry.get('command-cmd-7').running === false, 5000)
    assert.ok(registry.get('command-cmd-7').snapshot.rows.every(r => r.state === 'granted'))
  } finally { cleanup() }
})

test('unknown subcommands, other platforms; the words and the table', async () => {
  const { run, cleanup } = setup()
  try {
    assert.deepEqual(await run('grant'), { kind: 'error', text: 'Unknown subcommand "grant". Usage: /system-permissions [status | add | remove]' })
  } finally { cleanup() }
  if (process.platform !== 'darwin') {
    const off = createCommand({ prober: {}, registry: {} })
    assert.match((await off.handler({ rawInput: '' })).text, /Not applicable/)
  }
  assert.deepEqual(['granted', 'denied', 'not-granted', 'stale', 'not-determined', 'unknown', 'not-running', 'unavailable', 'restricted'].map(statusWord),
    ['granted', 'denied', 'denied', 'stale', 'not asked', 'not asked', 'not running', 'not installed', 'restricted'])
  assert.equal(textTable(['a', 'bb'], [['ccc', 'd']]), 'a    bb\n---  --\nccc  d')
})
