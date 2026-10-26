// LIVE, Safari Technology Preview and the screen: do pages in covered automation windows keep running?
// Covers the screen with an opaque test window for a few seconds per scenario and opens STP windows; do
// not click meanwhile (the focus check fails if you do). Run it in a session where the person expects it.
//
//   node scripts/live-parking.mjs [--browser safari|chrome] [--cover zoomed|screen|left:F|inset:N]
//                                 [--borderless] [--screen main|widest|N] [--activate | --no-raise]
//
// The page (animation-page.mjs) shows its form only after a Vue-style requestAnimationFrame +
// CSS-transition layout swap, with CSS-animation, Web-Animations and rAF probes beside it. Before each of
// five scenarios (opened while covered, navigate while covered, a second window, the first window under
// the second, a reload by the page itself) the occluder (occluder-app.swift, compiled into
// $TMPDIR/deepsea-browser-occluder-…) takes the front, then the plugin's real tools act and the run
// waits up to 8 s for every probe. The hidden-window remedy is park (default; the occluder must keep
// keyboard focus), --activate, or --no-raise (off: shows the failure). Chrome passes either way.
// With --trace, the plugin's trace goes to the variant's log directory (@deepsea/logs).
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.js'
import { fakeAgent, fakeCtx } from '../tests/fake-host.mjs'
import { assertLossless } from '../tests/lossless.mjs'
import { ANIMATION_OK, PAGE } from './animation-page.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argOf = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const only = argOf('--browser')
const cover = argOf('--cover') ?? 'zoomed'
const screen = argOf('--screen') ?? 'main'
const strategy = process.argv.includes('--no-raise') ? 'off' : (process.argv.includes('--activate') ? 'activate' : 'park')

const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.setHeader('cache-control', 'no-store'); res.end(PAGE) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = (tag) => `http://127.0.0.1:${server.address().port}/${tag}`

const scratch = await mkdtemp(join(tmpdir(), 'deepsea-browser-occluder-'))
const occluderBin = join(scratch, 'occluder')
execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-o', occluderBin, join(here, 'occluder-app.swift')], { stdio: 'inherit' })

const ctx = fakeCtx({ logger: console })
const config = plugin.Config({ idleMinutes: 0, trace: process.argv.includes('--trace'), safari: { reader: { enabled: false }, hiddenWindows: strategy } })
plugin.apply(ctx, config, { scratch })
const agent = fakeAgent('session-live-parking', { cwd: scratch })
ctx.emit('agent/created', { agent })
const exec = { agent, signal: new AbortController().signal }
const run = async (name, args = {}) => assertLossless(name, await agent.registered.get(name).execute(args, exec))

let occluder
const occlude = async () => {
  occluder?.kill()
  occluder = spawn(occluderBin, ['60', cover, process.argv.includes('--borderless') ? 'borderless' : 'titled', screen], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1500)) // up and frontmost
}
const frontmost = () => execFileSync('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js']).toString().trim()

/** Wait (at most 8 s) for the probes in `windowId`, then return the page's report. */
async function probe(browser, windowId) {
  const text = String(await run(`${browser}_evaluate_expression`, { windowId, expression: 'return JSON.stringify(window.__anim)', wait: { expression: ANIMATION_OK, timeout: 8000 } }))
  const json = text.match(/\{\\?".*\}/s)?.[0]
  return JSON.parse(json.startsWith('{\\"') ? JSON.parse(`"${json}"`) : json)
}

let failures = 0
async function scenario(label, browser, act) {
  await occlude()
  const windowId = await act()
  const s = await probe(browser, windowId)
  // Parking must never move keyboard focus off the person's app (here: the occluder).
  const front = frontmost()
  const focusKept = strategy !== 'park' || browser !== 'safari' || front === 'occluder'
  const ok = s.form && s.cssAnimation === 'done' && s.webAnimation === 'done' && focusKept
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${browser} ${label} [${windowId}] — form=${s.form} transition=${s.transition} css=${s.cssAnimation} waapi=${s.webAnimation} frames=${s.frames} visibility=${s.visibility.join('→')} ${s.elapsedMs} ms; frontmost=${front}`)
  if (!ok) failures++
}

try {
  for (const browser of ['safari', 'chrome']) {
    if (only && only !== browser) continue
    const open = `${browser}_open`; const navigate = `${browser}_navigate`; const letter = browser[0]
    await scenario('opened while covered', browser, async () => (await run(open, { url: url('a') })).windowId)
    await scenario('navigate while covered', browser, async () => { await run(navigate, { url: url('b'), windowId: `${letter}:0:0` }); return `${letter}:0:0` })
    await scenario('second window opened', browser, async () => (await run(open, { url: url('c') })).windowId)
    await scenario('first window under the second', browser, async () => { await run(navigate, { url: url('d'), windowId: `${letter}:0:0` }); return `${letter}:0:0` })
    await scenario('reload while covered', browser, async () => { await run(`${browser}_evaluate_expression`, { windowId: `${letter}:0:1`, expression: 'setTimeout(() => location.reload(), 50); return 1' }); await new Promise(r => setTimeout(r, 500)); return `${letter}:0:1` })
    await run(`${browser}_close`)
  }
} finally {
  occluder?.kill()
  server.close()
  await ctx.dispose()
}
console.log(failures === 0 ? 'all scenarios passed' : `${failures} scenario(s) failed`)
// Let the closed drivers and the STP quit grace finish: exiting at once can leave an orphaned STP window.
await new Promise(resolve => setTimeout(resolve, 6000))
await rm(scratch, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
