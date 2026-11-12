/**
 * Validation of what the browser sends: a draft document (the composer's
 * semantic draft: text, reference chips, a leading command chip, quotes) and
 * its attachment list. Anything else is refused before it is stored.
 */
import { validBlobId } from './store.mjs'

const isInteger = value => Number.isSafeInteger(value) && value >= 0
const isString = (value, max) => typeof value === 'string' && value.length <= max

/**
 * @param {unknown} value
 * @param {{ maxChars: number }} limits
 * @returns {{ document: object } | { error: string }}
 */
export function parseDocument(value, limits) {
  if (typeof value !== 'object' || value === null) return { error: 'document must be an object' }
  const { text, references, command, quotes } = value
  if (!isString(text, limits.maxChars)) return { error: `document text must be a string of at most ${String(limits.maxChars)} characters` }
  if (!Array.isArray(references) || references.length > 1000) return { error: 'document references must be a list' }
  const parsedReferences = []
  for (const reference of references) {
    if (typeof reference !== 'object' || reference === null) return { error: 'invalid reference' }
    const { source, ref, offset, length, label, appearance, clipboardText, invalid } = reference
    if (!isString(source, 200) || !isString(ref, 4096) || !isString(label, 4096) || !isString(clipboardText, 4096)
      || !isInteger(offset) || !isInteger(length) || length === 0 || offset + length > text.length
      || text.slice(offset, offset + length) !== clipboardText
      || (appearance !== undefined && !['session', 'file', 'folder'].includes(appearance))
      || (invalid !== undefined && typeof invalid !== 'boolean')) return { error: 'invalid reference' }
    parsedReferences.push({
      source, ref, offset, length, label, clipboardText,
      ...appearance === undefined ? {} : { appearance },
      ...invalid === undefined ? {} : { invalid },
    })
  }
  let parsedCommand
  if (command !== undefined) {
    if (typeof command !== 'object' || command === null || !isString(command.token, 200) || !/^\/\S/u.test(command.token)
      || !text.startsWith(command.token.trimEnd())) return { error: 'invalid command' }
    parsedCommand = { token: command.token }
  }
  let parsedQuotes
  if (quotes !== undefined) {
    if (!Array.isArray(quotes) || quotes.length > 100) return { error: 'document quotes must be a list' }
    parsedQuotes = []
    for (const quote of quotes) {
      if (typeof quote !== 'object' || quote === null || !isInteger(quote.offset) || !isInteger(quote.length)
        || quote.length === 0 || quote.offset + quote.length > text.length || !isString(quote.text, limits.maxChars)
        || quote.text.trim() === '') return { error: 'invalid quote' }
      parsedQuotes.push({ offset: quote.offset, length: quote.length, text: quote.text })
    }
  }
  return {
    document: {
      text, references: parsedReferences,
      ...parsedCommand === undefined ? {} : { command: parsedCommand },
      ...parsedQuotes === undefined || parsedQuotes.length === 0 ? {} : { quotes: parsedQuotes },
    },
  }
}

/**
 * @param {unknown} value
 * @param {{ maxAttachments: number, exists: (blob: string) => boolean }} options
 * @returns {{ attachments: { blob: string, name: string, type: string, size: number }[] } | { error: string }}
 */
export function parseAttachments(value, options) {
  if (!Array.isArray(value) || value.length > options.maxAttachments) {
    return { error: `attachments must be a list of at most ${String(options.maxAttachments)}` }
  }
  const attachments = []
  for (const attachment of value) {
    if (typeof attachment !== 'object' || attachment === null) return { error: 'invalid attachment' }
    const { blob, name, type, size } = attachment
    if (!validBlobId(blob) || !isString(name, 1024) || !isString(type, 255) || !isInteger(size)) return { error: 'invalid attachment' }
    if (!options.exists(blob)) return { error: `attachment ${blob} was not uploaded` }
    attachments.push({ blob, name, type, size })
  }
  return { attachments }
}
