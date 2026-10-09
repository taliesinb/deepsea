/**
 * @deepsea/prompt-excision: whole paragraphs removed from the initial system
 * prompt of selected provider routes when they contain configured literal
 * strings (README.md).
 */
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { exciseAssembly, resolveConfig } from './excision.mjs'

export const name = 'deepsea-prompt-excision'
export const inject = ['systemPrompt']
export { resolveConfig }

/** Cordis validates the provider mapping before activating this plugin. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'deepsea-prompt-excision',
    validate(input) {
      try { return { value: resolveConfig(input) } }
      catch (error) { return { issues: [{ message: error.message }] } }
    },
  },
}

/** Excise during assembly, so DSH's normal prompt admission records the same text it sends. */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const providers = new Map(Object.entries(config.providers))
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return exciseAssembly(assembly, providers, renderPrompt)
  }, { prepend: true })
}
