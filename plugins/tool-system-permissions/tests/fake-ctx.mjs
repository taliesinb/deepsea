// A fake plugin context for both rows: routes, tools, prompt sections, and a
// service table shared between contexts (`services`), so a tools row can read
// the service the root row provides, as a preset reads a Host service.
export function fakeCtx(services = new Map()) {
  const routes = new Map()
  const tools = new Map()
  const sections = []
  const disposers = []
  const listeners = new Map()
  const commands = new Map()
  const ctx = {
    routes, tools, sections, services, registeredCommands: commands,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      listeners.set(event, [...list, listener])
      disposers.push(() => listeners.set(event, (listeners.get(event) ?? []).filter(l => l !== listener)))
    },
    emit(event, ...args) { for (const listener of listeners.get(event) ?? []) listener(...args) },
    logger: { info() {}, warn() {}, debug() {} },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    provide(name, value) {
      if (services.has(name)) throw new Error(`service "${name}" has been registered`)
      services.set(name, value)
      disposers.push(() => services.delete(name))
    },
    get(name) { return services.get(name) },
    tools: { register(tool) { tools.set(tool.name, tool) }, get(toolName) { return tools.get(toolName) } },
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path) } } } },
    systemPrompt: { section(section) { sections.push(section) }, getSectionOrder() { return 1000 } },
    commands: { register(command) { commands.set(command.name, command); disposers.push(() => commands.delete(command.name)) } },
    inject(_names, callback) { callback(ctx) },
    dispose() { for (const dispose of disposers.splice(0).reverse()) dispose() },
  }
  return ctx
}

export const exec = (callId) => ({ callId, agent: { id: 'session-1', session: { id: 'session-1' } }, signal: new AbortController().signal })
