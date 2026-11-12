/**
 * @deepsea/tool-brow/tools: the browser tools row,
 * `deepsea-tool-brow-tools` ("Brow tools").
 *
 * Registers the brow daemon's tools (the nine `browser_*` tools, as the
 * daemon lists them: names, descriptions, JSON Schemas) once per mount: dsd's
 * generated presets put this row into every agent preset that has tool-web
 * (standard, ptc, cordis), and disable it globally. Everything process-wide
 * (the daemon connection, sessions, notices, images, the DeepSea app's routes,
 * the browser half) is the package root's (index.js,
 * `deepsea-tool-brow`), which this row reaches through the
 * `deepseaBrow` service. The service is read in an `inject`
 * sub-fiber, never in this row's own `inject`: preset rows mount before Host
 * rows, and a missing required service would make the preset unusable. The
 * root provides it once the daemon has listed its tools (and again when they
 * change), so without a reachable daemon this row registers nothing.
 *
 * Config:
 *
 *   subagents: true   # delegated child agents get the tools too (each its own daemon session)
 */

import Schema from '@deepseek-ai/schemastery'
import { SERVICE, toolsOf } from './index.js'

export const name = 'deepsea-tool-brow-tools'

export const inject = ['tools']

export const Config = Schema.object({
  subagents: Schema.boolean().default(true),
})

/** Delegation depth of the agent preparing a step (0 = a chat's own agent). */
export function depthOf(agent) {
  return agent?.session?.header?.delegationDepth ?? 0
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - this mount's context (an agent preset's, or the Host's).
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  // Only with subagents off: a conditional registration is not executable outside a model step.
  const options = config.subagents ? {} : { when: ({ agent }) => depthOf(agent) === 0 }
  ctx.inject([SERVICE], (scoped) => {
    /** @type {import('./index.js').BrowService} */
    const service = scoped[SERVICE]
    const tools = toolsOf(service)
    for (const tool of tools) scoped.tools.register(tool, options)
    service.trace({ event: 'registered', count: tools.length, subagents: config.subagents })
  })
}
