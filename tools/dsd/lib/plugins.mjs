/**
 * Plugins of a variant, from this checkout or a build of a commit
 * (lib/source.mjs): selected by name, prepared (dependencies, browser half),
 * and installed into the variant's web profile as bundles, as `dsh plugin
 * add` installs them, so the server loads each from its own bundle patch and
 * the Plugins panel lists it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { extrasDir, REPO } from './paths.mjs'
import { DsdError, note, usage } from './util.mjs'

const pluginsDir = (root = REPO) => join(root, 'plugins')

/** A plugin directory's package facts. */
function describe(name, root = REPO) {
  const dir = join(pluginsDir(root), name)
  const file = join(dir, 'package.json')
  if (!existsSync(file)) usage(`no plugin "${name}" in ${pluginsDir(root)}${root === extrasDir() ? '' : ` (or the extras, ${pluginsDir(extrasDir())})`}`)
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  return {
    name, dir, pkg,
    entry: join(dir, pkg.main ?? 'index.js'),
    client: pkg.dsh?.client !== undefined,
    machineWide: pkg.deepsea?.machineWide,
  }
}

/** Every plugin directory of a checkout (default: this one). */
export function allPlugins(root = REPO) {
  if (!existsSync(pluginsDir(root))) return []
  // A plugin directory may be a link (the extras link plugins that live in other repositories).
  return readdirSync(pluginsDir(root), { withFileTypes: true })
    .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && existsSync(join(pluginsDir(root), entry.name, 'package.json')))
    .map(entry => entry.name).sort()
}

/**
 * The plugins a `--plugins` value selects: names, or `all` (which, for a
 * throwaway, leaves machine-wide plugins out; naming one includes it).
 */
export function selectPlugins(value, root = REPO, { machineWide = false } = {}) {
  if (value === undefined || value === true) return []
  // A plugin the source build (`--source`) does not have comes from this checkout (a topic's
  // plugin not integrated yet runs beside the integration), else from the extras repository
  // (private plugins, never in a build of this one).
  const has = (dir, name) => existsSync(join(pluginsDir(dir), name, 'package.json'))
  const extras = extrasDir()
  const own = name => root !== REPO && !has(root, name) && has(REPO, name)
  const extra = name => !has(root, name) && !own(name) && has(extras, name)
  const from = (name) => {
    if (own(name)) { note(`plugins/${name} from this checkout (${REPO}): the source build has no such plugin`); return describe(name, REPO) }
    if (extra(name)) return describe(name, extras)
    return describe(name, root)
  }
  if (value === 'all') {
    const more = [...(root === REPO ? [] : allPlugins(REPO).filter(own)), ...allPlugins(extras).filter(extra)]
    const picked = [...allPlugins(root).map(name => describe(name, root)), ...more.map(from)]
    if (machineWide) return picked
    const skipped = picked.filter(p => p.machineWide)
    if (skipped.length) note(`leaving out machine-wide plugins (name them to include): ${skipped.map(p => `${p.name} (${p.machineWide})`).join(', ')}`)
    return picked.filter(p => !p.machineWide)
  }
  return String(value).split(',').map(s => s.trim()).filter(Boolean).map(from)
}

/** The newest modification time among a plugin's own files (not dependencies, output or tests). */
function newestSource(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'lib', 'tests', '.git'].includes(entry.name)) continue
    const path = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs)
  }
  return newest
}

/** Install a plugin that never was, and build its browser half when missing or older than its sources. */
export function preparePlugin(plugin) {
  const run = (args) => {
    const result = spawnSync('pnpm', args, { cwd: plugin.dir, encoding: 'utf8' })
    if (result.status !== 0) throw new DsdError(`pnpm ${args.join(' ')} in plugins/${plugin.name} failed:\n${(result.stderr || result.stdout).trim().split('\n').slice(-15).join('\n')}`)
  }
  if (!existsSync(join(plugin.dir, 'node_modules'))) { note(`installing plugins/${plugin.name}`); run(['install']) }
  if (plugin.client) {
    const bundle = join(plugin.dir, 'lib', 'client.js')
    const stale = !existsSync(bundle) || statSync(bundle).mtimeMs < newestSource(plugin.dir)
    if (stale) { note(`building plugins/${plugin.name}`); run(['run', 'build']) }
  }
}

/** Where a variant's web profile lives: the harness's profile directory. */
export const profileDirOf = home => join(home, 'profiles', 'web')

/**
 * Install plugins into a variant's web profile as bundles, as `dsh plugin add`
 * would: the profile is set up by the harness itself (its default bundles,
 * pnpm settings; nothing existing is touched), each plugin becomes a `link:`
 * dependency and a `dsh.profile.bundles` entry (in the given order, after the
 * profile's own), with `node_modules/<package>` linked to its directory. The
 * server then loads each from its own bundle patch, and the Plugins panel
 * lists it as an installed bundle, with its card. dsd owns the packages it
 * installed (recorded in the profile's `deepsea-bundles.json`; before that
 * record, the `@deepsea/*` ones): those not selected now are taken out;
 * anything else the person installed stays.
 * @param {object[]} plugins - from selectPlugins, in load order.
 * @param {string} home - the variant's home.
 * @param {string} harnessBuild - the harness build the variant runs.
 */
export function installBundles(plugins, home, harnessBuild) {
  const dir = profileDirOf(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // The harness's own profile setup, with the web profile's default bundles.
  // The templates moved from app-boot to official-bundles in dsh-v0.2.2;
  // older pins (still used by topic worktrees) keep them in app-boot.
  const init = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e',
    `import * as profile from './packages/boot/app-boot/src/profile.ts'
const bundles = await import('./packages/util/official-bundles/src/index.ts').catch(() => ({}))
const templates = bundles.PROFILE_TEMPLATES ?? profile.PROFILE_TEMPLATES
profile.initProfile(${JSON.stringify(dir)}, templates.web.bundles)`],
  { cwd: harnessBuild, encoding: 'utf8' })
  if (init.status !== 0) throw new DsdError(`setting up the profile in ${dir} failed: ${(init.stderr || init.stdout).trim().split('\n').slice(-3).join(' ')}`)
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const recordPath = join(dir, OWNED_RECORD)
  const recorded = existsSync(recordPath) ? new Set(JSON.parse(readFileSync(recordPath, 'utf8')).bundles ?? []) : undefined
  const ours = name => recorded ? recorded.has(name) : name.startsWith(OWNED_SCOPE)
  const names = plugins.map(p => p.pkg.name)
  manifest.dependencies = Object.fromEntries([
    ...Object.entries(manifest.dependencies ?? {}).filter(([name]) => !ours(name)),
    ...plugins.map(p => [p.pkg.name, `link:${p.dir}`]),
  ])
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles = [...(manifest.dsh.profile.bundles ?? []).filter(name => !ours(name)), ...names]
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  // Links of packages dsd installed before and not now (any scope, or none).
  const previous = recorded ? [...recorded] : (existsSync(join(dir, 'node_modules', '@deepsea')) ? readdirSync(join(dir, 'node_modules', '@deepsea')).map(e => `@deepsea/${e}`) : [])
  for (const name of previous) if (!names.includes(name)) rmSync(join(dir, 'node_modules', name), { recursive: true, force: true })
  writeFileSync(recordPath, `${JSON.stringify({ note: 'packages dsd installed into this profile (tools/dsd/lib/plugins.mjs)', bundles: names }, null, 2)}\n`)
  for (const plugin of plugins) {
    mkdirSync(dirname(join(dir, 'node_modules', plugin.pkg.name)), { recursive: true })
    const link = join(dir, 'node_modules', plugin.pkg.name)
    rmSync(link, { recursive: true, force: true })
    symlinkSync(plugin.dir, link)
  }
  return { profile: dir, bundles: names }
}

/** The record of the packages dsd installed into a profile. */
const OWNED_RECORD = 'deepsea-bundles.json'
/** Before that record: the package scope dsd owned. */
const OWNED_SCOPE = '@deepsea/'
