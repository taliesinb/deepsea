/**
 * The slug grammar, shared by the host half (index.js) and the browser half
 * (src/client). Pure, no imports.
 *
 * A prompt names its New Session when it STARTS with a slug followed by a
 * colon and whitespace:
 *
 *   foo-bar-baz: rename the widget                -> "foo-bar-baz"
 *   fix_login2: the login form...                  -> "fix_login2"
 *
 * Deliberately narrow, so prose never matches:
 *   - lowercase ASCII letters, digits, `-` and `_` only, starting with a
 *     letter or digit: capitalized openers ("Note:", "TODO:") never match;
 *   - the colon must be followed by whitespace or end the text, so `http://…`,
 *     `foo:bar` and drive letters never match;
 *   - leading whitespace is tolerated;
 *   - at most MAX_SLUG_CHARS characters.
 */

/** The grammar; group 1 is the slug. */
export const SLUG_PATTERN = /^\s*([a-z0-9][a-z0-9_-]*):(?=\s|$)/u

/** Longest slug taken as a title. */
export const MAX_SLUG_CHARS = 64

/**
 * Extract the session-title slug from prompt text.
 * @param {string} text - the composer draft or the prompt as sent.
 * @returns {string | undefined} the slug when the text starts with `slug: `, else undefined.
 */
export function parseSlug(text) {
  const match = SLUG_PATTERN.exec(text)
  if (match === null) return undefined
  const slug = match[1]
  if (slug === undefined || slug.length === 0 || slug.length > MAX_SLUG_CHARS) return undefined
  return slug
}
