/**
 * Renamed plugins (lib/renames.mjs) and the home migration that follows them
 * (lib/migrate-home.mjs), against fake homes in $TMPDIR. The old names here
 * are the migration's inputs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsd-migrate-test-'))
process.env.DEEPSEA_ROOT = join(root, 'deepsea')
process.env.DEEPSEA_LOG_ROOT = join(root, 'logs')
process.env.DEEPSEA_EXTRAS = join(root, 'no-extras')
test.after(() => rmSync(root, { recursive: true, force: true }))

const { PLUGIN_RENAMES, currentName, currentPackage, currentRowId, currentStatePath, formerName, isPlugin } = await import('../lib/renames.mjs')
const { migrateHome, migrationSummary } = await import('../lib/migrate-home.mjs')
const { allPlugins, selectPlugins } = await import('../lib/plugins.mjs')
const { normalizeMap } = await import('../lib/adopt-map.mjs')

const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
const read = (...parts) => readFileSync(join(...parts), 'utf8')

/** Every file under a directory with a hash of its content. */
function snapshot(dir) {
  const out = {}
  const visit = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = join(rel, entry.name)
      if (entry.isDirectory()) visit(path)
      else out[path] = `${createHash('sha256').update(readFileSync(join(dir, path))).digest('hex')} ${statSync(join(dir, path)).mtimeMs}`
    }
  }
  visit('')
  return out
}

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

/** A home from before the rename: plugin state, patch rows of every form, variant.yml, adopted.json. */
function oldHome(name) {
  const home = join(root, name)
  put(join(home, 'plugins', 'billing', 'sessions', 's1.jsonl'), '{"kind":"start"}\n')
  put(join(home, 'plugins', 'remote-workspaces', 'workspaces.json'), '{"servers":[]}')
  put(join(home, 'plugins', 'tailscale', 'state.json'), '{"old":true}')
  put(join(home, 'plugins', 'host-tailscale', 'state.json'), '{"new":true}')
  put(join(home, 'plugins', 'session-move', 'x.json'), '{}')
  put(join(home, 'plugins', 'third-party', 'y.json'), '{}')
  put(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '# This profile\'s own patch layer.',
    '- id: deepsea-billing   # the composer pill',
    '  config:',
    '    pill: true',
    '- id: "deepsea-tailscale"',
    '  config: { identityOperators: true }',
    "- id: 'deepsea-wait'",
    '  disabled: true',
    '- id: deepsea-billing-extra',
    '  disabled: true',
    '- id: session-title-llm',
    '  config:',
    '    id: deepsea-reboot',
    '- insert:',
    '    - id: deepsea-ask',
    '      name: "@deepsea/ask"',
    '',
  ].join('\n'))
  put(join(home, 'profiles', 'cli', 'cordis.patch.yml'), '- id: deepsea-fs-tools\n  disabled: true\n')
  put(join(home, 'cordis.patch.yml'), '- id: deepsea-login\n  config: {}\n')
  put(join(home, 'variant.yml'), '# DeepSea Lab: written by dsd\nid: lab\nports: 3210\nplugins: "billing,tailscale,session-move"\nsource: integration/base\n')
  put(join(home, 'adopted.json'), JSON.stringify({
    sources: {
      '/old/home': {
        files: { 'plugins/billing/sessions/s1.jsonl': { size: 17 }, 'plugins/tailscale/state.json': { size: 12 }, 'session-move-backups/a': { size: 1 } },
        rows: { 'id:deepsea-billing': '- id: deepsea-billing\n  config:\n    pill: true\n', 'id:session-title-llm': '- id: session-title-llm\n' },
        sessions: {},
      },
    },
    runs: [],
  }, null, 2))
  return home
}

test('migrateHome: state directories, patch rows (comments and quoting kept), the plugin list and adopt\'s record; then nothing', () => {
  const home = oldHome('lab')
  const report = migrateHome(home)
  assert.equal(report.changed, true)
  assert.deepEqual(report.plugins, [{ from: 'plugins/billing', to: 'plugins/llm-billing' }, { from: 'plugins/remote-workspaces', to: 'plugins/workspace-remote' }])
  assert.deepEqual(report.conflicts, [{ from: 'plugins/tailscale', to: 'plugins/host-tailscale', why: 'both exist: both left as they are' }])
  assert.equal(read(home, 'plugins', 'llm-billing', 'sessions', 's1.jsonl'), '{"kind":"start"}\n')
  assert.equal(existsSync(join(home, 'plugins', 'billing')), false)
  assert.equal(read(home, 'plugins', 'tailscale', 'state.json'), '{"old":true}', 'both kept')
  assert.equal(read(home, 'plugins', 'host-tailscale', 'state.json'), '{"new":true}')
  assert.ok(existsSync(join(home, 'plugins', 'session-move', 'x.json')) && existsSync(join(home, 'plugins', 'third-party', 'y.json')))

  assert.equal(read(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '# This profile\'s own patch layer.',
    '- id: deepsea-llm-billing   # the composer pill',
    '  config:',
    '    pill: true',
    '- id: "deepsea-host-tailscale"',
    '  config: { identityOperators: true }',
    "- id: 'deepsea-tool-wait'",
    '  disabled: true',
    '- id: deepsea-billing-extra',
    '  disabled: true',
    '- id: session-title-llm',
    '  config:',
    '    id: deepsea-command-reboot',
    '- insert:',
    '    - id: deepsea-command-ask',
    '      name: "@deepsea/command-ask"',
    '',
  ].join('\n'))
  assert.equal(read(home, 'profiles', 'cli', 'cordis.patch.yml'), '- id: deepsea-tool-fs-batch\n  disabled: true\n')
  assert.equal(read(home, 'cordis.patch.yml'), '- id: deepsea-llm-sign-in\n  config: {}\n')
  assert.deepEqual(report.rows.map(r => `${r.file}:${r.line} ${r.from} → ${r.to}`), [
    'cordis.patch.yml:1 deepsea-login → deepsea-llm-sign-in',
    'profiles/cli/cordis.patch.yml:1 deepsea-fs-tools → deepsea-tool-fs-batch',
    'profiles/web/cordis.patch.yml:2 deepsea-billing → deepsea-llm-billing',
    'profiles/web/cordis.patch.yml:5 deepsea-tailscale → deepsea-host-tailscale',
    'profiles/web/cordis.patch.yml:7 deepsea-wait → deepsea-tool-wait',
    'profiles/web/cordis.patch.yml:13 deepsea-reboot → deepsea-command-reboot',
    'profiles/web/cordis.patch.yml:15 deepsea-ask → deepsea-command-ask',
    'profiles/web/cordis.patch.yml:16 @deepsea/ask → @deepsea/command-ask',
  ])

  assert.match(read(home, 'variant.yml'), /^plugins: "llm-billing,host-tailscale,session-move"$/m)
  assert.match(read(home, 'variant.yml'), /^# DeepSea Lab: written by dsd\nid: lab\n/)
  assert.deepEqual(report.variant, { plugins: { from: 'billing,tailscale,session-move', to: 'llm-billing,host-tailscale,session-move' } })

  // adopt's record follows the moved files and the renamed rows; tailscale's stayed, and so does its record.
  const adopted = JSON.parse(read(home, 'adopted.json')).sources['/old/home']
  assert.deepEqual(Object.keys(adopted.files), ['plugins/llm-billing/sessions/s1.jsonl', 'plugins/tailscale/state.json', 'session-move-backups/a'])
  assert.deepEqual(adopted.rows, { 'id:deepsea-llm-billing': '- id: deepsea-llm-billing\n  config:\n    pill: true\n', 'id:session-title-llm': '- id: session-title-llm\n' })
  assert.deepEqual(report.adopted, { files: 1, rows: 1 })

  const before = snapshot(home)
  const again = migrateHome(home)
  assert.equal(again.changed, false)
  assert.deepEqual([again.plugins, again.rows, again.variant, again.adopted], [[], [], undefined, undefined])
  assert.equal(again.conflicts.length, 1, 'the pair that needs a person stays reported')
  assert.deepEqual(snapshot(home), before, 'a second run touches nothing')
  assert.deepEqual(migrationSummary(again), { conflicts: again.conflicts })
})

test('migrateHome --dry-run reports the same and touches nothing', () => {
  const home = oldHome('dry')
  const before = snapshot(home)
  const dry = migrateHome(home, { dryRun: true })
  assert.deepEqual(snapshot(home), before)
  const real = migrateHome(home)
  assert.deepEqual({ ...dry, dryRun: false }, real)
  assert.equal(migrationSummary(dry).dryRun, true)
})

test('migrateHome: a plugin still installed under its old name (an older build) keeps its state and rows', () => {
  const home = oldHome('older')
  put(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { '@deepsea/billing': 'link:/builds/x/plugins/billing' }, dsh: { profile: { bundles: ['@deepsea/billing'] } } }))
  put(join(home, 'profiles', 'web', 'deepsea-bundles.json'), JSON.stringify({ bundles: ['@deepsea/billing', '@deepsea/server-log'] }))
  const report = migrateHome(home)
  assert.ok(existsSync(join(home, 'plugins', 'billing', 'sessions', 's1.jsonl')))
  assert.ok(!existsSync(join(home, 'plugins', 'llm-billing')))
  assert.match(read(home, 'profiles', 'web', 'cordis.patch.yml'), /^- id: deepsea-billing {3}# the composer pill$/m)
  assert.match(read(home, 'profiles', 'web', 'cordis.patch.yml'), /^- id: "deepsea-host-tailscale"$/m, 'the others move')
  const waiting = report.waiting.find(w => w.plugin === 'billing')
  assert.deepEqual(waiting.keeps, ['plugins/billing', 'profiles/web/cordis.patch.yml:2 deepsea-billing'])
  assert.equal(waiting.now, 'llm-billing')
  assert.ok(JSON.parse(read(home, 'adopted.json')).sources['/old/home'].files['plugins/billing/sessions/s1.jsonl'], 'its record stays with it')
  assert.deepEqual(JSON.parse(read(home, 'profiles', 'web', 'deepsea-bundles.json')).bundles, ['@deepsea/billing', '@deepsea/server-log'], 'the record of what is installed stays')
  // Once the new build is installed (the old package gone), the rest follows.
  put(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { '@deepsea/llm-billing': 'link:/builds/y/plugins/llm-billing' } }))
  put(join(home, 'profiles', 'web', 'deepsea-bundles.json'), JSON.stringify({ bundles: ['@deepsea/llm-billing'] }))
  const later = migrateHome(home)
  assert.deepEqual(later.plugins, [{ from: 'plugins/billing', to: 'plugins/llm-billing' }])
  assert.deepEqual(later.waiting, [])
  assert.match(read(home, 'profiles', 'web', 'cordis.patch.yml'), /^- id: deepsea-llm-billing {3}# the composer pill$/m)
})

test('migrateHome: no home, an empty home, a list of all', () => {
  assert.equal(migrateHome(join(root, 'none')).changed, false)
  const home = join(root, 'empty')
  put(join(home, 'variant.yml'), 'id: empty\nplugins: all\n')
  const report = migrateHome(home)
  assert.equal(report.changed, false)
  assert.equal(migrationSummary(report), undefined)
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

test('adopt map: DeepSea names from before a rename are read as the new ones', () => {
  const map = normalizeMap({
    packages: { 'old-pkg': { plugin: 'billing', rows: ['old-row'] }, 'gone-pkg': { plugin: null, rows: [] } },
    settings: { 'old-section': { row: 'deepsea-tailscale', keys: ['k'] }, note: 'a note' },
    entries: [
      { name: 'billing', tree: 'plugins/billing', what: 'store' },
      { name: 'brand', tree: 'plugins/brand-kit/profiles', files: { 'state.json': 'plugins/brand-kit/state.json' }, what: 'brand' },
      { name: 'r.json', file: 'plugins/remote-workspaces/workspaces.json', what: 'servers' },
      { name: 'other', tree: 'other-place', what: 'third party' },
    ],
  })
  assert.equal(map.packages['old-pkg'].plugin, 'llm-billing')
  assert.equal(map.packages['gone-pkg'].plugin, null)
  assert.equal(map.rows['old-row'], 'old-pkg')
  assert.deepEqual(map.settings, { 'old-section': { row: 'deepsea-host-tailscale', keys: ['k'] }, note: 'a note' })
  const own = map.entries.slice(-4)
  assert.deepEqual(own.map(e => e.tree ?? e.file), ['plugins/llm-billing', 'plugins/ui-brand-kit/profiles', 'plugins/workspace-remote/workspaces.json', 'other-place'])
  assert.deepEqual(own[1].files, { 'state.json': 'plugins/ui-brand-kit/state.json' })
})
