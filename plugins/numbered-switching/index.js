/**
 * @deepsea/numbered-switching: host half.
 *
 * A browser-only feature (src/client): the host half exists so the Loader
 * has a row to hang the `dsh.client` bundle on.
 */
export const name = 'deepsea-numbered-switching'
export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  ctx.logger.info('numbered-switching: browser half serves ⌘1…⌘5 between the five most recent sessions')
}
