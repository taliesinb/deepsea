/**
 * What `dsd adopt` knows about an old DSH home. DSH's own entries are here;
 * the old plugins' names, rows and state files are a table of the machine
 * the old homes are on (their names are retired: they stay out of tracked
 * files), `adopt-map.mjs` in the extras repository (LAYOUT.md §3), else
 * `<main checkout>/private/adopt-map.mjs`, or `DEEPSEA_ADOPT_MAP`.
 * Without one, adopt carries DSH's own state and reports every old plugin's
 * entry as unknown.
 *
 * The table module's exports, all optional:
 *
 *   packages      old package → { plugin: <DeepSea plugin dir> | null, rows: [<old row ids>], note? }
 *                 (DeepSea names from before a plugin's rename are read as its new ones: lib/renames.mjs)
 *   translations  old row id → { keep: [<config keys the DeepSea plugin has with the same meaning>],
 *                 extra?(config) → more keys, drop?(key, value), gone?: <why the rest is not carried> }
 *   settings      old settings.yaml section → a note (the section is copied, and reported), or
 *                 { row: <DeepSea row id>, keys: [<its keys the row's config takes>], note? }: those
 *                 keys go into that row of the new profile patch (the section is copied too)
 *   color         { row, key }: the old row whose config holds the instance's #rrggbb colour
 *   entries       old top-level entries (by `name` or `match`) → { tree: <dir in the new home>,
 *                 files?: { <file at the tree's top>: <its own place> } } | { file, secret?: 'token' | 'servers' }
 *                 | { skip: <why> }; each with `what` (a label for the report)
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extrasDir, mainCheckout } from './paths.mjs'
import { currentName, currentRowId, currentStatePath } from './renames.mjs'
import { DsdError } from './util.mjs'

/** Default bundles of a harness profile: never reinstalled by adopt. */
export const HARNESS_BUNDLE = name => name.startsWith('@deepseek-ai/')

/**
 * DSH's own top-level entries of a home: `own` (a step of their own), or
 * `tree` (copied to the same place), or `skip`.
 */
export const DSH_ENTRIES = [
  { name: 'sessions', own: true },
  { name: 'attachments', own: true },
  { name: 'storages', own: true },
  { name: 'settings.yaml', own: true },
  { name: '.credentials.yaml', own: true },
  { name: '.agent-presets', own: true },
  { name: 'profiles', own: true },
  { name: 'session-move-backups', tree: 'session-move-backups', what: "DSH's copies of moved sessions" },
  { name: 'cache', skip: "DSH's cache (request images), rebuilt on demand" },
  { name: 'logs', skip: "the old instance's logs" },
  { name: 'tmp', skip: 'scratch' },
  { name: '.anonymous-user-id', skip: 'per home; the new home makes its own' },
]

/**
 * A DeepSea home's own top-level entries (when the source is another
 * variant's home), matched before DSH's: what dsd makes per variant stays
 * behind; `plugins/` comes file by file under the plugins' current names
 * (lib/renames.mjs). `secrets`: files in it holding an access token, stripped
 * for a throwaway (`token`: the file's `token`; `servers`: each server's).
 */
export const DEEPSEA_ENTRIES = [
  { name: 'variant.yml', skip: "the source variant's configuration (the target has its own)" },
  { name: 'adopted.json', skip: "the source's record of its own adoptions" },
  { name: 'relay', skip: "the source relay's standing token (each variant has its own)" },
  { name: 'run', skip: "a throwaway's run state" },
  { name: 'logs', skip: 'a link dsd makes for each variant' },
  { name: 'support', skip: 'a link dsd makes for each variant' },
  { name: 'source', skip: 'a link dsd makes for each variant' },
  { name: 'settings.yaml.imported', skip: "DSH's record of an earlier settings.yaml import (its settings are in the profile patch)" },
  {
    name: 'plugins', plugins: true, what: "DeepSea plugins' state",
    secrets: { 'plugins/host-tailscale/state.json': 'token', 'plugins/workspace-remote/workspaces.json': 'servers' },
  },
]

/** The table at `path` (default: DEEPSEA_ADOPT_MAP, else the extras' adopt-map.mjs, else private/adopt-map.mjs), normalized; `{}` when there is none. */
export async function loadAdoptMap(path = process.env.DEEPSEA_ADOPT_MAP ?? [join(extrasDir(), 'adopt-map.mjs'), join(mainCheckout(), 'private', 'adopt-map.mjs')].find(existsSync) ?? join(extrasDir(), 'adopt-map.mjs')) {
  if (!existsSync(path)) return normalizeMap({}, undefined)
  try {
    return normalizeMap(await import(pathToFileURL(resolve(path)).href), resolve(path))
  } catch (error) {
    throw new DsdError(`adopt: cannot load ${path}: ${error.message}`)
  }
}

/**
 * A table with every part present, and the old row id → old package index. The DeepSea names
 * it gives (plugin directories, their rows, their state under `plugins/<dir>/`) are read through
 * lib/renames.mjs, so a table written before a plugin was renamed names its new place.
 */
export function normalizeMap(table, path) {
  const packages = Object.fromEntries(Object.entries(table.packages ?? {}).map(([pkg, entry]) => [pkg, entry?.plugin ? { ...entry, plugin: currentName(entry.plugin) } : entry]))
  const settings = Object.fromEntries(Object.entries(table.settings ?? {}).map(([section, rule]) => [section, rule && typeof rule === 'object' && rule.row ? { ...rule, row: currentRowId(rule.row) } : rule]))
  const entry = e => ({
    ...e,
    ...(typeof e.tree === 'string' ? { tree: currentStatePath(e.tree) } : {}),
    ...(typeof e.file === 'string' ? { file: currentStatePath(e.file) } : {}),
    ...(e.files ? { files: Object.fromEntries(Object.entries(e.files).map(([f, to]) => [f, typeof to === 'string' ? currentStatePath(to) : to])) } : {}),
  })
  return {
    path,
    packages,
    rows: Object.fromEntries(Object.entries(packages).flatMap(([pkg, entry]) => (entry.rows ?? []).map(row => [row, pkg]))),
    translations: table.translations ?? {},
    settings,
    color: table.color,
    entries: [...DSH_ENTRIES, ...(table.entries ?? []).map(entry)],
  }
}
