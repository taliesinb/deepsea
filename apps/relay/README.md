# apps/relay — the front door of an installed variant

`relay.mjs` is the always-listening process every installed variant runs
(LAYOUT.md §6): its LaunchAgent (`<variant name>.relay`) starts it through the
variant's server host (on Linux its systemd user unit,
`<variant name>.relay.service`, starts it directly), and it starts `dsh web` on the first connection. Opening
the app, or the variant's tailnet URL, is therefore all it takes to bring a
variant up, and the server can quit or restart (`/reboot`, `/restore`) without
anyone starting it again by hand. Plain Node, no dependencies beyond
`packages/logs`.

```
node relay.mjs --variant <v> --home <DSH_HOME> --listen 127.0.0.1:<block+3>
               --dsh 127.0.0.1:<block+0> [--proxy 127.0.0.1:<block+4>]
               --log-dir <variant log dir> [--cwd <dir>] -- <dsh web argv…>
```

`dsd build <v> --install` writes this command into the LaunchAgent (macOS) or
the systemd user unit (Linux); `dsd run <v> --throwaway` runs it as a child
process.

## Routing

Each connection is routed by its first request:

| Client | Goes to |
|---|---|
| Tailscale Serve (the last `x-forwarded-for` hop is a tailnet address, or a `tailscale-user-login` header) | the tailscale plugin's proxy (`--proxy`), which admits it by Tailscale identity or its own token; without `--proxy`: 403 |
| anything else (this machine: the app's fallback URL) | `dsh web` itself (`--dsh`), whose own login admits it |

While the target is down, the relay starts `dsh web` (unless a proxy is down
while `dsh web` is up, which means the plugin is off: then 503 `no-proxy`) and
answers 503 with `x-deepsea-relay: starting`, `Retry-After: 2` and, for a
page load, a page that polls and reloads itself once the header is gone. Five
starts in a row that exit within 30 s without the server ever answering stop
the retries (`x-deepsea-relay: failed`, with the server log's path) until the
next successful start.

## Login

The relay keeps the variant's standing token in `<home>/relay/state.json`
(0600; created on first start; the app's token file) and starts `dsh web` with
it as its launch token (`DSH_LAUNCH_TOKEN`, harness topic `launch-token`). So
`http://127.0.0.1:<block+3>/?token=<standing token>` always logs in, through
DSH's own exchange, and DSH's persistent cookie then admits the client across
restarts.

## The server process

`dsh web` runs through the person's login shell (`$SHELL -lc 'exec "$@"'`), so
agents get the person's PATH. A `$SHELL` that is not a POSIX shell (nu, fish:
they read `-lc` and `"$@"` their own way), unset or missing gives way to the
first of `/bin/zsh`, `/bin/bash`, then bash and zsh on PATH (NixOS has
neither under `/bin`),
else `/bin/sh`; the relay's log names the shell and why. It runs detached in
its own process group, with
`DSH_HOME`, `DSH_LAUNCH_TOKEN`, `DEEPSEA_VARIANT` and `DEEPSEA_RELAY` (this
relay's URL: plugins such as `reboot` know a relay will start the server again)
set. Each start gets its own run log, `server/<ts>-<pid>.log`; the relay's own
log is `relay/<ts>-<pid>.log` (LAYOUT.md §5). SIGTERM (`launchctl bootout`,
`kickstart -k`, `systemctl --user stop`) stops the relay and the server's whole process group, SIGKILL
after 15 s.

## Tests

`node --test tests/*.test.mjs`: routing, the relay's page, the failure streak,
and a real start of a fake server through the login shell.
