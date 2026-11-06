import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrace, fileStamp, isoLocal, logRoot, openRunLog, pluginLogDirectory, prune, variantLogDirectory, variantOf } from '../index.mjs'

const made = []
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'deepsea-logs-test-')); made.push(dir); return dir }
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

test('time formats: file stamps sort and have no colons; ISO carries the offset', () => {
  const date = new Date(2026, 9, 7, 19, 4, 14, 5)
  assert.equal(fileStamp(date), '2026-10-07T19-04-14')
  assert.match(isoLocal(date), /^2026-10-07T19:04:14[+-]\d\d:\d\d$/)
  assert.match(isoLocal(date, { ms: true }), /^2026-10-07T19:04:14\.005[+-]\d\d:\d\d$/)
})

test('the variant: DEEPSEA_VARIANT, else a home in the DeepSea root, else none', () => {
  assert.equal(variantOf(join(homedir(), '.deepsea', 'personal'), {}), 'personal')
  assert.equal(variantOf(join(homedir(), '.deepsea', 'release-3f9a1c'), {}), 'release-3f9a1c')
  assert.equal(variantOf('/srv/homes/personal', { DEEPSEA_ROOT: '/srv/homes' }), 'personal')
  assert.equal(variantOf(join(homedir(), '.deepsea', 'personal'), { DEEPSEA_ROOT: '/elsewhere' }), undefined)
  assert.equal(variantOf(join(homedir(), '.dsh'), {}), undefined)
  assert.equal(variantOf(join(homedir(), '.deepsea', '_builds'), {}), undefined)
  assert.equal(variantOf('/anything', { DEEPSEA_VARIANT: 'preview' }), 'preview')
  assert.equal(variantOf('/anything', { DEEPSEA_VARIANT: 'Bad Id' }), undefined)
})

test('directories: the variant log directory per platform, or the home\'s own logs', () => {
  assert.equal(logRoot({ DEEPSEA_LOG_ROOT: '/logs' }), '/logs')
  assert.equal(logRoot({}, 'darwin'), join(homedir(), 'Library', 'Logs'))
  assert.equal(logRoot({ XDG_STATE_HOME: '/state' }, 'linux'), '/state')
  const env = { DEEPSEA_LOG_ROOT: '/logs' }
  assert.equal(variantLogDirectory(join(homedir(), '.deepsea', 'personal'), env), '/logs/io.github.taliesinb.deepsea.personal')
  assert.equal(pluginLogDirectory('llm-billing', join(homedir(), '.deepsea', 'personal'), env), '/logs/io.github.taliesinb.deepsea.personal/plugins/llm-billing')
  assert.equal(pluginLogDirectory('llm-billing', '/tmp/some-home', env), '/tmp/some-home/logs/plugins/llm-billing')
})

test('run logs: <ts>-<tag>.log, the identity first, latest follows renames', () => {
  const dir = join(scratch(), 'server')
  const log = openRunLog(dir, { tag: 'pending', identity: 'io.github.taliesinb.deepsea.test server pid 1' })
  assert.match(log.path, /\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-pending\.log$/)
  log.write('second line')
  log.rename(4242)
  log.close()
  assert.match(log.path, /-4242\.log$/)
  assert.equal(readlinkSync(join(dir, 'latest.log')), log.path.split('/').pop())
  const lines = readFileSync(log.path, 'utf8').trimEnd().split('\n')
  assert.match(lines[0], /^\S+ io\.github\.taliesinb\.deepsea\.test server pid 1$/)
  assert.equal(lines[1], 'second line')
})

test('pruning keeps the newest runs and anything recent', () => {
  const dir = scratch()
  const old = Date.now() / 1000 - 30 * 86_400
  for (let i = 0; i < 25; i++) {
    const file = join(dir, `2026-01-${String(i + 1).padStart(2, '0')}T00-00-00-${i}.log`)
    writeFileSync(file, '')
    if (i < 22) utimesSync(file, old, old)
  }
  writeFileSync(join(dir, 'notes.txt'), '')
  prune(dir, { keep: 20 })
  const left = readdirSync(dir)
  assert.equal(left.filter(f => f.endsWith('.log')).length, 20)
  assert.ok(left.includes('notes.txt'))
  assert.ok(!left.includes('2026-01-01T00-00-00-0.log'))
})

test('traces: nothing when disabled; otherwise a start line, then one object per event', () => {
  const home = scratch()
  const off = createTrace({ enabled: false, name: 'x', plugin: '@deepsea/x@0.1.0', home })
  off({ event: 'ignored' })
  assert.equal(off.path, undefined)
  assert.ok(!existsSync(join(home, 'logs')))
  const trace = createTrace({ enabled: true, name: 'x', plugin: '@deepsea/x@0.1.0', home, env: {} })
  trace({ event: 'call', tool: 'list_dir' })
  assert.match(trace.path, new RegExp(`^${home}/logs/plugins/x/\\d{4}-.*-${process.pid}\\.jsonl$`))
  const lines = readFileSync(trace.path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual([lines[0].event, lines[0].pid, lines[0].plugin, lines[0].home], ['start', process.pid, '@deepsea/x@0.1.0', home])
  assert.deepEqual([lines[1].event, lines[1].tool], ['call', 'list_dir'])
  assert.match(lines[1].t, /\.\d{3}[+-]\d\d:\d\d$/)
})
