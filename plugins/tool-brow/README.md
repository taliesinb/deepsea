# @deepsea/tool-brow

Browsers for agents from **brow**: a per-user daemon, separate
from DeepSea, that gives every chat (and every subagent) its own **Chrome for
Testing** and **Safari Technology Preview** windows through eight `browser_*`
tools. This plugin drives no browser itself. It is a thin client of the
daemon's Unix socket (JSON-RPC): it registers the tools the daemon lists,
maps each agent to a daemon session, shows screenshots inline, passes the
daemon's notices to the agent, and relays the DeepSea app's window so the
daemon can park Safari windows beside it.

The daemon is the standalone project `brow` (its README,
docs/protocol.md and docs/tools.md are the references for the tools and the
wire). It was extracted from `@deepsea/tool-browser-unified`, which drives
the same tools in-process; this plugin replaces it. **Run only one browser
plugin in a variant** (Coexistence, below).

It acts on something every variant on the Mac shares (one daemon per macOS
user, which it may start), so it is machine-wide (`"deepsea": { "machineWide":
… }` in package.json): `dsd run … --plugins all` leaves it out of throwaways;
name it to include it.

## Two rows

One package, two loader rows (plugins/AGENTS.md → Presets, "Two rows, one
package"):

| Row | Module | Title | Where | What |
|---|---|---|---|---|
| `deepsea-tool-brow` | `@deepsea/tool-brow` (`index.js`) | Brow | global | the connection to the daemon (started when none runs), one daemon session per agent, notices, inline images, closing a disposed agent's session, the DeepSea app's window routes and the browser half; provides the service `deepseaBrow` |
| `deepsea-tool-brow-tools` | `@deepsea/tool-brow/tools` (`tools-row.js`) | Brow tools | the agent presets that have `@deepseek-ai/dsh-tool-web` (standard, ptc, cordis), disabled globally | the daemon's tools |

The tools row joins the presets through dsd's generated presets
(`"deepsea": { "presets": { "joinWith": ["@deepseek-ai/dsh-tool-web"], "module": "@deepsea/tool-brow/tools" } }`),
so browsing lands where `web_search` and `web_fetch` are. It reads
`deepseaBrow` in an `inject` sub-fiber (preset rows mount before
Host rows). The root provides the service only **once the daemon has listed
its tools** (`tools.list`), and provides it again when a reconnect finds a
different list (a newer daemon), so the tools row registers them again.
Without a reachable daemon there are no browser tools; the root keeps trying
(5 s, 15 s, 1 min, then every 5 min) and logs why.

## Tools

Whatever `tools.list` returns, under the daemon's names, descriptions and
JSON Schemas, unchanged: today `browser_open`, `browser_close`,
`browser_navigate`, `browser_eval`, `browser_read`, `browser_screenshot`,
`browser_act`, `browser_logs` and `browser_script` (browser scripts the
daemon runs: start, status, wait, cancel, log, help).
A schema the harness does not take (`assertSupportedJsonSchema`) leaves that
tool out with a warning. Arguments are validated here against the schema
(`ToolArgsError`, as `defineTool` does) before anything goes to the daemon;
each call is `tools.call { session, name, arguments, images: "inline" }`, and
the call's abort signal becomes `$/cancel` (a daemon that does not answer 5 s
after the cancel is given up on). A result with `isError` throws its text,
so the model sees the daemon's message (with its `Hint:`) as a failed tool
call, as with the in-process tools; the result's structured `error { message,
hint?, tool, browser?, handle?, aborted? }` adds the window the call used in
front (`[chrome:0:3] browser_act: no element matches …`) when the text does
not name it, so the model and the row know which window failed. A call
cancelled by its own signal **returns** instead of throwing: the harness then
records its own cancelled result (`ABORTED`, a stopped row, not a failure).
A call the daemon cancelled for another reason (`error.aborted` while the
signal is not: the session ended, the daemon is stopping) fails with "…
was cancelled by the brow daemon (…)". A connection that closes during a call
fails it with "the brow daemon connection closed during <tool> …; the
call may or may not have run".

## Sessions

Each agent is one daemon session:

- `session.open { key: <agent id>, label: <chat title>, cwd: <the session's
  working directory>, lease: "connection" }` at the agent's first tool call.
  The label is the `sessionTitle` service's title, else `chat <last 8 of the
  id>`; the daemon puts it (after its own prefix) in Safari's banner and on
  the start page. When the title or the directory changes, the next call
  sends `session.update` first. Subagents are agents of their own, so
  sessions of their own (windows `chrome:<n>:…` of another index).
- `agent/disposed` → `session.close` (the daemon closes its windows). Plugin
  unload closes every session, then the connection.
- The `connection` lease also covers a server that dies: the daemon ends the
  sessions of a closed connection after its grace (`sessions.graceSeconds`,
  10 s), closing their windows.

**Restarts.** When the connection closes (the daemon stopped, restarted or
crashed) the plugin reconnects at once, three times (0.25 s, 1 s, 3 s)
**without** starting a daemon, re-opens the sessions in use in one request
(`session.resume { sessions: [session.open params …] }`) and replays the
app's window reports; after that the next tool call reconnects, starting the
daemon if needed. A call that arrives while the sessions are being resumed
waits for its own. A session re-opened on a daemon that no longer had it
(`resumed: false`) puts a note in front of that agent's next result: `NOTE:
the brow daemon restarted (pid A → B); this chat's earlier browser
windows are gone.` (or "had ended this chat's session (its lease lapsed)" on
the same daemon). A call refused with "unknown session" re-opens the session
and runs once more.

**Starting the daemon.** When nothing answers on the socket and
`brow.autostart` is on, the plugin starts one, preferring the
installed **Brow.app** (bundle id `io.github.taliesinb.brow`,
whose per-user LaunchAgent of the same label runs the daemon on the default
home's socket) and falling back to the daemon's CLI:

| | Way | When |
|---|---|---|
| 1 | `launchctl kickstart gui/<uid>/io.github.taliesinb.brow` | `launchctl print` of that service succeeds |
| 2 | `open -g -b io.github.taliesinb.brow` (in the background) | LaunchServices finds the app |
| 3 | `<command> start` | always last; the only way for a custom daemon |

Ways 1 and 2 are tried only for the **default daemon**: no configured
`socket` or `home`, no `BROW_HOME` / `BROW_SOCKET` in the
server's environment, and no `BROW_CONFIG` (the server's or
`brow.env`'s). A custom socket, home or configuration can only be
served by a daemon the plugin spawns itself, so those go straight to 3
(`usesDefaultDaemon` in index.js, `startDaemon` in daemon-client.mjs; every
step is an async child process). `command` is `brow` on the
server's PATH by default, or a checkout's `bin/brow.mjs` (run with
the server's node); `start` starts a detached daemon and returns. Then the
plugin waits for the socket (`startTimeoutMs`, 15 s).

Which way worked is in the trace (`daemon-started { via: launch-agent | app
| command, how, attempts }`), in the server log (with the ways passed over
and why), and in front of the next tool result (`Started the brow daemon
via its LaunchAgent (launchctl kickstart …). `). When every way fails, the
error lists each attempt. The daemon outlives the DeepSea server, as
intended: it is shared by everything on the Mac that uses it. Starting
happens at startup (to learn the tools) and on a tool call, never from the
app-window routes or a background reconnect, so a daemon the person stopped
comes back only when an agent needs a browser.
## Images

The daemon returns captures inline (`{ type: "image", data, mimeType }`
blocks before the text). The plugin admits each into the harness's
attachment store under the same rule as the harness's MCP bridge (and
tool-browser-unified's `admitImage`, copied): only when the current model
declares image input (`llm.resolveModelInfo(provider, model)` of the agent's
routed request). The admitted refs are put in front of the result text by
the tools' `finalizeContent`. Otherwise the capture is written to
`$TMPDIR/deepsea-tool-brow-screenshot-<ms>-<pid>-<n>.<ext>` and the
text says `screenshot not shown inline (<why>); saved to <path>, view it with
read_image`. A `path` the model gives `browser_screenshot` is written by the
daemon itself, relative to the session's `cwd`.

## Notices

The daemon pushes `session.notice { session, text }` to the connection that
opened a session (lease `connection`, notices `push`), today when it closed a
session's idle windows (`[browser] Closed idle browser window(s) … after N
min without use. …`). The plugin injects the text into that agent as a
user-role message (`source: { kind: "deepsea-tool-brow" }`),
exactly as the in-process plugin did.

## The DeepSea app's window

The browser half (`src/client/index.tsx` → `lib/client.js`, tool-browser-
unified's with only its route names changed) relays the macOS app's window
reports and long-polls for `set-frame` requests; the root forwards them to
the daemon (`app-relay.mjs`):

| Route (below `/api`, behind DeepSea's authentication) | Daemon |
|---|---|
| `POST /api/deepsea-tool-brow/app-window` (JSON report) | `app.report { report }` |
| `GET /api/deepsea-tool-brow/app-command?pid=N` (≤ 20 s) | `app.poll { pid }` |

- Whether the daemon parks is in its `hello` (`parking: { enabled, reason }`,
  fixed for the daemon's life). With parking off the relay stops: nothing is
  sent to the daemon, and both routes answer 404 at once (`{ error, parking:
  false }`, the reason in `error`), which the browser half reads as "no
  parking here" (it stops reporting and asks again once a minute, so a daemon
  restarted with parking on is found).
- The latest report of each app is kept and replayed on every new
  connection to a daemon that parks, so a daemon started later (by the first
  tool call) learns where the app is without waiting for the window to move.
- Without a daemon a report is kept (202) and a poll waits out its 20 s with
  nothing to do; an empty poll answer that comes at once (a newer poll of the
  same app took over) is held for 1 s, so no page can spin.

## Tool rows

The browser half claims `browser_screenshot`, `browser_navigate`,
`browser_eval` and `browser_act` in the `tool.call.toolview` slot, as
tool-browser-unified does: the title names the browser from the result's
`[handle]` ("Chrome screenshot", "Safari navigate"), collapsed the handle and
what was done, expanded the captures at point size with a lightbox, then the
text. The daemon's result text has the same shape as the in-process plugin's,
so the row is unchanged.

It claims `browser_script` too, since a run's report can carry its failure
screenshot (the generic card would print that block as JSON): "Chrome script
run" (the browser from the report's headline; "Browser" when the run used
both), collapsed the headline (`run:17 · login.browser.js · passed in 1.2 s ·
3 calls · chrome`), running the action and the file or the source's first
line. A run that failed, errored or timed out is an error row and a
cancelled one a stopped row, though the call itself succeeded (the report is
its result). `browser_open`, `browser_close`, `browser_read` and
`browser_logs` return text only and keep the generic card.

## Why a vendored socket client

`daemon-client.mjs` is a ~200-line copy of what the plugin needs of the
daemon's `src/rpc.mjs` and `src/client.mjs` (framing, requests, `$/cancel`,
notifications, hello with the protocol check, autostart: the installed app first, then a command)
rather than a dependency on the `brow` package:

- The protocol is small, versioned (`hello.protocol`, refused when it
  differs) and language-neutral; the socket is the contract, not the code.
- Linking the package would tie every profile this plugin is installed into
  to a checkout path, and pull the daemon's own dependencies
  (chrome-devtools-mcp, the MCP SDK) into the DeepSea server's install for
  nothing.
- The daemon can be installed, upgraded and restarted on its own; a newer
  daemon with a new tool needs no plugin release.

The daemon's own names (its command, Brow.app's bundle id, the
LaunchAgent label, the default home's directory, the `BROW_*`
environment variables) are all in `daemon-names.mjs`, so a renamed daemon is
a change of that file alone; the plugin's own names (package, rows, routes,
service, the `brow` config key) are DeepSea's, defined where they are used.

What it leaves out: the code stamp (`hello.stamp` hashes the daemon's
sources; only a client in the same checkout can compare it). Replies are read
in chunks with a newline search over new data only, since an inline
full-page screenshot is one multi-megabyte line.

## Configuration

```yaml
- insert:
    - id: deepsea-tool-brow
      name: "@deepsea/tool-brow"
      config:                         # all optional, defaults shown
        brow:
          socket: ''                  # '' = <home>/run/daemon.sock when home is set, else the daemon's default:
                                      #   $BROW_SOCKET, else <daemon home>/run/daemon.sock
                                      #   (~/Library/Application Support/io.github.taliesinb.brow on macOS,
                                      #   $XDG_STATE_HOME/brow on Linux, or $BROW_HOME)
          home: ''                    # the daemon's home; also BROW_HOME for a daemon the plugin starts
          command: brow     # `<command> start`: a name on PATH, or a checkout's bin/brow.mjs
          autostart: true             # start the daemon when none answers (default daemon: LaunchAgent,
                                      #   then Brow.app, then the command; otherwise the command)
          env: {}                     # extra environment for a started daemon (e.g. BROW_CONFIG)
          startTimeoutMs: 15000
        trace: false                  # JSONL trace in the variant's log directory (@deepsea/logs)
    - id: deepsea-tool-brow-tools
      name: "@deepsea/tool-brow/tools"
      config:
        subagents: true               # delegated child agents get the tools too
```

Browser settings (default browser, headless Chrome, parking, idle minutes,
timeouts) are the daemon's: `<daemon home>/config.json`, shared by every
client. The trace records connections, sessions opened and closed, calls,
notices, tool lists and parking answers.

## Coexistence

`@deepsea/tool-browser-unified` registers the same tool names and drives
the same kind of windows in-process; `@deepsea/tool-browser` drives Safari
Technology Preview too. Run only one of the three in a variant. The root row
logs a warning when it sees `deepseaBrowserUnified` or `deepseaBrowser`.
Two tools rows in one preset would register the same tool names twice, which
the harness refuses.

## Limits

- No tools until the daemon has answered once since the server started.
- Inline images travel base64 over the socket even when the model cannot see
  them (the plugin then writes the file); harmless at screenshot sizes.
- A tool call interrupted by a daemon restart is not retried (it may have
  acted); the model is told.
- The app-window relay needs the DeepSea macOS app; elsewhere the browser
  half does nothing.

## What the daemon could add for this client

Found while writing it (protocol 1):

- **Parking state up front.** `hello` / `daemon.status` do not say whether
  the daemon parks (`safari.hiddenWindows`); with parking off `app.poll`
  answers `{}` at once, so a client must learn it from `app.report`'s
  `{ ok: false }` and guard against a spinning poll. A `parking: boolean` in
  `hello`, and `app.poll` refusing (or waiting) when parking is off, would
  remove that.
- **Window lifecycle notifications** (`session.windows { session, opened,
  closed }`), so the client could show or drop windows without parsing
  result text, and tell an agent precisely which windows a restart lost.
- **`session.open` per key on reconnect** works, but a daemon-side
  `session.resume { keys }` for many sessions at once would save round trips
  after a restart.
- **A `tools.changed` notification** instead of comparing `tools.list` on
  every connection.
- **Structured errors over the socket.** `tools.call` has a `structured`
  mode internally (`error.hint`, `handle`, `aborted`) that the protocol does
  not expose; a client could then mark cancellations as aborts rather than
  failures.
- **Stop replaced the new daemon's socket.** `brow stop` returns
  once the socket file is gone, which Node's `server.close()` does early;
  the stopping daemon later `rmSync`s the socket path at the end of its
  shutdown. A `stop` immediately followed by `start` (as `restart` does) can
  thus leave the new daemon running without a socket file (seen live:
  connected clients keep working, new ones cannot connect). The daemon should
  remove the path only if it is still its own (compare the inode), and
  `stop` should wait for the pid to exit.

## Development

```sh
pnpm install          # also builds lib/client.js (prepare)
pnpm test             # node:test, offline: tests/*.test.mjs
pnpm typecheck        # the browser half against the harness's declarations
```

`pnpm test` runs a fake daemon (`tests/fake-daemon.mjs`) on a temporary
socket and both rows on a fake host (`tests/fake-host.mjs`): the vendored
client (framing of multi-megabyte replies, notifications, `$/cancel`,
protocol mismatch, autostart through `tests/fixtures/fake-brow.mjs`
and its failures; the order LaunchAgent → app → command with a fake process
runner, and when it is skipped), the link (single dial, quick reconnects, hooks), the tools
as listed (names and schemas unchanged, argument validation, a changed list
registered again), sessions (key, title, cwd, update, re-open after a lapsed
lease or a restart, the restart note), images (inline for a vision model, a
file otherwise), notices, disposal and unload, cancellation, the app-window
routes, and the built browser half under a fake module loader.

Live, with a real daemon in a temporary home (headless Chrome; the first
call downloads Chrome for Testing into that home, about 190 MB):

```sh
H=$(mktemp -d /tmp/bs-ds-XXXX)   # short: Unix socket paths are limited to ~104 bytes
BROW_HOME=$H BROW_CONFIG='{"chrome":{"headless":true},"defaultBrowser":"chrome","daemon":{"exitWhenIdleSeconds":60}}' \
  node <brow checkout>/bin/brow.mjs start
cat > $TMPDIR/deepsea-tool-brow-patch.yml <<EOF
- id: deepsea-tool-brow
  config:
    brow: { socket: $H/run/daemon.sock, autostart: false }
    trace: true
EOF
pnpm dsd run release --throwaway-server --detach --scripted --plugins tool-brow \
  --patch $TMPDIR/deepsea-tool-brow-patch.yml
pnpm dsd drive -v <id> create-session --preset standard --title bs-check
pnpm dsd drive -v <id> prompt last - <<'EOF'
{"cmd":"tool","name":"browser_open","args":{"url":"data:text/html,<title>T1</title><h1>Hello</h1><button onclick=\"document.title='clicked'\">Go</button>"},"id":"open"}
{"cmd":"expect","value":"tools.open.text","contains":"Opened chrome:"}
{"cmd":"tool","name":"browser_act","args":{"steps":[{"action":"click","target":{"text":"Go"}}]},"id":"act"}
{"cmd":"tool","name":"browser_read","args":{"format":"markdown"},"id":"read"}
{"cmd":"expect","value":"tools.read.text","contains":"Hello"}
{"cmd":"tool","name":"browser_screenshot","args":{},"id":"shot"}
{"cmd":"say","text":"done"}
EOF
pnpm dsd stop <id>
BROW_HOME=$H node <brow checkout>/bin/brow.mjs stop; rm -rf "$H"
```

The scripted model declares no image input, so screenshots take the file
path there. Restarting the daemon between prompts (`stop`, then `start` with
`"idleMinutes": 1` in its config) shows the reconnect, the restart note and,
a minute later, the idle notice in the session's events. The app-window
routes can be tried with curl after logging in with the throwaway's token
URL (a report answers `{"ok":true}`, a poll waits 20 s).
