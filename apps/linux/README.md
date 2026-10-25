# apps/linux — DeepSea for Linux

A desktop window (Electron) on one DeepSea server's web GUI, usually another
machine's on the tailnet, with that machine's loopback ports forwarded here:
when an agent there prints `http://localhost:5173/`, the link works in this
window and in your browser. It is a thin client. Nothing of DeepSea runs here:
the agents, the model calls and the files all stay on the server.

The macOS counterpart is `apps/macos` (one app per installed variant). This
client is not tied to a variant; it connects to any server.

## Running it

With Nix (flakes enabled), from a checkout or straight from the repository:

```sh
nix run 'git+file:.?dir=apps/linux'                        # in a checkout
nix run 'github:taliesinb/deepsea?dir=apps/linux' -- <host>  # without one
nix profile add 'github:taliesinb/deepsea?dir=apps/linux'  # installs it, with a desktop entry
```

The flake (`x86_64-linux`, `aarch64-linux`) supplies Electron, `xdg-utils`, and
a fallback `tailscale` CLI. The system's own CLI comes first on PATH, because it
matches its daemon. The package installs `bin/deepsea-client`, the desktop
entry `io.github.taliesinb.deepsea.desktop` ("DeepSea") and its icon.

Without Nix, you need an Electron of your own (a distribution package, or
`npm install -g electron`) and `xdg-open` and `tailscale` on PATH. From the
repository root:

```sh
electron apps/linux [<server>]
```

`apps/linux` imports `packages/logs` by relative path, so run it from a
checkout, not from a copy of the directory alone. A graphical session and a
connected Tailscale are prerequisites; the client starts neither.

## Choosing the server

```
deepsea-client [<server>] [--setup] [--name <name>] [--color <#rrggbb>]
```

Without a server, the client opens the saved one, else a connection form.
**File ▸ Change Server…** brings the form back. Typed forms are the same as in
the Add remote dialog of @deepsea/remote-workspaces (`resolve.mjs`):

| typed | becomes |
|---|---|
| `host` | `https://host.<magic-dns-suffix>/deepsea/` (the release variant's Serve path) |
| `user@host` | `https://host.<magic-dns-suffix>/deepsea-user/` (that account's release variant on a shared machine) |
| `host/deepsea-lab` | `https://host.<magic-dns-suffix>/deepsea-lab/` |
| `host.example.ts.net` | `https://host.example.ts.net/deepsea/` |
| `box.example.com:8443/x` | `https://box.example.com:8443/x/` |
| `localhost:3203`, `127.0.0.1:3203`, `[::1]:3203`, an IPv4 literal | `http://` added |
| `https://…/deepsea-x/?token=…` | the URL, with the token used once (below) |

The MagicDNS suffix comes from `tailscale status --json` (`MagicDNSSuffix`,
else the tail of `Self.DNSName`). It is needed because the Serve certificate
names the full name. Plain `http://` is refused except for loopback and IP
addresses.

**Admission** is the server's own (@deepsea/tailscale). There are two ways in:

- **Tailscale identity.** The server admits this device's tailnet login: its
  operator's own login, or one in its allowed list. Nothing is configured
  here. A tagged device has no login, so it needs the token.
- **The standing token.** Give the URL with `?token=…` (the server's Settings
  ▸ Tailscale QR code). The first load exchanges the token for the server's
  cookie, which stays in this server's browser store. The token itself is
  never saved.

`--name` and `--color` give this server's window an identity of its own: the
sidebar wordmark, the whale and the window title, as the macOS app shows its
variant. Without them, the server's own branding (@deepsea/variant-identity)
shows through. Both are saved with the server, and `''` clears them.

## What it does

- **Entry.** On every launch and **Reconnect** the client probes the mount
  URL. Any HTTP answer counts, because a relay answers 503 while its server
  starts. With no answer, an offline page retries every 5 seconds. A main-frame
  error status shows the client's failure page, except the relay's own pages
  (`x-deepsea-relay`: starting, failed), which show as they are.
- **Page identity**, set at document start by the preload, in the page's own
  world, as the macOS app does:
  `globalThis.__DEEPSEA_APP__ = { name, glyphColor, view, openExternal }`.
  @deepsea/login opens sign-in pages through `openExternal`, and
  @deepsea/tailscale's `installAppLoopbackLinks` keys on the object's
  presence. In Mobile view it also sets `<html data-deepsea-view="mobile">`.
  With a name or colour, a style renames the wordmark and colours the whale
  (the selectors of the macOS app's `desktop-branding.js`). "DSH Local Build"
  in the window title becomes the name, or "DeepSea".
- **Links.** The server's own pages (same origin, under the mount path) stay in
  the app; `window.open` of one opens a second window. Everything else opens in
  the default browser (`xdg-open`). `openExternal` takes `http`, `https` and
  `mailto` only. The user agent ends in `DeepSea/<version>`, which the
  server's Server section shows.
- **Loopback forwarding**, below.
- **View ▸ Desktop / Mobile**: Mobile resizes the window to 390×844 and sets
  the attribute live.
- **Forwarded Ports** lists the forwards. Each has Copy URL and Close; there is
  also Close All.
- **Files** live under the bare root, because the client is not a variant
  (LAYOUT.md §1: machine-wide things use `io.github.taliesinb.deepsea`). They go
  in a `client/` component directory, beside the root's `installer/` and
  `builds/` logs:

  ```
  ${XDG_CONFIG_HOME:-~/.config}/io.github.taliesinb.deepsea/client/
    client.json                 the server, its name and colour, the view (0600)
    Partitions/server-<hash>/   one persistent browser store per server URL
  ${XDG_STATE_HOME:-~/.local/state}/io.github.taliesinb.deepsea/client/
    <ts>-<pid>.log, latest.log  a run log per launch: entry, navigation errors,
                                console errors, forwards, external opens
  ```

  One launch runs at a time: a second launch focuses the first.

## Loopback forwarding

A loopback URL on the page (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`,
`0.0.0.0`) names the **server's** loopback. Its port is forwarded with
@deepsea/tailscale's protocol (`plugins/tailscale/forward.mjs`, README
"Loopback port forwarding"). Each TCP connection becomes a WebSocket to
`<mount>api/deepsea-tailscale/loopback-forward?port=<n>`, carrying the page's
cookies. A refusal is an HTTP status with `X-DeepSea-Forward-Error`. Otherwise
the server sends a text frame `{"type":"connected",port,pid,command}`, followed
by binary frames both ways.

- The first use of a port probes it once (the handshake and `connected`, then
  a close), then listens on `127.0.0.1:<port>` here. When that port is taken,
  any free port is used instead. Listeners bind loopback only, and close on
  Close, on quit, or after an hour without connections.
- **Inside the window**, nothing is rewritten. The window's session sends
  loopback destinations, and only those, to a small HTTP proxy
  (Chromium's `*;<-loopback>` bypass rule, with the server itself direct).
  The proxy hands each request or CONNECT to the matching listener. So an
  iframe of a dev server keeps its URL, its Host header, its absolute paths and
  its hard-coded HMR socket, even on a remapped port.
- **Links out** (a `window.open`, a foreign navigation, `openExternal`) go to
  the default browser at the forwarded address: `http://127.0.0.1:<local
  port>/…` when the port was remapped. A dev server that hard-codes its port in
  its HMR socket then works only inside the window.
- The server's own port (`reserved`) means the GUI itself: the client opens the
  matching page under the mount instead. Other refusals raise an alert naming
  the reason, at most once per port every 30 seconds: `nothing-listening`,
  `foreign-owner`, `disabled`, `not-operator`, `connect-failed`,
  `lsof-unavailable`.
- @deepsea/tailscale's `installAppLoopbackLinks` turns a plain click on a
  loopback link in an `https` page into `window.open` when `__DEEPSEA_APP__`
  is set, because WebKit blocks that frame as mixed content. Here such a click
  therefore opens the default browser, as in the macOS app, even though
  Chromium would load `http://localhost` in a frame.

There are no npm dependencies. `websocket.mjs` is the RFC 6455 client: masked
frames, text and binary, fragmented reads, ping/pong and the closing
handshake, with backpressure both ways.

## Security

Every window is `sandbox: true`, `contextIsolation: true`, without Node and
without `<webview>`. The one preload gives three kinds of page different things:

- **The server's pages** (scope checked again in the main process) get
  `__DEEPSEA_APP__` and one bridged function,
  `__DEEPSEA_APP_NATIVE__.openExternal`.
- **The app's own pages** (`pages/`) get `deepseaClient`: connect, retry,
  change server and details. Each IPC call checks the sender's frame URL.
- **Every other page** gets nothing.

Permissions are denied except clipboard writes, fullscreen and loopback
network access, for the server and loopback pages. TLS verification is never
relaxed.

## Files

| File | Role |
|---|---|
| `main.mjs` | the main process: server choice, windows, entry/offline/failure pages, link policy, menus, view, IPC |
| `preload.cjs` | the document-start identity and the app pages' bridge |
| `forward.mjs` | the forwards, the piping, the loopback proxy |
| `websocket.mjs` | the WebSocket client |
| `resolve.mjs` | typed server → mount URL, MagicDNS suffix, scope |
| `paths.mjs` | config and log locations, the config file, per-server partitions |
| `pages/` | the connection form and the offline/failure page |
| `icon.svg` | the harness whale (`apps/web/public/favicon.svg`) on a tile |
| `flake.nix`, `flake.lock` | the package, the desktop entry, the checks |

## Development and tests

```sh
cd apps/linux
npm test                                         # node --test tests/*.test.mjs
xvfb-run -a electron tests/electron-smoke.mjs     # or plain `electron …` in a desktop session
nix flake check 'git+file:../..?dir=apps/linux'  # both, in the build sandbox
```

- **`tests/websocket.test.mjs`**: the handshake and its accept check, masked
  frames, fragments, ping/pong, close, refusals, timeouts, and a 3 MiB frame
  arriving in 1 KB chunks.
- **`tests/forward.test.mjs`**: against a fake host (`tests/fake-host.mjs`, its
  own server-side framing, itself checked against Node's built-in WebSocket).
  It covers refusal codes, cookies and user agent, one probe for concurrent
  ensures, a remapped listener, 8 MiB echoed through a forward, 24 concurrent
  connections, close, idle expiry, and the proxy's plain requests, CONNECT,
  refusals and redirect of the server's own port.
  `DEEPSEA_FORWARD_HOST=<checkout>/plugins/tailscale/forward.mjs` runs the same
  tests against the shipped server half.
- **`tests/electron-smoke.mjs`**: the real app from its connection form against
  a fake server. It checks proxy routing; that identity and branding are
  present at document start under a CSP without `unsafe-eval`; that there is
  no Node in the page; the window title and user agent; an iframe dev server
  with its HMR socket through a remapped forward; a foreign link,
  `openExternal` with its scheme filter and a loopback link; the refusal alert;
  reload; Mobile view; a relay page; the failure page and Reconnect; the saved
  config and the run log; and the offline page. It runs with `--hold-external`,
  so external opens and alerts are recorded rather than shown, and in a
  temporary `XDG_CONFIG_HOME`/`XDG_STATE_HOME`. Inside the Nix build sandbox it
  needs `--no-sandbox`, because Chromium's sandbox cannot nest there; the
  installed app never passes it.

## Not yet

- No offline fallback to a local relay with a token file (the macOS app's
  `fallbackUrl`/`tokenFile`): a variant installed on this Linux machine is
  `dsd`'s business.
- No integrated title bar, window materials, snapshots or automation channel
  (the macOS app's test-build machinery); window size and position are not
  remembered.
- `aarch64-linux` builds but has not been run.
