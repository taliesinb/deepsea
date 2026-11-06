import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DEEPSEA_ROOT = mkdtempSync(join(tmpdir(), 'dsd-presets-root-'))
const { planPresets, toYaml, GENERATED_BUNDLE, GENERATED_DIR } = await import('../lib/presets.mjs')

const preset = (id, plugins, extra = {}) => ({ id: `preset-${id}`, name: '@deepseek-ai/dsh-agent-preset', config: { id, order: 1, plugins }, ...extra })
const row = (id, name = `@deepseek-ai/dsh-${id}`, extra = {}) => ({ id, name, ...extra })
const plugin = (name, joinWith) => ({ name, pkg: { name: `@deepsea/${name}`, ...(joinWith ? { deepsea: { presets: { joinWith } } } : {}) } })
const ids = list => list.map(r => r.id)

/** rc.1's presets in miniature: standard has everything, minimal a read-only tool-fs, minimal-no-tools no tool at all. */
function rows() {
  return [
    row('tool-fs', undefined, { disabled: true }),
    preset('standard', [row('persona'), row('tool-bash', undefined, { disabled: { __jsExpr: "process.platform === 'win32'" } }), row('tool-fs'), row('tool-fs-search'),
      { id: 'delegation', name: 'cordis:group', group: true, config: [row('tool-subagent')] }, row('tool-ask-user'), row('tool-web'), row('present')]),
    preset('minimal', [row('persona'), row('tool-fs', undefined, { config: { read: false } })]),
    { id: 'deepsea-preset-minimal-no-tools', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'minimal-no-tools', plugins: [row('persona'), row('deepsea-preset-chat-only', '@deepsea/preset-chat-only')] } },
    row('deepsea-tool-fs-batch', '@deepsea/tool-fs-batch'),
    row('deepsea-tool-dash-docsets', '@deepsea/tool-dash-docsets', { config: { maxChars: 9000 } }),
    row('deepsea-tool-rename-chat', '@deepsea/tool-rename-chat'),
    row('deepsea-tool-wait', '@deepsea/tool-wait'),
  ]
}
const plugins = [
  plugin('tool-wait'),
  plugin('tool-fs-batch', '@deepseek-ai/dsh-tool-fs-search'),
  plugin('tool-dash-docsets', ['@deepseek-ai/dsh-tool-web']),
  plugin('tool-rename-chat', '@deepseek-ai/dsh-tool-ask-user'),
  plugin('preset-chat-only'),
]

test('presets: joining rows go after their anchor, globals are disabled, tool-free presets stay so', () => {
  const plan = planPresets({ rows: rows(), userLayers: [], plugins })
  assert.deepEqual(plan.joined, { standard: ['deepsea-tool-fs-batch', 'deepsea-tool-dash-docsets', 'deepsea-tool-rename-chat'] })
  assert.deepEqual(plan.skipped, {})
  assert.deepEqual(plan.global, {})
  const [standard, ...globals] = plan.patches
  assert.equal(standard.id, 'preset-standard')
  assert.equal(standard.name, '@deepseek-ai/dsh-agent-preset')
  assert.deepEqual(ids(standard.config.plugins), ['persona', 'tool-bash', 'tool-fs', 'tool-fs-search', 'deepsea-tool-fs-batch', 'delegation',
    'tool-ask-user', 'deepsea-tool-rename-chat', 'tool-web', 'deepsea-tool-dash-docsets', 'present'])
  // The row as its bundle declares it, config included; the expression on an upstream row is kept.
  assert.deepEqual(standard.config.plugins.find(r => r.id === 'deepsea-tool-dash-docsets'), row('deepsea-tool-dash-docsets', '@deepsea/tool-dash-docsets', { config: { maxChars: 9000 } }))
  assert.deepEqual(standard.config.plugins[1].disabled, { __jsExpr: "process.platform === 'win32'" })
  assert.equal(standard.config.order, 1)
  assert.deepEqual(globals, [
    { id: 'deepsea-tool-fs-batch', name: '@deepsea/tool-fs-batch', disabled: true },
    { id: 'deepsea-tool-dash-docsets', name: '@deepsea/tool-dash-docsets', disabled: true },
    { id: 'deepsea-tool-rename-chat', name: '@deepsea/tool-rename-chat', disabled: true },
  ])
  // minimal has tool-fs but no fs-search: nothing joins it; minimal-no-tools has no tool row at all.
  assert.ok(!plan.patches.some(p => p.id === 'preset-minimal' || p.id === 'deepsea-preset-minimal-no-tools'))
  // An anchor inside a group counts; the row goes after the group.
  const toolX = [plugin('tool-x', '@deepseek-ai/dsh-tool-subagent')]
  assert.deepEqual(planPresets({ rows: rows(), userLayers: [], plugins: toolX }), { patches: [], joined: {}, skipped: {}, global: {} }, 'no row of tool-x installed: nothing to join')
  const withX = [...rows(), row('deepsea-tool-x', '@deepsea/tool-x')]
  assert.deepEqual(ids(planPresets({ rows: withX, userLayers: [], plugins: toolX }).patches[0].config.plugins).slice(3, 6), ['tool-fs-search', 'delegation', 'deepsea-tool-x'])
})

test('presets: the same input gives the same layer; a plugin taken out leaves the presets', () => {
  const once = planPresets({ rows: rows(), userLayers: [], plugins })
  assert.deepEqual(planPresets({ rows: rows(), userLayers: [], plugins }), once)
  assert.equal(toYaml(planPresets({ rows: rows(), userLayers: [], plugins }).patches), toYaml(once.patches))
  const fewer = planPresets({ rows: rows().filter(r => r.id !== 'deepsea-tool-rename-chat'), userLayers: [], plugins: plugins.filter(p => p.name !== 'tool-rename-chat') })
  assert.ok(!ids(fewer.patches[0].config.plugins).includes('deepsea-tool-rename-chat'))
  assert.ok(!fewer.patches.some(p => p.id === 'deepsea-tool-rename-chat'))
  // No declaring plugin: no layer.
  assert.deepEqual(planPresets({ rows: rows(), userLayers: [], plugins: [plugin('tool-wait')] }).patches, [])
  // A preset that already has the row (shipped with it) is left alone.
  const shipped = rows()
  shipped[1].config.plugins.push(row('deepsea-tool-fs-batch', '@deepsea/tool-fs-batch'))
  assert.deepEqual(planPresets({ rows: shipped, userLayers: [], plugins: [plugins[1]] }).joined, {})
})

test('presets: the person\'s edits win: an edited preset is skipped, a row they set disabled stays global', () => {
  const userLayers = [
    { file: 'profiles/web/cordis.patch.yml', patches: [{ id: 'preset-standard', config: { id: 'standard', plugins: [row('persona')] } }, { id: 'deepsea-tool-rename-chat', disabled: false }] },
    { file: 'extra.patch.yml', patches: [{ id: 'deepsea-tool-fs-batch', config: { readLimit: 100 } }] },
  ]
  const twoPresets = [...rows(), preset('ptc', [row('tool-fs-search'), row('tool-web')])]
  const plan = planPresets({ rows: twoPresets, userLayers, plugins })
  assert.deepEqual(plan.skipped, { standard: 'edited in profiles/web/cordis.patch.yml' })
  assert.deepEqual(plan.global, { 'deepsea-tool-rename-chat': 'disabled: false in profiles/web/cordis.patch.yml' })
  assert.deepEqual(plan.joined, { ptc: ['deepsea-tool-fs-batch', 'deepsea-tool-dash-docsets'] })
  assert.ok(!plan.patches.some(p => p.id === 'preset-standard' || p.id === 'deepsea-tool-rename-chat'))
  // A config the person's layers give the row goes with it.
  assert.deepEqual(plan.patches[0].config.plugins.find(r => r.id === 'deepsea-tool-fs-batch').config, { readLimit: 100 })
  // Joined nowhere (its only preset edited): it stays a global plugin.
  const onlyStandard = planPresets({ rows: rows(), userLayers, plugins })
  assert.deepEqual(onlyStandard.patches, [])
  assert.deepEqual(onlyStandard.global['deepsea-tool-fs-batch'], 'no preset to join')
})

test('presets: a malformed declaration is refused', () => {
  assert.throws(() => planPresets({ rows: rows(), userLayers: [], plugins: [{ name: 'bad', pkg: { name: '@deepsea/bad', deepsea: { presets: { joinWith: [] } } } }] }), /joinWith/)
})

const { REPO } = await import('../lib/paths.mjs')
const harness = existsSync(join(REPO, 'harness')) ? realpathSync(join(REPO, 'harness')) : undefined

test('presets: the generated bundle, read back by the harness: last in the profile, rewritten, gone with its plugins', { skip: harness === undefined && 'no harness link' }, async () => {
  const { installBundles } = await import('../lib/plugins.mjs')
  const root = mkdtempSync(join(tmpdir(), 'dsd-presets-'))
  try {
    const fake = (name, joinWith) => {
      const dir = join(root, 'plugins', name)
      mkdirSync(dir, { recursive: true })
      const pkg = { name: `@deepsea/${name}`, type: 'module', exports: { '.': './index.js', './package.json': './package.json' }, dsh: { bundle: { patch: './cordis.patch.yml' } }, ...(joinWith ? { deepsea: { presets: { joinWith } } } : {}) }
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
      writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: deepsea-${name}\n      name: "@deepsea/${name}"\n      config: { note: "a \\"quoted\\" value", word: "yes", number: "1.5", id: plain-word, at: "@x/y" }\n`)
      return { name, dir, pkg }
    }
    const home = join(root, 'home')
    const profile = join(home, 'profiles', 'web')
    const alpha = fake('alpha', '@deepseek-ai/dsh-tool-fs-search')
    const plain = fake('plain')
    const first = installBundles([plain, alpha], home, harness)
    const manifest = () => JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    assert.equal(manifest().dsh.profile.bundles.at(-1), GENERATED_BUNDLE)
    assert.equal(manifest().dependencies[GENERATED_BUNDLE], `link:./${GENERATED_DIR}`)
    assert.ok(lstatSync(join(profile, 'node_modules', '@deepsea', 'generated-presets')).isSymbolicLink())
    assert.deepEqual(Object.keys(first.presets.joined).sort(), ['cordis', 'ptc', 'standard'])
    // What the server composes from the profile, with the harness's own parser and patch code.
    const composed = compose(profile, home)
    const standard = composed.find(r => r.id === 'preset-standard').config.plugins
    const at = standard.findIndex(r => r.id === 'tool-fs-search')
    assert.deepEqual(standard[at + 1], { id: 'deepsea-alpha', name: '@deepsea/alpha', config: { note: 'a "quoted" value', word: 'yes', number: '1.5', id: 'plain-word', at: '@x/y' } })
    assert.deepEqual(standard.find(r => r.id === 'tool-bash').disabled, { __jsExpr: "process.platform === 'win32'" })
    assert.ok(standard.find(r => r.id === 'planning').config[0].config.section.includes('\n'), 'multi-line text survives')
    assert.equal(composed.find(r => r.id === 'deepsea-alpha').disabled, true)
    assert.equal(composed.find(r => r.id === 'deepsea-plain').disabled, undefined)
    assert.ok(!composed.find(r => r.id === 'preset-minimal').config.plugins.some(r => r.id === 'deepsea-alpha'))
    // Idempotent: the same install writes the same file.
    const layer = readFileSync(join(profile, GENERATED_DIR, 'cordis.patch.yml'), 'utf8')
    installBundles([plain, alpha], home, harness)
    assert.equal(readFileSync(join(profile, GENERATED_DIR, 'cordis.patch.yml'), 'utf8'), layer)
    assert.equal(manifest().dsh.profile.bundles.filter(b => b === GENERATED_BUNDLE).length, 1)
    // A preset the person edited (the Web preset editor writes the profile's patch) is left to them.
    writeFileSync(join(profile, 'cordis.patch.yml'), `- id: preset-ptc\n  name: "@deepseek-ai/dsh-agent-preset"\n  config:\n    id: ptc\n    plugins: []\n`)
    const edited = installBundles([plain, alpha], home, harness)
    assert.deepEqual(edited.presets.skipped, { ptc: 'edited in profiles/web/cordis.patch.yml' })
    assert.ok(!readFileSync(join(profile, GENERATED_DIR, 'cordis.patch.yml'), 'utf8').includes('id: preset-ptc'))
    // The plugin taken out: no layer, nothing of it left.
    const gone = installBundles([plain], home, harness)
    assert.equal(gone.presets, undefined)
    assert.ok(!manifest().dsh.profile.bundles.includes(GENERATED_BUNDLE))
    assert.equal(manifest().dependencies[GENERATED_BUNDLE], undefined)
    assert.equal(existsSync(join(profile, GENERATED_DIR)), false)
    assert.equal(existsSync(join(profile, 'node_modules', '@deepsea', 'generated-presets')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

/** The profile's composed top-level rows, every layer included, as the harness composes them. */
function compose(profile, home) {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e',
    `import { composeEntries, loadProfileDirectory } from './packages/boot/app-boot/src/profile.ts'
const p = loadProfileDirectory('test', ${JSON.stringify(profile)}, ${JSON.stringify(join(harness, 'apps', 'cli', 'package.json'))})
if (p.skippedBundles.length) throw new Error(JSON.stringify(p.skippedBundles))
process.stdout.write(JSON.stringify(composeEntries([...p.layers.map(l => l.patches), p.patches])))`], { cwd: harness, encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
