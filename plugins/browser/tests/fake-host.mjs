// A fake host context and agent for the plugin's apply(): events, effects, optional services through
// inject(), the agents service, the session projections the plugin reads. Shared by the tests and the
// live scripts (scripts/live-*.mjs), which drive the real tools without a server.
import { tmpdir } from 'node:os'

/**
 * @param {{ agents?: object[], services?: Record<string, unknown>, logger?: object }} [options]
 *   `services` are the optional ones the plugin injects (connection, attachments, llm).
 */
export function fakeCtx({ agents = [], services = {}, logger } = {}) {
  const handlers = new Map()
  const disposers = []
  const ctx = {
    warnings: [],
    injected: [],
    presets: new Map(),
    logger: logger ?? { info() {}, warn(message) { ctx.warnings.push(message) }, debug() {} },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    emit(event, ...args) { for (const handler of handlers.get(event) ?? []) handler(...args) },
    effect(run) { const dispose = run(); let done = false; const once = () => { if (!done) { done = true; return dispose?.() } }; disposers.push(once); return once },
    inject(names, callback) { ctx.injected.push(names); if (names.every(n => n in services)) callback({ ...ctx, ...services }) },
    tools: {},
    agents: { list: () => agents, get: (id) => ctx.agents.list().find(a => a.session.id === id) },
    sessionProjections: { stateOf: (session, key) => key === 'agentPreset' ? ctx.presets.get(session.id) : undefined },
    /** Unload: run every effect's disposer, newest first. */
    async dispose() { for (const dispose of disposers.splice(0).reverse()) await dispose() },
  }
  return ctx
}

/** A fake agent whose scope records the tools registered into it. */
export function fakeAgent(id, { depth = 0, preset = '', cwd = tmpdir() } = {}) {
  const registered = new Map()
  return {
    id,
    registered,
    session: { id, header: { cwd, delegationDepth: depth, agentPreset: preset } },
    ctx: { tools: { register: (def) => { registered.set(def.name, def); return () => { registered.delete(def.name) } } } },
    inject() {},
  }
}
