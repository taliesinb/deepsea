/**
 * title.mjs: the pure part of @deepsea/chat-title, title styling and the
 * "who named this chat" reading of a session log. No Cordis, no I/O, so the
 * tests run against plain values.
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Model-facing failure of the rename tool (a HarnessError so `code` survives into the tool/result). */
export class ChatTitleError extends HarnessError {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'CHAT_TITLE_FAILED') {
    super(message, code)
    this.name = 'ChatTitleError'
  }
}

/**
 * Coerce text into `foo-bar-baz`: lowercase ASCII words joined by single
 * hyphens, diacritics stripped, capped at `maxWords`. Mirrors the harness's
 * session-title-llm `slugifyTitle` (`style: slug`) so agent titles and automatic titles look
 * alike in the sidebar.
 * @param {string} text
 * @param {number} maxWords
 * @returns {string} the slug, possibly empty
 */
export function slugify(text, maxWords) {
  const words = String(text)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(word => word !== '')
  return words.slice(0, Math.max(1, maxWords)).join('-')
}

/**
 * Apply the configured style to a proposed title.
 * @param {string} text - raw model input
 * @param {{ style: 'natural' | 'slug', maxWords: number }} options
 * @returns {string} the styled title; may be empty, which the caller rejects
 */
export function styleTitle(text, options) {
  if (options.style === 'slug') return slugify(text, options.maxWords)
  return String(text).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Key under which the tool records the applied title on its `tool/result` event. */
export const META_KEY = 'deepseaChatTitle'

/**
 * Every title this tool applied in a session, read from the `tool/result`
 * events' `meta.deepseaChatTitle` (persisted by `presentationMeta`, so it survives a
 * restart, unlike anything held in memory).
 * @param {readonly any[]} events - the session's event log
 * @returns {Set<string>}
 */
export function agentTitlesOf(events) {
  const titles = new Set()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const meta = event.data?.meta
    const title = meta !== null && typeof meta === 'object' ? meta[META_KEY] : undefined
    if (typeof title === 'string' && title.length > 0) titles.add(title)
  }
  return titles
}

/**
 * Classify the standing title of a session for the tool and the nudge.
 *
 *   'none'      no title event yet (before the first prompt)
 *   'automatic' a fallback or provider title: one the agent reviews and may replace
 *   'agent'     a `user`-sourced title this tool applied
 *   'user'      a `user`-sourced title the human chose (Rename in the sidebar,
 *               the session-title-slug plugin's `slug: ` prefix); never
 *               overridden by the agent
 *
 * @param {{ title: string, source: { kind: string } } | undefined} current - `ctx.sessionTitle.get(session)`
 * @param {Set<string>} agentTitles - from {@link agentTitlesOf}
 * @param {string | undefined} [lastApplied] - the in-memory record of this process's last rename (covers a result whose meta was not persisted)
 * @returns {'none' | 'automatic' | 'agent' | 'user'}
 */
export function classifyTitle(current, agentTitles, lastApplied) {
  if (current === undefined) return 'none'
  if (current.source.kind !== 'user') return 'automatic'
  if (agentTitles.has(current.title) || current.title === lastApplied) return 'agent'
  return 'user'
}

/**
 * Style guidance shared by the tool description, the prompt section and the nudge.
 * @param {{ style: 'natural' | 'slug', maxWords: number }} options
 */
export function styleGuidance(options) {
  const n = Math.max(2, options.maxWords)
  if (options.style === 'slug') {
    return `${n} or fewer lowercase words joined by hyphens, specific to the task (fix-login-redirect), not generic (help-request).`
  }
  return `a specific phrase of ${Math.min(2, n)} to ${n} words in the user's language ("Fix login redirect loop"), not generic ("Help request").`
}
