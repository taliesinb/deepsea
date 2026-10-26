# apps/macos — the DeepSea macOS app and server host

A native window (WKWebView) around one variant's DeepSea web GUI. Its bundle
id is the variant name and its file name the display name (LAYOUT.md §1):
`DeepSea.app` is `io.github.taliesinb.deepsea.release`, `DeepSea
Personal.app` is `io.github.taliesinb.deepsea.personal`, and a throwaway is
`DeepSea 3f9a1c.app`. Each app therefore has its own cookies, window
position, preferences and logs.

| File | Role |
|---|---|
| `Sources/main.swift` | the app: entry points and the offline page, link handling, the integrated title bar, View ▸ Desktop / Mobile and Window Material, Settings… (⌘,), menus, downloads, the run log |
| `Sources/Automation.swift` | the automation channel of test builds (below) |
| `Sources/Snapshots.swift` | window and element snapshots |
| `Sources/PortForward.swift` | loopback links of a remote server and sign-in callbacks, forwarded to this Mac |
| `Sources/Paths.swift` | the variant's log directory and snapshot store |
| `Resources/desktop-branding.js` | the page-side identity: wordmark, whale colour, window title |
| `Resources/element-inspector.js` | `__DEEPSEA_INSPECT__`: describe or pick an element (selector, rect, styles, slots, React chain, accessibility) |
| `ServerHost/main.swift` | the server host (`DeepSea[ <V>] Server.app`): spawns the relay and forwards signals, so macOS charges agents' privacy prompts to the variant (below) |
| `Tools/make-icon.swift` | renders the glyph on a macOS tile, every iconset size |
| `Tools/ax-drive.swift` | drives one app's menus by pid through Accessibility (manual tests) |
| `build.mjs` | compiles and assembles one variant's app, and installs its server host |

## Building

```sh
node apps/macos/build.mjs --out <dir> --name "DeepSea Personal" \
  --bundle-id io.github.taliesinb.deepsea.personal --glyph <harness>/apps/web/public/favicon.svg \
  --glyph-color '#30A46C' --url https://<node>.example.ts.net/deepsea-personal/ \
  --fallback-url http://127.0.0.1:3213/ --token-file <home>/plugins/tailscale/state.json
```

It needs the Command Line Tools' `swiftc` (no Xcode). The executable and the
icon renderer are compiled once per source hash into `<cache>/macos-<12
hex>/` (`--cache`; `dsd` uses `~/.deepsea/_builds`), so every variant and
throwaway reuses them and assembling a bundle takes under a second. The
glyph is the harness's own whale (`apps/web/public/favicon.svg`), recoloured
per variant. The bundle carries `Contents/Resources/deepsea-app.json`: the
name, the URL, an optional fallback URL with the token file whose standing
token it uses, and the glyph colour. It is signed ad hoc, with the bundle id
as its identifier.

The app loads the URL when it answers at all (the relay's 503 while the
server boots counts), else the fallback URL, else an offline page that
retries. A 421 from the URL (the variant's Tailscale fence refusing that
name, as just after a tailnet switch) counts as no answer, at launch and on
any later page load, so the window goes to the local relay rather than an
error page; `[probe]` and `[navigation]` lines in the app log say so.

## The server host

`DeepSea[ <V>] Server.app` (bundle id `<variant name>.server`, background
only) is the program a variant's LaunchAgent runs (LAYOUT.md §6):
`deepsea-server-host <program> [args…]` spawns the relay and stays its parent,
forwarding TERM, INT, HUP, QUIT, USR1 and USR2 and exiting with its status
(127 when it cannot start it). macOS charges a process's privacy requests to
its responsible process, for a launchd job the job's executable, inherited
through `posix_spawn`: so every agent subprocess asks as "DeepSea <V>
Server", and Full Disk Access can be granted to that bundle. Exec'ing instead
would hand the identity back to Node. Its Info.plist declares the usage keys
macOS needs before it will ask at all.

```sh
node apps/macos/build.mjs server-host --dir "~/Library/Application Support/<variant name>" \
  --name "DeepSea <V> Server" --bundle-id <variant name>.server [--icon AppIcon.icns]
```

dsd runs this during `dsd build <v> --install`. The bundle is assembled and
signed beside the installed one and swapped in only when its code-directory
hash differs: macOS ties privacy grants to that hash, so reinstalling the
same code keeps them.

## Loopback ports of the server's machine

On another machine's server, a loopback address the page shows (a dev
server's `http://localhost:5173/`) names that machine's loopback, so the app
forwards the port before it loads or opens one (`Sources/PortForward.swift`;
the server half is @deepsea/tailscale's loopback-forward route): one
WebSocket per TCP connection to `<mount>api/deepsea-tailscale/loopback-forward`,
on the same local port when it is free here, else another, listed in View ▸
Forwarded Ports.

- **The asking page's server.** `__DEEPSEA_APP__.openExternal` is in every
  frame, so the app knows which page asked: the app's own GUI, or another
  server's session framed through remote-workspaces
  (`<mount>deepsea-remote-workspaces/servers/<id>/`, whose egress passes the
  forward route on). A forward goes through that page's server. A frame of any
  other origin (a dev server, a site in the sidebar browser) is not answered.
- **Sign-in callbacks.** A sign-in page whose `redirect_uri` is a loopback
  address (pi-ai's Anthropic flow: `http://localhost:53692/callback`) has its
  callback listening on the server's machine. When that is another machine,
  the app forwards exactly that port, for one use, then opens the page; the
  listener closes a moment after the callback has gone through, or after ten
  minutes, so it never holds the port against a later sign-in here. When the
  port is taken here, the sign-in is this Mac's own (pi-ai binds before it
  hands out the page), and the page just opens. If the forward fails anyway,
  the sign-in's own fallback remains: `/login <flow> <address>` (@deepsea/login).
- Forwards carry the window's cookies (an `--ephemeral` test build's own
  store), so a server reached on loopback admits them by its session cookie,
  and one on the tailnet by Tailscale identity.

## Test builds

`dsd run <v> --throwaway-app` builds a throwaway's app into
`$TMPDIR/deepsea-app-<id>/` and starts its executable directly (no `open`,
no LaunchServices launch) with:

| Flag | Effect |
|---|---|
| `--url <url>` | load this URL (the throwaway server's login URL) instead of the configured entry points |
| `--ephemeral` | a non-persistent WebKit store and in-memory preferences: nothing is kept under `~/Library` except the run log |
| `--hidden` | an invisible (1% opaque), click-through window that floats above other windows without ever taking focus, and no Dock tile; the page keeps running and rendering. With `--automation` it never opens anything outside itself (links, sign-in pages, Preview): the automation's `opened` lists them |
| `--automation <socket>` | the automation channel on this Unix socket (mode 0600) |
| `--downloads <dir>` | save downloads here instead of `~/Downloads` (dsd: the throwaway's `<home>/downloads`) |

An installed app gets none of these. When the throwaway goes, `dsd` quits
the app, unregisters the bundle from LaunchServices (running it registered
it), deletes it and removes everything under `~/Library` with its bundle id.

## The automation channel

One JSON object per line on the socket, each answered by one line:

```
→ {"id": 1, "op": "click", "text": "Settings"}
← {"id": 1, "ok": true, "value": {"x": 140, "y": 866, "clicks": 1, "hit": "span.U-KWbq_triggerLabel"}}
```

`dsd drive` and `dsd script` are its clients (tools/dsd/README.md). The
operations are listed in the header of `Sources/Automation.swift`: `hello`,
`load`, `reload`, `wait-page`, `eval`, `resize`, `view`, `appearance`,
`click`, `type`, `describe`, `snapshot`, `window-info`, `log`, `opened`, `quit`.

- **Input is real.** `click` and `type` post AppKit mouse and key events to
  the web view, so the page sees the full `pointerdown` … `click` sequence
  and trusted key events, as from a person; synthetic DOM events are not
  used. Each event is handed over only after the page has handled the
  previous one, so a `type` has finished when it answers. A command chord
  (`cmd+a`) reaches the page's `keydown` listeners first; one the page leaves
  alone runs its Edit menu command, as in a browser, even in the hidden
  window, which is never key. `click --text`
  picks the innermost visible element showing that text (exactly, else
  containing it), optionally within a selector.
- **Snapshots** come from `WKWebView.takeSnapshot`, which needs no Screen
  Recording permission and works for the hidden window; the window material
  behind the page shows as a flat fill. Running CSS animations are finished
  first: macOS pauses a page's animations while its window is covered or the
  screen is locked, which would otherwise freeze a capture mid-fade.
- Page operations fail with `offline` while the offline page shows.

A response from the relay (`x-deepsea-relay`: `starting`, `failed`,
`no-proxy`) is shown as the page it is; the "starting" page reloads itself
once the server answers. Any other main-frame error status shows the app's
own failure page.

## Logs

`~/Library/Logs/<variant name>/app/` (LAYOUT.md §5): one `<ts>-<pid>.log`
per run, its first line naming the run, `latest.log` pointing at the newest;
page errors, failed requests and the app's own events. Snapshots go to
`app/snapshots/`, their images stored once by content hash. `kill -USR1
<pid>` saves a window snapshot, `kill -USR2 <pid>` starts an element pick,
`kill <pid>` quits like ⌘Q.
