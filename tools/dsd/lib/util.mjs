/**
 * Small shared helpers: errors, argument parsing, flat YAML, time stamps.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'

/** A failure reported as `dsd: <message>` with an exit code, never a stack. */
export class DsdError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

/** Throw a usage error (exit 2). */
export function usage(message) {
  throw new DsdError(message, 2)
}

/**
 * Parse `argv` into positionals and flags. `--x=v` and `--x v` give values to
 * the names in `valued`; every other `--x` is a boolean.
 * @param {string[]} argv
 * @param {string[]} valued - flags that take a value.
 * @returns {{ _: string[], [flag: string]: unknown }}
 */
export function parseArgs(argv, valued = []) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') { out._.push(...argv.slice(i + 1)); break }
    if (!arg.startsWith('--')) { out._.push(arg); continue }
    const eq = arg.indexOf('=')
    const name = arg.slice(2, eq < 0 ? undefined : eq)
    if (eq >= 0) out[name] = arg.slice(eq + 1)
    else if (valued.includes(name)) {
      if (i + 1 >= argv.length) usage(`--${name} needs a value`)
      out[name] = argv[++i]
    } else out[name] = true
  }
  return out
}

/** Reject flags a command does not know. */
export function onlyFlags(args, known) {
  for (const name of Object.keys(args)) if (name !== '_' && !known.includes(name)) usage(`unknown option --${name}`)
}

/**
 * Read flat YAML (`key: value` lines; comments and blank lines skipped).
 * Values: JSON strings, true/false, numbers, or bare text. variant.yml uses
 * only this subset.
 */
export function parseFlatYaml(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line === '' || line.trimStart().startsWith('#')) continue
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!m) throw new DsdError(`cannot read line: ${line}`)
    const value = m[2].startsWith('"') ? m[2] : m[2].replace(/\s+#.*$/, '')
    out[m[1]] = value.startsWith('"') ? JSON.parse(value)
      : value === 'true' ? true : value === 'false' ? false
        : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value
  }
  return out
}

/** Write flat YAML; strings are quoted when they would not read back as themselves. */
export function formatFlatYaml(object, header = '') {
  const lines = header ? header.split('\n').map(l => `# ${l}`.trimEnd()) : []
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue
    const bare = typeof value === 'string' && /^[\w./@:+~-][\w ./@:+~-]*$/.test(value)
      && !/^(true|false|-?\d+(\.\d+)?)$/.test(value) && !value.includes(' #')
    lines.push(`${key}: ${typeof value === 'string' && !bare ? JSON.stringify(value) : String(value)}`)
  }
  return `${lines.join('\n')}\n`
}

/** File-name stamps and ISO local times: the shared implementation (packages/logs). */
export { fileStamp, isoLocal } from '../../../packages/logs/index.mjs'

/** The first executable `name` on PATH, or undefined (no `which`: NixOS keeps it out of /usr/bin). */
export function onPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, name)
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate } catch { /* next */ }
  }
  return undefined
}

/** Run git and return trimmed stdout. */
export function git(cwd, args) {
  try {
    // Diffs of a whole topic can be large (test fixtures); the default 1 MiB buffer would fail them.
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 }).trim()
  } catch (error) {
    const reason = error.code === 'ENOBUFS' ? 'output larger than 512 MiB' : String(error.stderr || error.message).trim().split('\n')[0]
    throw new DsdError(`git ${args.join(' ')} (in ${cwd}): ${reason}`)
  }
}

/** Print a JSON value on stdout. */
export function printJson(value) {
  if (selected !== undefined) {
    const picked = pick(value, selected)
    if (picked === undefined) throw new DsdError(`--get ${selected}: the output has no such field`)
    process.stdout.write(typeof picked === 'string' ? `${picked}\n` : `${JSON.stringify(picked, null, 2)}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** `--get <path>` (any command): print only that field of the JSON output (`a.b.0.c`), a string as it is. */
let selected
export function selectOutput(path) { selected = path }

/** A field of a JSON value by a dotted path; array indices are numbers, `-1` the last. */
export function pick(value, path) {
  let at = value
  for (const key of String(path).split('.').filter(Boolean)) {
    if (at === null || typeof at !== 'object') return undefined
    at = Array.isArray(at) && /^-?\d+$/.test(key) ? at.at(Number(key)) : at[key]
  }
  return at
}

/** A progress line on stderr. */
export function note(message) {
  process.stderr.write(`dsd: ${message}\n`)
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * The environment for a throwaway's relay, server and app: the caller's,
 * without what describes the caller's own DeepSea or DSH instance (every
 * `DSH_*` variable, and `DEEPSEA_RELAY` and `DEEPSEA_VARIANT`, which a relay
 * sets for its server), then `extra`. A throwaway started from an agent's
 * shell inside a variant would otherwise take that variant's home, profile,
 * session or relay for its own. dsd's own settings (`DEEPSEA_ROOT`,
 * `DEEPSEA_PORTS`, …) stay.
 * @param {Record<string, string>} [extra] - variables to set on top
 * @param {NodeJS.ProcessEnv} [env] - the environment to start from
 */
export function throwawayEnv(extra = {}, env = process.env) {
  const clean = Object.fromEntries(Object.entries(env)
    .filter(([key]) => !key.startsWith('DSH_') && key !== 'DEEPSEA_RELAY' && key !== 'DEEPSEA_VARIANT'))
  return { ...clean, ...extra }
}
