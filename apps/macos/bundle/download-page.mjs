#!/usr/bin/env node
/**
 * download-page — one self-contained HTML page: an icon per app variant, click
 * to download the newest release of that variant. Host it anywhere (it is a
 * single file, icons inlined).
 *
 *   node apps/macos/bundle/download-page.mjs --out downloads.html \
 *     --app "DeepSea|taliesinb/deepsea|release|#000000" \
 *     --app "DeepSea Office|org/private-repo|remote-node-example-ts-net|#0090FF" \
 *     [--title "DeepSea"]
 *
 * Each --app is `name|repo|channel|glyph-color`. The newest non-draft release
 * whose tag starts with `<channel>-` and whose DMG is named `<Name-with-dashes>-…dmg`
 * (the Updater's own two locks) is resolved NOW through `gh api`, and its
 * `browser_download_url` is written into the page — GitHub has no stable
 * "latest of this channel" URL, so the page is regenerated at release time
 * (the release scripts do). Private repos: the link works in a browser signed
 * in to GitHub with access to the repo; a release that cannot be read (no
 * access, or no release yet) renders the tile greyed out, without a link.
 *
 * Icons: the rendition macOS itself draws for the app (Liquid Glass squircle
 * on macOS 26), obtained from the system for a throwaway registered bundle —
 * see iconDataUrl(); 256 px PNG, inlined as data URLs.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'


const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const MACOS = resolve(HERE, '..')
const REPO = resolve(HERE, '..', '..', '..')
/** The whale glyph, from the harness build dsd links (or --harness DIR). */
const GLYPH_SVG = join(resolve(process.argv.includes('--harness') ? process.argv[process.argv.indexOf('--harness') + 1] : join(REPO, 'harness')), 'apps', 'web', 'public', 'favicon.svg')
const args = process.argv.slice(2)
const opt = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback }
const apps = args.flatMap((a, i) => (a === '--app' ? [args[i + 1]] : [])).map(parseApp)
const OUT = resolve(opt('--out', 'downloads.html'))
const TITLE = opt('--title', 'DeepSea')
if (!apps.length) { console.error('usage: download-page.mjs --out FILE --app "Name|owner/repo|channel|#glyph" [--app …]'); process.exit(2) }

function parseApp(spec) {
  const [name, repo, channel, glyph] = spec.split('|').map(s => s.trim())
  if (!name || !repo || !channel) throw new Error(`--app needs "Name|owner/repo|channel[|#glyph]", got ${JSON.stringify(spec)}`)
  return { name, repo, channel, glyph: glyph || '#000000' }
}

/** Mirror of Updater.parse: newest non-draft, non-prerelease release of the channel with a DMG named for the app. */
async function latest({ name, repo, channel }) {
  let releases
  try {
    const { stdout } = await execFileAsync('gh', ['api', `repos/${repo}/releases?per_page=50`], { maxBuffer: 16 * 1024 * 1024 })
    releases = JSON.parse(stdout)
  } catch (e) {
    return { error: `cannot read ${repo}: ${String(e.stderr || e.message).trim().split('\n')[0]}` }
  }
  const prefix = `${channel}-`, dmgPrefix = `${name.replace(/ /g, '-')}-`
  let best = null
  for (const r of releases) {
    if (!r.tag_name?.startsWith(prefix) || r.draft || r.prerelease) continue
    const build = Number(r.tag_name.slice(prefix.length))
    if (!Number.isInteger(build)) continue
    const dmg = (r.assets ?? []).find(a => a.name.endsWith('.dmg') && a.name.startsWith(dmgPrefix))
    if (!dmg) continue
    if (!best || build > best.build) best = { build, version: r.name, url: dmg.browser_download_url, size: dmg.size, published: r.published_at }
  }
  return best ?? { error: `no ${channel} release with a ${dmgPrefix}*.dmg in ${repo}` }
}

/**
 * The icon macOS ITSELF shows for this variant, 256 px PNG as a data URL —
 * not the raw tile: on macOS 26 the system wraps every icon in its own Liquid
 * Glass squircle (tighter corners than the Big Sur tile, a glass highlight on
 * the glyph), and that rendition is what the Dock, Finder and the DMG window
 * draw. It is obtainable only for a REGISTERED bundle (`NSWorkspace.icon(forFile:)`
 * on an unknown .app returns the generic document icon — measured), so a
 * throwaway minimal .app is written with the variant's icns, registered with
 * LaunchServices, rendered, and unregistered again.
 */
async function iconDataUrl(name, glyph) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dl-icon-'))
  const app = join(dir, `${name}.app`)
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  try {
    const iconset = join(dir, 'app.iconset')
    await execFileAsync(await iconToolPath(), [GLYPH_SVG, iconset, '--glyph-color', glyph])
    await execFileAsync('mkdir', ['-p', join(app, 'Contents', 'Resources'), join(app, 'Contents', 'MacOS')])
    await execFileAsync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(app, 'Contents', 'Resources', 'AppIcon.icns')])
    await writeFile(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${esc(name)}</string>
<key>CFBundleIdentifier</key><string>io.github.taliesinb.deepsea.download-page-${name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleExecutable</key><string>stub</string>
</dict></plist>
`)
    await writeFile(join(app, 'Contents', 'MacOS', 'stub'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await execFileAsync(lsregister, ['-f', app])
    const png = join(dir, 'icon.png')
    await execFileAsync(await toolPath('app-icon-png'), [app, png, '--size', '256'])
    return `data:image/png;base64,${(await readFile(png)).toString('base64')}`
  } finally {
    await execFileAsync(lsregister, ['-u', app]).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
}

/** An apps/macos/Tools/<name>.swift helper, compiled on demand into the shared build cache. */
async function toolPath(name) {
  const cache = join(opt('--cache', join(process.env.HOME ?? '', '.deepsea', '_builds')), 'macos-tools')
  const tool = join(cache, name)
  const src = join(MACOS, 'Tools', `${name}.swift`)
  const mtime = async p => (await stat(p).catch(() => null))?.mtimeMs ?? 0
  if (await mtime(tool) < await mtime(src)) {
    await mkdir(cache, { recursive: true })
    await execFileAsync('/usr/bin/xcrun', ['swiftc', '-O', '-o', tool, src, '-framework', 'Cocoa'], { maxBuffer: 8 * 1024 * 1024 })
  }
  return tool
}
const iconToolPath = () => toolPath('make-icon')

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const mb = n => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`

const tiles = []
for (const app of apps) {
  const [rel, icon] = await Promise.all([latest(app), iconDataUrl(app.name, app.glyph)])
  if (rel.error) console.error(`${app.name}: ${rel.error}`)
  else console.error(`${app.name}: ${rel.version} (build ${rel.build}, ${mb(rel.size)})`)
  tiles.push({ ...app, rel, icon })
}

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-content: center; gap: 48px;
         font: 15px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
         background: #f5f5f4; color: #1c1c1e; }
  @media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #f5f5f4; } }
  .apps { display: flex; flex-wrap: wrap; justify-content: center; gap: 40px 56px; padding: 32px; }
  a.app, .app { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 164px;
                text-decoration: none; color: inherit; }
  .app img { width: 128px; height: 128px; transition: transform .12s ease; }
  a.app:hover img { transform: scale(1.06); }
  a.app:active img { transform: scale(.98); }
  .name { font-weight: 600; font-size: 16px; }
  .ver { font-size: 12px; opacity: .55; font-variant-numeric: tabular-nums; }
  .app.off { opacity: .35; filter: grayscale(1); }
</style>
<div class="apps">
${tiles.map(t => t.rel.error
    ? `  <div class="app off" title="${esc(t.rel.error)}"><img src="${t.icon}" alt=""><div class="name">${esc(t.name)}</div><div class="ver">—</div></div>`
    : `  <a class="app" href="${esc(t.rel.url)}" download><img src="${t.icon}" alt=""><div class="name">${esc(t.name)}</div><div class="ver">${esc(t.rel.version.replace(new RegExp(`^${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), ''))} · ${mb(t.rel.size)}</div></a>`,
  ).join('\n')}
</div>
`
await writeFile(OUT, html)
console.error(`wrote ${OUT} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${tiles.length} apps)`)
