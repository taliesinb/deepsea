/**
 * @deepsea/session-reference-picker: host half.
 *
 * A browser-only feature (src/client): the host half exists so the Loader
 * has a row to hang the `dsh.client` bundle on.
 */
export const name = 'deepsea-session-reference-picker'
export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  ctx.logger.info('session-reference-picker: browser half serves the % session picker')
}
