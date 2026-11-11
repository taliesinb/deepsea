/**
 * dsd drive [-v <ref>] <op> … — one operation on a running throwaway, printed
 * as JSON. Server operations go to its test driver (plugins/dev-test-driver), app
 * operations to its app's automation socket (apps/macos, Automation.swift).
 *
 * Server:
 *   health
 *   create-session [--cwd <dir>] [--preset <name>] [--model <provider/model[:effort]>] [--title <t>]
 *   prompt [<session>] <text | -> [--no-wait] [--steer] [--timeout <s>]
 *   command [<session>] <line>
 *   wait <session> [--since <seq>] [--timeout <s>]
 *   events <session> [--since <seq>] [--types <a,b/*>] [--limit <n>]
 *   cancel <session>
 *   sessions
 *   restart-server                        (behind a relay, --throwaway) stop the server; the relay starts
 *                                         it again, as after /reboot; answers once its new driver is up
 *   invoke <namespace> <method> [<json args>]   the method's arguments as one object keyed by its
 *                                         parameter names (a failure names the missing and unexpected ones)
 *   url
 *
 * App (a throwaway started with --throwaway-app):
 *   load <url> | reload
 *   open-session <session>                show that session in the app (as a sidebar click would)
 *   wait-page [--selector <css>] [--text <t>] [--expression <js>] [--timeout <s>] [--settle <ms>]
 *   eval <js | ->                         a function body (await allowed); its JSON value
 *   resize <W>x<H> | view desktop|mobile | appearance light|dark|system
 *   click <css> [--nth <n>] [--clicks <n>] | click --text <label> [<css>] | click --x <x> --y <y>
 *   hover <css> [--nth <n>] | hover --text <label> [<css>]   (a pointer's page events on it: script-revealed hover controls)
 *   type <text | -> [--replace] | type --key <Enter | Escape | cmd+k | …>   (--replace: select the
 *                                         focused field's contents first, so the text replaces them)
 *   describe <css> [--nth <n>]            the element inspector's record
 *   snapshot [<css> [--nth <n>]] [--window] [--chrome] [--name <n>]   (--name: its file under run --shots)
 *   window-info | app-log [--lines <n>] | opened [--clear] | quit
 *
 * Script:
 *   run <script | dir>… [--from <line>] [--values] [--shots <dir>]   drive scripts, each in order to its
 *                                         first failing step; --shots: every snapshot copied there, numbered
 *                                         (lib/drive-script.mjs: the format; expect, let, try, sleep)
 *
 * <session> is a session id, or `last` (the default when it is left out):
 * the most recently active session on this throwaway, however it was made
 * (create-session, the GUI, a command); a prompt or command on a throwaway
 * with no session yet starts one. `-` reads the prompt from stdin (a
 * llm-scripted script, say). `wait-page` that times out says what the
 * page shows. Exit status: 0; 3 when a waited turn ended with an error;
 * 4 when the wait timed out.
 */
import { request } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homeOf } from '../lib/paths.mjs'
import { appRequest } from '../lib/appsocket.mjs'
import { alive, listenerPids } from '../lib/processes.mjs'
import { readState, resolveRef } from '../lib/variants.mjs'
import { DsdError, note, onlyFlags, parseArgs, pick, printJson, sleep, usage } from '../lib/util.mjs'
import { expectStep, parseDriveScript, render, STEPS } from '../lib/drive-script.mjs'

const USAGE = 'dsd drive [-v <ref>] <op> …  script: run <file>; server: health create-session prompt command wait events cancel sessions restart-server invoke url; app: load reload open-session wait-page eval resize view appearance click hover type describe snapshot window-info app-log opened quit (tools/dsd/README.md)'
const APP_OPS = new Set(['load', 'reload', 'wait-page', 'eval', 'resize', 'view', 'appearance', 'click', 'hover', 'type', 'describe', 'snapshot', 'window-info', 'app-log', 'opened', 'quit'])
const LAST_SESSION = 'run/drive-last-session'

/** POST one operation to the throwaway's test driver; resolve its value or throw its error. */
export function post(driver, op, body) {
  const url = new URL(`${driver.channel}/${op}`, driver.baseUrl)
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { authorization: `Bearer ${driver.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let reply
        try { reply = JSON.parse(text) } catch { reject(new DsdError(`test driver answered ${res.statusCode} with non-JSON: ${text.slice(0, 200)}`)); return }
        if (reply.ok) resolve(reply.value)
        else reject(new DsdError(`${op}: ${reply.error?.code ?? res.statusCode}: ${reply.error?.message ?? text}`))
      })
    })
    req.on('error', error => reject(new DsdError(`cannot reach the test driver at ${url.origin}: ${error.message}`)))
    req.end(payload)
  })
}

/** The test driver's endpoint file, when the server that wrote it is still running. */
function currentDriver(file) {
  try {
    const driver = JSON.parse(readFileSync(file, 'utf8'))
    return driver.pid !== undefined && alive(driver.pid) ? driver : undefined
  } catch {
    return undefined
  }
}

/**
/** The driver's state file in the home: a wire name kept from the plugin's old name (test-driver), as is its route. */
const DRIVER_STATE = join('run', 'test-driver.json')

/**
 * The test driver of a running throwaway. Behind a relay the server comes and goes (`/reboot`,
 * `/restore`, a crash): each start writes a new endpoint with a new token, and the relay starts
 * the server on the next connection, so the driver is asked for after a knock on the relay.
 */
export async function driverOf(variant, timeoutMs = 90_000) {
  if (!variant.throwaway) throw new DsdError(`${variant.id} is not a throwaway; dsd drive only drives throwaways`)
  if (!variant.running) throw new DsdError(`${variant.id} is not running`)
  const file = join(homeOf(variant.id), DRIVER_STATE)
  const relay = variant.state?.relay
  if (relay === undefined) {
    if (!existsSync(file)) throw new DsdError(`${variant.id} has no test driver (${file} missing): it started without plugins/dev-test-driver, or the plugin failed to load (see its log)`)
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const driver = currentDriver(file)
    if (driver !== undefined) return driver
    if (Date.now() > deadline) throw new DsdError(`${variant.id}: no test driver within ${Math.round(timeoutMs / 1000)} s of asking the relay to start the server (see dsd logs ${variant.id})`)
    try { await fetch(relay.url, { method: 'HEAD', signal: AbortSignal.timeout(2000) }) } catch { /* the relay answers or starts it either way */ }
    await sleep(500)
  }
}

const readStdin = () => readFileSync(0, 'utf8')
const seconds = (value, name) => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!(n > 0)) usage(`--${name} takes seconds`)
  return n * 1000
}

const VALUED = ['variant', 'cwd', 'preset', 'model', 'title', 'timeout', 'since', 'types', 'limit', 'nth', 'clicks', 'x', 'y', 'key', 'selector', 'text', 'expression', 'settle', 'lines', 'from', 'shots', 'name']
const BOOLEAN = ['no-wait', 'steer', 'window', 'chrome', 'clear', 'replace', 'values']
const SERVER_OPS = new Set(['health', 'create-session', 'prompt', 'command', 'wait', 'events', 'cancel', 'sessions', 'restart-server', 'invoke', 'url'])
/** Every operation of `dsd drive` (and so of a drive script). */
export const DRIVE_OPS = new Set([...SERVER_OPS, 'open-session', ...APP_OPS])

/** One operation's words as parsed arguments; `-v <ref>` is short for `--variant <ref>`. */
function driveArgs(argv) {
  const args = parseArgs(argv.map(a => (a === '-v' ? '--variant' : a)), VALUED)
  onlyFlags(args, [...VALUED, ...BOOLEAN])
  return args
}

export async function drive(argv) {
  const args = driveArgs(argv)
  if (args._[0] === undefined) usage(USAGE)
  const variant = resolveRef(args.variant)
  if (args._[0] === 'run') return runScripts(variant, args)
  const { value, exitCode } = await perform(variant, args, readStdin)
  printJson(value)
  if (exitCode) process.exitCode = exitCode
}

/**
 * dsd drive run <script | dir>… [-v <ref>] [--from <line>] [--values] [--shots <dir>] — drive scripts (a directory: its
 * *.drive files, by name), each in order to its first failing step (lib/drive-script.mjs has the
 * format). Every script is read before any runs. Prints a report: steps passed, the failing step
 * (line, text, error, the value it saw), every snapshot's files, and with --values every step's
 * value; for several scripts, one report each under `scripts`. --shots <dir> copies every snapshot
 * taken into the directory as `NN-<name>.png` in order (`snapshot … --name <name>`, else
 * `<script>-<line>`) and writes an index.md showing them with their steps: a UX flow to look
 * through. Exit status: 0; 1 when a step failed; 2 when a script cannot be read.
 */
async function runScripts(variant, args) {
  const files = driveScriptFiles(args._.slice(1))
  if (files.length === 0) usage('dsd drive run <script | dir>… [-v <ref>] [--from <line>] [--values] [--shots <dir>]')
  if (args.from !== undefined && files.length > 1) usage('--from takes one script')
  const scripts = files.map(file => ({ file, steps: loadDriveScript(file) }))
  const reports = []
  const shots = args.shots === undefined ? undefined : shotBook(String(args.shots))
  try {
    for (const { file, steps } of scripts) {
      const report = await runDriveScript(variant, file, steps, { from: args.from === undefined ? 0 : Number(args.from), values: Boolean(args.values), label: files.length > 1, shots })
      reports.push(report)
    }
  } finally { shots?.finish() }
  const ok = reports.every(r => r.ok)
  printJson(reports.length === 1 ? reports[0] : { id: variant.id, ok, passed: reports.filter(r => r.ok).length, failed: reports.filter(r => !r.ok).map(r => r.script), scripts: reports })
  if (!ok) process.exitCode = 1
}

/** The image a snapshot reply points at: the element for an element snapshot, else the page. */
export const snapshotImage = value => value?.images?.element?.path ?? value?.files?.elementPng ?? value?.image?.path ?? value?.file

/**
 * A directory collecting a run's snapshots as `NN-<name>.png`, in the order taken, with an
 * index.md that shows each under its step. Earlier shots of the same names are replaced.
 */
export function shotBook(dir) {
  mkdirSync(dir, { recursive: true })
  for (const f of readdirSync(dir)) if (/^\d{2,}-.*\.png$/.test(f)) rmSync(join(dir, f))
  const entries = []
  return {
    add(value, name, where, text) {
      const source = snapshotImage(value)
      if (!source) return undefined
      const file = `${String(entries.length + 1).padStart(2, '0')}-${name.replace(/[^\w.-]+/g, '-')}.png`
      copyFileSync(source, join(dir, file))
      entries.push({ file, where, text })
      return join(dir, file)
    },
    finish() {
      const body = entries.map(e => `## ${e.file.replace(/\.png$/, '')}\n\n\`${e.where}\` \`${e.text.replace(/`/g, "'")}\`\n\n![${e.file}](${e.file})\n`).join('\n')
      writeFileSync(join(dir, 'index.md'), `# Snapshots\n\n${body}`)
    },
  }
}

/** Scripts named, or a directory's `*.drive` files by name. */
export function driveScriptFiles(paths) {
  return paths.flatMap(path => {
    let isDir
    try { isDir = statSync(path).isDirectory() } catch { throw new DsdError(`no script ${path}`, 2) }
    if (!isDir) return [path]
    const found = readdirSync(path).filter(f => f.endsWith('.drive')).sort().map(f => join(path, f))
    if (found.length === 0) throw new DsdError(`${path} has no *.drive scripts`, 2)
    return found
  })
}

/** A script's steps, checked: unknown steps and syntax errors are reported (exit 2) before anything runs. */
export function loadDriveScript(file) {
  let steps
  try { steps = parseDriveScript(readFileSync(file, 'utf8')) } catch (error) {
    if (error instanceof DsdError) throw new DsdError(`${file}: ${error.message}`, error.code)
    throw new DsdError(`cannot read ${file}: ${error.message}`, 2)
  }
  for (const step of steps) {
    const head = step.words[0].parts.map(p => p.text).join('')
    const op = head === 'try' ? step.words[1] && step.words[1].parts.map(p => p.text).join('') : head
    if (!DRIVE_OPS.has(op) && (head === 'try' || !(op in STEPS))) throw new DsdError(`${file}:${step.line}: unknown step "${op ?? ''}" (operations: ${[...DRIVE_OPS].join(' ')}; steps: ${Object.keys(STEPS).join(' ')})`, 2)
  }
  return steps
}

/** Run one loaded script against a throwaway; its report (never throws for a failing step). */
export async function runDriveScript(variant, file, steps, { from = 0, values = false, label = false, shots } = {}) {
  const vars = {}
  const report = { script: file, id: variant.id, ok: true, steps: steps.length, passed: 0, snapshots: [] }
  if (values) report.values = []
  const prefix = label ? `${basename(file)}:` : ''
  let last, lastExit = 0
  for (const step of steps) {
    if (step.line < from) continue
    const started = Date.now()
    const shown = step.text.length > 100 ? `${step.text.slice(0, 100)}…` : step.text
    try {
      const words = step.words.map(w => render(w, vars, step.line))
      const [head, ...rest] = words
      if (head === 'expect') expectStep(step.words.slice(1), vars, last, step.line)
      else if (head === 'expect-exit') { if (lastExit !== Number(rest[0])) throw new DsdError(`exited ${lastExit}, expected ${rest[0]}`) }
      else if (head === 'let') {
        if (rest.length < 1 || rest.length > 2 || !/^[A-Za-z_][\w-]*$/.test(rest[0])) throw new DsdError('let <name> [<path>]', 2)
        const picked = rest[1] === undefined ? last : pick(last, rest[1])
        if (picked === undefined) throw new DsdError(`the last value has no ${rest[1]}`)
        vars[rest[0]] = picked
      } else if (head === 'sleep') await sleep(Number(rest[0]) * 1000)
      else {
        const lenient = head === 'try'
        const opArgs = driveArgs(lenient ? rest : words)
        if (opArgs.variant !== undefined) throw new DsdError('a script step takes no -v (give it to dsd drive run)', 2)
        if (opArgs._[0] === 'run') throw new DsdError('a script cannot run another', 2)
        const input = () => { if (step.input === undefined) throw new DsdError('`-` reads a heredoc here (<<TAG at the end of the line)', 2); return step.input }
        const { value, exitCode } = await perform(variant, opArgs, input)
        last = value
        lastExit = exitCode ?? 0
        if (opArgs._[0] === 'snapshot') {
          const name = opArgs.name === undefined ? `${basename(file).replace(/\.drive$/, '')}-${step.line}` : String(opArgs.name)
          const copied = shots?.add(value, name, `${basename(file)}:${step.line}`, step.text)
          report.snapshots.push({ line: step.line, ...(copied ? { shot: copied } : {}), ...value })
        }
        if (lastExit && !lenient) throw new DsdError(lastExit === 4 ? 'the wait timed out' : `the turn ended with an error: ${JSON.stringify(value?.summary?.turnEnd ?? null)}`)
      }
      report.passed++
      if (values) report.values.push({ line: step.line, value: head === 'expect' || head === 'expect-exit' ? undefined : last })
      note(`${prefix}${step.line}  ${shown}  ok (${((Date.now() - started) / 1000).toFixed(1)} s)`)
    } catch (error) {
      if (!(error instanceof DsdError)) throw error
      note(`${prefix}${step.line}  ${shown}  FAILED: ${error.message}`)
      report.ok = false
      report.failed = { line: step.line, step: step.text, error: error.message.replace(/^line \d+: /, ''), value: last }
      break
    }
  }
  if (report.snapshots.length === 0) delete report.snapshots
  return report
}
/** One drive operation: its value, and the exit status it implies (3 a turn's error, 4 a wait's timeout). */
async function perform(variant, args, input) {
  const [op, ...rest] = args._
  const home = homeOf(variant.id)
  // `last`: the most recently active session: of the sessions that have started, and the one
  // the last create-session made (blank until prompted), the one updated last. The GUI's own
  // New Session stays blank until someone types in it, so it is not taken for the agent's.
  let latest
  const newest = async () => {
    if (latest !== undefined) return latest
    const file = join(home, LAST_SESSION)
    const recorded = existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined
    try {
      const listed = await post(await driverOf(variant), 'sessions', {})
      const items = (listed?.items ?? []).filter(i => !i.blank || i.sessionId === recorded)
      latest = items.toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]?.sessionId
    } catch { /* fall back to the recorded one */ }
    latest ??= recorded
    if (latest === undefined) throw new DsdError('this throwaway has no session yet (dsd drive create-session)')
    return latest
  }
  const session = async (value) => value === undefined || value === 'last' ? newest() : value
  // A prompt or command with no session named, on a throwaway that has none yet, starts one.
  const sessionOrNew = async (value) => {
    try { return await session(value) } catch (error) {
      if (value !== undefined || !/has no session yet/.test(String(error?.message))) throw error
      const made = await post(await driverOf(variant), 'create-session', {})
      writeFileSync(join(home, LAST_SESSION), `${made.sessionId}\n`, { mode: 0o600 })
      return made.sessionId
    }
  }
  if (op === 'open-session') {
    if (rest.length > 1) usage('dsd drive open-session [<session id | last>]')
    const sessionId = await session(rest[0])
    // The page global is a wire name kept from the plugin's old name (test-driver).
    return { value: await appOp(variant, 'eval', [`const driver = window.__DEEPSEA_TEST_DRIVER__
      if (!driver) throw new Error("the test driver's browser half is not loaded")
      return await driver.openSession(${JSON.stringify(sessionId)})`], {}, input) }
  }
  if (APP_OPS.has(op)) return { value: await appOp(variant, op, rest, args, input) }
  if (op === 'url') {
    const state = readState(variant.id)
    return { value: { id: variant.id, url: state?.url, login: state?.url && state?.token ? `${state.url}?token=${state.token}` : undefined } }
  }
  if (op === 'restart-server') {
    const relay = variant.state?.relay
    if (relay === undefined) throw new DsdError(`${variant.id} runs its server without a relay; start it with --throwaway to restart its server`)
    const before = currentDriver(join(home, DRIVER_STATE))
    const pids = listenerPids(variant.state.port)
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    for (let i = 0; i < 300 && (listenerPids(variant.state.port).length > 0 || pids.some(alive)); i++) await sleep(100)
    if (pids.some(alive)) throw new DsdError(`the server (pid ${pids.filter(alive).join(', ')}) did not stop within 30 s`)
    const after = await driverOf(variant)
    return { value: { restarted: true, stopped: pids, driver: after?.port ?? after?.url, changed: JSON.stringify(after) !== JSON.stringify(before) } }
  }
  const driver = await driverOf(variant)
  switch (op) {
    case 'health': return { value: await post(driver, 'health', {}) }
    case 'sessions': return { value: await post(driver, 'sessions', {}) }
    case 'create-session': {
      const value = await post(driver, 'create-session', {
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.preset === undefined ? {} : { preset: args.preset }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.title === undefined ? {} : { title: args.title }),
      })
      writeFileSync(join(home, LAST_SESSION), `${value.sessionId}\n`, { mode: 0o600 })
      return { value }
    }
    case 'prompt': {
      if (rest.length < 1 || rest.length > 2) usage('dsd drive prompt [<session>] <text | -> [--no-wait] [--steer] [--timeout <s>]')
      const sessionId = await sessionOrNew(rest.length === 2 ? rest[0] : undefined)
      const given = rest.at(-1)
      const text = given === '-' ? input() : given
      const value = await post(driver, 'prompt', { sessionId, text, wait: !args['no-wait'], mode: args.steer ? 'steer' : 'queue', ...(args.timeout === undefined ? {} : { timeoutMs: seconds(args.timeout, 'timeout') }) })
      return { value: { sessionId, ...value }, exitCode: exitFor(value) }
    }
    case 'wait': {
      const value = await post(driver, 'wait', { sessionId: await session(rest[0]), ...(args.since === undefined ? {} : { since: Number(args.since) }), ...(args.timeout === undefined ? {} : { timeoutMs: seconds(args.timeout, 'timeout') }) })
      return { value, exitCode: exitFor(value) }
    }
    case 'command': {
      if (rest.length < 1 || rest.length > 2) usage('dsd drive command [<session>] <line>')
      const sessionId = await sessionOrNew(rest.length === 2 ? rest[0] : undefined)
      return { value: { sessionId, ...await post(driver, 'command', { sessionId, line: rest.at(-1) }) } }
    }
    case 'events': return { value: await post(driver, 'events', {
      sessionId: await session(rest[0]),
      ...(args.since === undefined ? {} : { since: Number(args.since) }),
      ...(args.types === undefined ? {} : { types: String(args.types).split(',') }),
      ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
    }) }
    case 'cancel': return { value: await post(driver, 'cancel', { sessionId: await session(rest[0]) }) }
    case 'invoke': {
      if (rest.length < 2 || rest.length > 3) usage('dsd drive invoke <namespace> <method> [<json args>]')
      let parsed = {}
      if (rest[2] !== undefined) { try { parsed = JSON.parse(rest[2]) } catch (error) { usage(`invoke args are not JSON: ${error.message}`) } }
      return { value: await post(driver, 'invoke', { namespace: rest[0], method: rest[1], args: parsed }) }
    }
    default: usage(`unknown drive operation "${op}"\n${USAGE}`)
  }
}

/** Exit 3 when a waited turn ended with an error, 4 when the wait timed out. */
function exitFor(value) {
  if (value?.idle === false) return 4
  if (value?.summary?.turnEnd?.kind === 'error') return 3
  return 0
}

/** One app operation over the throwaway app's automation socket. */
async function appOp(variant, op, rest, args, input) {
  const app = readState(variant.id)?.app
  if (!app?.socket) throw new DsdError(`${variant.id} has no app (it was started with --throwaway-server)`)
  const one = (what) => { if (rest.length !== 1) usage(`dsd drive ${op} <${what}>`); return rest[0] }
  const count = (name) => {
    if (args[name] === undefined) return {}
    const n = Number(args[name])
    if (!Number.isInteger(n)) usage(`--${name} takes a whole number`)
    return { [name]: n }
  }
  const target = () => rest.length === 1 ? { selector: rest[0], ...count('nth') } : rest.length === 0 && args.x !== undefined && args.y !== undefined ? { x: Number(args.x), y: Number(args.y) } : usage(`dsd drive ${op} <css selector> [--nth <n>]`)
  const send = (name, body = {}, timeoutMs) => appRequest(app.socket, name, body, timeoutMs ? { timeoutMs } : undefined)
  switch (op) {
    case 'load': return send('load', { url: one('url') })
    case 'reload': return send('reload')
    case 'wait-page': {
      const body = { ...(args.selector ? { selector: args.selector } : {}), ...(args.text ? { text: args.text } : {}), ...(args.expression ? { expression: args.expression } : {}) }
      if (Object.keys(body).length === 0) usage('dsd drive wait-page --selector <css> | --text <t> | --expression <js>')
      const timeout = seconds(args.timeout, 'timeout') ?? 15_000
      try {
        return await send('wait-page', { ...body, timeoutMs: timeout, ...(args.settle ? { settleMs: Number(args.settle) } : {}) }, timeout + 10_000)
      } catch (error) {
        if (!/timeout/.test(String(error?.message))) throw error
        // Say what the page shows instead, so the next try aims better.
        let seen = ''
        try {
          const page = await send('eval', { js: `const dialogs = [...document.querySelectorAll('[role=dialog], [role=menu], [role=alertdialog]')].map(d => (d.innerText || '').trim().slice(0, 120))
            return { url: location.href, title: document.title, dialogs, text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400) }` })
          seen = `; the page shows: ${JSON.stringify(page)}`
        } catch { /* the page cannot answer either */ }
        throw new DsdError(`${error.message}${seen}`)
      }
    }
    case 'eval': { const js = one('js | -'); return send('eval', { js: js === '-' ? input() : js }) }
    case 'resize': {
      const m = /^(\d+)x(\d+)$/.exec(one('W>x<H'))
      if (!m) usage('dsd drive resize <width>x<height>, e.g. 1280x860')
      return send('resize', { width: Number(m[1]), height: Number(m[2]) })
    }
    case 'view': return send('view', { mode: one('desktop | mobile') })
    case 'appearance': return send('appearance', { value: one('light | dark | system') })
    case 'click': {
      if (args.text !== undefined) { if (rest.length > 1) usage('dsd drive click --text <label> [<css scope>]'); return send('click', { text: args.text, ...(rest[0] ? { selector: rest[0] } : {}), ...count('nth'), ...count('clicks') }) }
      return send('click', { ...target(), ...count('clicks') })
    }
    case 'hover': {
      // The pointer's page events on the element (pointerover/enter, mouseover/enter, mousemove), as
      // a mouse arriving sends them; React's onMouseEnter and hover-revealed controls follow them.
      // CSS :hover does not change: a hidden window is never active, and WebKit tracks hover only there.
      const where = args.text !== undefined ? { text: args.text, selector: rest[0] ?? null } : rest.length === 1 ? { selector: rest[0], text: null } : usage('dsd drive hover <css> [--nth <n>] | hover --text <label> [<css scope>]')
      const nth = args.nth === undefined ? 0 : Number(args.nth)
      return send('eval', { js: `const where = ${JSON.stringify({ ...where, nth })}
        const shown = e => (e.innerText || '').trim()
        let all
        if (where.text != null) {
          const roots = where.selector ? [...document.querySelectorAll(where.selector)] : [document.body]
          const scope = [...new Set(roots.flatMap(r => [...(where.selector ? [r] : []), ...r.querySelectorAll('*')]))].filter(e => e.getClientRects().length > 0)
          let pool = scope.filter(e => shown(e) === where.text)
          if (pool.length === 0) pool = scope.filter(e => shown(e).includes(where.text))
          all = pool.filter(e => !pool.some(o => o !== e && e.contains(o)))
        } else all = [...document.querySelectorAll(where.selector)]
        const el = all[where.nth < 0 ? all.length + where.nth : where.nth]
        if (!el) throw new Error('nothing matches ' + (where.text != null ? 'text ' + JSON.stringify(where.text) : where.selector))
        const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2
        const at = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window }
        el.dispatchEvent(new PointerEvent('pointerover', { ...at, pointerType: 'mouse' }))
        for (let e = el; e; e = e.parentElement) e.dispatchEvent(new PointerEvent('pointerenter', { ...at, bubbles: false, pointerType: 'mouse' }))
        el.dispatchEvent(new MouseEvent('mouseover', at))
        for (let e = el; e; e = e.parentElement) e.dispatchEvent(new MouseEvent('mouseenter', { ...at, bubbles: false }))
        el.dispatchEvent(new PointerEvent('pointermove', { ...at, pointerType: 'mouse' }))
        el.dispatchEvent(new MouseEvent('mousemove', at))
        return { x, y, element: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/)[0] : '') }` })
    }
    case 'type': {
      if (args.key !== undefined) { if (rest.length) usage('dsd drive type --key <key> takes no text'); return send('type', { key: args.key }) }
      const text = one('text | -')
      if (args.replace) {
        // Select what the focused field holds, so the typed text replaces it.
        await send('eval', { js: `const e = document.activeElement
          if (!e || e === document.body) throw new Error('no field has the focus (click it first)')
          if (typeof e.select === 'function') e.select()
          else { const range = document.createRange(); range.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(range) }
          return true` })
      }
      return send('type', { text: text === '-' ? input() : text })
    }
    case 'describe': return send('describe', target())
    case 'snapshot': {
      if (args.window) { if (rest.length) usage('dsd drive snapshot --window takes no selector'); return send('snapshot', { window: true, ...(args.chrome ? { chrome: true } : {}) }) }
      return send('snapshot', target())
    }
    case 'window-info': return send('window-info')
    case 'app-log': return send('log', count('lines'))
    case 'opened': return send('opened', args.clear ? { clear: true } : {})
    case 'quit': return send('quit')
  }
  return undefined
}
