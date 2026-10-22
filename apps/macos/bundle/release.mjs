#!/usr/bin/env node
/**
 * Cut a release of the bundled app: build number → DMG → sha256 → GitHub Release.
 *
 *   node apps/macos/bundle/release.mjs [--variant release] [--repo owner/name] [--notes "text"]
 *                                      [--draft] [--dry-run] [--skip-pack] [--no-build] [--build N]
 *
 * The variant is the release channel (Updater.swift): tags are
 * `<variant>-<build>`, so `DeepSea.app` (variant `release`) and a `DeepSea
 * Canary.app` publish side by side in one repository and neither replaces
 * itself with the other's builds. Only the `release` channel is marked
 * "Latest" on GitHub; every other channel passes `--latest=false`.
 *
 * Build number: `YYYYMMDDnn` in UTC, nn = 01 + the number of this channel's
 * tags from the same day (two releases a day give …01 and …02); it is what the
 * updater compares as an integer against CFBundleVersion.
 *
 * Assets: `<Name-with-dashes>-<version>-<build>.dmg` and `<same>.sha256` (hex
 * digest, two spaces, filename — `shasum -a 256` format; the updater reads the
 * first word). Notes: --notes, else the commit subjects since the channel's
 * previous tag.
 *
 * Needs `gh` logged in with push rights, the harness build dsd links at
 * `<repo>/harness`, apps/relay (topic/relay; integration/base has it), the
 * network. --dry-run builds everything and prints the `gh release create`
 * command instead of running it. hdiutil cannot run inside a DSH file sandbox.
 */
import { execFile, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_DIR = resolve(HERE, '..', '..', '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const REPO = opt('--repo', 'taliesinb/deepsea')
const VARIANT = opt('--variant', 'release')
const DRY = args.includes('--dry-run')
const DRAFT = args.includes('--draft')
const OUT = join(REPO_DIR, 'dist', 'bundle')
const NAME = VARIANT === 'release' ? 'DeepSea' : `DeepSea ${VARIANT.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')}`

function log(msg) { process.stderr.write(`[release] ${msg}\n`) }
async function sh(cmd, argv, opts = {}) {
  const { stdout } = await execFileAsync(cmd, argv, { cwd: REPO_DIR, maxBuffer: 64 * 1024 * 1024, ...opts })
  return stdout.trim()
}
async function run(cmd, argv) {
  await new Promise((res, rej) => {
    const child = spawn(cmd, argv, { cwd: REPO_DIR, stdio: 'inherit', env: { ...process.env, npm_config_manage_package_manager_versions: 'false' } })
    child.on('close', code => (code === 0 ? res() : rej(new Error(`${cmd} ${argv.join(' ')} exited ${code}`))))
  })
}
/** The channel's existing release tags on the target repository (via gh: the tags live there, not necessarily here). */
async function existingTags() {
  const out = await sh('gh', ['release', 'list', '--repo', REPO, '--limit', '200', '--json', 'tagName', '--jq', '.[].tagName']).catch(() => null)
  if (out !== null) return out.split('\n').filter(t => t.startsWith(`${VARIANT}-`))
  log('gh release list failed; using local tags')
  return (await sh('git', ['tag', '--list', `${VARIANT}-*`])).split('\n').filter(Boolean)
}

async function main() {
  const tags = await existingTags()
  let build = Number(opt('--build', '0'))
  if (!build) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const today = tags.filter(t => t.startsWith(`${VARIANT}-${day}`)).length
    build = Number(`${day}${String(today + 1).padStart(2, '0')}`)
  }
  const tag = `${VARIANT}-${build}`
  if (tags.includes(tag)) throw new Error(`tag ${tag} already exists`)
  const previous = tags.map(t => Number(t.slice(VARIANT.length + 1))).filter(n => n < build).sort((a, b) => b - a)[0]
  log(`build ${build} (tag ${tag}${previous ? `, previous ${VARIANT}-${previous}` : ', first release of this channel'})`)

  if (!args.includes('--no-build')) {
    await run('node', [join(HERE, 'fetch-node.mjs')])
    await run('node', [join(HERE, 'stage.mjs'), ...(args.includes('--skip-pack') ? ['--skip-pack'] : [])])
    await run('node', [join(HERE, 'assemble.mjs'), '--variant', VARIANT, '--build', String(build), '--update-repo', REPO])
  }
  const manifest = JSON.parse(await readFile(join(OUT, `${NAME}.app`, 'Contents', 'Resources', 'deepsea-release.json'), 'utf8'))
  if (manifest.build !== build) throw new Error(`built app carries build ${manifest.build}, expected ${build} (pass --no-build only after building with --build ${build})`)
  const dmg = join(OUT, `${NAME.replace(/\s+/g, '-')}-${manifest.version}-${build}.dmg`)
  const digest = createHash('sha256').update(await readFile(dmg)).digest('hex')
  const shaFile = `${dmg}.sha256`
  await writeFile(shaFile, `${digest}  ${basename(dmg)}\n`)
  log(`dmg ${basename(dmg)} sha256 ${digest}`)

  let notes = opt('--notes')
  if (!notes) {
    const range = previous ? `${VARIANT}-${previous}..HEAD` : 'HEAD~20..HEAD'
    const subjects = await sh('git', ['log', '--no-merges', '--format=- %s', range]).catch(() => '')
    notes = [
      `${NAME} ${manifest.version} — build ${build}`,
      '',
      `harness ${manifest.harness} · node ${manifest.node} · ${manifest.plugins.length} plugins · ad-hoc signed (first launch: right-click → Open)`,
      '',
      subjects || '- (no commits since the previous release)',
    ].join('\n')
  }
  // The tag can only point at a commit of the repository it is created in: --target when this
  // checkout IS that repository (and the commit is pushed), else GitHub tags the default branch
  // and the built commit goes into the notes.
  const head = await sh('git', ['rev-parse', 'HEAD'])
  const remotes = await sh('git', ['remote', '-v']).catch(() => '')
  const sameRepo = remotes.toLowerCase().includes(REPO.toLowerCase())
  if (sameRepo) {
    const onRemote = await sh('git', ['branch', '-r', '--contains', head]).catch(() => '')
    if (!onRemote && !DRY) throw new Error(`HEAD ${head.slice(0, 7)} is not on any remote branch; git push first so the release tag can point at it`)
  } else {
    notes += `\n\nBuilt from ${head.slice(0, 10)}.`
  }
  const title = `${NAME} ${manifest.version}`
  const ghArgs = ['release', 'create', tag, dmg, shaFile, '--repo', REPO, ...(sameRepo ? ['--target', head] : []), '--title', title, '--notes', notes,
    VARIANT === 'release' ? '--latest' : '--latest=false', ...(DRAFT ? ['--draft'] : [])]
  if (DRY) {
    log(`dry run — would execute:\n  gh ${ghArgs.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
    return
  }
  log(`publishing ${tag} to ${REPO}`)
  await run('gh', ghArgs)
  const url = await sh('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'url', '--jq', '.url'])
  log(`released: ${url}`)
  process.stdout.write(url + '\n')
}

main().catch(err => { console.error(err.message ?? err); process.exit(1) })
