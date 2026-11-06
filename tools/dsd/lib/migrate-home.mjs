/**
 * A home's plugin names brought up to date after plugins were renamed
 * (lib/renames.mjs): dsd runs it before it starts a variant's server (a
 * throwaway, once its plugins are installed; `dsd run <v>`; `dsd build <v>
 * --install`) and on the target of `dsd adopt`.
 *
 * - `plugins/<old>/` (a plugin's state) becomes `plugins/<new>/` when only
 *   the old one exists; with both, both stay and the pair is reported.
 * - Rows `id: deepsea-<old>` (and `name: "@deepsea/<old>"`) of the home's
 *   `cordis.patch.yml` and of every `profiles/<p>/cordis.patch.yml` become
 *   the new names, line by line, so comments and layout stay.
 * - `plugins:` of `variant.yml` names the plugins by their new names.
 * - `adopted.json` (what `dsd adopt` wrote) records those files and rows
 *   under their new places, so a later adopt finds them unchanged.
 *
 * A plugin still installed under its old name (a profile of the home has
 * `@deepsea/<old>`: the variant runs a build from before the rename) keeps
 * its state and rows as they are, since that build reads them there; they
 * move once a build with the new name is installed (`dsd build <v>
 * --install`; a throwaway installs its plugins before this runs). For the
 * same reason the profile's `package.json` and `deepsea-bundles.json` are
 * left alone: they record the packages installed, and the next install
 * rewrites them. Idempotent: a second run finds nothing to do.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PLUGIN_RENAMES, currentName } from './renames.mjs'

const ID_LINE = /^(\s*(?:-\s+)?id:\s*)(["']?)deepsea-([a-z0-9-]+)\2(?=\s*(?:#.*)?$)/
const NAME_LINE = /^(\s*(?:-\s+)?name:\s*)(["']?)@deepsea\/([a-z0-9-]+)\2(?=\s*(?:#.*)?$)/

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }

/** The profiles of a home (`profiles/<p>/`). */
function profiles(home) {
  const dir = join(home, 'profiles')
  try { return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(dir, e.name)) } catch { return [] }
}

/** Old plugin names whose old package a profile of the home still has installed. */
function installedUnderOldNames(home) {
  const installed = new Set()
  for (const profile of profiles(home)) {
    const manifest = readJson(join(profile, 'package.json'))
    const record = readJson(join(profile, 'deepsea-bundles.json'))
    for (const name of [...Object.keys(manifest?.dependencies ?? {}), ...(manifest?.dsh?.profile?.bundles ?? []), ...(record?.bundles ?? [])]) {
      const m = /^@deepsea\/(.+)$/.exec(name)
      if (m && Object.hasOwn(PLUGIN_RENAMES, m[1])) installed.add(m[1])
    }
  }
  return installed
}

/**
 * Migrate a home to the current plugin names.
 * @param {string} home
 * @param {{ dryRun?: boolean }} [options] - dryRun: report what would change, touch nothing.
 * @returns {{ home: string, changed: boolean, dryRun: boolean, plugins: object[], conflicts: object[], rows: object[], variant?: object, waiting: object[] }}
 */
export function migrateHome(home, { dryRun = false } = {}) {
  const report = { home, changed: false, dryRun, plugins: [], conflicts: [], rows: [], waiting: [] }
  if (!existsSync(home)) return report
  const installed = installedUnderOldNames(home)
  const wait = (old, what) => {
    let entry = report.waiting.find(w => w.plugin === old)
    if (!entry) report.waiting.push(entry = { plugin: old, now: PLUGIN_RENAMES[old], why: `@deepsea/${old} is installed (a build from before the rename); the next dsd build --install migrates it`, keeps: [] })
    entry.keeps.push(what)
  }

  // Plugin state.
  for (const [old, current] of Object.entries(PLUGIN_RENAMES)) {
    const from = join(home, 'plugins', old)
    const to = join(home, 'plugins', current)
    if (!existsSync(from)) continue
    if (installed.has(old)) { wait(old, `plugins/${old}`); continue }
    if (existsSync(to)) { report.conflicts.push({ from: `plugins/${old}`, to: `plugins/${current}`, why: 'both exist: both left as they are' }); continue }
    if (!dryRun) renameSync(from, to)
    report.plugins.push({ from: `plugins/${old}`, to: `plugins/${current}` })
  }

  // Patch rows: the home's own patch and every profile's.
  const patches = [join(home, 'cordis.patch.yml'), ...profiles(home).map(p => join(p, 'cordis.patch.yml'))].filter(existsSync)
  for (const file of patches) {
    const text = readFileSync(file, 'utf8')
    let edited = false
    const lines = text.split('\n').map((line, i) => {
      for (const [pattern, prefix] of [[ID_LINE, 'deepsea-'], [NAME_LINE, '@deepsea/']]) {
        const m = pattern.exec(line)
        if (!m || !Object.hasOwn(PLUGIN_RENAMES, m[3])) continue
        if (installed.has(m[3])) { wait(m[3], `${relative(home, file)}:${i + 1} ${prefix}${m[3]}`); return line }
        edited = true
        report.rows.push({ file: relative(home, file), line: i + 1, from: `${prefix}${m[3]}`, to: `${prefix}${PLUGIN_RENAMES[m[3]]}` })
        return `${m[1]}${m[2]}${prefix}${PLUGIN_RENAMES[m[3]]}${m[2]}${line.slice(m[0].length)}`
      }
      return line
    })
    if (edited && !dryRun) writeFileSync(file, lines.join('\n'), { mode: statSync(file).mode & 0o777 })
  }

  // The variant's plugin list (variant.yml is flat YAML: `plugins: a` or `plugins: "a,b"`).
  const variantFile = join(home, 'variant.yml')
  if (existsSync(variantFile)) {
    const text = readFileSync(variantFile, 'utf8')
    const lines = text.split('\n')
    const i = lines.findIndex(l => /^plugins:\s*/.test(l))
    const raw = i < 0 ? undefined : lines[i].replace(/^plugins:\s*/, '')
    const quoted = raw?.startsWith('"')
    let value
    try { value = raw === undefined ? undefined : quoted ? JSON.parse(raw) : raw.replace(/\s+#.*$/, '').trim() } catch { value = undefined }
    if (typeof value === 'string' && value !== 'all') {
      const renamed = value.split(',').map(s => currentName(s.trim())).join(',')
      if (renamed !== value) {
        lines[i] = `plugins: ${quoted || renamed.includes(',') ? JSON.stringify(renamed) : renamed}`
        if (!dryRun) writeFileSync(variantFile, lines.join('\n'), { mode: statSync(variantFile).mode & 0o777 })
        report.variant = { plugins: { from: value, to: renamed } }
      }
    }
  }

  // dsd adopt's record: the files it wrote under a moved plugins/<old>/, and its rows, by their new names.
  const adoptedFile = join(home, 'adopted.json')
  const adopted = existsSync(adoptedFile) ? readJson(adoptedFile) : undefined
  if (adopted?.sources && typeof adopted.sources === 'object') {
    const moved = old => !installed.has(old) && (!existsSync(join(home, 'plugins', old)) || report.plugins.some(p => p.from === `plugins/${old}`))
    let files = 0
    let rows = 0
    for (const record of Object.values(adopted.sources)) {
      if (record?.files && typeof record.files === 'object') {
        record.files = Object.fromEntries(Object.entries(record.files).map(([key, value]) => {
          const m = /^plugins\/([^/]+)(\/.*)?$/.exec(key)
          if (!m || !Object.hasOwn(PLUGIN_RENAMES, m[1]) || !moved(m[1])) return [key, value]
          files++
          return [`plugins/${PLUGIN_RENAMES[m[1]]}${m[2] ?? ''}`, value]
        }))
      }
      if (record?.rows && typeof record.rows === 'object') {
        record.rows = Object.fromEntries(Object.entries(record.rows).map(([key, text]) => {
          const m = /^id:deepsea-(.+)$/.exec(key)
          if (!m || !Object.hasOwn(PLUGIN_RENAMES, m[1]) || installed.has(m[1])) return [key, text]
          rows++
          const renamed = String(text).split('\n').map((line) => {
            const id = ID_LINE.exec(line)
            return id && id[3] === m[1] ? `${id[1]}${id[2]}deepsea-${PLUGIN_RENAMES[m[1]]}${id[2]}${line.slice(id[0].length)}` : line
          }).join('\n')
          return [`id:deepsea-${PLUGIN_RENAMES[m[1]]}`, renamed]
        }))
      }
    }
    if (files + rows > 0) {
      if (!dryRun) writeFileSync(adoptedFile, `${JSON.stringify(adopted, null, 2)}\n`, { mode: statSync(adoptedFile).mode & 0o777 })
      report.adopted = { files, rows }
    }
  }

  report.changed = report.plugins.length > 0 || report.rows.length > 0 || report.variant !== undefined || report.adopted !== undefined
  return report
}

/** The report for printing: only what happened (undefined when nothing did). */
export function migrationSummary(report) {
  if (!report.changed && report.conflicts.length === 0 && report.waiting.length === 0) return undefined
  const { home, changed, dryRun, ...rest } = report
  return Object.fromEntries(Object.entries({ dryRun: dryRun || undefined, ...rest }).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)))
}
