/**
 * @deepsea/session-title-slug: host half.
 *
 * The first prompt of a session that begins with `some-slug: ` names the
 * session `some-slug` the moment the prompt is committed. The title is
 * written with the `user` source (as a sidebar Rename is), which pins it and
 * supersedes the pending automatic title generation, so no model is asked to
 * summarize a prompt the person already named. The prompt itself reaches the
 * model unchanged. Running on the server, this covers every client of it,
 * including a remote shell that frames one of its sessions.
 *
 * The browser half (src/client) previews the slug on the New Session row
 * while it is typed and keeps typed-into New Sessions reachable as ghost
 * rows; it renames nothing.
 *
 * Grammar: slug.mjs, shared with the browser half.
 */

import { parseSlug } from './slug.mjs'

export { parseSlug } from './slug.mjs'

export const name = 'deepsea-session-title-slug'
export const inject = ['sessionTitle']

/**
 * The title a session event asks for: the slug of the session's first human
 * prompt, when no title the person chose stands already.
 * @param {{ type: string, data: any }} event - the event just committed.
 * @param {readonly { type: string, data: any }[]} events - the session's log, the event included.
 * @param {{ source: { kind: string } } | undefined} title - the standing title.
 * @returns {string | undefined} the slug to rename to, or undefined.
 */
export function slugTitleFor(event, events, title) {
  if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') return undefined
  // First human prompt only: a slug typed later is just text. Counted in the
  // log rather than read off the title state, because the fallback title is
  // written asynchronously after this very event.
  const humanPrompts = events.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'user')
  if (humanPrompts.length !== 1) return undefined
  // Never override a name the person gave explicitly (a Rename before the first prompt).
  if (title?.source.kind === 'user') return undefined
  const text = (event.data.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return parseSlug(text)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    // oxlint-disable-next-line typescript/no-deprecated -- a log read, as the title service itself does
    const slug = slugTitleFor(event, session.snapshotEvents(), ctx.sessionTitle.get(session))
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
