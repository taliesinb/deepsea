/**
 * Renamed plugins (lib/renames.mjs), against fake builds in $TMPDIR. The old
 * names here are the table's inputs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsd-migrate-test-'))
process.env.DEEPSEA_ROOT = join(root, 'deepsea')
process.env.DEEPSEA_LOG_ROOT = join(root, 'logs')
process.env.DEEPSEA_EXTRAS = join(root, 'no-extras')
test.after(() => rmSync(root, { recursive: true, force: true }))

const { PLUGIN_RENAMES, currentName, currentPackage, currentRowId, currentStatePath, formerName, isPlugin } = await import('../lib/renames.mjs')
const { allPlugins, selectPlugins } = await import('../lib/plugins.mjs')

const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }

test('renames: one new name per old one, none of them an old name; this checkout has only current names', () => {
  const olds = Object.keys(PLUGIN_RENAMES)
  const news = Object.values(PLUGIN_RENAMES)
  assert.equal(olds.length, 32)
  assert.equal(new Set(news).size, news.length)
  for (const name of news) assert.equal(PLUGIN_RENAMES[name], undefined, `${name} is new and old`)
  for (const name of allPlugins()) assert.equal(currentName(name), name, `plugins/${name} has an old name`)
  assert.equal(currentName('test-driver'), 'dev-test-driver')
  assert.equal(currentName('session-move'), 'session-move')
  assert.equal(formerName('host-tailscale'), 'tailscale')
  assert.equal(formerName('session-move'), undefined)
  assert.ok(isPlugin('server-log', 'host-server-log') && isPlugin('host-server-log', 'host-server-log') && !isPlugin('alpha', 'host-server-log'))
  assert.equal(currentRowId('deepsea-billing'), 'deepsea-llm-billing')
  assert.equal(currentRowId('deepsea-billing-extra'), 'deepsea-billing-extra')
  assert.equal(currentRowId('session-title-llm'), 'session-title-llm')
  assert.equal(currentPackage('@deepsea/login'), '@deepsea/llm-sign-in')
  assert.equal(currentPackage('@deepseek-ai/login'), '@deepseek-ai/login')
  assert.equal(currentStatePath('plugins/brand-kit/profiles'), 'plugins/ui-brand-kit/profiles')
  assert.equal(currentStatePath('plugins/tailscale'), 'plugins/host-tailscale')
  assert.equal(currentStatePath('session-move-backups'), 'session-move-backups')
})

test('plugins: an old name selects the renamed plugin; an older build\'s plugin answers to its new name', () => {
  assert.equal(selectPlugins('scripted-model')[0].name, 'llm-scripted')
  const build = join(root, 'older-build')
  for (const name of ['test-driver', 'server-log', 'alpha']) put(join(build, 'plugins', name, 'package.json'), JSON.stringify({ name: `@deepsea/${name}` }))
  const [driver, log, alpha] = selectPlugins('dev-test-driver,host-server-log,alpha', build)
  assert.deepEqual([driver.name, driver.dir], ['test-driver', join(build, 'plugins', 'test-driver')])
  assert.deepEqual([log.name, log.dir], ['server-log', join(build, 'plugins', 'server-log')])
  assert.equal(alpha.dir, join(build, 'plugins', 'alpha'))
  // `all` from the older build adds this checkout's plugins it lacks, not its renamed ones twice.
  const all = selectPlugins('all', build).map(p => p.name)
  assert.ok(all.includes('test-driver') && !all.includes('dev-test-driver'))
  assert.ok(all.includes('server-log') && !all.includes('host-server-log'))
  assert.ok(all.includes('llm-scripted'), 'this checkout\'s plugin the build has under no name')
})
