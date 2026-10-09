// Pure parts of /tools: pattern parsing and matching, parameter summaries,
// first sentences, and the structured listing the browser card renders. No
// DSH imports, so node --test runs it directly; the browser half imports
// decodeListing from here too.

/** @typedef {{ name: string, description?: string, parameters?: any }} ToolSchema */
/** @typedef {{ name: string, type: string, required: boolean, description: string }} ParamEntry */
/** @typedef {{ name: string, summary: string, description: string, params: ParamEntry[] }} ToolEntry */
/**
 * What the command returns (as JSON after the first line of its text).
 * @typedef {{
 *   v: 1,
 *   total: number,
 *   patterns: string[],
 *   mode?: string,
 *   focus?: string,
 *   tools: ToolEntry[],
 * }} Listing
 */

export const LISTING_VERSION = 1
/** Caps that keep one /tools result in the session log bounded. */
export const DESCRIPTION_CAP = 4000
export const PARAM_DESCRIPTION_CAP = 1000

const ELLIPSIS = '…'

/**
 * Shorten `text` to at most `width` characters, ending in `…` when cut.
 * @param {string} text
 * @param {number} width
 */
export function truncate(text, width) {
  if (text.length <= width) return text
  return `${text.slice(0, Math.max(0, width - 1)).trimEnd()}${ELLIPSIS}`
}

// Abbreviations whose trailing period does not end a sentence.
const ABBREVIATIONS = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|incl|resp|Dr|Mr|Ms|No)\.$/i

/**
 * The first sentence of the first non-empty line, whitespace collapsed.
 * A sentence ends at `.`, `!` or `?` followed by whitespace (or the line
 * end), except after a known abbreviation (e.g., i.e., etc.) or inside a
 * dotted token (`index.js`, `0.5`), which have no following space.
 * @param {string | undefined} description
 */
export function firstSentence(description) {
  if (typeof description !== 'string') return ''
  const line = description.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  const text = line.replace(/\s+/g, ' ')
  const boundary = /[.!?](?=\s|$)/g
  for (let match = boundary.exec(text); match !== null; match = boundary.exec(text)) {
    const head = text.slice(0, match.index + 1)
    if (ABBREVIATIONS.test(head)) continue
    return head
  }
  return text
}

/**
 * A compact type label for one JSON-Schema property.
 * @param {any} schema
 * @returns {string}
 */
export function typeLabel(schema) {
  if (schema === null || typeof schema !== 'object') return 'any'
  if (Array.isArray(schema.enum)) {
    return schema.enum.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join('|')
  }
  if (schema.const !== undefined) return typeof schema.const === 'string' ? schema.const : JSON.stringify(schema.const)
  const variants = schema.oneOf ?? schema.anyOf
  if (Array.isArray(variants)) return [...new Set(variants.map(typeLabel))].join('|')
  const type = schema.type
  if (Array.isArray(type)) return type.join('|')
  if (type === 'array') return `${schema.items === undefined ? 'any' : typeLabel(schema.items)}[]`
  return typeof type === 'string' ? type : 'any'
}

/**
 * Parameters, required ones first (each group in schema order).
 * @param {any} parameters - a tool's JSON-Schema `parameters`.
 * @returns {ParamEntry[]}
 */
export function paramEntries(parameters) {
  const properties = parameters?.properties
  if (properties === null || typeof properties !== 'object') return []
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : [])
  const names = Object.keys(properties)
  return [...names.filter(name => required.has(name)), ...names.filter(name => !required.has(name))]
    .map(name => ({
      name,
      type: typeLabel(properties[name]),
      required: required.has(name),
      description: truncate(String(properties[name]?.description ?? '').trim(), PARAM_DESCRIPTION_CAP),
    }))
}

/**
 * One tool as the card shows it.
 * @param {ToolSchema} schema
 * @returns {ToolEntry}
 */
export function toolEntry(schema) {
  const description = String(schema.description ?? '').trim()
  return {
    name: schema.name,
    summary: firstSentence(description),
    description: truncate(description, DESCRIPTION_CAP),
    params: paramEntries(schema.parameters),
  }
}

/**
 * Parse the command's raw input into patterns. Whitespace separates
 * patterns; they combine with OR.
 * @param {string} rawInput
 * @returns {string[]}
 */
export function parsePatterns(rawInput) {
  return (rawInput ?? '').trim().split(/\s+/).filter(token => token !== '')
}

/** @param {string} pattern */
export function isGlob(pattern) {
  return /[*?]/.test(pattern)
}

/**
 * Case-insensitive, anchored glob: `*` any run, `?` one character.
 * @param {string} pattern
 */
export function globToRegExp(pattern) {
  const source = [...pattern].map(char => {
    if (char === '*') return '.*'
    if (char === '?') return '.'
    return char.replace(/[\\^$.|+()[\]{}]/g, '\\$&')
  }).join('')
  return new RegExp(`^${source}$`, 'i')
}

/**
 * Select tools for the patterns.
 *
 * - no pattern: every tool;
 * - a pattern with `*` or `?`: glob on the name;
 * - a bare word: substring of the name; when no name contains it, substring
 *   of the description instead.
 *
 * Patterns combine with OR. The result keeps the input order.
 * @param {ToolSchema[]} tools
 * @param {string[]} patterns
 * @returns {{ matched: ToolSchema[], exact: ToolSchema | undefined }}
 *   `exact`: the tool named by a single bare-word pattern.
 */
export function selectTools(tools, patterns) {
  if (patterns.length === 0) return { matched: [...tools], exact: undefined }
  const keep = new Set()
  for (const pattern of patterns) {
    if (isGlob(pattern)) {
      const regexp = globToRegExp(pattern)
      for (const tool of tools) if (regexp.test(tool.name)) keep.add(tool)
      continue
    }
    const needle = pattern.toLowerCase()
    const byName = tools.filter(tool => tool.name.toLowerCase().includes(needle))
    const hits = byName.length > 0
      ? byName
      : tools.filter(tool => String(tool.description ?? '').toLowerCase().includes(needle))
    for (const tool of hits) keep.add(tool)
  }
  const exact = patterns.length === 1 && !isGlob(patterns[0])
    ? tools.find(tool => tool.name.toLowerCase() === patterns[0].toLowerCase())
    : undefined
  return { matched: tools.filter(tool => keep.has(tool)), exact }
}

/** @param {ToolSchema[]} tools */
export function sortTools(tools) {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * The first line of the result: all a client without the card shows.
 * @param {number} count @param {number} total @param {string[]} patterns
 * @param {string} [mode] - the agent's tool presentation, when known.
 */
export function countLine(count, total, patterns, mode) {
  const noun = total === 1 ? 'tool' : 'tools'
  const head = patterns.length === 0
    ? `${String(total)} ${noun}`
    : `${String(count)} of ${String(total)} ${noun} matching ${patterns.join(' ')}`
  return mode === 'ptc' ? `${head} (ptc: the model is sent run_code only)` : head
}

/**
 * Encode a listing as command text: the count line, then the JSON payload.
 * @param {Listing} listing
 */
export function encodeListing(listing) {
  return `${countLine(listing.tools.length, listing.total, listing.patterns, listing.mode)}\n${JSON.stringify(listing)}`
}

/**
 * Decode command text produced by {@link encodeListing}; undefined for any
 * other text (an error message, a plain-text result).
 * @param {string | undefined} text
 * @returns {Listing | undefined}
 */
export function decodeListing(text) {
  if (typeof text !== 'string') return undefined
  const newline = text.indexOf('\n')
  if (newline < 0) return undefined
  try {
    const value = JSON.parse(text.slice(newline + 1))
    return value !== null && typeof value === 'object' && value.v === LISTING_VERSION && Array.isArray(value.tools)
      ? value
      : undefined
  } catch {
    return undefined
  }
}
