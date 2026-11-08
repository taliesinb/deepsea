/**
 * Value expressions in scripts: `{"$value$": <VALUE>}` anywhere in a command
 * is replaced by what <VALUE> evaluates to, a `"$splat$": <VALUE>` key merges
 * an object into the object holding it, and a `{"$splat$": <VALUE>}` list
 * entry splices an array into the list. Values are read from the JSON
 * context `{ tools, locals, globals, loop }` by dotted paths; the `save` command
 * writes `locals` and `globals`. Pure: no dependencies.
 *
 * <VALUE> is one of:
 *   "<path>"                                        load (e.g. "tools.bash.result.jobId")
 *   {"type": "load", "path": "<path>"}               the same, long form
 *   {"type": "toString", "value": <VALUE>}            the value as a string (JSON unless it is one)
 *   {"type": "stringSub", "str": "…", "lhs": "…", "rhs": <VALUE>}   every lhs in str replaced by rhs as a string
 *   {"type": "literal", "value": <anything>}          <anything>, not evaluated
 *   {"type": "range", "start"?, "stop", "step"?}       [start, start + step, …] up to stop (excluded), as Python's
 *                                                   range; each a whole number or a <VALUE> giving one
 *   {"$value$": <VALUE>}                              <VALUE>
 */

export const VALUE_KEY = '$value$'
export const SPLAT_KEY = '$splat$'

/** A value expression that cannot be evaluated against the context (a missing path, a splat of the wrong kind). */
export class ScriptValueError extends Error {}

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = v => typeof v === 'string'
/** What kind of JSON value `v` is, for messages: `a string`, `a list`, `null`. */
export const describe = v => v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : `a ${typeof v}`
const at = (where, key) => typeof key === 'number' ? `${where}[${key}]` : where === '' ? key : `${where}.${key}`
const prefix = where => where === '' ? '' : `${where}: `

/** The longest list a `range` gives. */
export const MAX_RANGE = 10_000

/** Set an own property, `__proto__` included, as JSON.parse would. */
export function put(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/** Whether `node` is `{"$value$": …}`. */
export const isValueExpression = node => isObject(node) && Object.hasOwn(node, VALUE_KEY)
const isSplatEntry = node => isObject(node) && Object.hasOwn(node, SPLAT_KEY) && Object.keys(node).length === 1

/** Whether `node` holds a value expression or a splat anywhere. */
export function hasExpressions(node) {
  if (Array.isArray(node)) return node.some(hasExpressions)
  if (!isObject(node)) return false
  if (Object.hasOwn(node, VALUE_KEY) || Object.hasOwn(node, SPLAT_KEY)) return true
  return Object.values(node).some(hasExpressions)
}

/** Each value type's fields: [kind, required]. */
const VALUE_FIELDS = {
  load: { path: ['path', true] },
  toString: { value: ['value', true] },
  stringSub: { str: ['string', true], lhs: ['string', true], rhs: ['value', true] },
  literal: { value: ['any', true] },
  range: { start: ['int', false], stop: ['int', true], step: ['int', false] },
}

/** Problems with a path string: empty, or an empty segment. */
function pathProblem(path) {
  if (path === '') return 'a path cannot be empty'
  if (path.split('.').some(s => s === '')) return `path ${JSON.stringify(path)} has an empty segment`
  return undefined
}

/**
 * Check the syntax of a <VALUE> (not whether its paths exist).
 * @returns {string[]} problems, each prefixed with `where`
 */
export function checkValue(value, where = '') {
  if (isString(value)) { const p = pathProblem(value); return p ? [`${prefix(where)}${p}`] : [] }
  if (isValueExpression(value)) return Object.keys(value).length === 1 ? checkValue(value[VALUE_KEY], where) : [`${prefix(where)}{"${VALUE_KEY}": …} takes no other keys`]
  if (!isObject(value)) return [`${prefix(where)}a value is a path string or an object with "type" (${describe(value)} needs {"type": "literal", "value": …})`]
  const fields = VALUE_FIELDS[value.type]
  if (fields === undefined) return [`${prefix(where)}value "type" must be one of ${Object.keys(VALUE_FIELDS).join(', ')}`]
  const errors = []
  for (const key of Object.keys(value)) if (key !== 'type' && !Object.hasOwn(fields, key)) errors.push(`${prefix(where)}${value.type} has no field "${key}"`)
  for (const [key, [kind, required]] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) { if (required) errors.push(`${prefix(where)}${value.type} needs "${key}"`); continue }
    const v = value[key]
    if (kind === 'value') errors.push(...checkValue(v, at(where, key)))
    else if (kind === 'int') errors.push(...typeof v === 'number' ? Number.isInteger(v) ? [] : [`${prefix(where)}${value.type} "${key}" must be a whole number`] : checkValue(v, at(where, key)))
    else if (kind === 'path') { const p = isString(v) ? pathProblem(v) : 'path must be a string'; if (p) errors.push(`${prefix(where)}${p}`) }
    else if (kind === 'string' && !isString(v)) errors.push(`${prefix(where)}${value.type} "${key}" must be a string`)
  }
  if (value.type === 'stringSub' && value.lhs === '') errors.push(`${prefix(where)}stringSub "lhs" cannot be empty`)
  if (value.type === 'range' && value.step === 0) errors.push(`${prefix(where)}range "step" cannot be 0`)
  return errors
}

/**
 * Check every value expression and splat in a JSON tree.
 * @returns {string[]} problems, each prefixed with where it is
 */
export function checkExpressions(node, where = '') {
  if (Array.isArray(node)) return node.flatMap((item, i) => isSplatEntry(item) ? checkValue(item[SPLAT_KEY], at(where, i)) : checkExpressions(item, at(where, i)))
  if (!isObject(node)) return []
  if (Object.hasOwn(node, VALUE_KEY)) return Object.keys(node).length === 1 ? checkValue(node[VALUE_KEY], where) : [`${prefix(where)}{"${VALUE_KEY}": …} takes no other keys`]
  return Object.entries(node).flatMap(([key, v]) => key === SPLAT_KEY ? checkValue(v, at(where, key)) : checkExpressions(v, at(where, key)))
}

/** Read a dotted path (`tools.bash.result.jobId`, `tools.last.args.items.0`) from the context. */
export function load(context, path) {
  let current = context
  const done = []
  for (const segment of path.split('.')) {
    const here = done.length === 0 ? 'the context' : done.join('.')
    if (Array.isArray(current)) {
      const i = /^\d+$/.test(segment) ? Number(segment) : NaN
      if (!(i < current.length)) throw new ScriptValueError(`"${path}": ${here} is a list of ${current.length}, with no item ${JSON.stringify(segment)}`)
      current = current[i]
    } else if (isObject(current)) {
      if (!Object.hasOwn(current, segment)) {
        const keys = Object.keys(current)
        throw new ScriptValueError(`"${path}": no "${segment}" in ${here} (${keys.length === 0 ? 'it is empty' : `it has ${keys.map(k => JSON.stringify(k)).join(', ')}`})`)
      }
      current = current[segment]
    } else {
      throw new ScriptValueError(`"${path}": ${here} is ${describe(current)}, not an object`)
    }
    done.push(segment)
  }
  return current
}

/** A value as a string: a string as it is, anything else as JSON. */
export const stringify = v => isString(v) ? v : JSON.stringify(v)

/** Evaluate a <VALUE> (checked by {@link checkValue}) against the context. */
export function evaluateValue(value, context, where = '') {
  try {
    if (isString(value)) return load(context, value)
    if (isValueExpression(value)) return evaluateValue(value[VALUE_KEY], context, where)
    switch (value.type) {
      case 'load': return load(context, value.path)
      case 'toString': return stringify(evaluateValue(value.value, context))
      case 'stringSub': return value.str.replaceAll(value.lhs, stringify(evaluateValue(value.rhs, context)))
      case 'literal': return value.value
      case 'range': return range(value, context)
    }
  } catch (error) {
    if (error instanceof ScriptValueError && where !== '' && !error.message.startsWith(prefix(where))) throw new ScriptValueError(`${prefix(where)}${error.message}`)
    throw error
  }
  throw new ScriptValueError(`${prefix(where)}not a value`)
}

/** A `range` value's list. */
function range(value, context) {
  const whole = (key, fallback) => {
    if (value[key] === undefined) return fallback
    const v = typeof value[key] === 'number' ? value[key] : evaluateValue(value[key], context)
    if (!Number.isInteger(v)) throw new ScriptValueError(`range "${key}" must be a whole number, not ${describe(v)}`)
    return v
  }
  const start = whole('start', 0)
  const stop = whole('stop')
  const step = whole('step', 1)
  if (step === 0) throw new ScriptValueError('range "step" cannot be 0')
  const length = Math.max(0, Math.ceil((stop - start) / step))
  if (length > MAX_RANGE) throw new ScriptValueError(`range gives ${length} numbers, more than ${MAX_RANGE}`)
  return Array.from({ length }, (_, i) => start + i * step)
}

/**
 * Evaluate every value expression and splat in a JSON tree; what they load
 * is not evaluated again. Returns a new tree; the input is untouched.
 */
export function evaluate(node, context, where = '') {
  if (Array.isArray(node)) {
    const out = []
    node.forEach((item, i) => {
      if (!isSplatEntry(item)) { out.push(evaluate(item, context, at(where, i))); return }
      const spliced = evaluateValue(item[SPLAT_KEY], context, at(where, i))
      if (!Array.isArray(spliced)) throw new ScriptValueError(`${prefix(at(where, i))}a list entry {"${SPLAT_KEY}": …} must give a list, not ${describe(spliced)}`)
      out.push(...spliced)
    })
    return out
  }
  if (!isObject(node)) return node
  if (Object.hasOwn(node, VALUE_KEY)) return evaluateValue(node[VALUE_KEY], context, where)
  const out = {}
  for (const [key, v] of Object.entries(node)) {
    if (key !== SPLAT_KEY) { put(out, key, evaluate(v, context, at(where, key))); continue }
    const merged = evaluateValue(v, context, at(where, key))
    if (!isObject(merged)) throw new ScriptValueError(`${prefix(at(where, key))}"${SPLAT_KEY}" must give an object, not ${describe(merged)}`)
    for (const [k, mv] of Object.entries(merged)) put(out, k, mv)
  }
  return out
}

/** A fresh, empty JSON context; `globals`, when given, is shared (it outlives the script). */
export const newContext = (globals = {}) => ({ tools: {}, locals: {}, globals, loop: {} })

/** Check a `save` command's `locals` / `globals` maps: names without dots, each value a <VALUE>. */
export function checkSave(fields) {
  const errors = []
  for (const scope of ['locals', 'globals']) {
    if (!isObject(fields[scope])) continue
    for (const [name, value] of Object.entries(fields[scope])) {
      if (name !== SPLAT_KEY && (name === '' || name.includes('.'))) errors.push(`save ${scope} name ${JSON.stringify(name)} must be non-empty and without dots`)
      errors.push(...checkValue(value, `${scope}.${name}`))
    }
  }
  return errors
}

/**
 * Run a `save` command: every value is evaluated first (against the context
 * as it was), then written, so `{"a": "locals.b", "b": "locals.a"}` swaps.
 * A `"$splat$": <VALUE>` entry writes each key of the object it gives.
 */
export function applySave(step, context) {
  const writes = []
  for (const scope of ['locals', 'globals']) {
    for (const [name, value] of Object.entries(step[scope] ?? {})) {
      const v = structuredClone(evaluateValue(value, context, `${scope}.${name}`))
      if (name !== SPLAT_KEY) { writes.push([scope, name, v]); continue }
      if (!isObject(v)) throw new ScriptValueError(`${scope}.${SPLAT_KEY}: must give an object, not ${describe(v)}`)
      for (const [k, kv] of Object.entries(v)) writes.push([scope, k, kv])
    }
  }
  for (const [scope, name, v] of writes) put(context[scope], name, v)
}

/**
 * Record a finished tool call in `context.tools` under `last`, its tool name
 * and its `id` (in that order, so an explicit id wins over a name).
 */
export function recordTool(context, descriptor, id) {
  put(context.tools, 'last', descriptor)
  put(context.tools, descriptor.name, descriptor)
  if (id !== undefined) put(context.tools, id, descriptor)
}
