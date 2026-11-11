/**
 * Drive scripts: a file of `dsd drive` operations, one per line, that a topic
 * keeps beside its code and reruns after each rebuild (`dsd drive run <file>`).
 *
 *   # rewind keeps the steering closers
 *   create-session --title rewind
 *   prompt '{"cmd": "say", "text": "one"}'
 *   prompt - <<EOF
 *   {"cmd": "say", "text": "two"}
 *   EOF
 *   expect summary.text = two
 *   let first sessionId
 *   open-session ${first}
 *   eval - <<JS
 *   return document.querySelectorAll('[data-turn]').length
 *   JS
 *   expect = 2
 *
 * A line is split into words as a shell would (single and double quotes,
 * backslash escapes, `#` comments, a trailing `\` continues the line);
 * `<<TAG` as its last word feeds the lines up to `TAG` to the operation's `-`.
 * `${name}` outside single quotes is a value saved by `let`. Besides the
 * drive operations a script has `expect`, `expect-exit`, `let`, `sleep` and
 * `try` (lib/drive-script.mjs, `STEPS`).
 */
import { isDeepStrictEqual } from 'node:util'
import { DsdError, pick } from './util.mjs'

/** The steps a script has besides drive operations. */
export const STEPS = {
  expect: 'expect [<path>] [= | != | ~ | !~ <value>]   a field of the last value (the whole value without a path): present and not false/null; equal (JSON or text); matching a regular expression',
  'expect-exit': 'expect-exit <n>   the last operation exited with n (after `try`: 3 a turn that ended with an error, 4 a wait that timed out)',
  let: 'let <name> [<path>]   save a field of the last value; ${name} in later words',
  sleep: 'sleep <seconds>',
  try: 'try <operation …>   run it without failing on its exit status (expect-exit checks it)',
}

const fail = (line, message) => { throw new DsdError(`line ${line}: ${message}`, 2) }

/**
 * Split one logical line into words. A word is a list of parts, each `{ text, expand }`: single-quoted
 * text never expands `${name}`. Returns the words and the heredoc tag, if the line ends with one.
 */
export function splitWords(line, at = 0) {
  const words = []
  let word, quote, heredoc
  const add = (text, expand) => { word ??= { parts: [], quoted: false }; const last = word.parts.at(-1); if (last && last.expand === expand) last.text += text; else word.parts.push({ text, expand }) }
  const end = () => { if (word) words.push(word); word = undefined }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") { if (c === "'") quote = undefined; else add(c, false); continue }
    if (quote === '"') {
      if (c === '"') quote = undefined
      else if (c === '\\' && i + 1 < line.length && '"\\$'.includes(line[i + 1])) add(line[++i] === '$' ? '\0' : line[i], true)
      else add(c, true)
      continue
    }
    if (c === "'" || c === '"') { quote = c; add('', c === '"'); word.quoted = true; continue }
    if (c === '\\') { if (i + 1 < line.length) add(line[++i] === '$' ? '\0' : line[i], true); continue }
    if (/\s/.test(c)) { end(); continue }
    if (c === '#' && word === undefined) break
    if (c === '<' && word === undefined && line[i + 1] === '<') {
      const m = /^<<\s*(['"]?)([A-Za-z_]\w*)\1\s*(#.*)?$/.exec(line.slice(i))
      if (!m) fail(at, 'a heredoc is `<<TAG` at the end of the line')
      heredoc = m[2]
      break
    }
    add(c, true)
  }
  if (quote) fail(at, `unclosed ${quote}`)
  end()
  return { words, heredoc }
}

/** Read a script into steps: `{ line, text, words, input? }`. */
export function parseDriveScript(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const steps = []
  for (let i = 0; i < lines.length; i++) {
    const at = i + 1
    let line = lines[i]
    // A trailing backslash (an odd run of them) continues the line.
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) line = `${line.slice(0, -1)} ${lines[++i]}`
    const { words, heredoc } = splitWords(line, at)
    if (words.length === 0) { if (heredoc) fail(at, 'a heredoc needs an operation'); continue }
    const step = { line: at, text: line.trim(), words }
    if (heredoc !== undefined) {
      const body = []
      for (;;) {
        if (++i >= lines.length) fail(at, `no line ${heredoc} ends the heredoc`)
        if (lines[i].trim() === heredoc) break
        body.push(lines[i])
      }
      step.input = body.join('\n')
    }
    steps.push(step)
  }
  return steps
}

/** A word as text, with `${name}` replaced from `vars` outside single quotes. */
export function render(word, vars, at) {
  return word.parts.map(({ text, expand }) => !expand ? text : text.replace(/\$\{([A-Za-z_][\w-]*)\}/g, (all, name) => {
    if (!(name in vars)) fail(at, `\${${name}} is not set (let ${name} …)`)
    const v = vars[name]
    return typeof v === 'string' ? v : JSON.stringify(v)
  }).replaceAll('\0', '$')).join('')
}

/** A word that is a bare comparison operator, not quoted. */
const OPERATORS = ['=', '!=', '~', '!~']
const isOperator = (word) => !word.quoted && word.parts.length === 1 && OPERATORS.includes(word.parts[0].text)

/**
 * Check `expect [<path>] [<op> <value>]` against a value; throws a DsdError (exit 1) saying what
 * was found. A value that reads as JSON compares as JSON, else as text.
 */
export function expectStep(words, vars, value, at) {
  const opAt = words.findIndex(isOperator)
  const head = opAt < 0 ? words : words.slice(0, opAt)
  if (head.length > 1) fail(at, 'expect [<path>] [= | != | ~ | !~ <value>]')
  const path = head.length ? render(head[0], vars, at) : ''
  const found = path ? pick(value, path) : value
  const shown = (v) => { const s = v === undefined ? 'nothing' : JSON.stringify(v); return s.length > 300 ? `${s.slice(0, 300)}…` : s }
  const where = path ? `${path} is` : 'the value is'
  if (opAt < 0) {
    if (found === undefined || found === null || found === false) throw new DsdError(`${where} ${shown(found)}`)
    return
  }
  const rest = words.slice(opAt + 1).map(w => render(w, vars, at))
  if (rest.length === 0) fail(at, `expect: ${words[opAt].parts[0].text} needs a value`)
  const operator = words[opAt].parts[0].text
  const wanted = rest.join(' ')
  if (operator === '=' || operator === '!=') {
    let expected = wanted
    try { expected = JSON.parse(wanted) } catch { /* text */ }
    const same = isDeepStrictEqual(found, expected) || (typeof found !== 'string' && String(found) === wanted && found !== undefined)
    if (same !== (operator === '=')) throw new DsdError(`${where} ${shown(found)}, expected ${operator === '=' ? '' : 'anything but '}${shown(expected)}`)
    return
  }
  let pattern
  try { pattern = new RegExp(wanted, 's') } catch (error) { fail(at, `expect: ${error.message}`) }
  const text = typeof found === 'string' ? found : JSON.stringify(found) ?? ''
  if (pattern.test(text) !== (operator === '~')) throw new DsdError(`${where} ${shown(found)}, expected it ${operator === '~' ? '' : 'not '}to match /${wanted}/`)
}
