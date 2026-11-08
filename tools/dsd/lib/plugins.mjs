/**
 * Plugins of a variant, from this checkout or a build of a commit
 * (lib/source.mjs): selected by name, prepared (dependencies, browser half),
 * and installed into the variant's web profile as bundles, as `dsh plugin
 * add` installs them, so the server loads each from its own bundle patch and
 * the Plugins panel lists it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { extrasDir, REPO } from './paths.mjs'
import { GENERATED_DIR, writePresetLayer } from './presets.mjs'
import { currentName, formerName } from './renames.mjs'
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
  // (private plugins, never in a build of this one). A renamed plugin answers to its old name
  // too (lib/renames.mjs): in a list written before the rename, and in a build made before it.
  const has = (dir, name) => existsSync(join(pluginsDir(dir), name, 'package.json'))
  const at = (dir, name) => [currentName(name), formerName(currentName(name))].find(n => n && has(dir, n))
  const extras = extrasDir()
  const own = name => root !== REPO && !at(root, name) && at(REPO, name)
  const extra = name => !at(root, name) && !own(name) && at(extras, name)
  const from = (name) => {
    if (own(name)) { note(`plugins/${own(name)} from this checkout (${REPO}): the source build has no such plugin`); return describe(own(name), REPO) }
    if (extra(name)) return describe(extra(name), extras)
    return describe(at(root, name) ?? name, root)
  }
  if (value === 'all') {
    const more = [...(root === REPO ? [] : allPlugins(REPO).filter(own)), ...allPlugins(extras).filter(extra)]
    const picked = [...allPlugins(root).map(name => describe(name, root)), ...more.map(from)]
    if (machineWide) return picked
    const skipped = picked.filter(p => p.machineWide)
    if (skipped.length) note(`leaving out machine-wide plugins (name them to include): ${skipped.map(p => `${p.name} (${p.machineWide})`).join(', ')}`)
    return picked.filter(p => !p.machineWide)
  }
  return String(value).split(',').map(s => s.trim()).filter(Boolean).map((name) => {
    if (currentName(name) !== name) note(`plugins/${name} is plugins/${currentName(name)} now`)
    return from(name)
  })
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

/** Files a process loads as code: Node addons and shared libraries. */
const LOADABLE = /\.(?:node|dylib|dll)$|\.so(?:\.\d+)*$/

/** Whether a package directory ships loadable native code (a few levels down, not in its own node_modules). */
function shipsNative(dir, depth = 3) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return false }
  return entries.some(entry => entry.isDirectory()
    ? depth > 0 && entry.name !== 'node_modules' && shipsNative(join(dir, entry.name), depth - 1)
    : LOADABLE.test(entry.name))
}

/**
 * The packages a pnpm store (`node_modules/.pnpm`) holds: `{ name, version, dir }`
 * each, the package's own directory in its entry (the other names there are
 * links to its dependencies). `prefix` keeps only entries starting with it.
 */
function storePackages(store, prefix = '') {
  if (!existsSync(store)) return []
  const out = []
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith(prefix) || entry === 'node_modules' || entry === 'lock.yaml') continue
    const modules = join(store, entry, 'node_modules')
    let names
    try { names = readdirSync(modules) } catch { continue }
    const candidates = names.flatMap(n => n.startsWith('@') ? (() => { try { return readdirSync(join(modules, n)).map(s => `${n}/${s}`) } catch { return [] } })() : [n])
    for (const name of candidates) {
      const dir = join(modules, name)
      if (!lstatSync(dir).isDirectory()) continue
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        out.push({ name: pkg.name ?? name, version: pkg.version, dir })
      } catch { /* not a package */ }
    }
  }
  return out
}

/**
 * Native packages a plugin installed copies of its own of while the harness
 * ships the same package too: each copy would load into the one server
 * process (on macOS, two libvips copies make objc report every class twice;
 * undefined behaviour). A plugin should take such a dependency from the
 * harness, as a `link:` into the harness package that owns it
 * (plugins/AGENTS.md). Same version or not: two paths are two copies.
 * @returns {{ name: string, plugin: string, harness: string[] }[]}
 */
export function duplicateNatives(pluginDir, harnessBuild) {
  const harnessStore = join(harnessBuild, 'node_modules', '.pnpm')
  const hits = []
  for (const own of storePackages(join(pluginDir, 'node_modules', '.pnpm'))) {
    if (!shipsNative(own.dir)) continue
    const theirs = storePackages(harnessStore, `${own.name.replace('/', '+')}@`).filter(p => p.name === own.name)
    if (theirs.length) hits.push({ name: own.name, plugin: own.version, harness: [...new Set(theirs.map(p => p.version))].sort() })
  }
  return hits.sort((a, b) => a.name.localeCompare(b.name))
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
 * anything else the person installed stays. Last comes the generated preset
 * layer (lib/presets.mjs), rewritten each time: the presets the plugins
 * join, as a bundle of its own after theirs.
 * @param {object[]} plugins - from selectPlugins, in load order.
 * @param {string} home - the variant's home.
 * @param {string} harnessBuild - the harness build the variant runs.
 * @param {{ patches?: string[] }} [options] - `patches`: the `--patch` files the server will get (they count as the person's layers).
 * @returns {{ profile: string, bundles: string[], presets?: object }} `presets`: what the generated layer holds and what it left out.
 */
export function installBundles(plugins, home, harnessBuild, { patches = [] } = {}) {
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
  const record = owned => writeFileSync(recordPath, `${JSON.stringify({ note: 'packages dsd installed into this profile (tools/dsd/lib/plugins.mjs)', bundles: owned }, null, 2)}\n`)
  record(names)
  for (const plugin of plugins) {
    mkdirSync(dirname(join(dir, 'node_modules', plugin.pkg.name)), { recursive: true })
    const link = join(dir, 'node_modules', plugin.pkg.name)
    rmSync(link, { recursive: true, force: true })
    symlinkSync(plugin.dir, link)
    for (const { name, plugin: own, harness } of duplicateNatives(plugin.dir, harnessBuild)) {
      note(`plugins/${plugin.name} installed its own ${name} ${own}, a native package the harness ships too (${harness.join(', ')}): both copies would load into the server; link the harness's (plugins/AGENTS.md)`)
    }
  }
  // The generated preset layer, composed from the bundles just written (it is out of the manifest now).
  const presets = writePresetLayer({ plugins, profileDir: dir, home, harnessBuild, patches })
  if (presets?.bundle) {
    manifest.dependencies[presets.bundle] = `link:./${GENERATED_DIR}`
    manifest.dsh.profile.bundles.push(presets.bundle)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    record([...names, presets.bundle])
  }
  for (const [preset, why] of Object.entries(presets?.skipped ?? {})) note(`preset ${preset}: left as it is (${why}); the DeepSea plugins that would join it are not in it`)
  return { profile: dir, bundles: names, ...(presets ? { presets: presetSummary(presets) } : {}) }
}

/** The generated layer's report for a command's output. */
function presetSummary({ bundle, layer, ...report }) {
  return { ...(layer ? { layer } : {}), ...report }
}

/** The record of the packages dsd installed into a profile. */
const OWNED_RECORD = 'deepsea-bundles.json'
/** Before that record: the package scope dsd owned. */
const OWNED_SCOPE = '@deepsea/'
