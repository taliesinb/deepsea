#!/usr/bin/env node
/**
 * Build DeepSea Window Helper.app, the machine-wide window helper of the
 * browser plugin (plain Node, no dependencies; Command Line Tools' swiftc, no
 * Xcode):
 *
 *   node apps/macos/WindowHelper/build.mjs --out <dir>    # <dir>/DeepSea Window Helper.app
 *   node apps/macos/WindowHelper/build.mjs --install      # into ~/Library/Application Support/io.github.taliesinb.deepsea/
 *
 * Prints `{ app, executable, bundleId, installed? }` as JSON. The bundle id is
 * the bare root `io.github.taliesinb.deepsea` (LAYOUT.md §1): one helper, and
 * one Accessibility grant, for every variant on the Mac. It is a background
 * app (LSUIElement), signed ad hoc with a designated requirement on its
 * identifier, so a rebuild keeps the grant (a plain ad-hoc signature is
 * identified by its code hash, and macOS drops the grant after any rebuild).
 * `--install` replaces the installed copy only when the executable or the
 * Info.plist changed. `build()` and `install()` are exported for dsd.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const APP_NAME = 'DeepSea Window Helper'
export const BUNDLE_ID = 'io.github.taliesinb.deepsea'
export const EXECUTABLE = 'deepsea-window-helper'
const MIN_MACOS = '13.0'

/** `~/Library/Application Support/io.github.taliesinb.deepsea` (LAYOUT.md §6). */
export function installDirectory(home = homedir()) {
  return join(home, 'Library', 'Application Support', BUNDLE_ID)
}

/** Where the plugin looks for the helper by default (its `safari.park.helper`). */
export function installedPath(home = homedir()) {
  return join(installDirectory(home), `${APP_NAME}.app`)
}

/** The bundle's Info.plist. */
export function infoPlist({ version = '1.0' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>${MIN_MACOS}</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`
}

/** Compile main.swift and assemble the signed bundle `<out>/DeepSea Window Helper.app`. */
export function build({ out, version } = {}) {
  if (!out) throw new Error('--out is required')
  const app = join(out, `${APP_NAME}.app`)
  const contents = join(app, 'Contents')
  rmSync(app, { recursive: true, force: true })
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  const executable = join(contents, 'MacOS', EXECUTABLE)
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos${MIN_MACOS}`
  try {
    execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', target, '-o', executable, join(HERE, 'main.swift'), '-framework', 'AppKit', '-framework', 'ApplicationServices'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    rmSync(app, { recursive: true, force: true })
    throw new Error(`swiftc failed:\n${String(error.stderr || error.message).trim().split('\n').slice(-30).join('\n')}`)
  }
  chmodSync(executable, 0o755)
  writeFileSync(join(contents, 'Info.plist'), infoPlist({ version }))
  writeFileSync(join(contents, 'PkgInfo'), 'APPL????')
  // The designated requirement names the identifier, so the Accessibility grant survives rebuilds. Any
  // binary signed ad hoc with this identifier would inherit it: a local concern only.
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', BUNDLE_ID, `-r=designated => identifier "${BUNDLE_ID}"`, app], { stdio: ['ignore', 'ignore', 'pipe'] })
  return { app, executable, bundleId: BUNDLE_ID }
}

/**
 * Build in a scratch directory and install into `dir` (default: the
 * machine-wide Application Support directory), unless the installed copy is
 * the same build.
 */
export function install({ dir = installDirectory(), version } = {}) {
  const scratch = join(tmpdir(), `deepsea-window-helper-${process.pid}`)
  try {
    const built = build({ out: scratch, version })
    const installed = join(dir, `${APP_NAME}.app`)
    const same = (relative) => existsSync(join(installed, relative)) && readFileSync(join(installed, relative)).equals(readFileSync(join(built.app, relative)))
    if (same(`Contents/MacOS/${EXECUTABLE}`) && same('Contents/Info.plist')) return { app: installed, executable: join(installed, 'Contents', 'MacOS', EXECUTABLE), bundleId: BUNDLE_ID, installed: false }
    mkdirSync(dir, { recursive: true })
    rmSync(installed, { recursive: true, force: true })
    cpSync(built.app, installed, { recursive: true, verbatimSymlinks: true })
    return { app: installed, executable: join(installed, 'Contents', 'MacOS', EXECUTABLE), bundleId: BUNDLE_ID, installed: true }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.platform !== 'darwin') { process.stderr.write('build.mjs: macOS only\n'); process.exit(1) }
  const argv = process.argv.slice(2)
  const value = (name) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined }
  try {
    const result = argv.includes('--install') ? install({ version: value('--version') }) : build({ out: value('--out'), version: value('--version') })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`build.mjs: ${error.message}\n`)
    process.exit(1)
  }
}
