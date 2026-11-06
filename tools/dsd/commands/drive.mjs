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
 *   snapshot [<css> [--nth <n>]] [--window] [--chrome]
 *   window-info | app-log [--lines <n>] | opened [--clear] | quit
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeOf } from '../lib/paths.mjs'
import { appRequest } from '../lib/appsocket.mjs'
import { alive, listenerPids } from '../lib/processes.mjs'
import { readState, resolveRef } from '../lib/variants.mjs'
import { DsdError, onlyFlags, parseArgs, printJson, sleep, usage } from '../lib/util.mjs'

const USAGE = 'dsd drive [-v <ref>] <op> …  server: health create-session prompt command wait events cancel sessions restart-server invoke url; app: load reload open-session wait-page eval resize view appearance click hover type describe snapshot window-info app-log opened quit (tools/dsd/README.md)'
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

export async function drive(argv) {
  // `-v <ref>` is short for `--variant <ref>`.
  const valued = ['variant', 'cwd', 'preset', 'model', 'title', 'timeout', 'since', 'types', 'limit', 'nth', 'clicks', 'x', 'y', 'key', 'selector', 'text', 'expression', 'settle', 'lines']
  const args = parseArgs(argv.map(a => (a === '-v' ? '--variant' : a)), valued)
  onlyFlags(args, [...valued, 'no-wait', 'steer', 'window', 'chrome', 'clear', 'replace'])
  const [op, ...rest] = args._
  if (op === undefined) usage(USAGE)
  const variant = resolveRef(args.variant)
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
    return printJson(await appOp(variant, 'eval', [`const driver = window.__DEEPSEA_TEST_DRIVER__
      if (!driver) throw new Error("the test driver's browser half is not loaded")
      return await driver.openSession(${JSON.stringify(sessionId)})`], {}))
  }
  if (APP_OPS.has(op)) return printJson(await appOp(variant, op, rest, args))
  if (op === 'url') {
    const state = readState(variant.id)
    return printJson({ id: variant.id, url: state?.url, login: state?.url && state?.token ? `${state.url}?token=${state.token}` : undefined })
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
    return printJson({ restarted: true, stopped: pids, driver: after?.port ?? after?.url, changed: JSON.stringify(after) !== JSON.stringify(before) })
  }
  const driver = await driverOf(variant)
  switch (op) {
    case 'health': return printJson(await post(driver, 'health', {}))
    case 'sessions': return printJson(await post(driver, 'sessions', {}))
    case 'create-session': {
      const value = await post(driver, 'create-session', {
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.preset === undefined ? {} : { preset: args.preset }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.title === undefined ? {} : { title: args.title }),
      })
      writeFileSync(join(home, LAST_SESSION), `${value.sessionId}\n`, { mode: 0o600 })
      return printJson(value)
    }
    case 'prompt': {
      if (rest.length < 1 || rest.length > 2) usage('dsd drive prompt [<session>] <text | -> [--no-wait] [--steer] [--timeout <s>]')
      const sessionId = await sessionOrNew(rest.length === 2 ? rest[0] : undefined)
      const given = rest.at(-1)
      const text = given === '-' ? readStdin() : given
      const value = await post(driver, 'prompt', { sessionId, text, wait: !args['no-wait'], mode: args.steer ? 'steer' : 'queue', ...(args.timeout === undefined ? {} : { timeoutMs: seconds(args.timeout, 'timeout') }) })
      printJson({ sessionId, ...value })
      return exitFor(value)
    }
    case 'wait': {
      const value = await post(driver, 'wait', { sessionId: await session(rest[0]), ...(args.since === undefined ? {} : { since: Number(args.since) }), ...(args.timeout === undefined ? {} : { timeoutMs: seconds(args.timeout, 'timeout') }) })
      printJson(value)
      return exitFor(value)
    }
    case 'command': {
      if (rest.length < 1 || rest.length > 2) usage('dsd drive command [<session>] <line>')
      const sessionId = await sessionOrNew(rest.length === 2 ? rest[0] : undefined)
      return printJson({ sessionId, ...await post(driver, 'command', { sessionId, line: rest.at(-1) }) })
    }
    case 'events': return printJson(await post(driver, 'events', {
      sessionId: await session(rest[0]),
      ...(args.since === undefined ? {} : { since: Number(args.since) }),
      ...(args.types === undefined ? {} : { types: String(args.types).split(',') }),
      ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
    }))
    case 'cancel': return printJson(await post(driver, 'cancel', { sessionId: await session(rest[0]) }))
    case 'invoke': {
      if (rest.length < 2 || rest.length > 3) usage('dsd drive invoke <namespace> <method> [<json args>]')
      let parsed = {}
      if (rest[2] !== undefined) { try { parsed = JSON.parse(rest[2]) } catch (error) { usage(`invoke args are not JSON: ${error.message}`) } }
      return printJson(await post(driver, 'invoke', { namespace: rest[0], method: rest[1], args: parsed }))
    }
    default: usage(`unknown drive operation "${op}"\n${USAGE}`)
  }
}

/** Exit 3 when a waited turn ended with an error, 4 when the wait timed out. */
function exitFor(value) {
  if (value?.idle === false) process.exitCode = 4
  else if (value?.summary?.turnEnd?.kind === 'error') process.exitCode = 3
}

/** One app operation over the throwaway app's automation socket. */
async function appOp(variant, op, rest, args) {
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
    case 'eval': { const js = one('js | -'); return send('eval', { js: js === '-' ? readStdin() : js }) }
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
      return send('type', { text: text === '-' ? readStdin() : text })
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
