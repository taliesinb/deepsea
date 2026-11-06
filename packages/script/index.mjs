/**
 * Model scripts: the JSONL language a prompt uses to dictate a model's exact
 * reply (text, reasoning, tool calls, checks, usage, errors), with parsing,
 * validation, the split into responses, and the plain prompts (`say <text>`,
 * `help`). Shared by the scripted model (plugins/llm-scripted) and the
 * provider simulator (tools/provider-sim), which plays the same scripts in
 * each provider's wire protocol. Pure: no dependencies.
 */

/** The reply to a prompt that is not a script and not a plain command. */
export const ORDERS_REPLY = "Awaiting orders, m'lord"

/** The reply once a script that ended in tool calls has nothing left to say. */
export const FINISHED_REPLY = 'Script finished.'

/** Error kinds: the harness code, the HTTP status, and whether the agent loop retries it. */
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

const isString = v => typeof v === 'string'
const isNonEmptyString = v => typeof v === 'string' && v.length > 0
const isCount = v => Number.isInteger(v) && v >= 0
const isPositiveInt = v => Number.isInteger(v) && v >= 1
const isSeconds = (max = 600) => v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isBool = v => typeof v === 'boolean'

/** Each command's fields: [check, required, description]. */
const SCHEMA = {
  say: { text: [isString, true, 'a string'], chunks: [isPositiveInt, false, 'a whole number ≥ 1'], chunkDelay: [isSeconds(60), false, 'seconds from 0 to 60'] },
  think: { text: [isString, true, 'a string'], chunks: [isPositiveInt, false, 'a whole number ≥ 1'], chunkDelay: [isSeconds(60), false, 'seconds from 0 to 60'] },
  tool: { name: [isNonEmptyString, true, 'a tool name'], args: [isObject, false, 'an object'], id: [isNonEmptyString, false, 'a non-empty string'] },
  expect: { contains: [isString, false, 'a string'], equals: [isString, false, 'a string'], isError: [isBool, false, 'true or false'], tool: [isNonEmptyString, false, "a tool command's id"] },
  sleep: { time: [isSeconds(), true, 'seconds from 0 to 600'] },
  usage: { input: [isCount, true, 'a whole number ≥ 0'], output: [isCount, true, 'a whole number ≥ 0'], cacheRead: [isCount, false, 'a whole number ≥ 0'], cacheWrite: [isCount, false, 'a whole number ≥ 0'], reasoning: [isCount, false, 'a whole number ≥ 0'] },
  error: { kind: [v => Object.hasOwn(ERROR_KINDS, v), true, `one of ${Object.keys(ERROR_KINDS).join(', ')}`], message: [isNonEmptyString, false, 'a non-empty string'], status: [v => Number.isInteger(v) && v >= 100 && v <= 599, false, 'an HTTP status from 100 to 599'], retryAfter: [v => typeof v === 'number' && v > 0 && v <= 3600, false, 'seconds above 0, at most 3600'], times: [isPositiveInt, false, 'a whole number ≥ 1'] },
  end: { reason: [v => v === 'stop' || v === 'max-tokens', false, 'stop or max-tokens'] },
  title: { text: [isNonEmptyString, true, 'a non-empty string'] },
}

/** What each command does, for `help`. */
const PURPOSE = {
  say: 'a text block, streamed in `chunks` pieces `chunkDelay` s apart',
  think: 'a reasoning block, as `say`',
  tool: 'a tool call; consecutive `tool` lines are one response, and the script continues after the results',
  expect: 'checks a result of the tool calls just before it (the last, or the one whose `id` is `tool`)',
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
  ].join('\n')
}

/**
 * The reply to a prompt that is not a script: `say <text>` (one line) answers `<text>`, `help` the
 * command table, anything else the standing reply.
 */
export function plainReply(text) {
  const trimmed = text.trim()
  if (/^help$/i.test(trimmed)) return helpText()
  const say = /^say\s+(.+)$/i.exec(trimmed)
  if (say && !/[\r\n]/.test(say[1])) return say[1].trim()
  return ORDERS_REPLY
}

/** Whether a prompt is meant as a script: its text starts with `{` (leading whitespace ignored). */
export function isScript(text) {
  return text.trimStart().startsWith('{')
}

/**
 * Parse and validate a whole script. Returns its commands (each with its
 * `line`) or every problem found, so one error message can list them all.
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
    if (!isObject(value)) { errors.push(`line ${line}: not a JSON object`); return }
    const { cmd, ...fields } = value
    if (cmd === undefined) { errors.push(`line ${line}: no "cmd"`); return }
    const schema = SCHEMA[cmd]
    if (schema === undefined) { errors.push(`line ${line}: unknown cmd ${JSON.stringify(cmd)} (known: ${Object.keys(SCHEMA).join(', ')})`); return }
    for (const key of Object.keys(fields)) if (!Object.hasOwn(schema, key)) errors.push(`line ${line}: ${cmd} has no field "${key}"`)
    for (const [key, [check, required, description]] of Object.entries(schema)) {
      if (fields[key] === undefined) { if (required) errors.push(`line ${line}: ${cmd} needs "${key}" (${description})`); continue }
      if (!check(fields[key])) errors.push(`line ${line}: ${cmd} "${key}" must be ${description}`)
    }
    if (cmd === 'expect' && fields.contains === undefined && fields.equals === undefined && fields.isError === undefined) errors.push(`line ${line}: expect needs "contains", "equals" or "isError"`)
    if (cmd === 'tool' && fields.id !== undefined) {
      if (ids.has(fields.id)) errors.push(`line ${line}: tool id "${fields.id}" is used twice`)
      ids.add(fields.id)
    }
    commands.push({ cmd, line, ...fields })
  })
  if (errors.length === 0) errors.push(...checkOrder(commands))
  return { commands, errors }
}

/** Placement rules: one title, `end` last, `expect` right after tool calls naming one of them. */
function checkOrder(commands) {
  const errors = []
  const titles = commands.filter(c => c.cmd === 'title')
  if (titles.length > 1) errors.push(`line ${titles[1].line}: only one title per script`)
  const steps = commands.filter(c => c.cmd !== 'title')
  steps.forEach((c, i) => {
    if (c.cmd === 'end' && i !== steps.length - 1) errors.push(`line ${c.line}: end must be the last command`)
    if (c.cmd !== 'expect') return
    let j = i - 1
    while (j >= 0 && steps[j].cmd === 'expect') j--
    if (j < 0 || steps[j].cmd !== 'tool') { errors.push(`line ${c.line}: expect must directly follow tool calls (or another expect)`); return }
    if (c.tool !== undefined) {
      let k = j
      const batch = []
      while (k >= 0 && steps[k].cmd === 'tool') batch.push(steps[k--])
      if (!batch.some(t => t.id === c.tool)) errors.push(`line ${c.line}: expect names tool "${c.tool}", which is not in the tool calls just before it`)
    }
  })
  return errors
}

/**
 * Split a script into responses: each ends after a run of consecutive tool
 * calls (the harness runs them and asks again) or at the end. The expects
 * that follow a run open the next response. `title` is not a step.
 * @returns {object[][]}
 */
export function segments(commands) {
  const out = [[]]
  const steps = commands.filter(c => c.cmd !== 'title')
  steps.forEach((c, i) => {
    out.at(-1).push(c)
    if (c.cmd === 'tool' && steps[i + 1]?.cmd !== 'tool') out.push([])
  })
  if (out.length > 1 && out.at(-1).length === 0) out.pop()
  return out
}

/** Split `text` into `n` nearly equal pieces (for chunked streaming). */
export function chunk(text, n = 1) {
  if (n <= 1 || text.length <= 1) return [text]
  const size = Math.ceil(text.length / Math.min(n, text.length))
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}
