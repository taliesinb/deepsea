/**
 * @deepsea/tool-system-permissions/tools: the subpath row
 * `deepsea-tool-system-permissions-tools` ("System permission tool"), which
 * joins the agent presets that have upstream's `@deepseek-ai/dsh-tool-bash`
 * (package.json `deepsea.presets`): the permissions guard what the agent's
 * shell commands do. It holds the `seek_system_permission` tool and its
 * system-prompt hint.
 *
 * Each call uses the package root's service (`deepseaSystemPermissions`,
 * index.js): its prober and its registry, where the card's Grant and Deny
 * reach the call. The service is read when a call starts, never injected:
 * preset rows mount before Host rows. Without the root row the tool still
 * works with a macOS prober of its own, but no card can grant or deny; only
 * the turn's Stop moves it.
 *
 * Config (all optional):
 *
 *   pollSeconds: 1.5        # between probes of the open permissions
 *   noticeSeconds: 60       # inactivity before the macOS app shows the card in a floating panel (0: never)
 *   promptHint: true        # a system-prompt line: ask before screenshots, UI automation and the like
 */

import Schema from '@deepseek-ai/schemastery'
import { createMacProber } from './macos.mjs'
import { PROMPT_HINT, SERVICE, TOOL_NAME, createSeekTool } from './seek.mjs'

export const name = 'deepsea-tool-system-permissions-tools'

// `systemPrompt` is optional (sub-fiber below) so a composition without it still gets the tool.
export const inject = ['tools']

export const Config = Schema.object({
  pollSeconds: Schema.number().min(0.2).max(60).default(1.5),
  noticeSeconds: Schema.number().min(0).max(3600).default(60),
  promptHint: Schema.boolean().default(true),
})

/** Name of the system-prompt section carrying the hint. */
export const PROMPT_SECTION = 'tool:deepsea-tool-system-permissions'

export { PROMPT_HINT }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - a preset's (or the Host's) plugin context.
 * @param {ReturnType<typeof Config>} config - validated plugin config.
 * @param {{ platform?: string, paneDelayMs?: number, refineMs?: number }} [testing] - tests only.
 */
export function apply(ctx, config, testing = {}) {
  let ownProber
  ctx.tools.register(createSeekTool({
    service: () => ctx.get(SERVICE),
    fallbackProber: () => (ownProber ??= createMacProber({ logger: ctx.logger })),
    settings: () => ({
      pollMs: Math.round(config.pollSeconds * 1000),
      noticeMs: Math.round(config.noticeSeconds * 1000),
      refineMs: testing.refineMs ?? 5000,
      ...testing.paneDelayMs !== undefined ? { paneDelayMs: testing.paneDelayMs } : {},
    }),
    platform: testing.platform,
    logger: ctx.logger,
  }))

  if (config.promptHint) {
    ctx.inject(['systemPrompt'], (ctx) => {
      ctx.systemPrompt.section({
        name: PROMPT_SECTION,
        order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
        text: ({ scope }) => ctx.tools.get(TOOL_NAME, scope) === undefined ? '' : PROMPT_HINT,
      })
    })
  }

  ctx.logger.info(`tool-system-permissions: registered ${TOOL_NAME} (poll ${config.pollSeconds}s, notice ${config.noticeSeconds}s)`)
}
