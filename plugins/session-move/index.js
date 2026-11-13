/**
 * @deepsea/session-move: host half.
 *
 * A browser-only feature (src/client): the moves and copies themselves are
 * the Host's session.move, session.moveMany and session.copy (harness topic
 * session-relocation). The host half exists so the Loader has a row to hang
 * the `dsh.client` bundle on.
 */
export const name = 'deepsea-session-move'
export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  ctx.logger.info('session-move: browser half serves Move to…, Copy to… and Rehome…')
}
