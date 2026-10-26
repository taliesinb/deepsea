#!/usr/bin/env node
/**
 * Build one variant's DeepSea.app (plain Node, no dependencies; Command Line
 * Tools' swiftc, no Xcode):
 *
 *   node apps/macos/build.mjs --out <dir> --name <display name> --bundle-id <variant name>
 *     --glyph <svg> [--glyph-color #hex] [--tile-color #hex] [--url <url>] [--fallback-url <url>]
 *     [--token-file <path>] [--version <x.y.z>] [--build <id>] [--cache <dir>]
 *
 * Writes `<out>/<name>.app` and prints `{ app, executable, bundleId, compiled }`
 * as JSON. The server host (ServerHost/, LAYOUT.md §6) is installed with
 *
 *   node apps/macos/build.mjs server-host --dir <Application Support dir> --name "DeepSea <V> Server"
 *     --bundle-id <variant name>.server [--icon <AppIcon.icns>] [--cache <dir>]
 *
 * which replaces the bundle only when its executable, Info.plist or icon
 * changed, so its signature, and the privacy grants macOS ties to it, survive
 * reinstalls; it prints `{ bundle, executable, changed }`. The executable and the icon renderer are compiled once per source
 * hash into `<cache>/macos-<12 hex>/` (default: a directory in $TMPDIR), so
 * every variant and every throwaway reuses them; icons are cached per colour.
 * The bundle: Info.plist, the executable `DeepSea`, the icon, the page scripts
 * and `deepsea-app.json` (name, url, fallbackUrl, tokenFile, glyphColor), signed
 * ad hoc with the bundle id as its identifier.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const EXECUTABLE = 'DeepSea'
export const HOST_EXECUTABLE = 'deepsea-server-host'
const FRAMEWORKS = ['Cocoa', 'WebKit', 'Network']
const MIN_MACOS = '13.0'

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The bundle's Info.plist. */
export function infoPlist({ name, bundleId, version = '0.0.0', build = '0' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${xml(name)}</string>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>${xml(bundleId)}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${xml(name)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xml(version)}</string>
  <key>CFBundleVersion</key><string>${xml(build)}</string>
  <key>LSMinimumSystemVersion</key><string>${MIN_MACOS}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
`
}

/** The source files a compile depends on, sorted. */
function sources() {
  const dir = join(HERE, 'Sources')
  return readdirSync(dir).filter(n => n.endsWith('.swift')).sort().map(n => join(dir, n))
}

/** A hash of the sources, the icon tool, the compiler and the target: one compile per value. */
export function sourceHash(files, compiler, target) {
  const hash = createHash('sha256')
  hash.update(`${compiler}\n${target}\n`)
  for (const file of files) hash.update(`${file.slice(HERE.length)}\n`).update(readFileSync(file)).update('\n')
  return hash.digest('hex').slice(0, 12)
}

const swiftc = (args) => execFileSync('/usr/bin/xcrun', ['swiftc', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })

/** Compile the executable and the icon renderer into `<cache>/macos-<hash>/` unless they are there. */
export function compile(cache) {
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos${MIN_MACOS}`
  const compiler = execFileSync('/usr/bin/xcrun', ['swiftc', '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n')[0]
  const files = sources()
  const icon = join(HERE, 'Tools', 'make-icon.swift')
  const host = join(HERE, 'ServerHost', 'main.swift')
  const dir = join(cache, `macos-${sourceHash([...files, icon, host], compiler, target)}`)
  const executable = join(dir, EXECUTABLE)
  const iconTool = join(dir, 'make-icon')
  const hostExecutable = join(dir, HOST_EXECUTABLE)
  if (existsSync(executable) && existsSync(iconTool) && existsSync(hostExecutable)) return { dir, executable, iconTool, hostExecutable, compiled: false }
  // Build beside, then rename: a second builder of the same hash finds a complete directory or none.
  const work = `${dir}.tmp-${process.pid}`
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  try {
    swiftc(['-O', '-target', target, '-o', join(work, EXECUTABLE), ...files, ...FRAMEWORKS.flatMap(f => ['-framework', f])])
    swiftc(['-O', '-target', target, '-o', join(work, 'make-icon'), icon, '-framework', 'Cocoa'])
    swiftc(['-O', '-target', target, '-o', join(work, HOST_EXECUTABLE), host])
  } catch (error) {
    rmSync(work, { recursive: true, force: true })
    throw new Error(`swiftc failed:\n${String(error.stderr || error.message).trim().split('\n').slice(-30).join('\n')}`)
  }
  try { renameSync(work, dir) } catch { rmSync(work, { recursive: true, force: true }) }
  return { dir, executable, iconTool, hostExecutable, compiled: true }
}

/** The icon for a glyph and colours, rendered once into the compile directory. */
function icon({ dir, iconTool }, glyph, glyphColor, tileColor) {
  const tag = createHash('sha256').update(readFileSync(glyph)).update(`${glyphColor}/${tileColor}`).digest('hex').slice(0, 12)
  const icns = join(dir, `AppIcon-${tag}.icns`)
  if (existsSync(icns)) return icns
  const iconset = join(dir, `AppIcon-${tag}-${process.pid}.iconset`)
  execFileSync(iconTool, [glyph, iconset, '--glyph-color', glyphColor, '--tile-color', tileColor], { stdio: 'ignore' })
  const out = join(dir, `AppIcon-${tag}.tmp-${process.pid}.icns`)  // iconutil wants the .icns extension
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', out], { stdio: 'ignore' })
  rmSync(iconset, { recursive: true, force: true })
  renameSync(out, icns)
  return icns
}

/** Assemble and sign `<out>/<name>.app`. */
export function build(options) {
  for (const key of ['out', 'name', 'bundleId', 'glyph']) if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} is required`)
  if (!/^[A-Za-z0-9.-]+$/.test(options.bundleId)) throw new Error(`bad bundle id ${options.bundleId}`)
  if (!existsSync(options.glyph)) throw new Error(`no glyph at ${options.glyph}`)
  const cache = options.cache ?? join(tmpdir(), 'deepsea-macos-builds')
  mkdirSync(cache, { recursive: true })
  const compiled = compile(cache)
  const glyphColor = options.glyphColor ?? '#000000'
  const icns = icon(compiled, options.glyph, glyphColor, options.tileColor ?? '#ffffff')

  const app = join(options.out, `${options.name}.app`)
  rmSync(app, { recursive: true, force: true })
  const contents = join(app, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  mkdirSync(join(contents, 'Resources'), { recursive: true })
  writeFileSync(join(contents, 'Info.plist'), infoPlist({ name: options.name, bundleId: options.bundleId, version: options.version, build: options.build }))
  writeFileSync(join(contents, 'PkgInfo'), 'APPL????')
  copyFileSync(compiled.executable, join(contents, 'MacOS', EXECUTABLE))
  chmodSync(join(contents, 'MacOS', EXECUTABLE), 0o755)
  copyFileSync(icns, join(contents, 'Resources', 'AppIcon.icns'))
  for (const script of ['desktop-branding.js', 'element-inspector.js']) copyFileSync(join(HERE, 'Resources', script), join(contents, 'Resources', script))
  const config = { name: options.name, url: options.url ?? 'http://127.0.0.1:3200/', glyphColor }
  if (options.fallbackUrl) config.fallbackUrl = options.fallbackUrl
  if (options.tokenFile) config.tokenFile = options.tokenFile
  writeFileSync(join(contents, 'Resources', 'deepsea-app.json'), `${JSON.stringify(config, null, 2)}\n`)
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', options.bundleId, app], { stdio: ['ignore', 'ignore', 'pipe'] })
  return { app, executable: join(contents, 'MacOS', EXECUTABLE), bundleId: options.bundleId, compiled: compiled.compiled }
}

/** Privacy usage keys the server host declares, so macOS asks on its behalf (one shared purpose string). */
const USAGE_KEYS = ['NSAppleEventsUsageDescription', 'NSAppleMusicUsageDescription', 'NSBluetoothAlwaysUsageDescription',
  'NSCalendarsUsageDescription', 'NSCalendarsFullAccessUsageDescription', 'NSCameraUsageDescription', 'NSContactsUsageDescription',
  'NSDesktopFolderUsageDescription', 'NSDocumentsFolderUsageDescription', 'NSDownloadsFolderUsageDescription',
  'NSFileProviderDomainUsageDescription', 'NSLocalNetworkUsageDescription', 'NSLocationUsageDescription',
  'NSLocationWhenInUseUsageDescription', 'NSMicrophoneUsageDescription', 'NSNetworkVolumesUsageDescription',
  'NSPhotoLibraryUsageDescription', 'NSRemindersUsageDescription', 'NSRemindersFullAccessUsageDescription',
  'NSRemovableVolumesUsageDescription', 'NSSpeechRecognitionUsageDescription', 'NSSystemAdministrationUsageDescription']
const PURPOSE = 'An agent running in DeepSea is asking for this.'

/** The server host's Info.plist. */
export function serverHostPlist({ name, bundleId, icon }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${xml(name)}</string>
  <key>CFBundleExecutable</key><string>${HOST_EXECUTABLE}</string>
${icon ? '  <key>CFBundleIconFile</key><string>AppIcon</string>\n' : ''}  <key>CFBundleIdentifier</key><string>${xml(bundleId)}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${xml(name)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSBackgroundOnly</key><true/>
  <key>LSMinimumSystemVersion</key><string>${MIN_MACOS}</string>
${USAGE_KEYS.map(key => `  <key>${key}</key><string>${PURPOSE}</string>`).join('\n')}
</dict>
</plist>
`
}

/** A validly signed bundle's code-directory hash (what macOS ties privacy grants to), or undefined. */
function cdhash(bundle) {
  if (!existsSync(bundle) || spawnSync('/usr/bin/codesign', ['--verify', bundle]).status !== 0) return undefined
  // codesign -d reports on stderr.
  return /CDHash=([0-9a-f]+)/.exec(spawnSync('/usr/bin/codesign', ['-dvvv', bundle], { encoding: 'utf8' }).stderr)?.[1]
}

/**
 * Install `<dir>/<name>.app`, the server host. The new bundle is assembled and signed beside the old one
 * (ad-hoc signing is deterministic) and swapped in only when its code-directory hash differs, so the
 * privacy grants macOS ties to that hash survive a reinstall of the same code. Returns
 * `{ bundle, executable, changed }`.
 */
export function installServerHost(options) {
  for (const key of ['dir', 'name', 'bundleId']) if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} is required`)
  if (!/^[A-Za-z0-9.-]+$/.test(options.bundleId)) throw new Error(`bad bundle id ${options.bundleId}`)
  const cache = options.cache ?? join(tmpdir(), 'deepsea-macos-builds')
  mkdirSync(cache, { recursive: true })
  const compiled = compile(cache)
  const bundle = join(options.dir, `${options.name}.app`)
  const executable = join(bundle, 'Contents', 'MacOS', HOST_EXECUTABLE)
  mkdirSync(options.dir, { recursive: true })
  // Staged beside its destination: the swap is a rename on one volume.
  const staging = `${bundle}.staging-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  try {
    mkdirSync(join(staging, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(staging, 'Contents', 'Info.plist'), serverHostPlist({ name: options.name, bundleId: options.bundleId, icon: Boolean(options.icon) }))
    writeFileSync(join(staging, 'Contents', 'PkgInfo'), 'APPL????')
    copyFileSync(compiled.hostExecutable, join(staging, 'Contents', 'MacOS', HOST_EXECUTABLE))
    chmodSync(join(staging, 'Contents', 'MacOS', HOST_EXECUTABLE), 0o755)
    if (options.icon) {
      mkdirSync(join(staging, 'Contents', 'Resources'), { recursive: true })
      copyFileSync(options.icon, join(staging, 'Contents', 'Resources', 'AppIcon.icns'))
    }
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', options.bundleId, staging], { stdio: ['ignore', 'ignore', 'pipe'] })
    const installed = cdhash(bundle)
    if (installed !== undefined && installed === cdhash(staging)) return { bundle, executable, changed: false }
    // A running job keeps its mapped image, so replacing the bundle under it is safe.
    rmSync(bundle, { recursive: true, force: true })
    renameSync(staging, bundle)
    return { bundle, executable, changed: true }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** `--kebab-case value` arguments → `{ camelCase: value }`. */
export function parseCommandLine(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--') || i + 1 >= argv.length) throw new Error(`unexpected argument ${arg}`)
    out[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i]
  }
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.platform !== 'darwin') { process.stderr.write('build.mjs: macOS only\n'); process.exit(1) }
  try {
    const argv = process.argv.slice(2)
    const result = argv[0] === 'server-host' ? installServerHost(parseCommandLine(argv.slice(1))) : build(parseCommandLine(argv))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`build.mjs: ${error.message}\n`)
    process.exit(1)
  }
}
