# @deepsea/tailscale

This variant on the tailnet, at

```
https://<node>.<tailnet>.ts.net/<serve path>/        /deepsea/ for release, /deepsea-<v>/ for another variant
```

- an **authenticating loopback proxy** (`proxy.mjs`) in front of DSH, which
  admits tailnet clients by Tailscale identity, a standing token or the
  token's cookie, and rewrites each request so DSH's own Host/Origin fence and
  cookie login are satisfied;
- the variant's own **Tailscale Serve path** (`tailscale.mjs`), published and
  removed by this plugin and never anyone else's;
- the **Tailscale** settings section: publish or remove the path, the
  addresses, a QR code carrying the standing token (Rotate), and the tailnet
  logins admitted without a token;
- the **Server** settings section: the variant's processes (relay, `dsh web`,
  the app) with restart, quit and launch, and who is connected;
- a **per-session QR button** in the session header;
- the **loopback-forward route** the DeepSea app on another Mac uses to reach
  this machine's dev servers (`forward.mjs`);
- the **`deepseaSessionOwners`** service: which tailnet login drives which
  session (`owners.mjs`).

Machine-wide (`"deepsea": { "machineWide": … }`): it adds and removes a
Tailscale Serve path, so `dsd run … --plugins all` leaves it out of throwaways
unless named. Requires the harness topic `embed-session` (the per-session
page).

## Where it runs

```
phone / another Mac / this Mac ─▶ https://<node>/deepsea-lab/
  └▶ tailscaled (TLS; Tailscale-User-Login) ─▶ relay 127.0.0.1:<block+3> (apps/relay)
       └▶ tailnet clients: proxy 127.0.0.1:<block+4> (this plugin) ─▶ dsh web 127.0.0.1:<block+0>
```

The relay hands a connection to the proxy when it comes through Tailscale
Serve (its last `x-forwarded-for` hop is a tailnet address) and to `dsh web`
otherwise; without this plugin it refuses tailnet clients (LAYOUT.md §6).

## Settings from the variant

With no config the plugin takes everything from the variant it runs in
(`variant.mjs`):

| Setting | From | Config key |
|---|---|---|
| proxy port | `$DSH_HOME/variant.yml` `ports` (the block) + 4 | `proxyPort` |
| Serve path | `variant.yml` `servePath`, when `serve: true` | `servePath` |
| Serve target | the relay, `DEEPSEA_RELAY` (set by the relay for the server it starts); else the proxy itself | — |
| cookie | `deepsea-tailscale-<v>`, `Path=<serve path>/` | — |
| tailscale CLI | `tailscalePath`, else PATH, then `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin` | `tailscalePath` |

A throwaway records neither a port block nor a Serve path, and a stock home
has no `variant.yml`: no Serve path, and a proxy only when `proxyPort` is
configured. Two more keys: `identityOperators` (default `true`, below) and
`loopbackForward` (`admitted` | `operators` | `off`, default `admitted`).
A later patch layer replaces the row's whole `config`:

```yaml
- id: deepsea-tailscale
  config:
    proxyPort: 41000
    servePath: /deepsea-test
```

State lives in `$DSH_HOME/plugins/tailscale/` (0700): `state.json` (0600:
whether the operator wants the path published, the allowed logins, the
standing token) and `session-owners.json` (0600).

## The Serve path

```
tailscale serve --bg --yes --https=443 --set-path=<path> <relay or proxy>
tailscale serve --https=443 --set-path=<path> off
```

At start the plugin publishes the path unless the operator removed it
(`state.json` `enabled: false`); Publish and Remove in the Tailscale section
change that wish. tailscaled keeps Serve config across restarts, so `serve
status --json` is the truth, and the section shows it:

| Status | Meaning |
|---|---|
| Published at `<path>` | the path points at this variant's relay (or proxy) |
| `<path>` points at … | it points at this variant, but at its other port (the proxy, from before a relay fronted the server): Publish re-points it |
| `<path>` is taken: … | it points somewhere else (another variant, another account on this Mac): never replaced or removed |
| Not published | no mapping on the path |
| No Serve path | a throwaway, `serve: false`, a stock home |
| Tailscale unavailable | the CLI is missing, tailscaled is unreachable, or Tailscale is not connected |

A mapping belongs to this variant only when it is loopback on its relay or
proxy port. Nothing here runs `serve reset` or touches Funnel; other paths
are never read for more than the status. Serve strips the path before
forwarding (`/deepsea-lab`, `/deepsea-lab/` and `/deepsea-lab/x?y` arrive as
`/`, `/` and `/x?y`), keeps the tailnet `Host`, adds `x-forwarded-for`,
`-host` and `-proto` and, for a device with a user, `Tailscale-User-Login`
(client copies are overwritten).

## How a request is admitted

First the same-origin fence: `Host` must be the tailnet name (with or without
`:443`) or the proxy's own loopback authority, else 421 (DNS rebinding); an
attached `Origin` must equal that Host, else 403. Then exactly one of:

1. **Tailscale identity.** `Tailscale-User-Login`, trusted only when the
   request looks like a Serve peer (loopback socket, the rightmost
   `x-forwarded-for` in `100.64.0.0/10` or `fd7a:115c:a1e0::/48`), and the
   lower-cased login is in the allowed list **or is this node's own login**
   (`tailscale status --json`; a tagged node has none). Serve injects the
   node's login for the node's requests to itself: the DeepSea app and a
   browser on this Mac get in with no token.
2. **The token.** `GET /?token=<standing token>` (the QR code) sets the
   proxy's HttpOnly cookie and redirects into `<serve path>/`, keeping every
   other query parameter (`?token=…&embed=<id>` → `<path>/?embed=<id>`). The
   token is 192 bits.
3. **The cookie** `deepsea-tailscale-<v>=<HMAC(token)>`, `Path=<serve
   path>/`, so variants sharing a tailnet name keep their own. Rotating the
   token signs out every device that used it; allowed logins are unaffected.

Everything else is 401; `/manifest.webmanifest` and `/favicon.svg` pass
anonymously (DSH serves them publicly too).

**Operators** are this node's own requests (the rightmost `x-forwarded-for`
is one of its tailnet addresses) and, with `identityOperators: true`, every
identity-admitted request: on a Mac shared by several accounts the person a
variant belongs to is not "the node itself". Token and cookie holders never
are. Only operators reach the control channel (others get 403, and the
sections say "Operators only."), and operators' index pages carry
`globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`, so Settings persist on
the host as they do on loopback.

Admitted requests go to `http://127.0.0.1:<dsh port>` with Host and Origin
rewritten to that authority, `sec-fetch-site: same-origin`, the browser's
cookies replaced by the DSH browser-session cookie the plugin obtained with
its own launch token (`ctx.connection.authenticatedUrl`, refreshed after 6 h
or a 401), Tailscale's headers removed and `x-forwarded-*` re-derived, plus
the headers other plugins read (plugins/AGENTS.md):

| Header | Value |
|---|---|
| `x-deepsea-tailscale` | `1` on every proxied request |
| `x-deepsea-tailscale-admitted` | `user`, `cookie` or `public` |
| `x-deepsea-tailscale-login` | the login, identity admissions only |
| `x-deepsea-tailscale-self` | `1` when the request is from this node itself |

Client copies of these are dropped. WebSocket upgrades take the same gate.
Index pages get a head script that turns `https://node/deepsea` into
`https://node/deepsea/`: both arrive as `/`, and without the slash the
shell's document-relative asset URLs would resolve at the site root.

**Threat model.** Any local process can connect to the loopback listener and
forge the identity headers; that is local access, which a local process has
anyway. The gate protects against the tailnet, not the machine.

## The control channel

`POST /deepsea-tailscale/<endpoint>`, a web-server route behind DSH's own
request gate (Host/Origin fence and browser-session cookie), with the
Connection envelope `{ type: 'client-request', rpcId, method, payload: {
args } }`: `status`, `enable`, `disable`, `set-users { allowedUsers }`,
`rotate-token`, `server-status`, `server-act { target, action }`. The proxy
forwards it for operators only.

## The Server section

- **Processes.** The relay, when `DEEPSEA_RELAY` names one: its LaunchAgent
  `<variant name>.relay` read with `launchctl print` (pid, running), and
  **Restart** = `launchctl kickstart -k`, which restarts the relay and the
  server it started (the page comes back through the relay's starting page);
  a throwaway's relay has no job and no action. **dsh web**: this process,
  **Quit** = SIGTERM to itself, and **Restart** (the same SIGTERM) only when a
  relay will start it again. **The app**, `~/Applications/<display name>.app`
  when installed: **Launch** (`open`) or **Quit** (`pkill -TERM -f
  <app>/Contents/MacOS/`). Restart and Quit ask once more inline. Installing,
  reinstalling or removing anything is `dsd`'s job (LAYOUT.md §6), so no
  button here can take down the server it runs in for good.
- **Clients.** Everyone who reached the server in the last 2 minutes, from a
  tracker on DSH's own `http.Server` (`ctx.webServer.server`; guarded): the
  tailnet login and address for proxied clients, `local` and the socket peer
  for direct ones, a short agent label (the DeepSea app's user agent ends in
  `DeepSea/<version>`), open `/api/remote.mux` WebSockets (live tabs), and the
  session of the last `POST /api/session/*` body, resolved to its workspace.
  The gateway sends `payload.args` keyed by parameter name
  (`session/prompt` → `{ args: { request: { sessionId, … } } }`), so the
  sniffer looks one level down.

## The `deepseaSessionOwners` service

DSH is single-user: a session carries no person. The tracker sees both the
login of every proxied request and the session id in every `POST
/api/session/<method>` body, so this plugin joins them for other host plugins
(optional; absent means a single-user machine):

```js
owners.of(sessionId)  // { owner, actor, first, last, logins } | undefined
owners.list()         // every attributed session
owners.selfLogin()    // this node's own login (what loopback requests count as)
owners.file           // where they are kept
```

`owner` is the login of the first request that drove the session
(`session/prompt`, `updateQueue`, `fork`, `selectModel`, `rename`; a look,
such as `attach`, becomes owner only if nobody ever drove it), `actor` the
latest driver. A request's identity: the proxied login; this node's own login
for direct loopback requests and this node's proxied ones; `token` for cookie
or QR clients. Attribution, not authorization.

## Per-session QR code

The QR button in the session header's utilities row opens a panel with a QR
code for the session on screen and one checkbox, **Only you** (ticked by
default). Clicking the code copies the link.

```
https://<node>/<path>/?embed=<sessionId>                   Only you: Tailscale identity admits the device
https://<node>/<path>/?token=<standing token>&embed=<id>   unticked: any device that scans gets in
```

`?embed=<sessionId>` is the chrome-less one-session page (harness topic
`embed-session`). It is a presentation, not a permission: a tokened link
admits the device to the whole GUI, exactly like the Settings QR code. The
URL and token come from `status` (operators only); elsewhere the panel uses
the document's own directory, token-less, and on a loopback page with nothing
published it says so. Not shown inside an embedded page itself. Session ids
keep their `session-` prefix. The code is rendered in the browser (`uqr`,
bundled).

## Loopback port forwarding

An agent here starts a dev server and prints `http://127.0.0.1:5173/`. In the
DeepSea app on another Mac that link names the other Mac's loopback. The app
(apps/macos, `PortForward.swift`) binds `127.0.0.1:<port>` there and opens
one WebSocket per TCP connection to

```
<serve path>/api/deepsea-tailscale/loopback-forward?port=<port>
```

through Serve and the proxy; the URL then works verbatim (Host header,
absolute paths, cookies, HMR socket). This side (`forward.mjs`, an
exact-path upgrade route behind DSH's own gate):

1. **Admission**, `loopbackForward`: `admitted` (anyone the proxy let in: a
   token holder already drives an agent with a shell here, so forwarding this
   account's ports adds nothing), `operators` (this node, and with
   `identityOperators` identity-admitted users), or `off`. A direct loopback
   caller (no proxy headers) passes.
2. **Reserved ports**: this variant's server, proxy and relay ports are 403.
3. **The uid guard**: `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcun` must show
   the listener and every visible one must belong to the uid running this
   server; other accounts' listeners are invisible to an unprivileged `lsof`.

Refusals are HTTP statuses before the 101 with the reason in
`X-DeepSea-Forward-Error`: `disabled`, `not-operator`, `not-admitted`,
`bad-port`, `reserved`, `nothing-listening`, `foreign-owner`,
`connect-failed`, `lsof-unavailable`, `too-many-connections`,
`not-websocket`. After the handshake a text frame
`{"type":"connected",port,pid,command}`, then binary frames both ways (own
RFC 6455 framing, no dependency); at most 64 connections, close code 1000 when
the target ends, 1011 on a target error, 1002 on a protocol error.

In the app on a tailnet (https) page, a plain click on a loopback link is
turned into `window.open` before the chat handles it (`installAppLoopbackLinks`):
the Sidebar Browser would load it as an `http://127.0.0.1` frame inside an
https page, which WebKit blocks as mixed content. On a loopback page nothing
is installed.

## Add workspace from any device

The bundle patch disables the web app's `directory-picker` row (the `-auto`
chooser, which on a loopback bind with a local display opens the native
folder dialog on this Mac's screen, out of reach from the tailnet) and
inserts `directory-picker-browse` and `ui-directory-picker-browse`, DSH's
in-app browser. Host rows: effective at the next server start. To get the
native dialog back, override in the profile's `cordis.patch.yml` (and do not
also insert those ids elsewhere: duplicate ids fail the boot):

```yaml
- id: directory-picker
  disabled: false
- id: directory-picker-browse
  disabled: true
- id: ui-directory-picker-browse
  disabled: true
```

## Develop

```sh
pnpm install && pnpm build      # lib/client.js
pnpm test                       # node:test; never the real tailscale CLI
pnpm typecheck
```

The tests run the Serve manager against `tests/fixtures/fake-tailscale.mjs`,
a stand-in CLI that keeps its state in a JSON file beside it and fails on
anything but status, `--set-path` and `off`; the proxy and forward route
against fake backends and listeners of their own; the Server section's
`launchctl`, `ps`, `pkill` and `open` through an injected runner. End to end
in a throwaway, with the fake CLI and a test path:

```yaml
# patch.yml
- id: deepsea-tailscale
  config:
    proxyPort: 41000
    servePath: /deepsea-test
    tailscalePath: /path/to/scratch/tailscale   # a copy of tests/fixtures/fake-tailscale.mjs
```

```sh
node tools/dsd/bin/dsd.mjs run release --throwaway-app --detach --plugins tailscale --patch patch.yml
curl -H 'Host: node.example.ts.net' -H 'X-Forwarded-Proto: https' \
     -H 'X-Forwarded-For: 100.100.100.1' -H 'Tailscale-User-Login: user@example.com' \
     http://127.0.0.1:41000/
```

## Limits

- Tailscale facts (the node's name, own login and addresses) are read at start
  and then every minute until known, every ten minutes after; until then the
  fence knows no tailnet name and tailnet requests get 421.
- iOS "Add to Home Screen" keeps its own cookie store, and the saved URL is
  the one after the exchange, without the token.
- The token is a credential: whoever holds it drives an agent that runs
  commands on this machine.
