/**
 * `dsd adopt`: bring an old DSH home (`~/.dsh…`, before DeepSea), or another
 * DeepSea variant's home, into a DeepSea home. It copies and never moves (Plan sign-ins only with
 * `moveSignIns`), never writes outside the new home (and its backups), and
 * is re-runnable: `<new home>/adopted.json` records what came from where,
 * so a later run brings what is new or changed in the old home and reports
 * a conflict instead of overwriting anything changed in the new home since.
 * tools/dsd/README.md → Adopting a DSH home; the tables: lib/adopt-map.mjs.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DEEPSEA_ENTRIES, HARNESS_BUNDLE, normalizeMap } from './adopt-map.mjs'
import { renameRowLines } from './migrate-home.mjs'
import { mainCheckout, REPO } from './paths.mjs'
import { currentName, currentStatePath } from './renames.mjs'
import { DsdError, git, isoLocal } from './util.mjs'

export const MANIFEST = 'adopted.json'
const LOCK = 'session.lock'

/** The YAML library of the harness build (the one DSH itself reads and writes these files with). */
export function yamlLib(harness = join(REPO, 'harness')) {
  try {
    return createRequire(join(harness, 'packages', 'credentials', 'credentials-local', 'package.json'))('yaml')
  } catch {
    throw new DsdError(`adopt reads YAML with the harness build's library; ${harness} has none (dsd link)`)
  }
}

/** Cordis' `!!js` tag kept as it is: `{ __js: '<expression>' }`. */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: text => ({ __js: text }), identify: v => v !== null && typeof v === 'object' && '__js' in v, stringify: item => item.value.__js }

const statOf = (path) => {
  try {
    const s = lstatSync(path)
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : s.isSymbolicLink() ? { link: true } : { dir: s.isDirectory() }
  } catch { return undefined }
}
const sameStat = (a, b) => a !== undefined && b !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex').slice(0, 16)

/** Relative paths of the regular files under `dir` (symbolic links are listed apart). */
function walk(dir, { links = [] } = {}) {
  const out = []
  const visit = (rel) => {
    let entries
    try { entries = readdirSync(join(dir, rel), { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = rel ? join(rel, entry.name) : entry.name
      if (entry.isSymbolicLink()) links.push(path)
      else if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) out.push(path)
    }
  }
  visit('')
  return out.sort()
}

/** Bytes under a path (a file or a tree). */
export function sizeOf(path) {
  const s = statOf(path)
  if (s === undefined || s.link) return 0
  if (!s.dir) return s.size
  return walk(path).reduce((sum, rel) => sum + (statOf(join(path, rel))?.size ?? 0), 0)
}

const identical = (a, b) => {
  try { return Buffer.compare(Buffer.isBuffer(a) ? a : readFileSync(a), Buffer.isBuffer(b) ? b : readFileSync(b)) === 0 } catch { return false }
}

/**
 * Writes, confined to the new home (and its backups directory); none at all
 * in a dry run. The old home is never written through here.
 */
function makeIo(roots, dryRun) {
  const allowed = roots.filter(Boolean).map(r => resolve(r))
  const guard = (path) => {
    const p = resolve(path)
    if (!allowed.some(root => p === root || p.startsWith(root + sep))) throw new DsdError(`adopt: refusing to write outside the new home: ${p}`)
    return p
  }
  const parent = path => mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  return {
    dryRun,
    copy(src, dest) {
      guard(dest)
      if (dryRun) return
      parent(dest)
      rmSync(dest, { force: true })
      copyFileSync(src, dest, constants.COPYFILE_FICLONE)
      const s = statSync(src)
      utimesSync(dest, s.atime, s.mtime)
    },
    write(dest, content, mode = 0o600) {
      guard(dest)
      if (dryRun) return
      parent(dest)
      const tmp = `${dest}.adopt-${process.pid}`
      writeFileSync(tmp, content, { mode })
      renameSync(tmp, dest)
    },
    move(from, to) {
      guard(from); guard(to)
      if (dryRun) return
      parent(to)
      renameSync(from, to)
    },
    remove(path) {
      guard(path)
      if (!dryRun) rmSync(path, { recursive: true, force: true })
    },
  }
}

/**
 * A DeepSea home's variant.yml (flat YAML, written by dsd), or undefined for an old DSH home.
 * @returns {{ id?: string, client?: boolean, ports?: number } | undefined}
 */
export function sourceVariant(home) {
  let text
  try { text = readFileSync(join(home, 'variant.yml'), 'utf8') } catch { return undefined }
  const field = name => new RegExp(`^${name}:\\s*(.*?)\\s*$`, 'm').exec(text)?.[1]?.replace(/^(["'])(.*)\1$/, '$2')
  return { id: field('id'), client: field('client') === 'true', ...(field('ports') ? { ports: Number(field('ports')) } : {}) }
}

/** A JSON file's text without its access token(s) (`token`: the file's own; `servers`: each server's). */
function withoutSecret(path, kind) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (kind === 'token') delete value.token
  if (kind === 'servers') for (const server of value.servers ?? []) delete server.token
  return `${JSON.stringify(value, null, 2)}\n`
}

/** The manifest of earlier adoptions into a home. */
export function readManifest(home) {
  try {
    const m = JSON.parse(readFileSync(join(home, MANIFEST), 'utf8'))
    if (m?.version === 1) return m
  } catch { /* none yet */ }
  return { version: 1, runs: [], sources: {} }
}

/**
 * Adopt `source` (an old DSH home) into `target` (a DeepSea home).
 * @param {object} o
 * @param {string} o.source - the old home (read only).
 * @param {string} o.target - the new home.
 * @param {boolean} [o.throwaway] - a throwaway: no credentials, backups or access tokens.
 * @param {boolean} [o.moveSignIns] - copy Plan sign-ins, then remove them from the old home's credentials.
 * @param {boolean} [o.dryRun] - report only; nothing is written.
 * @param {string} [o.backups] - the variant's backups directory (old `<home>-backups` go there).
 * @param {Map<string, {rows: string[], presets: string[]}>} o.plugins - the DeepSea plugins available, by name.
 * @param {(spec: string) => {ok: boolean, message?: string}} [o.installBundle] - `dsh plugin add <spec>` into the new home.
 * @param {object} [o.map] - the old world's table (lib/adopt-map.mjs, loadAdoptMap); default none.
 * @param {object} [o.yaml] - the YAML library (default: the harness build's).
 * @param {Map<string, object>} [o.bundleRows] - the harness bundles' row configs by row id (default: read from the harness build).
 */
export function adopt(o) {
  const source = resolve(o.source)
  const target = resolve(o.target)
  if (source === target) throw new DsdError('the old home and the new home are the same directory')
  // Another DeepSea variant's home (it has a variant.yml): its own per-variant entries stay behind.
  const variant = sourceVariant(source)
  if (variant?.client) throw new DsdError(`${source} is a thin client's home: it has no sessions`)
  if (!existsSync(join(source, 'sessions')) && !existsSync(join(source, 'settings.yaml'))) throw new DsdError(`${source} does not look like a DSH home (no sessions/, no settings.yaml)`)
  const Y = o.yaml ?? yamlLib()
  const map = o.map ?? normalizeMap({})
  const dryRun = Boolean(o.dryRun)
  const io = makeIo([target, o.backups], dryRun)
  const manifest = readManifest(target)
  const m = manifest.sources[source] ??= { files: {}, sessions: {}, rows: {}, credentials: {}, workspaces: {} }
  for (const key of ['files', 'sessions', 'rows', 'credentials', 'workspaces']) m[key] ??= {}

  const report = {
    source, target, dryRun, throwaway: Boolean(o.throwaway),
    sourceKind: variant ? 'deepsea' : 'dsh', ...(variant?.id ? { sourceVariant: variant.id } : {}),
    map: map.path ?? 'none: old plugins\' state and rows are reported as unknown (lib/adopt-map.mjs)',
    categories: {},
    sessions: { new: 0, updated: 0, unchanged: 0, kept: 0, removedInNewHome: 0, bytes: 0 },
    workspaces: { added: [], merged: [], sessionsRegistered: 0 },
    rows: { carried: [], translated: [], unchanged: [], dropped: [] },
    bundles: { thirdParty: [], oldPlugins: {}, deepsea: [] },
    credentials: { keys: [], signIns: [], movedSignIns: [], leftOut: [] },
    settings: { oldSections: [] },
    translated: [],
    skipped: [],
    unknown: [],
    conflicts: [],
  }
  const conflict = (what, why) => report.conflicts.push({ what, why })
  const tally = (category) => (report.categories[category] ??= { new: 0, updated: 0, unchanged: 0, kept: 0, removedInNewHome: 0, bytes: 0 })

  /**
   * One file, by the adoption rule: absent in the new home → copy; recorded
   * and unchanged in the new home → bring the old home's change; changed on
   * both sides, or present but never adopted and different → conflict.
   */
  const syncFile = ({ srcPath, destPath, key, category, content }) => {
    const t = tally(category)
    const rec = m.files[key]
    const src = statOf(srcPath)
    const dest = statOf(destPath)
    const bytes = () => (content ? Buffer.from(content()) : srcPath)
    const write = (kind) => {
      if (content) io.write(destPath, content())
      else io.copy(srcPath, destPath)
      t[kind]++
      t.bytes += src.size
      if (!dryRun) m.files[key] = { src: relative(source, srcPath), srcSize: src.size, srcMtimeMs: src.mtimeMs, ...statOf(destPath) }
    }
    if (!rec) {
      if (!dest) return write('new')
      if (!dest.link && !dest.dir && identical(bytes(), destPath)) {
        t.unchanged++
        if (!dryRun) m.files[key] = { src: relative(source, srcPath), srcSize: src.size, srcMtimeMs: src.mtimeMs, ...dest }
        return
      }
      return conflict(key, 'in the new home already (not from an adopt), and different')
    }
    if (!dest) { t.removedInNewHome++; return }
    const srcChanged = !(src.size === rec.srcSize && src.mtimeMs === rec.srcMtimeMs)
    const destChanged = !sameStat(dest, rec)
    if (!srcChanged) { t[destChanged ? 'kept' : 'unchanged']++; return }
    if (!destChanged) return write('updated')
    conflict(key, 'changed in both homes since the last adopt')
  }

  /** A tree of the old home into a place in the new home, file by file. */
  const syncTree = (fromRel, toRel, category, { exclude = () => false, toPath } = {}) => {
    const from = join(source, fromRel)
    const links = []
    for (const rel of walk(from, { links })) {
      if (exclude(rel)) continue
      const destRel = join(toRel, rel)
      syncFile({ srcPath: join(from, rel), destPath: toPath ? toPath(rel) : join(target, destRel), key: destRel, category })
    }
    for (const rel of links) report.skipped.push({ what: join(fromRel, rel), why: 'a symbolic link' })
  }

  // --- Sessions: one unit per session directory, by session id.
  const sessionsOf = (home) => {
    const out = new Map()
    const root = join(home, 'sessions')
    let projects = []
    try { projects = readdirSync(root, { withFileTypes: true }) } catch { return out }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      for (const entry of readdirSync(join(root, project.name), { withFileTypes: true })) {
        const rel = join('sessions', project.name, entry.name)
        if (entry.isDirectory()) {
          const files = {}
          for (const name of walk(join(home, rel))) if (name !== LOCK) files[name] = statOf(join(home, rel, name))
          out.set(entry.name, { rel, files })
        } else if (home === source && /\.jsonl(\.zstd)?$/.test(entry.name)) {
          // DSH 0.2 refuses a whole sessions root holding the old flat-file layout.
          report.skipped.push({ what: rel, why: 'a session log in the flat-file layout, which DSH 0.2 refuses' })
        }
      }
    }
    return out
  }
  const sameFiles = (a, b) => {
    const ka = Object.keys(a ?? {}).sort()
    const kb = Object.keys(b ?? {}).sort()
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameStat(a[k], b[k]))
  }
  const oldSessions = sessionsOf(source)
  const newSessions = sessionsOf(target)
  /** Sessions adopted for the first time in this run (they join the workspace registry). */
  const fresh = new Set()
  const copySession = (id, src, destRel, previous) => {
    const s = report.sessions
    for (const [name, st] of Object.entries(src.files)) {
      if (previous && sameStat(previous.srcFiles?.[name], st) && previous.files?.[name]) continue
      io.copy(join(source, src.rel, name), join(target, destRel, name))
      s.bytes += st.size
    }
    for (const name of Object.keys(previous?.files ?? {})) if (!(name in src.files)) io.remove(join(target, destRel, name))
    if (dryRun) return
    const files = {}
    for (const name of walk(join(target, destRel))) if (name !== LOCK) files[name] = statOf(join(target, destRel, name))
    m.sessions[id] = { src: src.rel, dest: destRel, srcFiles: src.files, files }
  }
  for (const [id, src] of oldSessions) {
    const rec = m.sessions[id]
    const dest = newSessions.get(id)
    if (!rec) {
      if (dest) {
        if (sameFiles(dest.files, src.files) || Object.keys(src.files).every(n => dest.files[n] && identical(join(source, src.rel, n), join(target, dest.rel, n)))) {
          report.sessions.unchanged++
          if (!dryRun) m.sessions[id] = { src: src.rel, dest: dest.rel, srcFiles: src.files, files: dest.files }
        } else conflict(src.rel, 'a session with this id is in the new home already (not from an adopt), and different')
        continue
      }
      copySession(id, src, src.rel)
      report.sessions.new++
      fresh.add(id)
      // The projection cache (a derived listing shortcut; a stale record costs a replay, never a wrong value).
      const cache = join('storages', 'session_projcache', 'sessions', `${id}.json`)
      if (existsSync(join(source, cache)) && !existsSync(join(target, cache))) io.copy(join(source, cache), join(target, cache))
      continue
    }
    if (!dest) { report.sessions.removedInNewHome++; continue }
    const srcChanged = src.rel !== rec.src || !sameFiles(src.files, rec.srcFiles)
    const destChanged = dest.rel !== rec.dest || !sameFiles(dest.files, rec.files)
    if (!srcChanged) { report.sessions[destChanged ? 'kept' : 'unchanged']++; continue }
    if (destChanged) { conflict(src.rel, 'a session changed in both homes since the last adopt'); continue }
    if (src.rel !== dest.rel) io.move(join(target, dest.rel), join(target, src.rel))
    copySession(id, src, src.rel, src.rel === dest.rel ? rec : undefined)
    report.sessions.updated++
  }
  report.sessions.total = oldSessions.size

  // --- The workspace registry (storages/workspace.json): workspaces and the sessions they own.
  adoptRegistry({ source, target, io, m, fresh, report, dryRun })
  for (const entry of readdirSafe(join(source, 'storages'))) {
    if (entry !== 'workspace.json' && entry !== 'session_projcache') report.unknown.push({ what: join('storages', entry), bytes: sizeOf(join(source, 'storages', entry)) })
  }

  // --- Attachments: content-addressed objects; the store's scratch stays behind.
  syncTree('attachments', 'attachments', 'attachments', { exclude: rel => rel.split(sep).includes('tmp') })

  // --- settings.yaml, as it is: DSH 0.2 moves it into the profile patch at its first start (renaming it
  // settings.yaml.imported). Sections the new profile has a row of its own for stay out (a conflict; in a
  // throwaway, dsd's rows win); sections of plugins that are gone are reported.
  const settingsInto = {}
  const settingsPath = join(source, 'settings.yaml')
  if (existsSync(settingsPath)) {
    const text = readFileSync(settingsPath, 'utf8')
    const sections = [...text.matchAll(/^([^\s#:][^:]*):/gm)].map(x => x[1].trim())
    for (const section of sections) {
      const rule = map.settings[section]
      const note = (typeof rule === 'object' ? rule?.note ?? `its ${rule.keys.join(', ')} go to ${rule.row}` : rule) ?? (map.packages[section] || map.rows[section] ? 'an old plugin\'s section' : undefined)
      if (note) report.settings.oldSections.push({ section, note })
      // A section whose keys a DeepSea row takes: they go into that row of the new profile patch.
      if (typeof rule === 'object' && rule?.row) {
        let parsed
        try { parsed = Y.parse(text)?.[section] } catch { /* unreadable: reported as copied only */ }
        const keys = Object.fromEntries((rule.keys ?? []).filter(k => parsed && typeof parsed === 'object' && parsed[k] !== undefined && parsed[k] !== '').map(k => [k, parsed[k]]))
        if (Object.keys(keys).length) settingsInto[rule.row] = { ...settingsInto[rule.row], ...keys, from: section }
      }
    }
    const rec = m.files['settings.yaml']
    const imported = existsSync(join(target, 'settings.yaml.imported'))
    const own = profileRowIds(join(target, 'profiles', 'web', 'cordis.patch.yml'), m)
    // In a throwaway, dsd's rows that decide how it behaves win; the rest merge (DSH's import merges a
    // section into its row: old providers join the simulated ones).
    const clash = sections.filter(section => own.has(LEGACY_SECTIONS[section] ?? section) && (!o.throwaway || THROWAWAY_ROWS.has(section)))
    // Sections whose keys went into a DeepSea row stay out of the copy (DSH would warn it has no entry for them).
    const moved = sections.filter(section => typeof map.settings[section] === 'object' && map.settings[section]?.row)
    if (o.throwaway && /^\s*apiKey\s*:\s*\S/m.test(text)) report.skipped.push({ what: 'settings.yaml', why: 'holds an API key inline; a throwaway never gets one' })
    else if (rec && imported && !existsSync(join(target, 'settings.yaml'))) {
      const s = statOf(settingsPath)
      if (s.size !== rec.srcSize || s.mtimeMs !== rec.srcMtimeMs) conflict('settings.yaml', 'changed in the old home since the last adopt, and the new home has moved its copy into its profile patch (settings.yaml.imported): carry the change by hand')
      report.settings.imported = true
    } else {
      for (const section of clash) {
        if (o.throwaway) report.skipped.push({ what: `settings.yaml ${section}`, why: "the throwaway's own row stays" })
        else conflict(`settings.yaml ${section}`, 'the new profile has its own row for this section; left out of the copy')
      }
      const content = clash.length || moved.length ? () => withoutSections(text, [...clash, ...moved]) : undefined
      syncFile({ srcPath: settingsPath, destPath: join(target, 'settings.yaml'), key: 'settings.yaml', category: 'settings.yaml', content })
      report.settings.note = 'DSH 0.2 imports settings.yaml into the profile patch at its first start (settings.yaml.imported); a section with no plugin entry stays only in that file'
    }
  }

  // --- Credentials: API keys; Plan sign-ins only when moved; nothing into a throwaway.
  adoptCredentials({ source, target, io, m, report, conflict, Y, throwaway: Boolean(o.throwaway), moveSignIns: Boolean(o.moveSignIns), dryRun })

  // --- Agent presets, except those a DeepSea plugin now ships.
  const shipped = new Map([...o.plugins].flatMap(([name, p]) => (p.presets ?? []).map(preset => [preset, name])))
  for (const preset of readdirSafe(join(source, '.agent-presets'))) {
    if (shipped.has(preset)) { report.skipped.push({ what: join('.agent-presets', preset), why: `the DeepSea plugin ${shipped.get(preset)} ships this preset` }); continue }
    syncTree(join('.agent-presets', preset), join('.agent-presets', preset), 'agent presets')
  }

  // --- The profile: third-party bundles, then its own patch layer's rows (a third-party row only with its bundle).
  const missingBundles = adoptBundles({ source, target, report, installBundle: o.installBundle, dryRun, plugins: o.plugins, map })
  const bundleRows = o.bundleRows ?? harnessBundleRows(Y)
  adoptRows({ source, target, io, m, report, conflict, Y, plugins: o.plugins, throwaway: Boolean(o.throwaway), missingBundles, map, settingsInto, bundleRows })
  for (const profile of readdirSafe(join(source, 'profiles'))) if (profile !== 'web') report.unknown.push({ what: join('profiles', profile), bytes: sizeOf(join(source, 'profiles', profile)) })

  // --- Old plugins' state, into the DeepSea plugins' places; everything else reported.
  const handled = new Set()
  const entries = variant ? [...DEEPSEA_ENTRIES, ...map.entries] : map.entries
  for (const name of readdirSafe(source)) {
    const entry = entries.find(e => e.name === name || e.match?.test(name))
    if (!entry) {
      report.unknown.push({ what: name, bytes: sizeOf(join(source, name)) })
      continue
    }
    if (entry.skip) { report.skipped.push({ what: name, why: entry.skip, bytes: sizeOf(join(source, name)) }); continue }
    if (entry.own) continue
    if (entry.plugins) {
      // A DeepSea home's plugin state, each file under its plugin's current name (plugins/<old>/… → plugins/<new>/…).
      const links = []
      for (const rel of walk(join(source, name), { links })) {
        const key = currentStatePath(join(name, rel))
        const secret = o.throwaway ? entry.secrets?.[key] : undefined
        const srcPath = join(source, name, rel)
        if (secret) report.skipped.push({ what: `${join(name, rel)}: access token${secret === 'servers' ? 's' : ''}`, why: 'a throwaway never gets credentials' })
        syncFile({ srcPath, destPath: join(target, key), key, category: entry.what, content: secret ? () => withoutSecret(srcPath, secret) : undefined })
      }
      for (const rel of links) report.skipped.push({ what: join(name, rel), why: 'a symbolic link' })
      const renamed = readdirSafe(join(source, name)).filter(dir => currentName(dir) !== dir).map(dir => `${name}/${dir}/ → ${name}/${currentName(dir)}/`)
      report.translated.push(renamed.length ? `${name}/ (${renamed.join(', ')})` : `${name}/`)
      continue
    }
    if (entry.tree) {
      // A tree, with files at its top that have places of their own (`files`).
      const own = entry.files ?? {}
      syncTree(name, entry.tree, entry.what, { exclude: rel => rel in own })
      for (const [file, to] of Object.entries(own)) {
        if (existsSync(join(source, name, file))) syncFile({ srcPath: join(source, name, file), destPath: join(target, to), key: to, category: entry.what })
      }
      report.translated.push(`${name}/ → ${entry.tree}/${Object.entries(own).map(([f, to]) => `, ${name}/${f} → ${to}`).join('')}`)
      continue
    }
    if (handled.has(entry.file)) { report.skipped.push({ what: name, why: `a second file for ${entry.file}` }); continue }
    handled.add(entry.file)
    const srcPath = join(source, name)
    let content
    if (o.throwaway && entry.secret) {
      // An access token is a credential: never into a throwaway.
      content = () => withoutSecret(srcPath, entry.secret)
      report.skipped.push({ what: `${name}: access token${entry.secret === 'servers' ? 's' : ''}`, why: 'a throwaway never gets credentials' })
    }
    syncFile({ srcPath, destPath: join(target, entry.file), key: entry.file, category: entry.what, content })
    report.translated.push(`${name} → ${entry.file}`)
  }
  if (existsSync(join(source, 'cordis.patch.yml'))) report.unknown.push({ what: 'cordis.patch.yml (the home-level patch layer)', bytes: sizeOf(join(source, 'cordis.patch.yml')) })

  // --- Backups (`<old home>-backups/`), beside the variant's home; never for a throwaway (they hold credentials).
  const oldBackups = `${source}-backups`
  const zips = readdirSafe(oldBackups).filter(n => n.endsWith('.zip'))
  // A DeepSea variant's backups (`_backups/<v>/` beside its home) stay with it: they hold credentials, and /restore restores them there.
  const variantBackups = variant ? join(dirname(source), '_backups', variant.id ?? basename(source)) : undefined
  if (variantBackups && existsSync(variantBackups)) report.skipped.push({ what: variantBackups, why: "the source variant's backups stay with it", bytes: sizeOf(variantBackups) })
  if (zips.length && (o.throwaway || !o.backups)) report.skipped.push({ what: oldBackups, why: 'backups hold credentials: not into a throwaway', bytes: sizeOf(oldBackups) })
  else if (zips.length) {
    for (const zip of zips) syncFile({ srcPath: join(oldBackups, zip), destPath: join(o.backups, zip), key: join('_backups', zip), category: 'backups (old format: session-import reads them; /restore does not)' })
    report.translated.push(`${oldBackups}/ → ${o.backups}/`)
  }

  const copied = report.sessions.bytes + Object.values(report.categories).reduce((sum, c) => sum + c.bytes, 0)
  report.bytes = { copied, notCarried: [...report.skipped, ...report.unknown].reduce((sum, e) => sum + (e.bytes ?? 0), 0) }
  const summary = {
    sessions: { new: report.sessions.new, updated: report.sessions.updated },
    files: Object.fromEntries(Object.entries(report.categories).map(([k, v]) => [k, v.new + v.updated])),
    conflicts: report.conflicts.length,
  }
  if (!dryRun) {
    manifest.runs.push({ source, at: isoLocal(), ...(o.throwaway ? { throwaway: true } : {}), ...(o.moveSignIns ? { movedSignIns: report.credentials.movedSignIns } : {}), summary })
    io.write(join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return report
}

function readdirSafe(dir) {
  try { return readdirSync(dir).sort() } catch { return [] }
}

/** Rows dsd writes into a throwaway's profile that decide how it behaves (commands/run.mjs: no telemetry, its own documents, its models). */
const THROWAWAY_ROWS = new Set(['agent-default-model', 'session-log-deepseek', 'session-telemetry-otel', 'ui-settings-models', 'workspace-controller'])

/** settings.yaml sections whose entry has another id (the harness's own table, packages/settings/settings). */
const LEGACY_SECTIONS = { 'ui-developer-tools': 'ui-settings', 'ui-onboarding': 'ui-settings-general', shell: 'bash-sandbox' }

/** Row ids of a profile patch that an adoption did not write. */
function profileRowIds(path, m) {
  let text
  try { text = readFileSync(path, 'utf8') } catch { return new Set() }
  const ours = new Set(Object.keys(m.rows).filter(k => k.startsWith('id:')).map(k => k.slice(3)))
  return new Set([...text.matchAll(/^-\s+id:\s*['"]?([\w-]+)['"]?\s*$/gm)].map(x => x[1]).filter(id => !ours.has(id)))
}

/** A YAML document without some of its top-level sections (each up to the next top-level line). */
function withoutSections(text, sections) {
  const out = []
  let skipping = false
  for (const line of text.split('\n')) {
    const top = /^([^\s#:][^:]*):/.exec(line)
    if (top) skipping = sections.includes(top[1].trim())
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

/**
 * Merge the old workspace registry into the new one. Workspaces are matched
 * by an earlier adoption, by id, then by path; sessions adopted for the first
 * time join their old workspace (leaving any other: one owner each), in the
 * old order, before the sessions already there; their archived and pinned
 * state comes along. Nothing already in the new registry is removed.
 */
function adoptRegistry({ source, target, io, m, fresh, report, dryRun }) {
  const file = join('storages', 'workspace.json')
  let old
  try { old = JSON.parse(readFileSync(join(source, file), 'utf8')) } catch { return }
  let reg
  try { reg = JSON.parse(readFileSync(join(target, file), 'utf8')) } catch { reg = undefined }
  if (reg !== undefined && (reg.unit?.name !== 'workspace' || reg.unit?.version !== old.unit?.version)) {
    report.conflicts.push({ what: file, why: `the new home's registry is ${JSON.stringify(reg.unit)}, the old one's ${JSON.stringify(old.unit)}: not merged` })
    return
  }
  reg ??= { unit: old.unit, global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } }
  reg.tables ??= {}
  reg.tables.workspaces ??= {}
  const g = reg.global
  g.workspaceIds ??= []
  g.archivedSessionIds ??= []
  g.pinnedSessionIds ??= []
  const tables = reg.tables.workspaces
  const byPath = new Map(Object.entries(tables).map(([id, w]) => [w.path, id]))
  let changed = false
  const now = new Date().toISOString()
  const owned = new Set(Object.values(old.tables?.workspaces ?? {}).flatMap(w => w.sessionIds ?? []))
  for (const wid of old.global?.workspaceIds ?? []) {
    const w = old.tables?.workspaces?.[wid]
    if (!w) continue
    const joining = (w.sessionIds ?? []).filter(id => fresh.has(id))
    const mapped = m.workspaces[wid]
    if (mapped && tables[mapped] && joining.length === 0) continue
    let destId = mapped && tables[mapped] ? mapped : tables[wid] ? wid : byPath.get(w.path)
    if (destId === undefined) {
      destId = wid
      tables[destId] = { path: w.path, title: w.title, sessionIds: [], createdAt: w.createdAt ?? now, updatedAt: w.updatedAt ?? now }
      g.workspaceIds.push(destId)
      byPath.set(w.path, destId)
      report.workspaces.added.push(w.title)
      changed = true
    } else if (joining.length) report.workspaces.merged.push(w.title)
    m.workspaces[wid] = destId
    if (joining.length) {
      for (const [id, other] of Object.entries(tables)) if (id !== destId) other.sessionIds = other.sessionIds.filter(s => !joining.includes(s))
      const dest = tables[destId]
      dest.sessionIds = [...joining, ...dest.sessionIds.filter(s => !joining.includes(s))]
      dest.updatedAt = now
      report.workspaces.sessionsRegistered += joining.length
      changed = true
    }
  }
  for (const [key, list] of [['archivedSessionIds', old.global?.archivedSessionIds], ['pinnedSessionIds', old.global?.pinnedSessionIds]]) {
    for (const id of list ?? []) {
      if (fresh.has(id) && owned.has(id) && !g[key].includes(id)) { g[key].push(id); changed = true }
    }
  }
  if (changed) io.write(join(target, file), `${JSON.stringify(reg, null, 2)}\n`)
}

/**
 * Credentials (`.credentials.yaml`, DSH's version-1 document): API keys
 * (`refs`, and `api-key` records a provider's key login stored) are copied;
 * Plan sign-ins (`records` holding an OAuth grant) only with `moveSignIns`,
 * which then removes them from the old home in the same step, since two homes
 * refreshing one grant sign each other out. The installation device id that
 * ChatGPT sign-in presents travels with moved sign-ins (copied: it names the
 * installation, not a grant), so OpenAI keeps seeing the same installation.
 * This home's browser-session secret stays. A throwaway gets none of it:
 * everything is reported instead.
 */
function adoptCredentials({ source, target, io, m, report, conflict, Y, throwaway, moveSignIns, dryRun }) {
  const srcPath = join(source, '.credentials.yaml')
  if (!existsSync(srcPath)) return
  const old = Y.parse(readFileSync(srcPath, 'utf8')) ?? {}
  const refs = old.refs ?? {}
  const records = old.records ?? {}
  const DEVICE_ID = 'llm-pi-ai-installation/device-id'
  const isKeyRecord = record => record?.kind === 'api-key'
  const isGrant = (key, record) => !key.startsWith('client-connection/') && key !== DEVICE_ID && !isKeyRecord(record)
    && (record?.payload?.type === 'oauth' || key.startsWith('llm-pi-ai/'))
  const signIns = Object.keys(records).filter(key => isGrant(key, records[key]))
  const keyRecords = Object.keys(records).filter(key => isKeyRecord(records[key]))
  const deviceId = records[DEVICE_ID] === undefined ? undefined : DEVICE_ID
  report.credentials.keys = [...Object.keys(refs), ...keyRecords]
  report.credentials.signIns = signIns
  for (const key of Object.keys(records)) {
    if (signIns.includes(key) || keyRecords.includes(key) || key === deviceId) continue
    report.credentials.leftOut.push({ what: key, why: key.startsWith('client-connection/') ? "this home's browser-session secret (each home has its own)" : 'not an API key or a sign-in' })
  }
  if (throwaway) {
    if (report.credentials.keys.length) report.credentials.leftOut.push({ what: `API keys: ${report.credentials.keys.join(', ')}`, why: 'a throwaway never gets credentials' })
    if (deviceId) report.credentials.leftOut.push({ what: deviceId, why: 'a throwaway never gets credentials' })
    if (signIns.length) report.credentials.leftOut.push({ what: `sign-ins: ${signIns.join(', ')}`, why: 'a throwaway never gets credentials' })
    return
  }
  const destPath = join(target, '.credentials.yaml')
  const doc = existsSync(destPath) ? Y.parseDocument(readFileSync(destPath, 'utf8')) : new Y.Document({ version: 1, refs: {}, records: {} })
  let changed = false
  /** One credential by the adoption rule, with a hash of its value recorded rather than the value. */
  const put = (path, value, label) => {
    const key = path.join('/')
    const current = doc.getIn(path)
    const currentJs = current?.toJSON ? current.toJSON() : current
    const rec = m.credentials[key]
    if (currentJs === undefined) { doc.setIn(path, value); changed = true; m.credentials[key] = hash(value); return 'new' }
    if (hash(currentJs) === hash(value)) { m.credentials[key] = hash(value); return 'unchanged' }
    if (rec !== undefined && hash(currentJs) === rec) { doc.setIn(path, value); changed = true; m.credentials[key] = hash(value); return 'updated' }
    conflict(`.credentials.yaml ${label}`, 'different in the new home; kept')
    return 'conflict'
  }
  if (doc.get('version') === undefined) doc.set('version', 1)
  for (const [name, value] of Object.entries(refs)) put(['refs', name], value, `key ${name}`)
  for (const key of keyRecords) put(['records', key], records[key], `key ${key}`)
  const moved = []
  if (moveSignIns) {
    for (const key of signIns) if (put(['records', key], records[key], `sign-in ${key}`) !== 'conflict') moved.push(key)
    if (deviceId) put(['records', deviceId], records[deviceId], 'installation device id')
  } else {
    if (signIns.length) report.credentials.leftOut.push({ what: `sign-ins: ${signIns.join(', ')}`, why: 'Plan sign-ins move only with --move-sign-ins (two homes sharing a refresh token sign each other out)' })
    if (deviceId) report.credentials.leftOut.push({ what: deviceId, why: 'travels only with --move-sign-ins; a new home without them is a new installation' })
  }
  if (changed) io.write(destPath, doc.toString())
  if (moved.length === 0) return
  report.credentials.movedSignIns = moved
  if (dryRun) return
  // The old home's DSH may have refreshed a grant meanwhile: read it again, keep the newest in the
  // new home, then take the grants out of the old home's credentials.
  const oldDoc = Y.parseDocument(readFileSync(srcPath, 'utf8'))
  let refreshed = false
  for (const key of moved) {
    const now = oldDoc.getIn(['records', key])?.toJSON?.()
    if (now !== undefined && hash(now) !== hash(records[key])) { doc.setIn(['records', key], now); refreshed = true; m.credentials[`records/${key}`] = hash(now) }
    oldDoc.deleteIn(['records', key])
  }
  if (refreshed) io.write(destPath, doc.toString())
  removeFromOldCredentials(srcPath, oldDoc.toString())
}

/** The one write adopt makes in an old home: its credentials without the moved sign-ins (same mode, atomic). */
function removeFromOldCredentials(path, text) {
  if (basename(path) !== '.credentials.yaml') throw new DsdError(`adopt: refusing to write ${path}`)
  const mode = statSync(path).mode & 0o777
  const tmp = `${path}.adopt-${process.pid}`
  writeFileSync(tmp, text, { mode })
  renameSync(tmp, path)
}

/** Split a patch file into its header and top-level rows (each with the comment lines just above it). */
export function splitRows(text) {
  // The harness's new profile patch is an empty flow list (`[]`, under its comment): no rows, and not
  // something block rows can follow.
  const lines = String(text).split('\n').filter(line => !/^\s*\[\]\s*(#.*)?$/.test(line))
  const starts = lines.flatMap((line, i) => (/^-(\s|$)/.test(line) ? [i] : []))
  if (starts.length === 0) return { header: lines.join('\n').trimEnd(), rows: [] }
  // A row begins at its `- ` line, or at the comment lines right above it (no blank line between).
  const begins = starts.map((s) => { let b = s; while (b > 0 && /^#/.test(lines[b - 1])) b--; return b })
  // A row ends at its last line of YAML: a comment paragraph after it belongs to no row and is left out.
  const end = (from, to) => { let e = to; while (e > from && (lines[e - 1].trim() === '' || /^#/.test(lines[e - 1]))) e--; return e }
  const rows = starts.map((s, i) => lines.slice(begins[i], end(s + 1, i + 1 < starts.length ? begins[i + 1] : lines.length)).join('\n'))
  return { header: lines.slice(0, begins[0]).join('\n').trimEnd(), rows }
}

/** A row's identity in a patch: `id:<id>`, `insert:<ids>`, or its text. */
function rowKey(value, text) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(value.insert)) return `insert:${value.insert.map(e => e?.id ?? e?.name).join(',')}`
    if (typeof value.id === 'string') return `id:${value.id}`
  }
  return `text:${hash(text)}`
}
/** A row's text without its comments, for comparing. */
const bare = text => text.split('\n').filter(l => !/^\s*#/.test(l) && l.trim() !== '').join('\n')

/**
 * The configs of the rows the harness's own bundles insert, by row id
 * (`packages/bundle/<name>/cordis.patch.yml`). A profile row's config replaces
 * its bundle row's whole config, so a carried row is completed from these.
 * @param {object} Y - the YAML library.
 * @param {string} [harness] - the harness build.
 * @returns {Map<string, object>}
 */
export function harnessBundleRows(Y, harness = join(REPO, 'harness')) {
  const rows = new Map()
  const visit = (entries) => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (Array.isArray(entry?.insert)) visit(entry.insert)
      else if (typeof entry?.id === 'string' && entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config)) rows.set(entry.id, entry.config)
    }
  }
  for (const bundle of readdirSafe(join(harness, 'packages', 'bundle'))) {
    const file = join(harness, 'packages', 'bundle', bundle, 'cordis.patch.yml')
    if (!existsSync(file)) continue
    try { visit(Y.parse(readFileSync(file, 'utf8'), { customTags: [JS_TAG] })) } catch { /* not ours to judge */ }
  }
  return rows
}

/**
 * The old profile's own patch layer, row by row, into the new one: rows of
 * harness packages and of third-party bundles as they are, a harness row's
 * config completed with the keys its bundle row now sets and the old row did
 * not (the bundle's settings could have defaults then and none now); rows of
 * old plugins (DeepSea bundles now) translated where the DeepSea plugin has
 * the same settings (lib/adopt-map.mjs), else dropped and reported.
 */
function adoptRows({ source, target, io, m, report, conflict, Y, plugins, throwaway, missingBundles, map, settingsInto = {}, bundleRows = new Map() }) {
  const srcPath = join(source, 'profiles', 'web', 'cordis.patch.yml')
  const fromSettings = (rowId) => {
    const { from, ...keys } = settingsInto[rowId] ?? {}
    return { keys, from }
  }
  const settingsUsed = new Set()
  if (!existsSync(srcPath) && Object.keys(settingsInto).length === 0) return
  const parseRow = text => { try { return Y.parse(text, { customTags: [JS_TAG] })?.[0] } catch { return undefined } }
  const wanted = []
  for (const original of existsSync(srcPath) ? splitRows(readFileSync(srcPath, 'utf8')).rows : []) {
    // A DeepSea home's rows name its plugins as its build did: under their current names here (lib/renames.mjs).
    const text = renameRowLines(original)
    const value = parseRow(text)
    if (value === undefined) { report.rows.dropped.push({ row: text.split('\n').find(l => l.startsWith('-')), why: 'not readable as YAML' }); continue }
    if (Array.isArray(value.insert)) {
      const old = value.insert.filter(e => map.packages[e?.name] || map.rows[e?.id])
      if (old.length === value.insert.length) { for (const e of old) report.rows.dropped.push({ row: e.id, why: 'an old plugin: DeepSea installs its plugins as bundles' }); continue }
      if (old.length) { report.rows.dropped.push({ row: rowKey(value, text), why: 'mixes old plugins with other rows: carry it by hand' }); continue }
      const mcp = value.insert.filter(e => e?.name === '@deepseek-ai/dsh-mcp-client' && e.disabled !== true)
      if (throwaway && mcp.length) {
        // An MCP server signs in with this machine's credentials (mcp-remote's ~/.mcp-auth): off in a throwaway.
        for (const e of mcp) e.disabled = true
        const comment = text.split('\n').filter(l => l.startsWith('#'))
        const out = [...comment, '# disabled in a throwaway: it signs in with this machine\'s MCP credentials', Y.stringify([value], { customTags: [JS_TAG] }).trimEnd()].join('\n')
        wanted.push({ key: rowKey(value, text), text: out, outcome: { carried: `${rowKey(value, text)} (disabled: it signs in with this machine's MCP credentials)` } })
        continue
      }
      wanted.push({ key: rowKey(value, text), text, outcome: { carried: rowKey(value, text) } })
      continue
    }
    const id = value.id
    if (typeof id === 'string' && missingBundles.has(id)) { report.rows.dropped.push({ row: id, why: 'its bundle is not installed' }); continue }
    // A DeepSea plugin's own row (a DeepSea home's): carried when a plugin of this variant has it.
    if (typeof id === 'string' && id.startsWith('deepsea-') && !map.rows[id]) {
      const was = parseRow(original)?.id
      if (![...plugins.values()].some(p => (p.rows ?? []).includes(id))) { report.rows.dropped.push({ row: was, why: `no DeepSea plugin of this variant has the row ${id}` }); continue }
      wanted.push({ key: `id:${id}`, text, outcome: was !== id ? { translated: { from: was, to: id } } : { carried: `id:${id}` } })
      continue
    }
    if (typeof id !== 'string' || !map.rows[id]) {
      const base = typeof id === 'string' ? bundleRows.get(id) : undefined
      const missing = base && value.config && typeof value.config === 'object' ? Object.keys(base).filter(key => !(key in value.config)) : []
      if (missing.length) {
        const row = { ...value, config: { ...Object.fromEntries(missing.map(key => [key, base[key]])), ...value.config } }
        const comment = text.split('\n').filter(l => l.startsWith('#'))
        const out = [...comment, `# completed from the harness bundle row: ${missing.join(', ')}`, Y.stringify([row], { customTags: [JS_TAG] }).trimEnd()].join('\n')
        wanted.push({ key: rowKey(value, text), text: out, outcome: { carried: `${rowKey(value, text)} (completed: ${missing.join(', ')})` } })
        continue
      }
      wanted.push({ key: rowKey(value, text), text, outcome: { carried: rowKey(value, text) } })
      continue
    }
    const pkg = map.rows[id]
    const plugin = map.packages[pkg].plugin
    const rule = map.translations[id]
    if (!plugin) { report.rows.dropped.push({ row: id, why: `not in DeepSea: ${map.packages[pkg].note ?? 'not ported'}` }); continue }
    if (!plugins.has(plugin)) { report.rows.dropped.push({ row: id, why: `the DeepSea plugin ${plugin} is not in this variant (not ported, or left out)` }); continue }
    if (!rule) { report.rows.dropped.push({ row: id, why: `no translation for ${plugin}'s settings: set them by hand`, config: value.config }); continue }
    const config = value.config ?? {}
    const kept = {}
    for (const key of rule.keep) if (key in config && !rule.drop?.(key, config[key])) kept[key] = config[key]
    Object.assign(kept, rule.extra?.(config) ?? {})
    const left = Object.keys(config).filter(key => !(key in kept) && key !== 'traceFile')
    const newId = plugins.get(plugin).rows?.[0] ?? `deepsea-${plugin}`
    // Settings of an old settings.yaml section this row takes (lib/adopt-map.mjs `settings`).
    Object.assign(kept, fromSettings(newId).keys)
    settingsUsed.add(newId)
    const row = { id: newId, ...(value.disabled !== undefined ? { disabled: value.disabled } : {}), ...(Object.keys(kept).length ? { config: kept } : {}) }
    if (Object.keys(row).length === 1) {
      report.rows.dropped.push({ row: id, why: rule.gone ?? 'nothing the DeepSea plugin has the same setting for', ...(left.length ? { settings: left } : {}) })
      continue
    }
    const out = `# ${id}, adopted\n${Y.stringify([row], { customTags: [JS_TAG] }).trimEnd()}`
    wanted.push({ key: `id:${newId}`, text: out, outcome: { translated: { from: id, to: newId, ...(left.length ? { notCarried: left, why: rule.gone ?? 'no such setting in the DeepSea plugin' } : {}) } } })
  }
  // A row that only settings.yaml configured (no old profile row): a row of its own.
  for (const rowId of Object.keys(settingsInto)) {
    if (settingsUsed.has(rowId)) continue
    const { keys, from } = fromSettings(rowId)
    const plugin = [...plugins].find(([, p]) => (p.rows ?? []).includes(rowId))?.[0]
    if (plugin === undefined) { report.rows.dropped.push({ row: rowId, why: `settings.yaml ${from}: the plugin with this row is not in this variant`, settings: Object.keys(keys) }); continue }
    const out = `# settings.yaml ${from}, adopted\n${Y.stringify([{ id: rowId, config: keys }], { customTags: [JS_TAG] }).trimEnd()}`
    wanted.push({ key: `id:${rowId}`, text: out, outcome: { translated: { from: `settings.yaml ${from}`, to: rowId } } })
  }
  const done = (row) => {
    if (row.outcome.carried) report.rows.carried.push(row.outcome.carried)
    else report.rows.translated.push(row.outcome.translated)
  }
  if (wanted.length === 0) return

  const destPath = join(target, 'profiles', 'web', 'cordis.patch.yml')
  const destText = existsSync(destPath) ? readFileSync(destPath, 'utf8') : '# This profile\'s own patch layer: rows here come after every bundle\'s (a row\'s config replaces the bundle\'s whole config).\n'
  const { header, rows } = splitRows(destText)
  const keyed = rows.map(text => ({ text, key: rowKey(parseRow(text), text) }))
  let changed = false
  for (const row of wanted) {
    const at = keyed.findIndex(r => r.key === row.key)
    const rec = m.rows[row.key]
    if (at < 0) {
      keyed.push({ text: row.text, key: row.key })
      m.rows[row.key] = row.text
      changed = true
      done(row)
      continue
    }
    if (bare(keyed[at].text) === bare(row.text)) { m.rows[row.key] = row.text; report.rows.unchanged.push(row.key); continue }
    if (rec !== undefined && bare(keyed[at].text) === bare(rec)) {
      keyed[at] = { text: row.text, key: row.key }
      m.rows[row.key] = row.text
      changed = true
      done(row)
      continue
    }
    if (rec === undefined && throwaway) { report.rows.dropped.push({ row: row.key, why: "the throwaway's own row stays (dsd: no telemetry, its own documents and models)" }); continue }
    conflict(`profiles/web/cordis.patch.yml ${row.key}`, rec === undefined ? 'the new profile has its own row with this id' : 'changed in both homes since the last adopt')
  }
  if (changed) io.write(destPath, `${[header, ...keyed.map(r => r.text)].filter(Boolean).join('\n\n')}\n`)
}

/**
 * Third-party bundles of the old profile (npm specs in its package.json),
 * installed into the new profile as the harness does (`dsh plugin --profile
 * web add <spec>`). Old plugins are DeepSea bundles now; local links are
 * reported.
 */
function adoptBundles({ source, target, report, installBundle, dryRun, plugins, map }) {
  const missing = new Set()
  let manifest
  try { manifest = JSON.parse(readFileSync(join(source, 'profiles', 'web', 'package.json'), 'utf8')) } catch { return missing }
  let installed = {}
  try { installed = JSON.parse(readFileSync(join(target, 'profiles', 'web', 'package.json'), 'utf8')).dependencies ?? {} } catch { /* no profile yet */ }
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (HARNESS_BUNDLE(name)) continue
    // DeepSea's own bundles (a DeepSea home's): dsd installs the variant's plugins itself (dsd build --install).
    if (name.startsWith('@deepsea/')) { report.bundles.deepsea.push(name); continue }
    if (map.packages[name]) {
      const plugin = map.packages[name].plugin
      report.bundles.oldPlugins[name] = !plugin ? `not in DeepSea: ${map.packages[name].note ?? 'not ported'}` : plugins.has(plugin) ? plugin : `the DeepSea plugin ${plugin} is not in this variant (not ported, or left out)`
      continue
    }
    const out = report.bundles.thirdParty
    if (/^(link|file|workspace|portal):/.test(spec)) { out.push({ name, spec, result: 'a local link: not installed (install it by hand)' }); missing.add(name); continue }
    const full = `${name}@${spec}`
    if (name in installed) { out.push({ spec: full, result: 'installed already' }); continue }
    if (dryRun || !installBundle) { out.push({ spec: full, result: 'would install' }); continue }
    const result = installBundle(full)
    out.push({ spec: full, result: result.ok ? 'installed' : `failed: ${result.message}` })
    if (!result.ok) {
      missing.add(name)
      report.skipped.push({ what: `bundle ${full}`, why: `dsh plugin add refused it: ${result.message}` })
    }
  }
  return missing
}

/**
 * The DeepSea plugins found in these checkouts or builds (earlier first):
 * name → their row ids and the agent presets their bundle patches ship.
 */
export function availablePlugins(roots) {
  const out = new Map()
  for (const root of roots) {
    // A root is a directory (a checkout or build), or `{ commit }` of this repository, read with git.
    const atCommit = typeof root === 'object'
    const show = path => { try { return git(mainCheckout(), ['show', `${root.commit}:${path}`]) } catch { return undefined } }
    const names = atCommit
      ? (() => { try { return git(mainCheckout(), ['ls-tree', '--name-only', `${root.commit}:plugins`]).split('\n').filter(Boolean) } catch { return [] } })()
      : readdirSafe(join(root, 'plugins'))
    for (const name of names) {
      // Keyed by the current name (lib/renames.mjs): an older build has a renamed plugin under its old one.
      if (out.has(currentName(name))) continue
      const dir = atCommit ? `${root.commit.slice(0, 10)}:plugins/${name}` : join(root, 'plugins', name)
      if (atCommit ? show(`plugins/${name}/package.json`) === undefined : !existsSync(join(dir, 'package.json'))) continue
      let patch = ''
      if (atCommit) patch = show(`plugins/${name}/cordis.patch.yml`) ?? ''
      else try { patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8') } catch { /* none */ }
      const rows = [...patch.matchAll(/^\s*-\s+id:\s*['"]?([\w-]+)['"]?\s*$/gm)].map(x => x[1])
      const presets = [...patch.matchAll(/name:\s*['"]?@deepseek-ai\/dsh-agent-preset['"]?\s*\n\s*config:\s*\n\s*id:\s*['"]?([\w-]+)/g)].map(x => x[1])
      let machineWide = false
      let optIn = false
      try {
        const deepsea = JSON.parse(atCommit ? show(`plugins/${name}/package.json`) : readFileSync(join(dir, 'package.json'), 'utf8')).deepsea
        machineWide = Boolean(deepsea?.machineWide)
        optIn = Boolean(deepsea?.optIn)
      } catch { /* unreadable */ }
      out.set(currentName(name), { dir, rows: rows.filter(r => r === `deepsea-${name}`).concat(rows.filter(r => r !== `deepsea-${name}`)), presets, machineWide, optIn })
    }
  }
  return out
}

/** The old instance's colour (the table's `color`: a row and a config key), for a new variant. */
export function oldColor(source, map, Y = yamlLib()) {
  if (!map?.color) return undefined
  try {
    const rows = Y.parse(readFileSync(join(source, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), { customTags: [JS_TAG] })
    const color = rows?.find(r => r?.id === map.color.row)?.config?.[map.color.key]
    return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined
  } catch { return undefined }
}
