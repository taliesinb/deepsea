/**
 * The script grammar: every command and its fields, parsing and validation
 * (all problems at once, before anything runs), the `help` table, and a
 * command's evaluation against the JSON context just before it runs.
 * Pure: no dependencies.
 */
import { checkExpressions, checkSave, checkValue, evaluate, hasExpressions, isValueExpression, ScriptValueError, SPLAT_KEY } from './values.mjs'

/** Error kinds: the harness code and the HTTP status. */
export const ERROR_KINDS = {
  'rate-limit': { code: 'RATE_LIMIT', status: 429 },
  'overloaded': { code: 'SERVER', status: 529 },
  'server': { code: 'SERVER', status: 500 },
  'timeout': { code: 'TIMEOUT', status: 504 },
  'network': { code: 'TRANSPORT' },
  'auth': { code: 'INVALID_CREDENTIAL', status: 401 },
  'quota': { code: 'QUOTA', status: 402 },
  'context-length': { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 },
  'invalid-request': { code: 'INVALID_REQUEST', status: 400 },
}

/** What `expect` checks when it names no `value`: the text the model saw from the last tool call. */
export const DEFAULT_EXPECT_VALUE = 'tools.last.text'

/** What `print` shows when it names no `value`: the last tool call, whole. */
export const DEFAULT_PRINT_VALUE = 'tools.last'

/** How many characters of a value `print` shows unless its `maxChars` says otherwise. */
export const DEFAULT_PRINT_CHARS = 4000

const isString = v => typeof v === 'string'
const isNonEmptyString = v => typeof v === 'string' && v.length > 0
const isCount = v => Number.isInteger(v) && v >= 0
const isPositiveInt = v => Number.isInteger(v) && v >= 1
const isSeconds = (max = 600) => v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isRegExp = (v) => {
  if (!isString(v)) return false
  try { new RegExp(v); return true } catch { return false }
}
const isName = v => isNonEmptyString(v) && !v.includes('.') && v !== 'this'
const anything = v => v !== undefined

/** Each command's fields: [check, required, description]. */
const SCHEMA = {
  say: { text: [isString, true, 'a string'], chunks: [isPositiveInt, false, 'a whole number ≥ 1'], chunkDelay: [isSeconds(60), false, 'seconds from 0 to 60'] },
  think: { text: [isString, true, 'a string'], chunks: [isPositiveInt, false, 'a whole number ≥ 1'], chunkDelay: [isSeconds(60), false, 'seconds from 0 to 60'] },
  print: { value: [anything, false, 'a value'], prefix: [isString, false, 'a string'], maxChars: [isPositiveInt, false, 'a whole number ≥ 1'], chunks: [isPositiveInt, false, 'a whole number ≥ 1'], chunkDelay: [isSeconds(60), false, 'seconds from 0 to 60'] },
  tool: { name: [isNonEmptyString, true, 'a tool name'], args: [isObject, false, 'an object'], id: [isNonEmptyString, false, 'a non-empty string'], chunks: [isPositiveInt, false, 'a whole number ≥ 1'], chunkDelay: [isSeconds(60), false, 'seconds from 0 to 60'] },
  batch: { cmds: [v => Array.isArray(v) && v.length > 0, true, 'a non-empty list of commands'] },
  expect: { value: [anything, false, 'a value'], equals: [anything, false, 'any JSON'], contains: [isString, false, 'a string'], matches: [isRegExp, false, 'a regular expression'] },
  loop: { values: [anything, true, 'a value giving a list'], body: [v => isObject(v) || (Array.isArray(v) && v.length > 0), true, 'a command or a non-empty list of commands'], id: [isName, false, 'a name without dots, not "this"'], delay: [isSeconds(), false, 'seconds from 0 to 600'], limit: [isCount, false, 'a whole number ≥ 0'] },
  save: { locals: [isObject, false, 'an object of name → value'], globals: [isObject, false, 'an object of name → value'] },
  sleep: { time: [isSeconds(), true, 'seconds from 0 to 600'] },
  usage: { input: [isCount, true, 'a whole number ≥ 0'], output: [isCount, true, 'a whole number ≥ 0'], cacheRead: [isCount, false, 'a whole number ≥ 0'], cacheWrite: [isCount, false, 'a whole number ≥ 0'], reasoning: [isCount, false, 'a whole number ≥ 0'] },
  error: { kind: [v => Object.hasOwn(ERROR_KINDS, v), true, `one of ${Object.keys(ERROR_KINDS).join(', ')}`], message: [isNonEmptyString, false, 'a non-empty string'], status: [v => Number.isInteger(v) && v >= 100 && v <= 599, false, 'an HTTP status from 100 to 599'], retryAfter: [v => typeof v === 'number' && v > 0 && v <= 3600, false, 'seconds above 0, at most 3600'], times: [isPositiveInt, false, 'a whole number ≥ 1'] },
  end: { reason: [v => v === 'stop' || v === 'max-tokens', false, 'stop or max-tokens'] },
  title: { text: [isNonEmptyString, true, 'a non-empty string'] },
}

/**
 * Fields written out as they are: they shape the script before it runs (its
 * title, its tool ids, its structure), or are values of their own (`expect`'s
 * `value`, `loop`'s `values`, `save`'s maps), so `$value$` does not apply.
 * `$splat$` in this list means the command takes no splat.
 */
const LITERAL_FIELDS = {
  tool: ['id'],
  batch: ['cmds', SPLAT_KEY],
  loop: ['body', 'id', 'delay', 'limit', SPLAT_KEY],
  save: [SPLAT_KEY],
  title: ['text', SPLAT_KEY],
}

/** Fields that are a <VALUE> themselves (not JSON with `$value$` inside). */
const VALUE_FIELDS = { expect: ['value'], loop: ['values'], print: ['value'] }

/** What each command does, for `help`. */
const PURPOSE = {
  say: 'a text block, streamed in `chunks` pieces `chunkDelay` s apart',
  think: 'a reasoning block, as `say`',
  print: 'a text block showing a value (default `tools.last`) in a fenced block: a string as it is, anything else as indented JSON; `prefix` above it, at most `maxChars` (default 4000) characters',
  tool: 'a tool call, its arguments streamed in `chunks` pieces `chunkDelay` s apart; it ends the response, and the script continues once its result is in',
  batch: 'runs `cmds` in one response: their tool calls go out together, and the script continues once all their results are in',
  expect: 'checks a value (default `tools.last.text`): `equals` (any JSON), `contains` (text), `matches` (a regular expression)',
  loop: 'runs `body` once per item of the list `values` gives (at most `limit`), `delay` s apart; `loop.this` (and `loop.<id>`) is `{id, index, value, count, last}`',
  save: 'writes `locals` (this script) and `globals` (later scripts too): name → value',
  sleep: 'waits `time` s',
  usage: 'the token usage this response reports',
  error: 'fails the request as a provider error; with `times`, only the first attempts',
  end: 'the finish reason (`stop` or `max-tokens`); last line only',
  title: "the session's title, when the titler asks",
}

/** The `help` reply: the plain commands and every script command with its fields, as Markdown. */
export function helpText() {
  const fields = cmd => Object.entries(SCHEMA[cmd]).map(([name, [, required]]) => `\`${name}${required ? '' : '?'}\``).join(' ')
  const rows = Object.keys(SCHEMA).map(cmd => `| \`{"cmd":"${cmd}"}\` | ${fields(cmd)} | ${PURPOSE[cmd]} |`)
  return [
    'Plain prompts:',
    '',
    '| Prompt | Reply |',
    '|---|---|',
    '| `say <text>` | `<text>` (one line) |',
    '| `help` | this table |',
    '',
    'Scripts: a prompt starting with `{`, one JSON command per line (`?` marks an optional field):',
    '',
    '| Command | Fields | Does |',
    '|---|---|---|',
    ...rows,
    '',
    `Error kinds: ${Object.keys(ERROR_KINDS).map(k => `\`${k}\``).join(', ')}.`,
    '',
    'Values: `{"$value$": V}` anywhere in a command is replaced by V, evaluated against `{tools, locals, globals, loop}` just before the command runs; `"$splat$": V` merges an object V into its object (in a list, `{"$splat$": V}` splices a list V). V is a path (`"tools.bash.result.jobId"`) or `{"type": …}`: `load` `path`, `toString` `value`, `stringSub` `str` `lhs` `rhs`, `literal` `value`, `range` `start?` `stop` `step?`. Each finished tool call is `tools.last`, `tools.<name>` and `tools.<id>`: `{name, args, result, text, duration, error, ok}`.',
  ].join('\n')
}

/** Where a command is, for messages: `line 3`, or `line 3, body[1]` inside a loop or batch. */
export const label = command => command.at ? `line ${command.line}, ${command.at}` : `line ${command.line}`

const join = (at, part) => at === '' ? part : `${at}.${part}`

/**
 * Parse and validate a whole script. Returns its commands or every problem
 * found, so one error message can list them all. Each command carries its
 * `line`, its place inside a loop or batch (`at`, e.g. `body[1]`) and a
 * `ref` unique in the script (`3`, `3_1`), from which tool call ids are made.
 * A `batch`'s `cmds` and a `loop`'s `body` are parsed commands (a body is
 * always a list).
 * @param {string} text - JSONL; blank lines are skipped.
 * @returns {{ commands: object[], errors: string[] }}
 */
export function parseScript(text) {
  const commands = []
  const errors = []
  const ids = new Set()
  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    if (raw.trim() === '') return
    let value
    try { value = JSON.parse(raw) } catch (error) { errors.push(`line ${line}: not JSON (${error.message})`); return }
    const command = parseCommand(value, { line, at: '', ref: String(line), within: undefined, inBatch: false }, errors, ids)
    if (command !== undefined) commands.push(command)
  })
  if (errors.length === 0) {
    const titles = commands.filter(c => c.cmd === 'title')
    if (titles.length > 1) errors.push(`${label(titles[1])}: only one title per script`)
    const steps = commands.filter(c => c.cmd !== 'title')
    steps.forEach((c, i) => { if (c.cmd === 'end' && i !== steps.length - 1) errors.push(`${label(c)}: end must be the last command`) })
  }
  return { commands, errors }
}

/** Parse one command (and the commands inside it), pushing its problems onto `errors`. */
function parseCommand(value, { line, at, ref, within, inBatch }, errors, ids) {
  const where = at === '' ? `line ${line}` : `line ${line}, ${at}`
  const fail = message => errors.push(`${where}: ${message}`)
  if (!isObject(value)) { fail(at === '' ? 'not a JSON object' : 'not a command (a JSON object)'); return undefined }
  const { cmd, ...fields } = value
  if (cmd === undefined) { fail('no "cmd"'); return undefined }
  if (!isString(cmd) || !Object.hasOwn(SCHEMA, cmd)) { fail(`unknown cmd ${JSON.stringify(cmd)} (known: ${Object.keys(SCHEMA).join(', ')})`); return undefined }
  if (within !== undefined && (cmd === 'title' || cmd === 'end')) fail(`${cmd} cannot be inside a ${within}`)
  if (inBatch && cmd === 'batch') fail('a batch cannot be inside a batch')

  const literal = LITERAL_FIELDS[cmd] ?? []
  const values = VALUE_FIELDS[cmd] ?? []
  const problems = []
  for (const key of literal) {
    if (!Object.hasOwn(fields, key)) continue
    if (key === SPLAT_KEY) problems.push(`${cmd} takes no "${SPLAT_KEY}"`)
    else if (key !== 'cmds' && key !== 'body' && hasExpressions(fields[key])) problems.push(`${cmd} "${key}" must be written out, not a value expression`)
  }
  if (cmd === 'save') problems.push(...checkSave(fields))
  for (const key of values) if (Object.hasOwn(fields, key)) problems.push(...checkValue(fields[key], key))
  const evaluated = Object.fromEntries(Object.entries(fields).filter(([key]) => !literal.includes(key) && !values.includes(key)))
  if (cmd !== 'save') problems.push(...checkExpressions(evaluated))
  problems.forEach(fail)
  if (problems.length === 0) errors.push(...checkCommand({ cmd, line, at, ...fields }, { deferred: true }))

  if (cmd === 'tool' && isString(fields.id)) {
    if (ids.has(fields.id)) fail(`tool id "${fields.id}" is used twice`)
    ids.add(fields.id)
  }
  const command = { cmd, line, ...at === '' ? {} : { at }, ref, ...fields }
  if (cmd === 'batch' && Array.isArray(fields.cmds)) {
    command.cmds = fields.cmds.flatMap((c, i) => parseCommand(c, { line, at: join(at, `cmds[${i}]`), ref: `${ref}_${i}`, within: 'batch', inBatch: true }, errors, ids) ?? [])
  }
  if (cmd === 'loop' && (isObject(fields.body) || Array.isArray(fields.body))) {
    const body = Array.isArray(fields.body) ? fields.body : [fields.body]
    command.body = body.flatMap((c, i) => parseCommand(c, { line, at: join(at, Array.isArray(fields.body) ? `body[${i}]` : 'body'), ref: `${ref}_${i}`, within: 'loop', inBatch }, errors, ids) ?? [])
  }
  return command
}

/**
 * Check a command's fields against its schema. With `deferred` (parse time),
 * fields that are value expressions are checked only once evaluated, and a
 * command with a `"$splat$"` key is not yet missing anything; without it
 * (run time, after evaluation) everything is checked.
 * @param {object} command - `{ cmd, line, at?, ...fields }`
 * @returns {string[]}
 */
export function checkCommand({ cmd, line, at, ref, ...fields }, { deferred = false } = {}) {
  const errors = []
  const where = label({ line, at })
  const schema = SCHEMA[cmd]
  const splatted = deferred && Object.hasOwn(fields, SPLAT_KEY)
  for (const key of Object.keys(fields)) if (!Object.hasOwn(schema, key) && !(splatted && key === SPLAT_KEY)) errors.push(`${where}: ${cmd} has no field "${key}"`)
  for (const [key, [check, required, description]] of Object.entries(schema)) {
    if (fields[key] === undefined) { if (required && !splatted) errors.push(`${where}: ${cmd} needs "${key}" (${description})`); continue }
    if (deferred && isValueExpression(fields[key]) && !(VALUE_FIELDS[cmd] ?? []).includes(key)) continue
    if (!check(fields[key])) errors.push(`${where}: ${cmd} "${key}" must be ${description}`)
  }
  if (cmd === 'expect' && !splatted && fields.equals === undefined && fields.contains === undefined && fields.matches === undefined) {
    errors.push(`${where}: expect needs "equals", "contains" or "matches"`)
  }
  return errors
}

/**
 * A command with its value expressions and splats evaluated against the
 * context, checked again in full. Fields that are values of their own
 * (`expect`'s `value`) are left for the command to evaluate.
 * @throws {ScriptValueError} `line N: …` for a value that cannot be evaluated or an evaluated field that is wrong
 */
export function evaluateCommand(command, context) {
  const { cmd, line, at, ref, ...fields } = command
  const kept = VALUE_FIELDS[cmd] ?? []
  const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => !kept.includes(key)))
  if (!hasExpressions(rest)) return command
  let evaluated
  try { evaluated = evaluate(rest, context) } catch (error) {
    if (error instanceof ScriptValueError) throw new ScriptValueError(`${label(command)}: ${error.message}`)
    throw error
  }
  const problems = [
    ...Object.hasOwn(evaluated, 'cmd') ? [`${label(command)}: "${SPLAT_KEY}" cannot set "cmd"`] : [],
    ...kept.filter(k => Object.hasOwn(evaluated, k)).map(k => `${label(command)}: "${SPLAT_KEY}" cannot set ${cmd} "${k}"`),
    ...(LITERAL_FIELDS[cmd] ?? []).filter(k => k !== SPLAT_KEY && evaluated[k] !== fields[k]).map(k => `${label(command)}: "${SPLAT_KEY}" cannot set ${cmd} "${k}"`),
  ]
  const result = { cmd, line, ...at === undefined ? {} : { at }, ref, ...evaluated, ...Object.fromEntries(kept.filter(k => Object.hasOwn(fields, k)).map(k => [k, fields[k]])) }
  problems.push(...checkCommand(result))
  if (problems.length > 0) throw new ScriptValueError(problems.join('\n'))
  return result
}
