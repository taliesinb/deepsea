/**
 * Whether a prompt is a JSONL script: every non-blank line is a JSON object
 * whose first key is a plain name. A cheap pattern rules out ordinary prose
 * first; only text that passes it is parsed.
 */

/** A line that looks like `{"key": …}` (trimmed). */
const SCRIPT_LINE = /^\{\s*"[A-Za-z_$][\w$.-]*"\s*:.*\}$/

/** The lines of a script, without the blank ones at its start and end; undefined when the text is not one. */
export function scriptLines(text: string): string[] | undefined {
  const lines = text.split('\n').map(line => line.replace(/\s+$/, ''))
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
  if (lines.length === 0) return undefined
  const content = lines.map(line => line.trim()).filter(line => line !== '')
  if (!content.every(line => SCRIPT_LINE.test(line))) return undefined
  for (const line of content) {
    let value: unknown
    try { value = JSON.parse(line) } catch { return undefined }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  }
  return lines
}
