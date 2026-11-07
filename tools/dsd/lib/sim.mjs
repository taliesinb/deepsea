/**
 * The provider simulator (tools/provider-sim): one per checkout (it runs that
 * checkout's providers, so a worktree changing the simulator tests its own),
 * all sharing one store, started on demand and left running.
 *
 *   ~/.deepsea/_sim/sim.sqlite        accounts and generations (the simulators' store)
 *   ~/.deepsea/_sim/sim-<hash>.json   { pid, url, started, checkout } of a checkout's simulator
 *   <machine logs>/sim/               their run logs
 *
 * Test accounts (tools/provider-sim/fixtures/<provider>.json) are named starting points:
 * `--accounts openrouter,deepseek-empty` gives a throwaway fresh accounts in
 * those states, its credentials suffixed with the throwaway's id so no two
 * throwaways share one; `name=<credential>` uses that credential as it is (a
 * persistent account, created on first use). A sign-in fixture (`kind:
 * email`, `signIn: <route>`) names an email address instead of a key (the
 * suffix goes before the `@`): the simulator signs it in and the throwaway
 * starts with the grant stored for that route. Every sign-in fixture also comes
 * signed out, as `<name>-signed-out`: the same account and route rows, no grant.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { takeLock } from './harness.mjs'
import { openRunLog } from './logs.mjs'
import { deepseaRoot, machineLogDir, REPO } from './paths.mjs'
import { alive } from './processes.mjs'
import { DsdError, isoLocal, note, sleep } from './util.mjs'

export const simDir = () => join(deepseaRoot(), '_sim')
/** This checkout's simulator: its state file is named after the checkout's path. */
const checkoutTag = () => createHash('sha256').update(REPO).digest('hex').slice(0, 8)
const stateFile = () => join(simDir(), `sim-${checkoutTag()}.json`)
const SERVER = () => join(REPO, 'tools', 'provider-sim', 'server.mjs')
const FIXTURES = () => join(REPO, 'tools', 'provider-sim', 'fixtures')

/** The running simulator's facts, or undefined. */
export async function simStatus() {
  if (!existsSync(stateFile())) return undefined
  let state
  try { state = JSON.parse(readFileSync(stateFile(), 'utf8')) } catch { return undefined }
  if (!alive(state.pid)) return undefined
  try {
    const response = await fetch(`${state.url}/_sim/status`, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return undefined
    return { ...state, ...(await response.json()) }
  } catch { return undefined }
}

/** pi-ai's generated catalog in a harness build: the models and prices the simulator serves. */
function catalogDir(harnessBuild) {
  const dir = join(harnessBuild, 'packages', 'llm', 'llm-pi-ai', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers')
  return existsSync(dir) ? dir : undefined
}

/** Make sure the simulator runs (starting it with the catalog of `harnessBuild`); returns its facts. */
export async function ensureSim(harnessBuild) {
  const running = await simStatus()
  if (running) return running
  mkdirSync(simDir(), { recursive: true, mode: 0o700 })
  const lock = join(simDir(), `start-${checkoutTag()}.lock`)
  for (let i = 0; ; i++) {
    const { held } = takeLock(lock)
    if (held === undefined) break
    if (i > 60) throw new DsdError(`another dsd (pid ${held}) has been starting the simulator for a minute`)
    await sleep(1000)
    const started = await simStatus()
    if (started) return started
  }
  try {
    const again = await simStatus()
    if (again) return again
    const log = openRunLog(join(machineLogDir(), 'sim'), { tag: 'pending', identity: `provider simulator of ${REPO}, started by dsd pid ${process.pid}` })
    const catalog = harnessBuild ? catalogDir(harnessBuild) : undefined
    const args = [SERVER(), '--db', join(simDir(), 'sim.sqlite'), '--port', '0', ...(catalog ? ['--catalog', catalog] : [])]
    const out = join(simDir(), `start-${checkoutTag()}.out`)
    rmSync(out, { force: true })
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', openSync(out, 'w'), log.fd] })
    child.unref()
    log.rename(child.pid)
    log.close()
    let url
    for (let i = 0; i < 100 && !url; i++) {
      await sleep(100)
      if (child.exitCode !== null) throw new DsdError(`the simulator exited at start; log: ${log.path}`)
      url = existsSync(out) ? readFileSync(out, 'utf8').split('\n')[0].trim() || undefined : undefined
    }
    if (!url) throw new DsdError(`the simulator did not start; log: ${log.path}`)
    writeFileSync(stateFile(), `${JSON.stringify({ pid: child.pid, url, started: isoLocal(), checkout: REPO, log: log.path }, null, 2)}\n`, { mode: 0o600 })
    note(`provider simulator on ${url} (log: ${log.path})`)
    return await simStatus()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** Stop the simulator, if it runs. */
export async function stopSim() {
  const running = await simStatus()
  if (!running) return false
  process.kill(running.pid, 'SIGTERM')
  for (let i = 0; i < 50 && alive(running.pid); i++) await sleep(100)
  rmSync(stateFile(), { force: true })
  return true
}

/**
 * A comma-separated account list with its sets expanded: `standard` is one
 * account per provider and route (every fixture marked `standard`: a key for
 * each API route and a signed-in Plan for each Plan route), `none` is none.
 * One account per slot (a key's environment variable, a Plan's route): a
 * later account replaces an earlier one, so `standard,openrouter-low` is the
 * standard set with a nearly spent OpenRouter key.
 */
export function expandAccounts(spec, known = fixtures()) {
  const items = String(spec).split(',').map(s => s.trim()).filter(Boolean).flatMap((item) => {
    if (item === 'none') return []
    if (item === 'standard') return Object.entries(known).filter(([, f]) => f.standard).map(([name]) => name)
    return [item]
  })
  const slot = (item) => {
    const fixture = known[item.split('=')[0]]
    return fixture === undefined ? item : fixture.signIn ? `route:${fixture.signIn}` : fixture.env ? `env:${fixture.env}` : `account:${item}`
  }
  const bySlot = new Map()
  for (const item of items) { bySlot.delete(slot(item)); bySlot.set(slot(item), item) }
  return [...bySlot.values()]
}

/** The suffix that names a sign-in fixture's signed-out form. */
export const SIGNED_OUT = '-signed-out'

/**
 * The named test accounts: the fixture files' accounts, each sign-in fixture
 * followed by its signed-out form `<name>-signed-out` (`signedOut: true`, never
 * `standard`): the same account in the simulator and the same route rows in
 * the profile, but no grant stored, so the Plan is configured and signed out.
 */
export function fixtures() {
  const read = {}
  for (const file of readdirSync(FIXTURES()).filter(f => f.endsWith('.json')).sort()) Object.assign(read, JSON.parse(readFileSync(join(FIXTURES(), file), 'utf8')).accounts)
  const all = {}
  for (const [name, fixture] of Object.entries(read)) {
    all[name] = fixture
    if (!fixture.signIn || fixture.signedOut || read[`${name}${SIGNED_OUT}`]) continue
    const { standard: _standard, ...rest } = fixture
    all[`${name}${SIGNED_OUT}`] = { ...rest, signedOut: true }
  }
  return all
}

/** POST JSON to the simulator; the answer's JSON. */
async function simPost(sim, path, body, what) {
  const response = await fetch(`${sim.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new DsdError(`the simulator refused ${what}: ${await response.text()}`)
  return response.json()
}

/**
 * Accounts for a throwaway: each `name` or `name=<credential>` resolved,
 * created (or reset to the fixture's state when fresh) in the simulator. A
 * sign-in fixture is signed in: its `grant` is the OAuth credential pi-ai
 * stores for the route (`{ type: 'oauth', access, refresh, expires }`); a
 * signed-out one keeps its `route` (and rows) with no grant.
 * @returns {Promise<Array<{ name, provider, credential, env?, settings?, route?, grant? }>>}
 */
export async function provisionAccounts(sim, spec, suffix) {
  const known = fixtures()
  const out = []
  for (const item of expandAccounts(spec, known)) {
    const [name, given] = item.split('=')
    const fixture = known[name]
    if (!fixture) throw new DsdError(`no test account "${name}" (have: ${Object.keys(known).join(', ')})`)
    const kind = fixture.kind ?? 'key'
    const credential = given ?? (kind === 'email' ? fixture.credential.replace('@', `+${suffix}@`) : `${fixture.credential}-${suffix}`)
    await simPost(sim, '/_sim/account', { provider: fixture.provider, kind, credential, ...(given === undefined && fixture.state ? { state: fixture.state } : {}) }, `account ${name}`)
    const account = { name, provider: fixture.provider, credential, env: fixture.env, settings: fixture.settings }
    if (fixture.signIn) {
      const route = fixture.signIn
      if (out.some(a => a.route === route)) throw new DsdError(`${out.find(a => a.route === route).name} and ${name} both sign in to ${route}; a throwaway holds one sign-in per route`)
      account.route = route
      if (fixture.signedOut) { out.push(account); continue }
      const issued = await simPost(sim, '/_sim/sign-in', { provider: fixture.provider, email: credential }, `the sign-in of ${name}`)
      // As pi-ai's login stores it: expiry five minutes early, so it refreshes in time.
      Object.assign(account, { grant: { type: 'oauth', refresh: issued.refresh_token, access: issued.access_token, expires: Date.now() + issued.expires_in * 1000 - 5 * 60 * 1000 } })
    }
    out.push(account)
  }
  return out
}

/**
 * The credentials document of a home holding these sign-ins (`$DSH_HOME/.credentials.yaml`,
 * credentials-local's version 1: records keyed `llm-pi-ai/<route>`, a grant's payload
 * pi-ai's own credential), or undefined when there are none. JSON is YAML.
 */
export function credentialsDocument(accounts) {
  const records = Object.fromEntries(accounts.filter(a => a.grant).map(a => [`llm-pi-ai/${a.route}`, { kind: 'grant', payload: a.grant }]))
  return Object.keys(records).length === 0 ? undefined : `${JSON.stringify({ version: 1, records }, null, 2)}\n`
}
