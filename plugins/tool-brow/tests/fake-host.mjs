// A fake host context and agent for the plugin's two rows: events, effects, optional services through
// inject() (re-run when a service is provided later, as Cordis does), provided services, a tool registry,
// the session projections the plugin reads.
import { tmpdir } from 'node:os'
import * as root from '../index.js'
import * as toolsRow from '../tools-row.js'

/**
 * @param {{ services?: Record<string, unknown>, logger?: object }} [options]
 *   `services` are the ones the rows inject (connection, attachments, llm, sessionTitle, deepseaBrow).
 */
export function fakeCtx({ services = {}, logger } = {}) {
  const handlers = new Map()
  const disposers = []
  /** Pending inject callbacks: { names, callback, disposers }. */
  const waiting = []
  const ctx = {
    warnings: [],
    infos: [],
    services,
    provided: {},
    logger: logger ?? { info(message) { ctx.infos.push(message) }, warn(message) { ctx.warnings.push(message) }, debug() {} },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    emit(event, ...args) { for (const handler of handlers.get(event) ?? []) handler(...args) },
    effect(run) { const dispose = run(); let done = false; const once = () => { if (!done) { done = true; return dispose?.() } }; disposers.push(once); return once },
    inject(names, callback) {
      const entry = { names, callback, active: false, scoped: undefined }
      waiting.push(entry)
      ctx.wake()
    },
    /** Run inject callbacks whose services are all present; dispose those whose services went away. */
    wake() {
      for (const entry of waiting) {
        const ready = entry.names.every(n => services[n] !== undefined)
        if (ready && !entry.active) {
          entry.active = true
          entry.scoped = fakeScope(ctx, services)
          entry.callback(entry.scoped)
        } else if (!ready && entry.active) {
          entry.active = false
          entry.scoped.dispose()
        }
      }
    },
    provide(name, value) {
      ctx.provided[name] = value
      for (const listener of ctx.providers) listener(name, value)
      return async () => {
        if (ctx.provided[name] === value) delete ctx.provided[name]
        for (const listener of ctx.providers) listener(name, undefined)
      }
    },
    providers: [],
    /** The tool registry: name → { definition, options }; unload removes the registrations. */
    registered: new Map(),
    tools: {
      register(definition, options = {}) {
        if (ctx.registered.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered in this scope`)
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

/** A sub-fiber of an inject callback: its effects and registrations go when it is disposed. */
function fakeScope(parent, services) {
  const disposers = []
  const scoped = {
    ...services,
    logger: parent.logger,
    effect(run) { const dispose = run(); disposers.push(dispose); return dispose },
    tools: {
      register(definition, options = {}) {
        if (parent.registered.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered in this scope`)
        parent.registered.set(definition.name, { definition, options })
        disposers.push(() => parent.registered.delete(definition.name))
      },
    },
    // Synchronous: a withdrawn service's dependents are gone before its disposer resolves (as in Cordis).
    dispose() { for (const dispose of disposers.splice(0).reverse()) dispose?.() },
  }
  return scoped
}

/**
 * Both rows as a server mounts them: the package root (global) and one mount of the tools row, which
 * sees the root's service whenever it is provided (and loses it when it is withdrawn).
 * @param {object} config - the root's config (validated here).
 * @param {object} [seams] - the root's test seams.
 * @param {{ services?: Record<string, unknown>, logger?: object, tools?: object }} [options]
 */
export function mountBoth(config, seams, { services = {}, logger, tools = {} } = {}) {
  const host = fakeCtx({ services, logger })
  const presetServices = {}
  const preset = fakeCtx({ services: presetServices, logger })
  host.providers.push((name, value) => {
    if (value === undefined) delete presetServices[name]
    else {
      // A re-provide is a withdrawal, then the new value: dependents run again.
      if (presetServices[name] !== undefined) { delete presetServices[name]; preset.wake() }
      presetServices[name] = value
    }
    preset.wake()
  })
  root.apply(host, root.Config(config), seams)
  toolsRow.apply(preset, toolsRow.Config(tools))
  return {
    host,
    preset,
    tool: (name) => preset.registered.get(name)?.definition,
    async dispose() { await preset.dispose(); await host.dispose() },
  }
}

/** A fake agent: its session projection and the notices injected into it. */
export function fakeAgent(id, { depth = 0, cwd = tmpdir(), provider = 'sim', model = 'vision-model' } = {}) {
  return {
    id,
    notices: [],
    options: { provider, model },
    session: { id: `s-${id}`, header: { cwd, delegationDepth: depth } },
    inject(message) { this.notices.push(message) },
  }
}

/** The services behind inline images: models named `vision-*` declare image input. */
export function imagingServices() {
  const saved = []
  return {
    saved,
    attachments: {
      async saveImages(images) {
        return images.map((image, i) => {
          saved.push(image)
          return { attachmentId: `sha256:${saved.length}-${i}`, mediaType: image.mediaType, bytes: image.data.byteLength, width: 1, height: 1, name: image.name }
        })
      },
    },
    llm: { async resolveModelInfo(_provider, model) { return { inputModalities: model.startsWith('vision') ? ['text', 'image'] : ['text'] } } },
  }
}

/** Wait until `check()` is truthy (polling), or fail after `ms`. */
export async function until(check, ms = 3000, what = 'condition') {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
