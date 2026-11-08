/**
 * The script interpreter. A script runs top to bottom as a generator of
 * actions; a tool call outside a batch, or a batch with tool calls, ends the
 * response (a `suspend` action), and the script continues once the results
 * are in. A host plays a request by replaying the responses the transcript
 * already has (`resume`: no output, no sleeps, no errors, no checks; saves,
 * loops and the results recorded into the context) and then streaming the
 * actions up to the next `suspend` or the end. Pure: no dependencies.
 */
import { DEFAULT_EXPECT_VALUE, DEFAULT_PRINT_CHARS, DEFAULT_PRINT_VALUE, evaluateCommand, label } from './grammar.mjs'
import { applySave, describe, evaluateValue, put, ScriptValueError } from './values.mjs'

/** How many commands one run may execute (loops included) before it fails. */
export const MAX_STEPS = 100_000

/** A failed `expect`. */
export class ScriptExpectationError extends Error {}

const located = (error, command) => error instanceof ScriptValueError && !error.message.startsWith('line ')
  ? new ScriptValueError(`${label(command)}: ${error.message}`)
  : error

/**
 * Run a script against a context, yielding its actions in order:
 *
 * - `{ op, command, key, evaluate }` for `say`, `think`, `tool`, `expect`,
 *   `sleep`, `usage`, `error` and `end`: `evaluate()` gives the command with
 *   its values evaluated (call it when the action is reached, before asking
 *   for the next one); `key` is unique in the run (the command's `id` or
 *   `ref`, then `-<index>` per enclosing loop): tool call ids are made from it.
 * - `{ op: 'suspend' }` where the response ends to wait for tool results;
 *   record them into `context.tools` before asking for the next action.
 *
 * `save` and `loop` act on the context inside the generator. A loop's
 * `delay` is a `sleep` action between iterations. A `print` is a `say`
 * action whose text shows the value (`formatPrint`).
 * @throws {ScriptValueError} a value that cannot be evaluated (`line N: …`)
 */
export function* interpret(commands, context) {
  let steps = 0
  let batched = 0
  const action = (command, path) => ({
    op: command.cmd,
    command,
    key: `${command.id ?? command.ref}${path.map(i => `-${i}`).join('')}`,
    evaluate: () => evaluateCommand(command, context),
  })

  function* block(list, inBatch, path) {
    for (const command of list) {
      if (++steps > MAX_STEPS) throw new ScriptValueError(`${label(command)}: the script ran more than ${MAX_STEPS} commands`)
      switch (command.cmd) {
        case 'title': break
        case 'save':
          try { applySave(command, context) } catch (error) { throw located(error, command) }
          break
        case 'batch':
          yield* block(command.cmds, true, path)
          if (batched > 0) { batched = 0; yield { op: 'suspend' } }
          break
        case 'loop': yield* loop(command, inBatch, path); break
        case 'print': yield { ...action(command, path), op: 'say', evaluate: () => printed(command, context) }; break
        case 'tool':
          yield action(command, path)
          if (inBatch) batched++
          else yield { op: 'suspend' }
          break
        default: yield action(command, path)
      }
    }
  }

  function* loop(command, inBatch, path) {
    let values
    try { values = evaluateValue(command.values, context, 'values') } catch (error) { throw located(error, command) }
    if (!Array.isArray(values)) throw new ScriptValueError(`${label(command)}: loop "values" must give a list, not ${describe(values)}`)
    const items = command.limit === undefined ? values : values.slice(0, command.limit)
    // `loop.this` and `loop.<id>` hold only inside the loop: what they were before comes back after it.
    const scope = context.loop
    const names = command.id === undefined ? ['this'] : ['this', command.id]
    const before = names.map(name => [name, Object.hasOwn(scope, name), scope[name]])
    for (const [index, value] of items.entries()) {
      if (index > 0 && command.delay) {
        const sleep = { cmd: 'sleep', line: command.line, ...command.at ? { at: command.at } : {}, ref: command.ref, time: command.delay }
        yield { op: 'sleep', command: sleep, key: `${command.ref}${path.map(i => `-${i}`).join('')}`, evaluate: () => sleep }
      }
      const descriptor = { id: command.id ?? null, index, value, count: items.length, last: index === items.length - 1 }
      for (const name of names) put(scope, name, descriptor)
      yield* block(command.body, inBatch, [...path, index])
    }
    for (const [name, had, value] of before) {
      if (had) put(scope, name, value)
      else delete scope[name]
    }
  }

  yield* block(commands, false, [])
}

/**
 * Replay a script's first `position` responses, as far as they go, and
 * return the run at the start of the next one; `undefined` when the script
 * ended within them. Replay emits nothing: only saves, loops and the
 * recorded results act on the context.
 * @param {(response: number, calls: object[]) => void} record - puts the results of response `n`'s tool calls (its `tool` actions, in order, each with `replayed`: the evaluated command, or undefined when it no longer evaluates) into the context
 * @returns {Generator | undefined}
 */
export function resume(commands, context, position, record) {
  const run = interpret(commands, context)
  let calls = []
  for (let response = 0; response < position;) {
    const { value, done } = run.next()
    if (done) return undefined
    if (value.op === 'tool') {
      try { value.replayed = value.evaluate() } catch { value.replayed = undefined }
      calls.push(value)
    } else if (value.op === 'suspend') {
      record(response, calls)
      calls = []
      response++
    }
  }
  return run
}

/** A `print` command as the `say` that shows its value. */
function printed(command, context) {
  const { value = DEFAULT_PRINT_VALUE, prefix, maxChars, chunks, chunkDelay } = evaluateCommand(command, context)
  let shown
  try { shown = evaluateValue(value, context, 'value') } catch (error) { throw located(error, command) }
  const { cmd, line, at, ref } = command
  return {
    cmd: 'say', line, ...at ? { at } : {}, ref, text: formatPrint(shown, { prefix, maxChars }),
    ...chunks === undefined ? {} : { chunks }, ...chunkDelay === undefined ? {} : { chunkDelay },
  }
}

/**
 * A value as Markdown: a string as it is in a plain fenced block, anything
 * else as JSON indented by 2 in a `json` one, the fence longer than any run
 * of backticks inside; `prefix` on the line above; at most `maxChars`
 * characters, then how many more there were.
 */
export function formatPrint(value, { prefix, maxChars = DEFAULT_PRINT_CHARS } = {}) {
  const isText = typeof value === 'string'
  let body = isText ? value : JSON.stringify(value, null, 2)
  let note = ''
  if (body.length > maxChars) {
    note = `\n… (${body.length - maxChars} more characters)`
    body = body.slice(0, maxChars)
  }
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  // Output that ends its last line (most tool text) closes the block without a blank line.
  const ending = body.endsWith('\n') ? '' : '\n'
  return `${prefix ? `${prefix}\n` : ''}${fence}${isText ? '' : 'json'}\n${body}${ending}${fence}${note}`
}

/** Deep equality of JSON values (key order ignored). */
export function jsonEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]))
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
}

const shown = (v) => {
  const json = JSON.stringify(v) ?? String(v)
  return json.length > 300 ? `${json.slice(0, 300)}…` : json
}

/**
 * Check an evaluated `expect` command against the context.
 * @throws {ScriptExpectationError} what was expected and what is there
 */
export function checkExpectation(command, context) {
  const value = command.value ?? DEFAULT_EXPECT_VALUE
  const what = typeof value === 'string' ? value : 'the value'
  const fail = detail => { throw new ScriptExpectationError(`${label(command)}: expected ${what} ${detail}`) }
  let actual
  try { actual = evaluateValue(value, context) } catch (error) {
    if (error instanceof ScriptValueError) fail(`to be there; ${error.message}`)
    throw error
  }
  if (command.equals !== undefined && !jsonEqual(actual, command.equals)) fail(`to equal ${shown(command.equals)}; got ${shown(actual)}`)
  for (const [check, test] of [['contains', s => s.includes(command.contains)], ['matches', s => new RegExp(command.matches).test(s)]]) {
    if (command[check] === undefined) continue
    if (typeof actual !== 'string') fail(`to be a string that ${check === 'contains' ? 'contains' : 'matches'} ${shown(command[check])}; got ${describe(actual)}, ${shown(actual)}`)
    if (!test(actual)) fail(`to ${check === 'contains' ? 'contain' : 'match'} ${shown(command[check])}; got ${shown(actual)}`)
  }
}
