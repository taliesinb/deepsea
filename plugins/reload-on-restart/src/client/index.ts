/**
 * @deepsea/reload-on-restart, browser half: reload the page when the server
 * comes back running new code throughout, instead of hot-swapping every
 * client plugin in place.
 *
 * The client-hmr plugin hands every `graph` frame of its `/plugins/events`
 * stream to `ctx.modules.entries.sync(graph)`, which replaces each entry
 * whose rev changed in place: it tears the plugin down, imports the new
 * bundle and mounts it again. For one rebuilt bundle that is hot reload. When
 * a restarted server re-revisions every bundle at once, the whole tree is
 * swapped under a live React root: components render while the services they
 * use are gone, the root unmounts on the uncaught error, and the window is
 * left as a bare dark page with no navigation that would show anything else.
 *
 * This plugin wraps `entries.sync` (and `entries.reload`, which delivers
 * single rebuilt bundles, to keep its table current) and keeps row id → rev
 * as the page runs them, seeded from `ctx.modules.manifest`. A frame in which
 * every known row changed rev (detect.ts) reloads the page and never reaches
 * the swap; any other frame passes through. The reload boots cleanly against
 * the server that is there, or, while it is still coming up, lands on
 * whatever answers in its place (a relay's splash, the macOS app's offline
 * page).
 */
import type { Context } from '@deepseek-ai/cordis'
import { classify, graphRows } from './detect.ts'

/** The slice of `ctx.modules` (dsh-client-modules' ClientModuleLoader) this plugin touches. */
export interface EntriesLike {
  sync(graph: unknown): Promise<void>
  reload(id: string, rev: string): Promise<void>
}
export interface ModulesLike {
  manifest: { modules: readonly { id: string; rev: string }[] }
  entries: EntriesLike
}

export const name = 'deepsea-reload-on-restart'
export const inject = ['modules']

/** The installed wrapper, for tests. */
export interface Installed {
  /** Row id → rev as the page currently runs them. */
  readonly known: Map<string, string>
  /** Undo the wrapping. */
  dispose(): void
}

/**
 * Wrap the entry controller.
 * @param modules - the `ctx.modules` service.
 * @param reloadPage - what a restart does (default `location.reload()`).
 */
export function install(modules: ModulesLike, reloadPage: () => void = () => { location.reload() }): Installed {
  const entries = modules.entries
  const known = new Map<string, string>()
  for (const row of modules.manifest.modules) known.set(row.id, row.rev)

  const originalSync = entries.sync
  const originalReload = entries.reload
  let reloading = false

  const wrappedSync = function sync(this: EntriesLike, graph: unknown): Promise<void> {
    const rows = graphRows(graph)
    const verdict = classify(known, rows)
    if (verdict.kind === 'restart') {
      if (!reloading) {
        reloading = true
        // The console, not ctx.logger: the page keeps no log sink, while the
        // macOS app copies console warnings into its run log.
        console.warn(`[${name}] every client bundle changed revision (${String(verdict.changed)}): the server restarted on new code; reloading the page`)
        reloadPage()
      }
      // The page is going away: never start the swap.
      return Promise.resolve()
    }
    if (verdict.kind === 'partial') {
      console.info(`[${name}] ${String(verdict.changed)} of ${String(verdict.common)} client bundles changed revision; hot reload`)
    }
    for (const row of rows) known.set(row.id, row.rev)
    return originalSync.call(this, graph)
  }

  const wrappedReload = function reload(this: EntriesLike, id: string, rev: string): Promise<void> {
    known.set(id, rev)
    return originalReload.call(this, id, rev)
  }

  entries.sync = wrappedSync
  entries.reload = wrappedReload

  return {
    known,
    dispose() {
      // Undo only this layer; a wrapper stacked on top of it stays.
      if (entries.sync === wrappedSync) entries.sync = originalSync
      if (entries.reload === wrappedReload) entries.reload = originalReload
    },
  }
}

export function apply(ctx: Context): void {
  const modules = (ctx as unknown as { modules?: ModulesLike }).modules
  if (modules === undefined || typeof modules.entries?.sync !== 'function' || typeof modules.entries.reload !== 'function') {
    console.warn(`[${name}] ctx.modules.entries.sync or .reload not found; inactive`)
    return
  }
  ctx.effect(() => {
    const installed = install(modules)
    return () => { installed.dispose() }
  }, 'deepsea-reload-on-restart: entries.sync wrapper')
}
