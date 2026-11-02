/**
 * The canonical session-reference URI and mention, in the browser: the same
 * encoding as the harness's `encodeSessionReferenceUri` (context/session-reference,
 * which uses Node's Buffer), so the server's session-reference resolver reads
 * what this plugin inserts.
 */

/**
 * @param sessionId - the referenced session.
 * @returns `dsh-session:<base64url of the JSON-encoded id>`.
 */
export function encodeSessionReferenceUri(sessionId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(sessionId))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `dsh-session:${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`
}

/**
 * @param sessionId - the referenced session.
 * @param label - the readable label (`workspace/session`).
 * @returns the Markdown mention `@[label](dsh-session:…)`, `\` and `]` escaped in the label.
 */
export function formatSessionReferenceMention(sessionId: string, label: string): string {
  const escaped = label.replaceAll('\\', '\\\\').replaceAll(']', '\\]')
  return `@[${escaped}](${encodeSessionReferenceUri(sessionId)})`
}
