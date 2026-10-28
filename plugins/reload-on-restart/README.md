# @deepsea/reload-on-restart

When the web GUI reconnects to a server whose every client bundle has a new
revision (a restart on new code), the page **reloads** instead of letting the
shell hot-swap the whole plugin tree in place. That swap runs under a live
React root: components render while the services they use are gone, the
root unmounts on the uncaught error, and the window is left as a bare dark
page. No navigation happens, so nothing else (a relay's splash, the macOS
app's offline page) can show either. Browser only; the host half is an empty
`apply`.

## What it does

The client-hmr plugin hands every `graph` frame of its `/plugins/events`
stream to `ctx.modules.entries.sync(graph)`, which replaces each entry whose
revision changed. This plugin wraps that method, and `entries.reload` (which
delivers single rebuilt bundles), and keeps row id → revision as the page
runs them, seeded from `ctx.modules.manifest`. For each graph frame:

| Rows in common whose revision changed | Verdict | Action |
|---|---|---|
| none | unchanged: the first frame after boot, a restart on the same files, rows only added or removed | pass through |
| some | partial: hot reload of rebuilt bundles | pass through |
| **all** | **restart on new code** | `location.reload()`; the frame never reaches the swap |

A row's revision is a hash of its bundle file's metadata (modification and
change time, size). So:

- a server restarted on the same files keeps every revision: the page
  reconnects and carries on, and nothing is swapped;
- a server started on a new build, with every bundle rebuilt, re-revisions
  every row: the page reloads;
- a bundle rebuilt while the page is connected arrives as one `rebuilt`
  frame and then the graph, and hot-reloads as usual.

The host sends the current graph on every connection, and the page's event
stream reconnects by itself, so the frame arrives as soon as the new server
answers. The reload then boots against that server, or, if it is still
starting, against whatever answers in its place.

## Console

- `[deepsea-reload-on-restart] every client bundle changed revision (N): the
  server restarted on new code; reloading the page`: a warning, which the
  macOS app copies into its run log.
- `[deepsea-reload-on-restart] k of N client bundles changed revision; hot
  reload`: a partial frame passed through.
- `[deepsea-reload-on-restart] ctx.modules.entries.sync or .reload not found;
  inactive`: the client's module system changed shape; nothing else is
  affected.

## Limits

- A server restarted with only some bundles rebuilt (a new harness build
  under plugins loaded in place, say) is a partial frame and is hot-swapped.
- A page that never sees a graph frame from the new server (its event stream
  stays down) is not reloaded; the GUI shows its own reconnecting state.

## Development

```sh
pnpm install          # also builds lib/client.js (prepare)
pnpm test             # the decision and the wrapper against a fake ctx.modules (node:test)
pnpm typecheck
```

`src/client/detect.ts` is the decision (no globals); `src/client/index.ts`
wraps the entry controller (`install`, exported for tests).

In the macOS app: `dsd run release --throwaway-app --plugins
reload-on-restart` (tools/dsd/README.md). dsd cannot restart a throwaway's
server on the same home and port, so the reload is exercised by handing the
real `entries.sync` a graph whose revisions are all new, through a test
plugin of your own that exposes `ctx.modules.entries.sync` to the page
(`--patch`): the page reloads (`performance.timeOrigin` changes) and the
warning lands in the app's run log; the boot graph itself passes through.
