/**
 * @deepsea/session-title-slug: host half.
 *
 * The first prompt of a session that begins with `some-slug: ` names the
 * session `some-slug` the moment the prompt is committed. The title is
 * written with the `user` source (as a sidebar Rename is), which pins it and
 * supersedes the pending automatic title generation, so no model is asked to
 * summarize a prompt the person already named. The prefix is stripped from
 * the prompt before it enters the session (`agent/pre-step`), so the model
 * sees only the rest. Running on the server, this covers every client of it,
 * including a remote shell that frames one of its sessions.
 *
 * The browser half (src/client) previews the slug on the New Session row
 * while it is typed and keeps typed-into New Sessions reachable as ghost
 * rows; it renames nothing.
 *
 * Grammar: slug.mjs, shared with the browser half.
 */

import { parseSlug, stripSlug } from './slug.mjs'

export { parseSlug, stripSlug } from './slug.mjs'

export const name = 'deepsea-session-title-slug'
export const inject = ['sessionTitle']

/**
 * Whether a session event is a human prompt.
 * @param {{ type: string, data: any }} event - a session event.
 * @returns {boolean} true for a `user/message` with the `user` source.
 */
const isHumanPrompt = event => event.type === 'user/message' && event.data?.source?.kind === 'user'

/**
 * The text of a message: its text blocks, joined by newlines.
 * @param {{ content?: readonly { type: string, text?: string }[] }} message - a user message.
 * @returns {string} the joined text.
 */
const textOf = message => (message.content ?? [])
  .filter(block => block.type === 'text')
  .map(block => block.text)
  .join('\n')

/**
 * The title a session event asks for: the slug of the session's first human
 * prompt, when no title the person chose stands already.
 * @param {{ type: string, data: any }} event - the event just committed.
 * @param {readonly { type: string, data: any }[]} events - the session's log, the event included.
 * @param {{ source: { kind: string } } | undefined} title - the standing title.
 * @param {string} [strippedSlug] - the slug pre-step stripped from this very prompt, if any.
 * @returns {string | undefined} the slug to rename to, or undefined.
 */
export function slugTitleFor(event, events, title, strippedSlug) {
  if (!isHumanPrompt(event)) return undefined
  // First human prompt only: a slug typed later is just text. Counted in the
  // log rather than read off the title state, because the fallback title is
  // written asynchronously after this very event.
  if (events.filter(isHumanPrompt).length !== 1) return undefined
  // Never override a name the person gave explicitly (a Rename before the first prompt).
  if (title?.source.kind === 'user') return undefined
  return strippedSlug ?? parseSlug(textOf(event.data))
}

/**
 * Strip the slug prefix from the session's first human prompt, as it enters
 * its first step. Only the first human prompt of the session, only when it
 * matches the grammar, only the prefix of its first text block; a prompt that
 * would be left empty stays as typed.
 * @template {{ id: string, source: { kind: string }, content: readonly { type: string, text?: string }[] }} M
 * @param {readonly M[]} messages - the batch entering the step.
 * @param {readonly { type: string, data: any }[]} events - the session's log before the batch.
 * @returns {{ messages: M[], id: string, slug: string } | undefined} the rewritten batch, the stripped message's id and its slug; undefined when nothing changes.
 */
export function stripFirstPrompt(messages, events) {
  const index = messages.findIndex(message => message.source?.kind === 'user')
  if (index === -1) return undefined
  const message = /** @type {M} */ (messages[index])
  // Cheap test first: the log is scanned only for a prompt that has a slug.
  const slug = parseSlug(textOf(message))
  if (slug === undefined) return undefined
  if (events.some(isHumanPrompt)) return undefined
  const blockIndex = message.content.findIndex(block => block.type === 'text')
  const block = message.content[blockIndex]
  // The slug spans the first text block (it is anchored at the start of the joined text).
  if (block?.text === undefined || parseSlug(block.text) !== slug) return undefined
  const rest = /** @type {string} */ (stripSlug(block.text))
  const content = message.content.map((b, i) => (i === blockIndex ? Object.freeze({ ...b, text: rest }) : b))
  // Never send an empty prompt: `slug:` alone stays as typed.
  if (textOf({ content }).trim().length === 0 && content.every(b => b.type === 'text')) return undefined
  const stripped = /** @type {M} */ (Object.freeze({ ...message, content: Object.freeze(content) }))
  return { messages: messages.map((m, i) => (i === index ? stripped : m)), id: message.id, slug }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  /**
   * Slug stripped from a session's first prompt, until that prompt is committed.
   * @type {WeakMap<object, { id: string, slug: string }>}
   */
  const stripped = new WeakMap()

  // Outermost (prepend), wrapping next(): the batch every other listener settled on.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const session = payload.agent.session
    // oxlint-disable-next-line typescript/no-deprecated -- a log read, as the title service itself does
    const result = stripFirstPrompt(decision.messages, session.snapshotEvents())
    if (result === undefined) return decision
    stripped.set(session, { id: result.id, slug: result.slug })
    return { ...decision, messages: result.messages }
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const pending = stripped.get(session)
    const strippedSlug = pending !== undefined && pending.id === event.data?.id ? pending.slug : undefined
    if (strippedSlug !== undefined) stripped.delete(session)
    // oxlint-disable-next-line typescript/no-deprecated -- a log read, as the title service itself does
    const slug = slugTitleFor(event, session.snapshotEvents(), ctx.sessionTitle.get(session), strippedSlug)
    if (slug === undefined) return
    // A session refuses an append while another one is being published (this
    // listener runs inside the prompt's), so the rename follows in a
    // microtask: still before the title service's own deferred fallback
    // title and long before its provider request, which the rename supersedes.
    queueMicrotask(() => {
      try {
        if (ctx.sessionTitle.get(session)?.source.kind === 'user') return
        ctx.sessionTitle.rename(session, slug)
      } catch (error) {
        ctx.logger.warn(`session-title-slug: could not name session "${session.id}" "${slug}": ${String(error)}`)
      }
    })
  })
}
