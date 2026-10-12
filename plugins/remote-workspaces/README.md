# @deepsea/remote-workspaces

Workspaces of **other DeepSea servers** in this sidebar. A remote workspace is
a group in the **Remotes** section whose sessions live on another server,
usually another Mac reached at its tailnet URL
(`https://<node>.<tailnet>.ts.net/deepsea[-<v>]/`, published there by
@deepsea/tailscale). Selecting one of its sessions shows the remote GUI's own
chrome-less page for that session (`?embed=<sessionId>`), framed **same-origin**:
this server serves it at `/deepsea-remote-workspaces/servers/<server>/…`
through an egress proxy that holds the remote's credentials. Everything runs
on the remote: the agent, the model calls, the files. Sessions are listed,
started, renamed, archived, moved and copied host to host over the remote's
own API.

```
browser ──same origin──▶ this server                                  the remote server
  Remotes section          egress /deepsea-remote-workspaces/servers/<id>/*  ──▶  <url>/*   (?embed: one session, no sidebar)
  <iframe ?embed=…>        control /deepsea-remote-workspaces/<endpoint>     ──▶  <url>/api/<ns>/<method>
```

Harness topics: `embed-session` (the framed page, on the remote; and
`ctx.layout.embedSessionId` here), `session-relocation` (`session.move`,
`session.copy`, `/api/session.import`), `workspace-destinations`
(`workspace.list`, the `sidebar.workspaces.extra` seat,
`ctx.uiWorkspace.contributeDestinations`, Menu `matchAnchorWidth`) and
`modal-width`. The remote needs `embed-session`, `session-relocation` and
`workspace-destinations` too; this plugin need not run there.

## Admission at the remote

The egress reaches the remote in one of two ways:

1. **Tailscale identity.** The remote runs @deepsea/tailscale and this
   machine's tailnet login is one it admits (its own login, or an allowed
   one): Serve injects the login for every request this server makes, so
   nothing is configured here. Leave the token empty.
2. **A standing token.** The remote's token (Settings ▸ Tailscale there, the
   QR code's `?token=`, `plugins/tailscale/state.json` in its home) is
   exchanged once with `GET <url>?token=…` for the remote's cookie
   (`deepsea-tailscale-<v>`), sent on every request, exchanged again after
   6 hours or on a 401. A server reached directly takes its launch token the
   same way.

The add-remote modal asks for a token only after the remote refused. The
token is stored with the server (`workspaces.json`, 0600).

Forwarded requests carry the remote's `Host`, an `Origin` rewritten to the
remote's origin, `sec-fetch-site: same-origin` and the bridged cookie in
place of the browser's. Dropped: the browser's cookies, `x-forwarded-*`
(Serve derives them), and every `x-deepsea-tailscale*` and `Tailscale-*`
header: when this GUI is itself opened through this server's tailscale proxy,
those describe the hop to this server, and the remote's own proxy, and the
plugins behind it that read them (import-sessions: same machine or not), must
see only what it stamps itself. Responses relay as they are, except
`Set-Cookie` (dropped) and `Location` (remote paths mapped back under the
mount). The mux WebSocket of the framed page is piped both ways. Every egress
route sits behind this server's own request gate (Host/Origin fence and
browser session), so it is not an open relay.

## The Remotes section

At the bottom of the workspace list (the `sidebar.workspaces.extra` seat),
growing upward to half the list, with its own scroll. Header: the label
(click folds the section), fold chevron, **Refresh all remotes**, **View
options**, **Add remote workspace**; with no remotes, only the label and the
add button.

- One group per remote workspace, with cached sessions. A collapsed group
  touches no network; expanding polls the remote (rows keep their cached
  titles with a spinner). Hovering a group: **Refresh from remote**, **…**
  (Rename in this sidebar, Remove from sidebar; the workspace stays on the
  remote), **+** (**New remote session**: reuses the workspace's blank session
  on the remote or creates one, and frames the remote's own composer).
- A session row: click opens it; **…** has Rename, Move to…, Copy to…, Archive
  (all on the remote). Rows carry
  `data-deepsea-remote-session="<workspaceId>:<sessionId>"`.
- While a framed blank session is selected it has a **New Session** row; while
  its composer starts with `slug: `, the row previews the slug, parsed with the
  `__DEEPSEA_SESSION_TITLE_SLUG__` convention of @deepsea/session-title-slug
  (no such plugin here, no preview). The frame is same-origin, so the row reads
  the framed composer's text every 300 ms. The remote names the session on
  send only if it runs session-title-slug itself.
- A blank remote session with a persisted draft keeps a dimmed row after
  switching away, labelled with the draft's slug or New Session: the framed
  page keeps drafts in this origin's localStorage under its own namespace
  (`embed:<id>:dsh.conversation.<id>`), and the poll lists the workspace's
  blank sessions.
- Groups and sessions can be dragged into a manual order (kept here; new
  remote sessions stay on top in the remote's order).
- **View options**: group by Workspace, Server (one group per remote) or In
  one list (newest first, with `workspace · server` under each title); order
  by Manual, Last updated or Last created (the remote account's order:
  `session.list` carries no creation time). Server and list views poll every
  workspace on entry and every 60 s.
- Hover cards like the local tree's: a session (title, `workspace · server`,
  time, Running/Idle, permission mode), a workspace (`server:path`, the
  remote's own name when it differs, created, sessions, last fetched), a
  server (URL, counts, token or identity, last failure).

The framed page has no channel back here, so the sidebar learns a session's
title and activity by polling: on selection +12 s, +40 s, +90 s, then every
2 minutes while the remote panel shows. Frames stay alive hidden for 10
minutes (at most 4), so switching back is instant; a reload brings the
remote panel back when it was the last thing shown. The view state is kept
in `deepsea.remote-workspaces.view` (localStorage).

## The add-remote modal

**Server.** A full URL or a short form; the host normalizes it
(`resolve.mjs`), and the canonical URL is what gets stored:

| typed | becomes |
|---|---|
| `host` | `https://host.<magic-dns-suffix>/deepsea/` (the release variant's Serve path) |
| `user@host` | `https://host.<magic-dns-suffix>/deepsea-user/` (that account's release variant on a shared Mac) |
| `host/deepsea-lab` | `https://host.<magic-dns-suffix>/deepsea-lab/` |
| `host.example.ts.net` | `https://host.example.ts.net/deepsea/` |
| `box.example.com:8443/x`, `host:8443` | `https://…/` as typed (a port or a non-tailnet name gets no default path) |
| `localhost:3202`, `127.0.0.1:3202`, `[::1]:3202`, an IPv4 literal | `http://` added |
| `https://…` | kept; a dot-less host still gets the suffix; trailing slash added |

The MagicDNS suffix comes from `tailscale status --json` (`MagicDNSSuffix`,
else the tail of `Self.DNSName`; cached 5 minutes), run only when a dot-less
host is typed, with the CLI at `tailscalePath`, else on PATH, else the macOS
app and the usual prefixes; failing that, from any known `*.ts.net` server.
The Serve certificate names the FQDN, so `https://studio/` would fail TLS.

**Workspace.** "Connected to *host* in *N* ms", the remote's workspaces (those
already in this sidebar grayed) and **New workspace**: a directory field that
asks the remote about the typed path while typing (120 ms debounce):

- `~` is the remote account's home; the verdict is **Directory exists**,
  **Directory will be created** (Done makes it, `mkdir -p`, before
  `workspace.create`), *Not a directory*, *Cannot create it: … is a file*, or
  **Existing workspace “…”** / **Already in this sidebar** for a path that is
  one; the resolved path sits at the right. `~/` and `/` themselves are not
  accepted.
- Completion: the child directories of the typed directory whose names start
  with the typed last segment (hidden ones only after a typed `.`; directory
  symlinks included; 40 at most). **Tab** completes (one candidate: with a
  slash; several: their common prefix, then highlights the first), ↑↓
  highlight, Enter on a highlighted row accepts it, a click too.
- The answer comes through one of two doors of the remote (`remote-fs.mjs`):
  its own remote-workspaces plugin (`fs.inspect`, `fs.mkdir`: exact `stat`,
  one round trip), else the harness's `directoryPicker` Remote there (`list`,
  `createDirectory`, the in-app browser's primitives, present wherever the
  composed picker is the `browse` backend, which @deepsea/tailscale pins).
  Kinds are read off the listing failures (`ENOENT`, `ENOTDIR`) and a missing
  directory is made one segment at a time. After the plugin door answered "no
  such endpoint" once, later keystrokes go straight to the picker. A remote
  with neither door gives **Paths cannot be checked on this server**, and Done
  takes an absolute path that already exists there.

**Name**: the remote workspace's own title, or the new directory's last
segment, editable. Enter presses Connect / Done; Escape closes.

`fs.inspect` / `fs.mkdir` are served on this server's control channel for
peers and are gated like everything else (this server's request gate:
browser session, or through the tailscale proxy its admission). They list
directory names anywhere on the filesystem: no more than the browse directory
picker shows any admitted client, and far less than the agent it can run.

## Moving and copying sessions across servers

A remote row's **Move to…** / **Copy to…** opens this plugin's dialog: a
destination tree with **This machine** first, then each remote by its label.
A local row's own Move to… / Copy to… (the shell's dialog) lists the remotes
too, after This machine (`contributeDestinations`); a pick of one comes back
here.

| source → destination | Move | Copy |
|---|---|---|
| remote → another workspace of the same remote | the remote's `session.move` | the remote's `session.copy` (its own workspace too: a duplicate) |
| remote → this server, this server → remote, remote A → remote B | export at the source (`GET /api/session.export`, a ZIP with descendants and attachments), import at the destination (`POST /api/session.import`), then **archive** the source, never delete it | the same export and import with `mode=copy` (fresh ids); the source is not touched |

Both carry the session log, its subagent descendants and its attachments; the
files the agent worked on stay where they are. A cross-server move keeps the
session id when it is free at the destination (the result says "with a new
id" otherwise). The import notice names where the session came from: this
machine's host name, or the remote's label. A running source is refused once
(`session/move-live` / `session/copy-live`) and the dialog then offers
**Interrupt the current turn and move it**, or **Copy only up to the last
completed turn** (ticked: the turn in progress and its prompt are left out;
unticked: everything so far, the turn closed as interrupted). A copy's title
starts as "<title> (copy)"; unchanged keeps the source's. Enter presses Move /
Copy. Dragging a local row onto a remote group is not supported.

Calls to this server's own API go in-process through
`connection.createSharedFetchHandler('/api')` (no token, no cookie); calls to
a remote go through its egress (`call` for Typert, `fetchRaw` for the binary
export and import routes). These are the harness's routes, not
import-sessions' (`/import-dsh` reads homes and backups on this machine's
disk).

## For other browser plugins: `deepseaRemoteWorkspaces`

The browser half provides an optional service so sibling plugins can treat
remote sessions like local ones without a build-time dependency (consumer:
@deepsea/numbered-switching, which numbers remote sessions with local ones and
brings a frame back with ⌘N). Consume it with
`ctx.inject(['deepseaRemoteWorkspaces'], scoped => …)`, which runs only while
this plugin is loaded and unwinds when it goes.

```ts
interface RemoteWorkspacesFace {
  getSelection(): { workspaceId: string; sessionId: string } | undefined  // the remote session ON SCREEN
  has(selection): boolean      // false only on positive evidence (workspace gone, or fetched and not listing it); unknown = true
  open(selection): void        // what a row click does: select and show the remote panel
  subscribe(listener): () => void  // selection, on-screen state and the remote workspaces
}
```

Row identity for DOM patchers: `data-deepsea-remote-session="<workspaceId>:<sessionId>"`
on every remote session row (`div[role="treeitem"][aria-selected]`, padding
`0 8px`, a 16px status slot first). Neither id contains a colon.

The framed page is a same-origin shell running the remote's client plugins,
and iframes share the tab's `sessionStorage`: a plugin with per-window
browser state stays inactive in an embedded page
(`ctx.layout.embedSessionId !== undefined`), as this one does. Keys pressed
inside the frame do not reach this page (⌘N works once focus is outside it).

## Configuration and state

```yaml
- id: deepsea-remote-workspaces
  config:
    servers:                     # seeds: present at every start, never written to the registry
      - id: studio               # route segment: /deepsea-remote-workspaces/servers/studio/
        url: https://studio.example.ts.net/deepsea/
        label: studio
        token: ''                # '' = Tailscale identity
    tailscalePath: ''            # the tailscale CLI, for short names; '' = PATH, then the app
    trace: false                 # JSONL trace of control calls and egress failures
```

The registry is `$DSH_HOME/plugins/remote-workspaces/workspaces.json` (0600
in a 0700 directory): servers (id, URL, label, token, last use) and the
remote workspaces with their cached sessions. A server's default label is
`localhost:<port>` for loopback, the first label of a MagicDNS name (`studio`
for `studio.example.ts.net`), else the host name; then the port unless it is
the scheme's default, and the mount path unless it is `/deepsea`
(`studio/deepsea-lab`). The trace (`trace: true`, @deepsea/logs) goes to the
variant's `plugins/remote-workspaces/` log directory.

## Files

| File | Role |
|---|---|
| `index.js` | host: the egress routes per server (prefix route and the exact `api/remote.mux` upgrade route), the control channel, the registry, moves and copies |
| `egress.mjs` | one remote: URL facts, token exchange, header rewriting, request and upgrade forwarding, `call`, `callControl` (the peer's control channel), `fetchRaw` |
| `resolve.mjs` | short forms → URL, the MagicDNS suffix; `inspectPath` / `makeDirectory` (the `fs.*` endpoints served for peers) |
| `remote-fs.mjs` | the same questions asked of a remote: its `fs.*`, else its directory picker |
| `state.mjs` | the registry file |
| `src/client/` | browser half: `api.ts` (control channel), `store.ts` (view and runtime stores, frames), `ui.tsx` and `view.tsx` (the section, modal, dialogs, frame pool, hover cards), `face.ts` (the service), `drafts.ts`, `labels.ts`, `dialog-keys.ts` (identical in every plugin with a dialog) |

## Facts worth keeping

- The embedded shell resolves every Host URL relative to its document
  directory, so the frame URL is `…/servers/<id>/?embed=<sessionId>` with the
  slash; the slash-less form gets a 301 that keeps the query.
- Remote RPC arguments are keyed by the method's parameter name:
  `session.list` takes `{ _request: {} }`, `workspace.list` `{}`,
  `session.create` / `workspace.create` / `session.rename` / `session.move` /
  `session.copy` `{ request: {…} }`. A `session.list` item is `{ sessionId,
  updatedAt, running, blank, cwd, projections: { values: { title, … } } }`.
- `main` is a keyed slot that unmounts inactive entries, so the iframes live
  in `shell.overlay` (always mounted, click-through) positioned over the
  panel host's measured box; the centre column is an unpositioned flex
  column, so the host fills it as a flex child.

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

The tests run a fake remote (token exchange, header rewriting, `Location`
mapping, 401 re-exchange, WebSocket echo, identity mode), two plugin instances
on two listeners (`servers.inspectPath` → egress → the peer's `fs.inspect`;
`workspaces.add` making the directory there), a remote with only the browse
directory picker, a stand-in tailscale CLI, and the browser half's pure parts
(the service, drafts, labels), all under `$TMPDIR/deepsea-remote-workspaces-…`.

End to end, two throwaways on this Mac: a remote with the tailscale plugin's
proxy on a port of your choice and its CLI pointed at a copy of
`plugins/tailscale/tests/fixtures/fake-tailscale.mjs` (no Serve path, so
nothing touches Tailscale), and a local app with this plugin and its
`tailscalePath` pointed at the same copy:

```yaml
# remote.patch.yml
- id: deepsea-tailscale
  config: { proxyPort: 41000, tailscalePath: /path/to/scratch/tailscale.mjs }
```

```sh
dsd run release --throwaway-server --detach --scripted --plugins tailscale,import-sessions --patch remote.patch.yml
dsd run release --throwaway-app --detach --scripted --plugins remote-workspaces,numbered-switching,session-title-slug
```

Then add `127.0.0.1:41000` in the modal with the remote home's
`plugins/tailscale/state.json` token. Tailscale identity admission and Serve's
path stripping need two machines on a tailnet.
