#!/usr/bin/env node
/**
 * Assemble the self-contained DeepSea.app and its DMG from the staged pieces:
 *
 *   dist/bundle/stage/   apps/macos/bundle/stage.mjs       harness + plugins, production closure
 *   dist/bundle/node/    apps/macos/bundle/fetch-node.mjs  official Node LTS build
 *   apps/macos/          the wrapper (build.mjs compiles it into the shared cache)
 *   apps/relay/          the relay the app starts (topic/relay; integration/base has it)
 *
 *   node apps/macos/bundle/assemble.mjs [--variant release] [--build N] [--glyph-color #hex]
 *        [--sign IDENTITY] [--update-repo owner/name] [--update-feed URL] [--no-update]
 *        [--ports 3200] [--out DIR] [--inputs DIR] [--relay DIR] [--no-dmg] [--no-prune] [--with-office]
 *
 * The app IS a variant (LAYOUT.md §1): `--variant release` → `DeepSea.app`,
 * bundle id `io.github.taliesinb.deepsea.release`, home `~/.deepsea/release`,
 * port block 3200; `--variant canary` → `DeepSea Canary.app`, …`.canary`,
 * `~/.deepsea/canary`, the block recorded in its variant.yml (default `--ports`).
 * What differs from a `dsd build <v> --install` of the same variant is only
 * where the code lives: inside the bundle, with its own Node, and the relay
 * is started by the app instead of a LaunchAgent (EmbeddedServer.swift). The
 * home, profile, logs and ports are the ones dsd would use, so dsd and the DMG
 * can take a variant over from each other.
 *
 * Contents/Resources:
 *   node/bin/node                      the runtime
 *   deepsea/node_modules/              the staged closure: @deepseek-ai/dsh + every @deepsea plugin
 *   runtime/apps/relay/relay.mjs       the relay (+ runtime/packages/logs it imports)
 *   home-setup.mjs                     run at every launch: home, variant.yml, profile bundles (as dsd installs them)
 *   deepsea-app.json                   the wrapper's config with the `embedded` block (and `update`)
 *   deepsea-release.json               build, versions, plugin list (About panel, release notes)
 *
 * Signing: `--sign -` (default) is ad hoc — Gatekeeper shows "cannot verify" on a
 * downloaded DMG until the user right-clicks → Open once; a `Developer ID
 * Application: …` identity signs for real (notarization is a separate `xcrun
 * notarytool submit` this script does not run). Every Mach-O inside (node, .node
 * addons, helper binaries) is signed too: a hardened-runtime signature over a
 * bundle with unsigned Mach-O files is rejected at launch.
 */
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const MACOS = resolve(HERE, '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
/** Where the .app (and DMG) land; the staged inputs default to dist/bundle regardless (`--inputs DIR` to move them). */
const OUT = resolve(opt('--out', join(REPO, 'dist', 'bundle')))
const INPUTS = resolve(opt('--inputs', join(REPO, 'dist', 'bundle')))
const STAGE = join(INPUTS, 'stage')
const NODE_DIR = join(INPUTS, 'node')
const RELAY_DIR = resolve(opt('--relay', join(REPO, 'apps', 'relay')))
/** The harness build (for the whale glyph, as dsd takes it): the `harness` link dsd keeps, or `--harness DIR`. */
const HARNESS = resolve(opt('--harness', join(REPO, 'harness')))
const GLYPH_SVG = join(HARNESS, 'apps', 'web', 'public', 'favicon.svg')
/** The variant this app is (LAYOUT.md §1): name, bundle id, home and ports all follow from it. */
const VARIANT = opt('--variant', 'release')
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(VARIANT) || /-[0-9a-f]{6}$/.test(VARIANT)) throw new Error(`--variant ${VARIANT}: lowercase letters, digits and single dashes, not ending in six hex digits`)
const ROOT_ID = 'io.github.taliesinb.deepsea'
const BUNDLE_ID = `${ROOT_ID}.${VARIANT}`
/** `release` → DeepSea; `canary` → DeepSea Canary (dsd's displayName). */
const NAME = VARIANT === 'release' ? 'DeepSea' : `DeepSea ${VARIANT.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')}`
/** Black whale for the release, like the shipped GUI; red for canaries unless told otherwise. */
const GLYPH = opt('--glyph-color', VARIANT === 'release' ? '#000000' : '#D93025')
/** The default port block (LAYOUT.md §7: ten ports; dsh web +0, relay +3, proxy +4); variant.yml wins at run time. */
const PORTS = Number(opt('--ports', VARIANT === 'release' ? '3200' : '3210'))
const SIGN = opt('--sign', '-')
const DMG = !args.includes('--no-dmg')
const PRUNE = !args.includes('--no-prune')
const WITH_OFFICE = args.includes('--with-office')
/** `--no-update` leaves the update block out (a throwaway build must not replace itself with a release). */
const UPDATES = !args.includes('--no-update')
/** GitHub owner/repo whose Releases the app polls for updates (Updater.swift); the channel is the variant. */
const REPO_SLUG = opt('--update-repo', 'taliesinb/deepsea')

const wrapper = await import(pathToFileURL(join(MACOS, 'build.mjs')).href)

function log(msg) { process.stderr.write(`[assemble] ${msg}\n`) }
const readJson = async p => JSON.parse(await readFile(p, 'utf8'))

/**
 * App identity: a BUILD number (integer, CFBundleVersion, what the updater
 * compares — `--build 2026092401`, default 0 = "dev build, every release is
 * newer") and a calver display version derived from it (`2026.9.24`, or
 * `2026.9.24.2` for the day's second build; `--version` overrides). The fork's
 * own version and the repo SHA go into the release manifest and
 * CFBundleGetInfoString, not into the comparison.
 */
async function version() {
  const build = Number(opt('--build', '0'))
  if (!Number.isSafeInteger(build) || build < 0) throw new Error(`--build must be a non-negative integer, got ${opt('--build')}`)
  const stage = await readJson(join(STAGE, 'package.json'))
  const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO })
  let short = opt('--version')
  if (!short) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(String(build))
    short = m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}${Number(m[4]) > 1 ? `.${Number(m[4])}` : ''}` : '0.0.0'
  }
  return { build, short, full: `${short} (build ${build}, harness ${stage.version}, ${stdout.trim()})` }
}

/** Every Mach-O inside the resources that must carry a signature of its own. */
async function machOFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) out.push(...await machOFiles(path))
    else if (entry.name.endsWith('.node') || entry.name.endsWith('.dylib') || path.endsWith('/bin/node')
      || path.endsWith('/rg') || path.endsWith('/spawn-helper') || path.endsWith('/landlock-run')) out.push(path)
  }
  return out
}

/**
 * Drop what the runtime never reads (measured 2026-09-23 on the 640 MB tree):
 * declarations 41 MB, source maps 46 MB, TypeScript sources 42 MB, READMEs
 * 8 MB, test dirs 10 MB, node-pty's other-platform prebuilds 24 MB, three.js
 * examples/src 29 MB (the wolfram client bundle inlines its own copy), and —
 * unless --with-office — the 259 MB native LibreOffice engine behind Office →
 * PDF previews (dsh-office-to-pdf creates its converter lazily on first use,
 * so boot is unaffected; a preview then reports the engine as unavailable).
 * Mirrors upstream's apps/desktop/scripts/runtime-file-policy.ts in spirit.
 */
async function prune(root) {
  let files = 0, bytes = 0
  const dropFile = async (path) => { bytes += (await stat(path)).size; files++; await rm(path, { force: true }) }
  const dropDir = async (path) => {
    const out = await execFileAsync('du', ['-sk', path]).catch(() => null)
    if (!out) return
    bytes += Number(out.stdout.split('\t')[0]) * 1024; files++
    await rm(path, { recursive: true, force: true })
  }
  const platform = `${process.platform}-${process.arch}`
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (/^(?:test|tests|__tests__|testdata|\.github)$/.test(entry.name)) { await dropDir(path); continue }
        if (dir.endsWith('/node-pty/prebuilds') && entry.name !== platform) { await dropDir(path); continue }
        if (dir.endsWith('/node_modules/three') && (entry.name === 'examples' || entry.name === 'src')) { await dropDir(path); continue }
        await walk(path)
        continue
      }
      if (/\.(?:d\.[mc]?ts|map|tsbuildinfo)$/.test(entry.name)) { await dropFile(path); continue }
      // Only documentation by name: SKILL.md, preset guides and chrome-devtools-mcp's
      // issue descriptions are runtime data (measured), so `*.md` wholesale is wrong.
      if (/^(?:README|CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|UPGRADING|MIGRATION)[^/]*\.md$/i.test(entry.name)) { await dropFile(path); continue }
      // Plain .ts sources (never .d.ts, handled above): the runtime is built JavaScript throughout.
      if (/\.[mc]?ts$/.test(entry.name) && !dir.includes('/node_modules/typescript/')) { await dropFile(path); continue }
    }
  }
  await walk(root)
  if (!WITH_OFFICE) {
    for (const name of await readdir(join(root, '@deepseek-ai'))) {
      if (/^libreoffice-kit-(?:darwin|win32|linux)-|^libreoffice-kit-wasm$/.test(name)) await dropDir(join(root, '@deepseek-ai', name))
    }
  }
  log(`pruned ${files} entries, ${(bytes / 1024 / 1024).toFixed(0)} MB`)
}

/** Compile an apps/macos/Tools/*.swift helper on demand (cached by mtime beside the wrapper's compile cache). */
async function swiftTool(name) {
  const source = join(MACOS, 'Tools', `${name}.swift`)
  const cache = join(opt('--cache', join(process.env.HOME ?? '', '.deepsea', '_builds')), 'macos-tools')
  const binary = join(cache, name)
  const mtime = async p => (await stat(p).catch(() => null))?.mtimeMs ?? 0
  if (await mtime(binary) < await mtime(source)) {
    log(`compiling ${name}`)
    await mkdir(cache, { recursive: true })
    await execFileAsync('/usr/bin/xcrun', ['swiftc', '-O', '-o', binary, source, '-framework', 'Cocoa'], { maxBuffer: 8 * 1024 * 1024 })
  }
  return binary
}

/**
 * Finder writes the volume's .DS_Store: icon view, backdrop, positions. Runs
 * through osascript against the mounted read-write image; Finder must be
 * running (it always is on a logged-in desktop). Positions are icon centres
 * in the 660×400 content area, matching the backdrop's arrow and caption.
 */
async function layoutDmgWindow(mount, appName) {
  const volume = mount.split('/').pop()
  const script = `
    tell application "Finder"
      tell disk "${volume}"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set pathbar visible of container window to false
        set sidebar width of container window to 0
        set the bounds of container window to {200, 120, 860, 520}
        set theOptions to the icon view options of container window
        set arrangement of theOptions to not arranged
        set icon size of theOptions to 128
        set text size of theOptions to 13
        set background picture of theOptions to file ".background:backdrop.png"
        set position of item "${appName}" of container window to {180, 190}
        set position of item "Applications" of container window to {480, 190}
        close
        open
        update without registering applications
        delay 2
        close
      end tell
    end tell`
  await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 60000 })
}

/**
 * The .dmg FILE's own icon — what Downloads and the Desktop show before the
 * double-click. Embedded INSIDE the UDIF container with `hdiutil udifrez`
 * (the slot license agreements live in), as resource type `icns` id -16455,
 * which Finder reads as the file's custom icon. Being file bytes it survives
 * HTTP downloads, VirtioFS shares and every copy — unlike a resource-fork
 * icon (`NSWorkspace.setIcon`), which is an xattr and is stripped by all of
 * those (measured 2026-09-29: xattr -c + byte copy, icon stays).
 */
async function embedDmgIcon(dmg, icns) {
  const plist = join(OUT, 'dmg-icon-rez.plist')
  const data = await readFile(icns)
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>icns</key><array><dict>
<key>Attributes</key><string>0x0000</string>
<key>Data</key><data>${data.toString('base64')}</data>
<key>ID</key><string>-16455</string>
<key>Name</key><string>${NAME}</string>
</dict></array></dict></plist>
`
  await writeFile(plist, xml)
  await execFileAsync('/usr/bin/hdiutil', ['udifrez', '-xml', plist, '', '-quiet', dmg], { maxBuffer: 16 * 1024 * 1024 })
  await rm(plist, { force: true })
}

/** SetFile is Xcode's (CLT lacks it); without it the icon file is still there, just not shown on the volume. */
async function setVolumeIconFlag(mount) {
  const setFile = await execFileAsync('/usr/bin/xcrun', ['--find', 'SetFile']).then(r => r.stdout.trim()).catch(() => null)
  if (!setFile) { log('SetFile not found (needs Xcode): the volume icon flag is not set'); return }
  await execFileAsync(setFile, ['-t', 'icns', '-c', 'MACS', join(mount, '.VolumeIcon.icns')])
  await execFileAsync(setFile, ['-a', 'C', mount])                       // custom icon on the volume root
  await execFileAsync(setFile, ['-a', 'V', join(mount, '.background')])  // invisible in older Finders too
}

async function main() {
  const stagePkg = await readJson(join(STAGE, 'package.json'))
  const nodeInfo = await readJson(join(NODE_DIR, 'current.json'))
  const ver = await version()
  if (!(await stat(join(RELAY_DIR, 'relay.mjs')).catch(() => null))) throw new Error(`no relay at ${RELAY_DIR} (apps/relay is topic/relay; build from integration/base, or pass --relay DIR)`)
  const app = join(OUT, `${NAME}.app`)
  const contents = join(app, 'Contents')
  const resources = join(contents, 'Resources')
  const plugins = stagePkg.dshBundle.plugins
  log(`building ${app} (${ver.full}, node ${nodeInfo.version}, ${plugins.length} plugins)`)

  // The wrapper exactly as dsd builds it for this variant (compiled into the shared cache), then the runtime inside.
  await rm(app, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  const built = wrapper.build({
    out: OUT, name: NAME, bundleId: BUNDLE_ID, glyph: GLYPH_SVG,
    glyphColor: GLYPH, url: `http://127.0.0.1:${PORTS + 3}/`, fallbackUrl: `http://127.0.0.1:${PORTS + 3}/`,
    version: ver.short, build: String(ver.build), cache: opt('--cache', join(process.env.HOME ?? '', '.deepsea', '_builds')),
  })
  const icns = join(resources, 'AppIcon.icns')

  log('copying node')
  await mkdir(join(resources, 'node', 'bin'), { recursive: true })
  await cp(join(NODE_DIR, nodeInfo.dir, 'bin', 'node'), join(resources, 'node', 'bin', 'node'))
  await cp(join(NODE_DIR, nodeInfo.dir, 'LICENSE'), join(resources, 'node', 'LICENSE'))
  if (PRUNE) {
    // The official binary carries local symbols (121 → 97 MB). Stripping invalidates its
    // signature (SIGKILL on launch) — it is re-signed with everything else below.
    await execFileAsync('/usr/bin/strip', ['-x', join(resources, 'node', 'bin', 'node')])
  }

  log('copying the staged installation')
  await mkdir(join(resources, 'deepsea'), { recursive: true })
  await cp(join(STAGE, 'package.json'), join(resources, 'deepsea', 'package.json'))
  // node_modules is hoisted (no links out of the tree); copy dereferences the few pnpm-internal symlinks.
  await cp(join(STAGE, 'node_modules'), join(resources, 'deepsea', 'node_modules'), { recursive: true, dereference: true, verbatimSymlinks: false })
  if (PRUNE) await prune(join(resources, 'deepsea', 'node_modules'))

  // The relay, with the one package it imports by relative path (../../packages/logs).
  await mkdir(join(resources, 'runtime', 'apps', 'relay'), { recursive: true })
  await cp(join(RELAY_DIR, 'relay.mjs'), join(resources, 'runtime', 'apps', 'relay', 'relay.mjs'))
  await cp(join(RELAY_DIR, 'package.json'), join(resources, 'runtime', 'apps', 'relay', 'package.json'))
  await mkdir(join(resources, 'runtime', 'packages', 'logs'), { recursive: true })
  await cp(join(RELAY_DIR, '..', '..', 'packages', 'logs', 'index.mjs'), join(resources, 'runtime', 'packages', 'logs', 'index.mjs'))
  await cp(join(HERE, 'home-setup.mjs'), join(resources, 'home-setup.mjs'))

  // The wrapper's config, now with the embedded block EmbeddedServer.swift reads. url/fallbackUrl/tokenFile
  // are placeholders for the default block: the app recomputes them from variant.yml at launch.
  const config = {
    name: NAME,
    url: `http://127.0.0.1:${PORTS + 3}/`,
    fallbackUrl: `http://127.0.0.1:${PORTS + 3}/`,
    glyphColor: GLYPH,
    embedded: {
      variant: VARIANT,
      ports: PORTS,
      node: 'node/bin/node',
      dsh: 'deepsea/node_modules/@deepseek-ai/dsh/lib/bin.js',
      relay: 'runtime/apps/relay/relay.mjs',
      homeSetup: 'home-setup.mjs',
      proxy: plugins.some(p => p.name === '@deepsea/tailscale'),
    },
    ...(UPDATES ? { update: { repo: REPO_SLUG, channel: VARIANT, intervalHours: 6, feed: opt('--update-feed') ?? null } } : {}),
  }
  await writeFile(join(resources, 'deepsea-app.json'), JSON.stringify(config, null, 2) + '\n')
  await writeFile(join(resources, 'deepsea-release.json'), JSON.stringify({
    variant: VARIANT, build: ver.build, version: ver.short, harness: stagePkg.version, node: nodeInfo.version, plugins, builtAt: new Date().toISOString(),
  }, null, 2) + '\n')

  // One instance per variant (its home and ports are one), and the full version string for Get Info.
  let plist = await readFile(join(contents, 'Info.plist'), 'utf8')
  plist = plist.replace('<key>NSHighResolutionCapable</key>',
    `<key>LSMultipleInstancesProhibited</key><true/>\n  <key>CFBundleGetInfoString</key><string>${ver.full}</string>\n  <key>NSHighResolutionCapable</key>`)
  await writeFile(join(contents, 'Info.plist'), plist)

  log(`signing (${SIGN === '-' ? 'ad-hoc' : SIGN})`)
  const inner = await machOFiles(resources)
  for (const file of inner) {
    await execFileAsync('/usr/bin/codesign', ['--force', '--sign', SIGN, ...(SIGN === '-' ? [] : ['--options', 'runtime', '--timestamp']), file])
  }
  await execFileAsync('/usr/bin/codesign', ['--force', '--sign', SIGN, '--identifier', BUNDLE_ID, ...(SIGN === '-' ? [] : ['--options', 'runtime', '--timestamp']), app])
  await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  const size = (await execFileAsync('du', ['-sh', app])).stdout.split('\t')[0]
  log(`app ready: ${app} (${size}, ${inner.length} inner Mach-O files signed)`)

  if (DMG) {
    const dmg = join(OUT, `${NAME.replace(/\s+/g, '-')}-${ver.short}${ver.build ? `-${ver.build}` : ''}.dmg`)
    const staging = join(OUT, 'dmg-root')
    await rm(staging, { recursive: true, force: true })
    await rm(dmg, { force: true })
    await mkdir(staging, { recursive: true })
    await cp(app, join(staging, `${NAME}.app`), { recursive: true, verbatimSymlinks: true })
    await symlink('/Applications', join(staging, 'Applications'))
    // Window dressing: a rendered backdrop (whale watermark, arrow, caption) in
    // a hidden folder, and Finder's view settings — icon size, the two icon
    // positions, no sidebar/toolbar, 660×400 — written into the volume's .DS_Store
    // by Finder itself while a read-write image is mounted. Then the image is
    // converted to the compressed read-only DMG. The coordinates match
    // Tools/make-dmg-background.swift.
    await mkdir(join(staging, '.background'), { recursive: true })
    await execFileAsync(await swiftTool('make-dmg-background'), [GLYPH_SVG, join(staging, '.background', 'backdrop.png'), '--glyph-color', GLYPH, '--name', NAME])
    // The disk-image icon (a drive slab wearing the app tile): the volume's icon and,
    // stamped as a Finder custom icon, the .dmg file's own — what Downloads shows.
    const dmgIcon = join(OUT, 'dmg-icon.icns')
    await execFileAsync(await swiftTool('make-dmg-icon'), ['render', icns, dmgIcon])
    log('creating the DMG')
    const rw = join(OUT, 'dmg-rw.dmg')
    await rm(rw, { force: true })
    // Volume name carries the version so a mounted image is never confused with the installed app.
    const volume = `${NAME} ${ver.short}`
    await execFileAsync('/usr/bin/hdiutil', ['create', '-volname', volume, '-srcfolder', staging, '-ov', '-format', 'UDRW', '-fs', 'APFS', rw], { maxBuffer: 16 * 1024 * 1024 })
    const attach = await execFileAsync('/usr/bin/hdiutil', ['attach', '-readwrite', '-noverify', '-nobrowse', rw])
    const mount = attach.stdout.split('\n').map(l => l.split('\t').pop()?.trim()).find(p => p?.startsWith('/Volumes/'))
    if (!mount) throw new Error(`hdiutil attach: no mount point in\n${attach.stdout}`)
    try {
      await layoutDmgWindow(mount, `${NAME}.app`)
      // The mounted volume (Desktop, sidebar, and the .dmg file once Finder has seen
      // it) wears the app icon. Copied onto the mounted image AFTER the Finder layout:
      // both `hdiutil create -srcfolder` and Finder's view-settings pass drop a
      // root-level .VolumeIcon.icns (measured 2026-09-29, in that order).
      await cp(dmgIcon, join(mount, '.VolumeIcon.icns'))
      // Finder ignores the icon while the file carries com.apple.provenance (added by
      // the copy) — strip xattrs, then the classic type/creator on the file and the
      // custom-icon flag on the root. Measured 2026-09-29: with provenance → generic
      // drive; without → the whale.
      await execFileAsync('/usr/bin/xattr', ['-c', join(mount, '.VolumeIcon.icns')])
      await setVolumeIconFlag(mount)
      if (!(await stat(join(mount, '.VolumeIcon.icns')).catch(() => null))) throw new Error('.VolumeIcon.icns did not survive on the mounted image')
    } finally {
      await execFileAsync('/usr/bin/hdiutil', ['detach', mount, '-quiet']).catch(async () => { await new Promise(r => setTimeout(r, 2000)); await execFileAsync('/usr/bin/hdiutil', ['detach', mount, '-force', '-quiet']) })
    }
    await execFileAsync('/usr/bin/hdiutil', ['convert', rw, '-format', 'ULMO', '-o', dmg, '-ov'], { maxBuffer: 16 * 1024 * 1024 })
    await rm(rw, { force: true })
    await embedDmgIcon(dmg, dmgIcon)
    await rm(staging, { recursive: true, force: true })
    const dmgSize = (await stat(dmg)).size
    log(`dmg ready: ${dmg} (${(dmgSize / 1024 / 1024).toFixed(0)} MB)`)
    process.stdout.write(dmg + '\n')
  } else {
    process.stdout.write(app + '\n')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
