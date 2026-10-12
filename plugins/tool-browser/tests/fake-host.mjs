// A fake host context and agent for the plugin's two rows: events, effects, optional services through
// inject(), provided services, a tool registry, the session projections the plugin reads. Shared by the
// tests and the live scripts (scripts/live-*.mjs), which drive the real tools without a server.
import { tmpdir } from 'node:os'
import * as root from '../index.js'
import * as toolsRow from '../tools-row.js'

/**
 * @param {{ services?: Record<string, unknown>, logger?: object }} [options]
 *   `services` are the optional ones the rows inject (connection, attachments, llm, deepseaBrowser).
 */
export function fakeCtx({ services = {}, logger } = {}) {
  const handlers = new Map()
  const disposers = []
  const ctx = {
    warnings: [],
    injected: [],
    provided: {},
    logger: logger ?? { info() {}, warn(message) { ctx.warnings.push(message) }, debug() {} },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    emit(event, ...args) { for (const handler of handlers.get(event) ?? []) handler(...args) },
    effect(run) { const dispose = run(); let done = false; const once = () => { if (!done) { done = true; return dispose?.() } }; disposers.push(once); return once },
    inject(names, callback) { ctx.injected.push(names); if (names.every(n => n in services)) callback({ ...ctx, ...services }) },
    provide(name, value) { ctx.provided[name] = value; return () => { delete ctx.provided[name] } },
    /** The tool registry: name → { definition, options }; unload removes the registrations. */
    registered: new Map(),
    tools: {
      register(definition, options = {}) {
        ctx.registered.set(definition.name, { definition, options })
        return ctx.effect(() => () => { ctx.registered.delete(definition.name) })
      },
    },
    get: (name) => services[name],
    /** Unload: run every effect's disposer, newest first. */
    async dispose() { for (const dispose of disposers.splice(0).reverse()) await dispose() },
  }
  return ctx
}

/**
 * Both rows as a server mounts them: the package root (global) and one mount of the tools row reading
 * its `deepseaBrowser` service.
 * @param {object} config - the root's config (validated here).
 * @param {object} [seams] - the root's test seams.
 * @param {{ services?: Record<string, unknown>, logger?: object, tools?: object }} [options] - `tools`: the tools row's config.
 */
export function mountBoth(config, seams, { services = {}, logger, tools = {} } = {}) {
  const host = fakeCtx({ services, logger })
  root.apply(host, root.Config(config), seams)
  const preset = fakeCtx({ services: { ...host.provided }, logger })
  toolsRow.apply(preset, toolsRow.Config(tools))
  return {
    host,
    preset,
    tool: (name) => preset.registered.get(name)?.definition,
    async dispose() { await preset.dispose(); await host.dispose() },
  }
}

/** A fake agent: its session projection and the notices injected into it. */
export function fakeAgent(id, { depth = 0, cwd = tmpdir() } = {}) {
  return {
    id,
    notices: [],
    session: { id, header: { cwd, delegationDepth: depth } },
    inject(message) { this.notices.push(message) },
  }
}
