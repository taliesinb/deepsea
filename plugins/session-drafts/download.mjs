/**
 * A draft as a file to save: `<name>.draft.md` with its text, or, when it has
 * attachments, `<name>.draft.zip` holding `draft.md` (the text, then a link to
 * each attachment) and the attachments under their own names.
 */
import { strToU8, zipSync } from 'fflate'

/** Characters no file system accepts, and controls. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/gu

/**
 * @param {string} name
 * @param {string} fallback - used when nothing is left.
 * @returns {string} the name with unsafe characters replaced, at most 120 characters, without leading dots.
 */
export function safeFileName(name, fallback) {
  const clean = name.replace(UNSAFE, '-').replace(/\s+/gu, ' ').trim().replace(/^\.+/u, '').slice(0, 120).trim()
  return clean === '' ? fallback : clean
}

/**
 * Distinct names in order: a repeat gets " 2", " 3", … before its extension.
 * @param {readonly string[]} names
 * @param {readonly string[]} [taken] - names already used.
 * @returns {string[]}
 */
export function uniqueNames(names, taken = []) {
  const used = new Set(taken.map(name => name.toLowerCase()))
  return names.map((name) => {
    let candidate = name
    const dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    for (let counter = 2; used.has(candidate.toLowerCase()); counter += 1) candidate = `${stem} ${String(counter)}${ext}`
    used.add(candidate.toLowerCase())
    return candidate
  })
}

/**
 * The Markdown of a draft: its text (chips in their clipboard form), then one link per attachment file.
 * @param {string} text
 * @param {readonly { name: string, type: string }[]} attachments - with the names they have in the archive.
 * @returns {string}
 */
export function draftMarkdown(text, attachments) {
  const body = text.endsWith('\n') ? text : `${text}\n`
  if (attachments.length === 0) return body
  const links = attachments.map(({ name, type }) => `${type.startsWith('image/') ? '!' : ''}[${name.replace(/[[\]]/gu, '\\$&')}](<${name}>)`)
  return `${body}\n${links.join('\n')}\n`
}

/**
 * @param {{ document: { text: string }, attachments: readonly { blob: string, name: string, type: string }[] }} draft
 * @param {string} base - file name without extension, e.g. `2026-11-10-2230.Fix the parser`.
 * @param {(blob: string) => Uint8Array} readBlob - an attachment's bytes.
 * @returns {{ filename: string, type: string, body: Uint8Array }}
 */
export function draftDownload(draft, base, readBlob) {
  const stem = `${safeFileName(base, 'draft')}.draft`
  if (draft.attachments.length === 0) {
    return { filename: `${stem}.md`, type: 'text/markdown; charset=utf-8', body: strToU8(draftMarkdown(draft.document.text, [])) }
  }
  const names = uniqueNames(draft.attachments.map(attachment => safeFileName(attachment.name, 'attachment')), ['draft.md'])
  /** @type {Record<string, Uint8Array | [Uint8Array, { level: 0 }]>} */
  const entries = {}
  draft.attachments.forEach((attachment, index) => {
    const bytes = readBlob(attachment.blob)
    // Images and archives are compressed already.
    entries[names[index]] = /^(image|video|audio)\/|zip|compressed/u.test(attachment.type) ? [bytes, { level: 0 }] : bytes
  })
  entries['draft.md'] = strToU8(draftMarkdown(draft.document.text, draft.attachments.map((attachment, index) => ({ name: names[index], type: attachment.type }))))
  return { filename: `${stem}.zip`, type: 'application/zip', body: zipSync(entries, { level: 6 }) }
}

/**
 * A `Content-Disposition` header value offering `filename` for saving, with an ASCII fallback.
 * @param {string} filename
 * @returns {string}
 */
export function attachmentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
