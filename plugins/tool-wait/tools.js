/**
 * @deepsea/tool-wait/tools: the subpath row `deepsea-tool-wait-tools`
 * ("Wait tool"), which joins the agent presets that have upstream's
 * `@deepseek-ai/dsh-tool-jobs` (package.json `deepsea.presets`): the `wait`
 * tool and its system-prompt hint.
 *
 * Each wait is started in the package root's registry (service `deepseaWait`,
 * index.js), where the browser card's Skip and Abort find it through the root's
 * routes. The service is read when a wait starts, never injected: preset rows
 * mount before Host rows, and a required service that is missing makes the
 * whole preset unusable. Without the root row the tool still waits, in a
 * registry of its own that nothing can skip or abort.
 *
 * Config (all optional):
 *
 *   maxSeconds: 3600     # longest single wait the tool accepts (the model is told to call again for more)
 *   promptHint: true     # add a system-prompt line steering the model from bash `sleep` to `wait`
 */

import Schema from '@deepseek-ai/schemastery'
import { SERVICE, createWaitRegistry, createWaitTool } from './wait.mjs'

export const name = 'deepsea-tool-wait-tools'

// `systemPrompt` is optional (sub-fiber below) so a composition without it still gets the tool.
export const inject = ['tools']

export const Config = Schema.object({
  maxSeconds: Schema.number().min(1).default(3600),
  promptHint: Schema.boolean().default(true),
})

/** Name of the system-prompt section carrying the hint (kept from the single-row plugin). */
export const PROMPT_SECTION = 'tool:deepsea-tool-wait'

export const PROMPT_HINT = 'To let time pass (a server starting, a build finishing, polling backoff) call the `wait` tool with the number of '
  + 'seconds — never bash `sleep`. The user sees the wait as a progress bar and can skip it (returns early, as if the time had elapsed) '
  + 'or abort it (the call fails with "user aborted sleep": stop and ask, do not wait again).'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - a preset's (or the Host's) plugin context.
 * @param {ReturnType<typeof Config>} config - validated plugin config.
 */
export function apply(ctx, config) {
  // Waits started while the root row is absent: no route reaches them, so they only time out or are cancelled.
  const uncontrolled = createWaitRegistry()
  ctx.effect(() => () => uncontrolled.disposeAll(), 'tool-wait: uncontrolled waits')
  const registry = { start: (spec) => (ctx.get(SERVICE) ?? uncontrolled).start(spec) }

  ctx.tools.register(createWaitTool(registry, { maxSeconds: config.maxSeconds }))

  if (config.promptHint) {
    ctx.inject(['systemPrompt'], (ctx) => {
      ctx.systemPrompt.section({
        name: PROMPT_SECTION,
        order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
        text: ({ scope }) => ctx.tools.get('wait', scope) === undefined ? '' : PROMPT_HINT,
      })
    })
  }

  ctx.logger.info(`tool-wait: registered wait (maxSeconds=${config.maxSeconds})`)
}
