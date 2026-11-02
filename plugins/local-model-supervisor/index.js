/**
 * @deepsea/local-model-supervisor: local model servers (AFM, llama.cpp, …)
 * hosted by DeepSea itself (README.md).
 *
 * When a session selects, or sends a request to, a provider a configured
 * server carries, the server is started (or adopted, when something else
 * already runs it) and reused by every session. Once it has been idle past
 * its window and no live session selects its providers, the server is
 * stopped. Only processes this plugin spawned are ever stopped; unloading
 * the plugin stops them too.
 */
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { pluginLogDirectory, variantName, variantOf } from '@deepsea/logs'
import { Supervisor, resolveConfig, serverLogDirectory } from './supervisor.mjs'

export const name = 'deepsea-local-model-supervisor'
export const inject = ['agents', 'sessionProjections']
export { resolveConfig }

const SWEEP_MS = 60_000

/** Cordis validates the server list before activating the plugin. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'deepsea-local-model-supervisor',
    validate(input) {
      try { return { value: resolveConfig(input) } }
      catch (error) { return { issues: [{ message: error.message }] } }
    },
  },
}

/**
 * Whether a live top-level agent's current model selection (pending, else
 * last used) names one of the server's providers.
 */
export function inUseBy(ctx) {
  return (server) => {
    const providers = new Set(server.providers)
    for (const agent of ctx.agents.list()) {
      let selection
      try {
        const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
        selection = state?.pending ?? state?.lastUsed
      } catch {
        continue
      }
      if (selection !== null && selection !== undefined && providers.has(selection.provider)) return true
    }
    return false
  }
}

/** The provider a committed session event names: a model selection or a request. */
export function providerOf(event) {
  if (event.type === 'model/selection') return event.data?.provider
  if (event.type === 'request/header') return event.data?.header?.config?.provider
  return undefined
}

export function apply(ctx, input) {
  install(ctx, input)
}

/**
 * Wire a supervisor to the session events and a sweep timer, both undone on
 * unload (which stops the owned servers). `options` replaces the home, the
 * environment, the sweep interval and supervisor internals, for tests.
 * @returns the supervisor, or undefined when no server is configured.
 */
export function install(ctx, input, options = {}) {
  const { servers } = resolveConfig(input)
  if (servers.length === 0) {
    ctx.logger.warn('no servers configured; nothing to supervise')
    return undefined
  }
  const home = options.home ?? resolveDshHome()
  const env = options.env ?? process.env
  // Run logs in the variant's log directory (LAYOUT.md §5), named after the variant.
  const variant = variantOf(home, env)
  const supervisor = new Supervisor({
    servers,
    logger: ctx.logger,
    inUse: inUseBy(ctx),
    logDirectory: serverLogDirectory(pluginLogDirectory('local-model-supervisor', home, env)),
    ...(variant === undefined ? {} : { variant: variantName(variant) }),
    ...options.supervisor,
  })

  ctx.on('session/event', (_session, event) => {
    const provider = providerOf(event)
    if (typeof provider === 'string') void supervisor.touch(provider)
  })

  ctx.effect(() => {
    const timer = setInterval(() => supervisor.sweep(), options.sweepMs ?? SWEEP_MS)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      supervisor.stopOwned()
    }
  })
  return supervisor
}
