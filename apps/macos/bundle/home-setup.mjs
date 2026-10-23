#!/usr/bin/env node
/**
 * home-setup — run by the bundled DeepSea.app at every launch, with its own
 * Node, before it starts the relay (EmbeddedServer.swift). Makes the variant's
 * home what `dsd new` + `dsd build <v> --install` would have made, so dsd and
 * the bundled app can take the same variant over from each other:
 *
 *   ~/.deepsea/<v>/                 (DEEPSEA_ROOT replaces ~/.deepsea)
 *     variant.yml                   written once: id, display, ports, source: bundle, plugins: all
 *     profiles/web/package.json     the harness's own profile setup, then every bundled plugin as a
 *                                   `link:` dependency and a dsh.profile.bundles entry (installBundles
 *                                   in tools/dsd/lib/plugins.mjs does exactly this); node_modules/<pkg>
 *                                   links into the bundle, re-pointed on every launch (the app may move)
 *     profiles/web/deepsea-bundles.json   the packages this installed (dsd's ownership record)
 *     logs -> ~/Library/Logs/<variant name>/
 *     support -> ~/Library/Application Support/<variant name>/
 *     source -> <the bundle's Resources/deepsea>
 *
 *   node home-setup.mjs --variant <v> --resources <Contents/Resources> [--ports <block>]
 *
 * Prints JSON: { home, ports: { dsh, relay, proxy }, logDir, variantName, created }.
 * Nothing of the person's is touched: settings, credentials, sessions, rows
 * and bundles they added themselves stay (the ownership record decides).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, lstatSync, readlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const VARIANT = opt('--variant')
const RESOURCES = opt('--resources') && resolve(opt('--resources'))
if (!VARIANT || !RESOURCES) { process.stderr.write('usage: home-setup.mjs --variant <v> --resources <dir> [--ports <block>]\n'); process.exit(2) }

const ROOT_ID = 'io.github.taliesinb.deepsea'
const variantName = `${ROOT_ID}.${VARIANT}`
const displayName = VARIANT === 'release' ? 'DeepSea' : `DeepSea ${VARIANT.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')}`
const root = process.env.DEEPSEA_ROOT ? resolve(process.env.DEEPSEA_ROOT.replace(/^~(?=$|\/)/, homedir())) : join(homedir(), '.deepsea')
const home = join(root, VARIANT)
const logRoot = process.env.DEEPSEA_LOG_ROOT ? resolve(process.env.DEEPSEA_LOG_ROOT.replace(/^~(?=$|\/)/, homedir())) : join(homedir(), 'Library', 'Logs')
const logDir = join(logRoot, variantName)
const supportDir = join(homedir(), 'Library', 'Application Support', variantName)
const deepsea = join(RESOURCES, 'deepsea')

/** dsd's flat YAML (tools/dsd/lib/util.mjs): one `key: value` per line, strings quoted when needed. */
function parseFlatYaml(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim()
    let value = line.slice(i + 1).trim()
    if (/^".*"$/.test(value)) value = JSON.parse(value)
    else if (value === 'true' || value === 'false') value = value === 'true'
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value)
    out[key] = value
  }
  return out
}
function formatFlatYaml(obj, comment) {
  const q = v => typeof v === 'string' && !/^[A-Za-z0-9_./:@+-]+$/.test(v) ? JSON.stringify(v) : String(v)
  return `# ${comment}\n${Object.entries(obj).map(([k, v]) => `${k}: ${q(v)}`).join('\n')}\n`
}

/** A symlink at `link` pointing to `target`, replaced when it points elsewhere; never touches a real file. */
function relink(link, target) {
  try {
    const st = lstatSync(link)
    if (!st.isSymbolicLink()) return   // a real directory or file: the person's; leave it
    if (readlinkSync(link) === target) return
    unlinkSync(link)
  } catch { /* absent */ }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link)
}

let created = false
if (!existsSync(home)) { mkdirSync(home, { recursive: true, mode: 0o700 }); created = true }

// variant.yml: written once (dsd's fields), so a later `dsd build <v> --install` sees the same ports.
const variantFile = join(home, 'variant.yml')
let config = existsSync(variantFile) ? parseFlatYaml(readFileSync(variantFile, 'utf8')) : undefined
if (!config) {
  config = { id: VARIANT, display: displayName, ports: Number(opt('--ports', VARIANT === 'release' ? '3200' : '3210')), source: 'bundle', plugins: 'all', serve: false, created: new Date().toISOString() }
  writeFileSync(variantFile, formatFlatYaml(config, `${displayName}: written by the bundled app (home-setup.mjs)`), { mode: 0o600 })
}
const block = Number(config.ports)
const ports = { dsh: block, relay: block + 3, proxy: block + 4 }

mkdirSync(logDir, { recursive: true, mode: 0o700 })
relink(join(home, 'logs'), logDir)
relink(join(home, 'support'), supportDir)
relink(join(home, 'source'), deepsea)

// The profile: the harness's own setup first (its default bundles, pnpm settings; nothing existing touched).
const profile = join(home, 'profiles', 'web')
mkdirSync(profile, { recursive: true, mode: 0o700 })
const appBoot = join(deepsea, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
try {
  const mod = await import(pathToFileURL(join(appBoot, 'lib', 'index.js')).href)   // the built package re-exports initProfile and PROFILE_TEMPLATES
  mod.initProfile(profile, mod.PROFILE_TEMPLATES.web.bundles)
} catch (error) {
  if (!existsSync(join(profile, 'package.json'))) throw new Error(`profile setup failed: ${error.message}`)
}

// Then every bundled plugin, exactly as dsd's installBundles does.
const pluginsDir = join(deepsea, 'node_modules', '@deepsea')
const names = existsSync(pluginsDir) ? readdirSync(pluginsDir).filter(n => existsSync(join(pluginsDir, n, 'package.json'))).map(n => `@deepsea/${n}`).sort() : []
// server-log first, as dsd orders it (it must see the others' startup).
const log = names.indexOf('@deepsea/server-log'); if (log > 0) names.unshift(...names.splice(log, 1))
const manifestPath = join(profile, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const recordPath = join(profile, 'deepsea-bundles.json')
const recorded = existsSync(recordPath) ? new Set(JSON.parse(readFileSync(recordPath, 'utf8')).bundles ?? []) : undefined
const ours = name => recorded ? recorded.has(name) : name.startsWith('@deepsea/')
manifest.dependencies = Object.fromEntries([
  ...Object.entries(manifest.dependencies ?? {}).filter(([name]) => !ours(name)),
  ...names.map(name => [name, `link:${join(pluginsDir, name.slice('@deepsea/'.length))}`]),
])
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles = [...(manifest.dsh.profile.bundles ?? []).filter(name => !ours(name)), ...names]
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
const previous = recorded ? [...recorded] : (existsSync(join(profile, 'node_modules', '@deepsea')) ? readdirSync(join(profile, 'node_modules', '@deepsea')).map(e => `@deepsea/${e}`) : [])
for (const name of previous) if (!names.includes(name)) rmSync(join(profile, 'node_modules', name), { recursive: true, force: true })
writeFileSync(recordPath, `${JSON.stringify({ note: 'packages the bundled app installed into this profile (apps/macos/bundle/home-setup.mjs; dsd reads the same record)', bundles: names }, null, 2)}\n`)
for (const name of names) {
  const link = join(profile, 'node_modules', name)
  const target = join(pluginsDir, name.slice('@deepsea/'.length))
  mkdirSync(dirname(link), { recursive: true })
  try { if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) continue; rmSync(link, { recursive: true, force: true }) } catch { /* absent */ }
  symlinkSync(target, link)
}

process.stdout.write(`${JSON.stringify({ home, ports, logDir, variantName, created, bundles: names.length })}\n`)
