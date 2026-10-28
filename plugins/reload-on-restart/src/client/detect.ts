/**
 * The decision, free of globals: does an incoming graph frame come from the
 * server code the page is running (perhaps with a rebuilt bundle), or from a
 * server whose every client bundle is new?
 *
 * Facts it relies on (harness packages/client/modules and client/hmr):
 *   - A graph row's `rev` is a hash of its bundle file's metadata (mtime,
 *     ctime, size). A server restarted on the same files keeps every rev; a
 *     server started on a new build re-revisions every row it rebuilt.
 *   - A bundle rebuilt while the page is connected is announced by a
 *     `rebuilt` frame for that one row (`entries.reload`), then a graph frame.
 *   - The host sends the current graph on every connection, so the page's
 *     event stream, reconnecting by itself after a restart, receives the new
 *     server's graph at once.
 * Hence: every row the page knows changed rev in one graph frame ⇔ the page
 * is talking to a server running new code throughout.
 */

/** One wire graph row; only its identity and revision matter here. */
export interface GraphRow {
  readonly id: string
  readonly rev: string
}

export type Verdict =
  /** No known row changed rev (the first frame after boot, or rows only added or removed). */
  | { readonly kind: 'unchanged'; readonly common: number }
  /** Some known rows changed rev: hot reload of rebuilt bundles. */
  | { readonly kind: 'partial'; readonly changed: number; readonly common: number }
  /** Every known row changed rev at once: a server with new code throughout. */
  | { readonly kind: 'restart'; readonly changed: number }
  /** No row in common: nothing to compare. */
  | { readonly kind: 'unrelated' }

/**
 * Read `{ entries: [{ id, rev }] }` from a wire frame; other shapes give [].
 * @param graph - the frame's graph, as received.
 */
export function graphRows(graph: unknown): GraphRow[] {
  if (typeof graph !== 'object' || graph === null) return []
  const entries = (graph as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return []
  const rows: GraphRow[] = []
  for (const row of entries as unknown[]) {
    if (typeof row !== 'object' || row === null) continue
    const { id, rev } = row as { id?: unknown; rev?: unknown }
    if (typeof id === 'string' && typeof rev === 'string') rows.push({ id, rev })
  }
  return rows
}

/**
 * Compare a frame's rows with the revisions the page runs.
 * @param known - row id → rev as last applied in this page.
 * @param incoming - the rows of the frame just received.
 */
export function classify(known: ReadonlyMap<string, string>, incoming: readonly GraphRow[]): Verdict {
  let common = 0
  let changed = 0
  for (const row of incoming) {
    const current = known.get(row.id)
    if (current === undefined) continue
    common += 1
    if (current !== row.rev) changed += 1
  }
  if (common === 0) return { kind: 'unrelated' }
  if (changed === 0) return { kind: 'unchanged', common }
  if (changed === common) return { kind: 'restart', changed }
  return { kind: 'partial', changed, common }
}
