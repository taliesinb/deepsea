/**
 * Generated agent presets: the rows of DeepSea plugins that declare
 * `"deepsea": { "presets": { "joinWith": [<module>, …] } }` in package.json
 * (plugins/AGENTS.md → Presets) join the harness's agent presets, so they
 * list under Settings → Built-in plugins → Session plugins, the way
 * upstream's own tool rows do ("disabled globally, enabled in presets").
 *
 * The harness has no patch operation that adds a row to a preset: a later
 * layer can only replace a preset row's whole `config`. So dsd writes that
 * replacement itself, each time it installs a variant's plugins: it composes
 * the profile's bundle layers as the server will (the harness's own
 * profile code, in the variant's harness build), adds the joining rows to
 * every preset that has one of their `joinWith` modules, and writes the
 * result as a bundle of its own, the last one of the profile:
 * `profiles/web/deepsea-generated-presets/` (package
 * `@deepsea/generated-presets`). Upstream's lists are copied fresh each
 * time, so they follow the harness; a plugin taken out of the variant
 * leaves the presets with it.
 *
 * The person's layers win, and dsd stays out of their way:
 * - a preset whose row the person's layers give a `config` (the Web preset
 *   editor writes the profile's `cordis.patch.yml`; the home's
 *   `cordis.patch.yml` and `--patch` files count too) is not generated; it is
 *   reported under `skipped`;
 * - a joining plugin whose own row those layers give `disabled` (turned off,
 *   or turned on as a global plugin) joins no preset and keeps its row as
 *   they set it, reported under `global`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DsdError } from './util.mjs'

/** The generated bundle: its package and its directory in the profile. */
export const GENERATED_BUNDLE = '@deepsea/generated-presets'
export const GENERATED_DIR = 'deepsea-generated-presets'
/** The module of an agent preset declaration row. */
export const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'

/**
 * A plugin's preset declaration, normalized: the modules it joins with, or
 * undefined when it declares none.
 * @param {{ pkg: object }} plugin
 * @returns {string[] | undefined}
 */
export function joinRule(plugin) {
  const rule = plugin.pkg?.deepsea?.presets
  if (rule === undefined) return undefined
  const joinWith = typeof rule.joinWith === 'string' ? [rule.joinWith] : rule.joinWith
  if (!Array.isArray(joinWith) || joinWith.length === 0 || !joinWith.every(m => typeof m === 'string' && m)) {
    throw new DsdError(`${plugin.pkg.name}: deepsea.presets.joinWith must name one module or a list of modules`)
  }
  return joinWith
}

const isExpression = value => value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string'
/** A row is off only when `disabled` is literally true; an expression may enable it. */
const isOff = row => row.disabled === true

/** Whether a row, or a row inside it (a group), is an enabled row of one of the modules. */
function holds(row, modules) {
  if (isOff(row)) return false
  if (modules.includes(row.name)) return true
  return Boolean(row.group) && Array.isArray(row.config) && row.config.some(child => holds(child, modules))
}

/**
 * What the person's own layers set on a row (non-insert patch rows only): the
 * last `config` and the last `disabled`, each with the file it came from.
 * @param {{ file: string, patches: object[] }[]} userLayers - in application order.
 * @param {string} id - the row id.
 * @returns {{ config?: { file: string, value: unknown }, disabled?: { file: string, value: unknown } }}
 */
function userSettings(userLayers, id) {
  const found = {}
  for (const { file, patches } of userLayers) {
    for (const patch of patches ?? []) {
      if (patch?.insert !== undefined || patch?.id !== id) continue
      if (Object.hasOwn(patch, 'config')) found.config = { file, value: patch.config }
      if (Object.hasOwn(patch, 'disabled')) found.disabled = { file, value: patch.disabled }
    }
  }
  return found
}

/**
 * Plan the generated layer. Pure: no files, no harness.
 * @param {object} input
 * @param {object[]} input.rows - the profile's top-level rows composed from its bundle layers (the generated one left out).
 * @param {{ file: string, patches: object[] }[]} input.userLayers - the person's layers in order: the profile's patch, the home's, `--patch` files.
 * @param {{ name: string, pkg: object }[]} input.plugins - the variant's plugins, in load order.
 * @returns {{ patches: object[], joined: Record<string, string[]>, skipped: Record<string, string>, global: Record<string, string> }}
 *   `patches`: the layer's rows (empty: no layer); `joined`: preset id → the rows added;
 *   `skipped`: preset id → why it was left as composed; `global`: row id → why that plugin joined nothing.
 */
export function planPresets({ rows, userLayers, plugins }) {
  const joiners = []
  const global = {}
  for (const plugin of plugins) {
    const joinWith = joinRule(plugin)
    if (joinWith === undefined) continue
    // The plugin's own rows: those its bundle patch inserted under its package name.
    for (const row of rows.filter(r => r.name === plugin.pkg.name)) {
      const own = userSettings(userLayers, row.id)
      if (own.disabled !== undefined) { global[row.id] = `disabled: ${JSON.stringify(own.disabled.value)} in ${own.disabled.file}`; continue }
      if (isOff(row)) { global[row.id] = 'disabled by its bundle'; continue }
      const joined = structuredClone(row)
      if (joined.disabled === false || joined.disabled === null) delete joined.disabled
      // A config the person's layers give the row (a `--patch` file, an edit made while it was
      // global) goes with it into the presets.
      if (own.config !== undefined) joined.config = structuredClone(own.config.value)
      joiners.push({ row: joined, joinWith })
    }
  }
  const patches = []
  const joined = {}
  const skipped = {}
  const used = new Set()
  if (joiners.length > 0) {
    for (const preset of rows.filter(r => r.name === PRESET_MODULE && !isOff(r))) {
      const config = preset.config ?? {}
      const list = Array.isArray(config.plugins) ? config.plugins : []
      const presetId = config.id ?? preset.id
      const present = new Set(list.flatMap(function ids(r) { return [r.id, r.name, ...(r.group && Array.isArray(r.config) ? r.config.flatMap(ids) : [])] }))
      const adding = joiners.filter(j => !present.has(j.row.id) && !present.has(j.row.name) && list.some(r => holds(r, j.joinWith)))
      if (adding.length === 0) continue
      const edited = userSettings(userLayers, preset.id).config
      if (edited !== undefined) { skipped[presetId] = `edited in ${edited.file}`; continue }
      // Each joining row goes after the top-level row holding its first anchor, after rows
      // joined there before it (variant order): a position that does not move as rows are added.
      const next = [...list]
      for (const joiner of adding) {
        let at = list.findIndex(r => holds(r, joiner.joinWith))
        const anchor = list[at]
        at = next.indexOf(anchor) + 1
        while (at < next.length && adding.some(j => j.row === next[at])) at++
        next.splice(at, 0, joiner.row)
        used.add(joiner.row.id)
      }
      joined[presetId] = adding.map(j => j.row.id)
      patches.push({ id: preset.id, name: preset.name, config: { ...structuredClone(config), plugins: structuredClone(next) } })
    }
  }
  // A plugin is disabled globally only where it joined a preset ("via presets"); one that joined
  // none (no anchor anywhere, every such preset edited) stays a global plugin.
  for (const joiner of joiners) {
    if (used.has(joiner.row.id)) patches.push({ id: joiner.row.id, name: joiner.row.name, disabled: true })
    else global[joiner.row.id] ??= 'no preset to join'
  }
  return { patches, joined, skipped, global }
}

/** A string YAML reads back as that string when written unquoted (ids, words). */
const plain = s => /^[A-Za-z_][\w.-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s)

/** YAML for patch rows (block style; other strings JSON-quoted, which YAML reads as double-quoted; `!!js` kept). */
export function toYaml(value, indent = '') {
  const scalar = (v) => {
    if (isExpression(v)) return `!!js ${JSON.stringify(v.__jsExpr)}`
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'string') return plain(v) ? v : JSON.stringify(v)
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (Array.isArray(v) && v.length === 0) return '[]'
    if (typeof v === 'object' && Object.keys(v).length === 0) return '{}'
    return undefined
  }
  const key = k => /^[A-Za-z_][\w-]*$/.test(k) ? k : JSON.stringify(k)
  const lines = []
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = scalar(item)
      if (s !== undefined) { lines.push(`${indent}- ${s}`); continue }
      const inner = toYaml(item, `${indent}  `).split('\n')
      lines.push(`${indent}- ${inner[0].slice(indent.length + 2)}`, ...inner.slice(1))
    }
  } else {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      const s = scalar(v)
      if (s !== undefined) lines.push(`${indent}${key(k)}: ${s}`)
      else lines.push(`${indent}${key(k)}:`, toYaml(v, Array.isArray(v) ? indent : `${indent}  `))
    }
  }
  return lines.join('\n')
}

/**
 * The profile as the server composes it, from the harness build's own profile
 * code: the top-level rows of every bundle layer but the generated one, and
 * the person's layers (the profile's patch, the home's, `--patch` files) as
 * parsed patch lists.
 */
function composeProfile(profileDir, home, harnessBuild, extraPatches) {
  const input = { dir: profileDir, anchor: join(harnessBuild, 'apps', 'cli', 'package.json'), generated: GENERATED_BUNDLE, user: [join(profileDir, 'cordis.patch.yml'), join(home, 'cordis.patch.yml'), ...extraPatches] }
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e',
    `import { existsSync } from 'node:fs'
import { composeEntries, loadProfileDirectory } from './packages/boot/app-boot/src/profile.ts'
import { loadOverlayPatches } from './packages/boot/app-boot/src/index.ts'
const input = ${JSON.stringify(input)}
const profile = loadProfileDirectory('dsd', input.dir, input.anchor, { userLayer: false })
const rows = composeEntries(profile.layers.filter(l => l.packageName !== input.generated).map(l => l.patches))
const userLayers = input.user.filter(f => existsSync(f)).map(file => ({ file, patches: loadOverlayPatches('dsd', file) }))
process.stdout.write(JSON.stringify({ rows, userLayers, skippedBundles: profile.skippedBundles }))`],
  { cwd: harnessBuild, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new DsdError(`composing the profile in ${profileDir} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`)
  return JSON.parse(result.stdout)
}

const HEADER = `# Generated by dsd (tools/dsd/lib/presets.mjs) each time it installs this
# variant's plugins, and rewritten then: do not edit. DeepSea plugins that
# declare deepsea.presets join the agent presets below (upstream's lists, as
# composed from the bundles before this one), and their own rows are disabled
# globally. A preset edited in the Web preset editor (the profile's own
# cordis.patch.yml) is left out of this file, and that edit wins.
`

/**
 * Write (or remove) the profile's generated preset layer for the plugins just
 * installed. Called by installBundles after the plugins' bundles are in place
 * and the generated bundle is out of the manifest.
 * @param {object} options
 * @param {object[]} options.plugins - the variant's plugins, in load order.
 * @param {string} options.profileDir - the web profile.
 * @param {string} options.home - the variant's home.
 * @param {string} options.harnessBuild - the harness build the variant runs.
 * @param {string[]} [options.patches] - the `--patch` files the server will get.
 * @returns {{ bundle?: string, layer?: string, joined: object, skipped: object, global: object } | undefined}
 *   undefined when no plugin declares presets (and no layer is left).
 */
export function writePresetLayer({ plugins, profileDir, home, harnessBuild, patches = [] }) {
  const dir = join(profileDir, GENERATED_DIR)
  const link = join(profileDir, 'node_modules', ...GENERATED_BUNDLE.split('/'))
  const remove = () => { rmSync(link, { force: true }); rmSync(dir, { recursive: true, force: true }) }
  if (!plugins.some(p => joinRule(p) !== undefined)) { remove(); return undefined }
  const composed = composeProfile(profileDir, home, harnessBuild, patches)
  const plan = planPresets({ rows: composed.rows, userLayers: composed.userLayers.map(l => ({ ...l, file: shortPath(l.file, home) })), plugins })
  const report = { joined: plan.joined, skipped: plan.skipped, global: plan.global }
  if (plan.patches.length === 0) { remove(); return report }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: GENERATED_BUNDLE, version: '0.0.0', private: true,
    description: 'Agent presets with the DeepSea plugins that join them, generated by dsd (tools/dsd/lib/presets.mjs) at each plugin install.',
    exports: { './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml', './locale/*.json': './locale/*.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`)
  // The Plugins list shows the bundle by this title (the harness reads `locale/<lang>.json`).
  mkdirSync(join(dir, 'locale'), { recursive: true })
  writeFileSync(join(dir, 'locale', 'en.json'), `${JSON.stringify({ meta: { title: 'Generated presets', description: 'Agent presets with the DeepSea plugins that join them, rewritten by dsd at each install.' } }, null, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), `${HEADER}${toYaml(plan.patches)}\n`)
  mkdirSync(join(link, '..'), { recursive: true })
  rmSync(link, { recursive: true, force: true })
  symlinkSync(dir, link)
  return { bundle: GENERATED_BUNDLE, layer: join(dir, 'cordis.patch.yml'), ...report }
}

/** A path inside the home as `<home>/…`-relative, else as it is. */
function shortPath(file, home) {
  const rel = relative(home, file)
  return rel.startsWith('..') ? file : rel
}

/** Whether a profile has the generated layer (for tests and reports). */
export const hasPresetLayer = profileDir => existsSync(join(profileDir, GENERATED_DIR, 'cordis.patch.yml'))
