/**
 * dsd adopt <home> (<variant> | --throwaway [run options…]) [--move-sign-ins] [--dry-run]
 *
 * Brings an old DSH home (`~/.dsh`, `~/.dsh-<name>`, …), or another DeepSea
 * variant's home (`~/.deepsea/<v>`), into a DeepSea variant: sessions and their attachments, the workspace registry,
 * settings.yaml, API keys, each old plugin's state in its DeepSea place, the
 * old profile's own rows and third-party bundles (lib/adopt.mjs). Copies,
 * never moves; re-runnable (`<home>/adopted.json`); never writes the old
 * home, except that `--move-sign-ins` takes the Plan sign-ins it copied out
 * of the old home's credentials. A named variant that does not exist is
 * created as `dsd new` would (the old instance's colour); building and
 * installing it stays `dsd build <v> --install`. The variant must not be
 * running. `--throwaway` adopts into a fresh throwaway (`release`'s, or the
 * old home's name: `~/.dsh-lab` → `lab-<hex>`, a variant's home: its id; every plugin unless
 * `--plugins`) and starts it as `dsd run … --throwaway` does, passing the run
 * options through (`--throwaway-app`, `--throwaway-server`, `--detach`,
 * `--simulated`, `--source`, …); it never gets credentials, backups or access
 * tokens. `--dry-run` reports what would be copied, translated, skipped and
 * in conflict, and touches nothing.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { adopt, availablePlugins, oldColor, sourceVariant, yamlLib } from '../lib/adopt.mjs'
import { listening, OFFSETS } from '../lib/install.mjs'
import { loadAdoptMap } from '../lib/adopt-map.mjs'
import { migrateHome, migrationSummary } from '../lib/migrate-home.mjs'
import { currentName } from '../lib/renames.mjs'
import { buildPaths, buildReady } from '../lib/harness.mjs'
import { deepseaRoot, extrasDir, homeOf, REPO } from '../lib/paths.mjs'
import { SERVER_ENTRY } from '../lib/remove.mjs'
import { ensureSourceBuild, resolveSourceCommit } from '../lib/source.mjs'
import { DsdError, note, onlyFlags, parseArgs, printJson, usage } from '../lib/util.mjs'
import { checkNamedId, readVariant } from '../lib/variants.mjs'
import { run } from './run.mjs'
import { createVariant, namedStatus } from './variant.mjs'

const USAGE = 'dsd adopt <home> (<variant> | --throwaway [run options…]) [--move-sign-ins] [--dry-run]'
const RUN_VALUED = ['source', 'harness', 'timeout', 'plugins', 'ttl', 'app', 'patch', 'accounts']
const RUN_FLAGS = ['throwaway-app', 'throwaway-server', 'detach', 'visible', 'scripted', 'simulated', 'keep']

const real = path => { try { return realpathSync(path) } catch { return resolve(path) } }

/** `dsh plugin --profile web add <spec>` with DSH_HOME the new home, from a harness build. */
function bundleInstaller(home, harness) {
  return (spec) => {
    const own = process.env.DSH_HOME
    if (!real(home).startsWith(`${real(deepseaRoot())}/`) || (own && real(own) === real(home))) throw new DsdError(`adopt: not running dsh in ${home}`)
    note(`dsh plugin --profile web add ${spec}`)
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', join(harness, SERVER_ENTRY), 'plugin', '--profile', 'web', 'add', spec],
      { cwd: harness, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
    return result.status === 0 ? { ok: true } : { ok: false, message: (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ') }
  }
}

/** The build a source ref would run, when it exists already (none is made for a dry run). */
function existingSourceBuild(ref) {
  try {
    const commit = resolveSourceCommit(ref)
    return buildReady(commit, 'deepsea') ? buildPaths(commit, 'deepsea').dir : undefined
  } catch { return undefined }
}

/** Where a variant's plugins come from: its source's build, else that commit read with git; then this checkout and the extras. */
function pluginRoots(ref) {
  const build = ref ? existingSourceBuild(ref) : undefined
  let commit
  if (ref && !build) try { commit = resolveSourceCommit(ref) } catch { /* not a commit */ }
  return [build ?? (commit ? { commit } : undefined), REPO, extrasDir()].filter(Boolean)
}

/** dsd adopt */
export async function adoptCommand(argv) {
  const args = parseArgs(argv, RUN_VALUED)
  onlyFlags(args, ['throwaway', 'move-sign-ins', 'dry-run', ...RUN_VALUED, ...RUN_FLAGS])
  const [from, variant, ...extra] = args._
  if (from === undefined || extra.length > 0) usage(USAGE)
  const source = resolve(from.replace(/^~(?=\/|$)/, homedir()))
  if (!existsSync(source)) throw new DsdError(`no ${source}`)
  const dryRun = Boolean(args['dry-run'])
  const moveSignIns = Boolean(args['move-sign-ins'])
  const runOptions = Object.keys(args).filter(k => RUN_VALUED.includes(k) || RUN_FLAGS.includes(k))
  const map = await loadAdoptMap()
  // Another variant's home: copied as it is now, even while it runs (a session written meanwhile comes with the next adopt).
  const sourceConfig = sourceVariant(source)
  if (sourceConfig?.ports && !dryRun) {
    const up = await listening(sourceConfig.ports + OFFSETS.relay) || await listening(sourceConfig.ports + OFFSETS.dsh)
    if (up) note(`${sourceConfig.id ?? source} is running: its sessions are copied as they are now; what it writes meanwhile comes with the next dsd adopt`)
  }

  if (args.throwaway) {
    if (variant !== undefined) usage(`${USAGE}: a variant or --throwaway, not both`)
    if (moveSignIns) usage('--move-sign-ins refuses --throwaway: a throwaway never gets credentials')
    // The throwaway's parent: the old instance's name (`~/.dsh-lab` → lab), else release.
    const named = sourceConfig?.id ?? /^\.dsh-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(basename(source))?.[1]
    const parent = named && !/-[0-9a-f]{6}$/.test(named) ? named : 'release'
    if (dryRun) {
      // As the run would select them: every plugin but the machine-wide and opt-in ones, unless --plugins names some.
      const all = availablePlugins(pluginRoots(args.source))
      const named = typeof args.plugins === 'string' && args.plugins !== 'all' ? args.plugins.split(',').map(currentName) : undefined
      const plugins = new Map([...all].filter(([name, p]) => (named ? named.includes(name) : !p.machineWide && !p.optIn)))
      printJson(adopt({ source, target: join(tmpdir(), `deepsea-adopt-dry-run-${process.pid}`), throwaway: true, dryRun, plugins, map }))
      return
    }
    const runArgv = [parent, args['throwaway-app'] ? '--throwaway-app' : args['throwaway-server'] ? '--throwaway-server' : '--throwaway']
    for (const key of runOptions) {
      if (key === 'throwaway-app' || key === 'throwaway-server') continue
      runArgv.push(`--${key}`, ...(RUN_VALUED.includes(key) ? [String(args[key])] : []))
    }
    if (args.plugins === undefined) runArgv.push('--plugins', 'all')
    let report
    await run(runArgv, {
      prepareHome: ({ home, build, source: built, plugins: loaded }) => {
        // Only the plugins this throwaway loads: a row for another would name no entry.
        const all = availablePlugins([built?.dir, REPO, extrasDir()].filter(Boolean))
        const plugins = new Map([...all].filter(([name]) => loaded.map(currentName).includes(name)))
        report = adopt({ source, target: home, throwaway: true, plugins, map, installBundle: bundleInstaller(home, build), yaml: yamlLib(build) })
        note(`adopted ${source}: ${report.sessions.new} sessions, ${report.workspaces.added.length} workspaces, ${report.conflicts.length} conflicts`)
      },
      output: () => ({ adopt: report }),
    })
    return
  }

  if (variant === undefined) usage(USAGE)
  if (runOptions.length) usage(`--${runOptions[0]} is a run option, for --throwaway`)
  checkNamedId(variant)
  const config = readVariant(variant)
  const target = homeOf(variant)
  if (real(source) === real(target)) throw new DsdError('the old home and the new home are the same directory')
  if (config) {
    const status = await namedStatus(variant, config)
    if (status.relay || status.server) throw new DsdError(`${variant} is running; stop it first (dsd stop ${variant}): adopt never writes under a running server`)
  }
  const sourceRef = config?.source ?? 'integration/base'
  const build = existingSourceBuild(sourceRef)
  let created
  if (!config) {
    if (dryRun) created = { id: variant, wouldCreate: true, color: oldColor(source, map) }
    else created = await createVariant(variant, { color: oldColor(source, map) })
  }
  // The source build, for the harness that installs third-party bundles (made now: adopt itself is synchronous).
  const buildDir = build ?? (dryRun ? undefined : await ensureSourceBuild(resolveSourceCommit(sourceRef)))
  const installBundle = (spec) => {
    if (buildDir === undefined) return { ok: true }
    return bundleInstaller(target, readlinkSync(join(buildDir, 'harness')))(spec)
  }
  const report = adopt({
    source, target, dryRun, moveSignIns, map,
    backups: join(deepseaRoot(), '_backups', variant),
    plugins: availablePlugins(pluginRoots(sourceRef)),
    installBundle,
  })
  // What the target had under plugin names from before a rename (lib/migrate-home.mjs).
  const migrated = existsSync(target) ? migrationSummary(migrateHome(target, { dryRun })) : undefined
  printJson({ variant: created ?? { id: variant, existing: true }, ...report, ...(migrated ? { migrated } : {}), next: dryRun ? undefined : `dsd build ${variant} --install` })
}
