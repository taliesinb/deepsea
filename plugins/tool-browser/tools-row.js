/**
 * @deepsea/tool-browser/tools: the browser tools row, `deepsea-tool-browser-tools` ("Browser tools").
 *
 * Registers the `safari_*` and `chrome_*` tools (tools.mjs) of the browsers
 * the package root enables, once per mount: dsd's generated presets put this
 * row into every agent preset that has tool-web (standard, ptc, cordis), and
 * disable it globally. Everything process-wide (windows, MCP processes, the
 * reader pool, placement, the DeepSea app's routes, the browser half, idle
 * timers) is the package root's (index.js, `deepsea-tool-browser`), which this
 * row reaches through the `deepseaBrowser` service. The service is read in an
 * `inject` sub-fiber, never in this row's own `inject`: preset rows mount
 * before Host rows, and a missing required service would make the preset
 * unusable. Without the root (disabled, or no browser enabled) the row
 * registers nothing. The tools find their caller's windows through
 * `exec.agent`.
 *
 * Config:
 *
 *   subagents: true   # delegated child agents get the tools too (each its own session)
 */

import Schema from '@deepseek-ai/schemastery'
import { SERVICE, toolsOf } from './index.js'

export const name = 'deepsea-tool-browser-tools'

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
    /** @type {import('./index.js').BrowserService} */
    const browser = scoped[SERVICE]
    const tools = toolsOf(browser)
    for (const tool of tools) scoped.tools.register(tool, options)
    browser.trace({ event: 'tools', count: tools.length, subagents: config.subagents })
  })
}
