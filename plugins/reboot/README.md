# @deepsea/reboot

`/reboot` restarts **this** DeepSea server (`dsh web`) from inside a session:
a graceful SIGTERM to its own process, with a confirmation dialog that lists
what a reboot would interrupt and can wait until nothing is running.

```text
/reboot            the dialog (bare command, `/reboot ` + Enter, or the slash menu)
/reboot status     one line: what is busy, whether a reboot is armed, what the relay does
/reboot now        interrupt whatever is running and reboot
/reboot if-idle    reboot only if nothing is in flight right now, else say what is
/reboot wait       arm: reboot once every session has been idle for 2 s
/reboot cancel     drop an armed reboot
```

In the dialog Enter is **Reboot now** and Escape is **Cancel**. Without the
browser half the bare command answers like `/reboot status`.

Every form runs as a host command, so the transcript keeps a `command/run` +
`command/done` pair and its one-line result: what the command did, and what
happens after the SIGTERM.

## Restart or quit

Whether a reboot is a restart depends on what started the process. An
installed variant's relay (apps/relay) starts the server and sets
`DEEPSEA_RELAY` to its own URL; it starts the server again on the next
connection, and the page comes back. Without a relay the server just stops
and has to be started again by hand. The reply and the dialog say which:

| Relay facts | Verdict |
|---|---|
| `DEEPSEA_RELAY` set and the relay answers | Relay running: the server comes back up on the next connection |
| `DEEPSEA_RELAY` set, nothing answers there | Relay not answering: the server will not come back up automatically |
| no `DEEPSEA_RELAY` (started by hand, a throwaway without a relay) | No relay: the server will not come back up automatically |

The facts are a 1 s TCP check of the relay's address, cached for 5 s across
polls.

## The dialog

Only what changes the decision:

- the relay verdict, only when it is bad news (red for a quit, amber for
  unknown); a running relay says nothing;
- **Safe to reboot** when no session has work in flight; otherwise **Rebooting
  now would interrupt:** and the busy sessions, polled once a second, each
  with its sidebar title, working directory and blockers: *a turn is
  running*, *N queued messages*, *N background jobs: labels*, *N subagents
  loaded, k running* (the blockers the Host names when it refuses to move a
  live session, plus the queue). "(this session)" marks the one the command
  came from; a subagent row names its parent;
- an armed when-idle reboot, with the time and session it was armed from.
  Arming is host-side, so it survives closing the dialog or the tab and every
  client sees it.

Buttons: **Cancel** · **Reboot when idle** (only while something is busy) ·
**Reboot now** (red when it interrupts). While armed: **Close** · **Cancel**
(drops the armed reboot) · **Reboot now**.

After firing, the dialog stays up ("Rebooting DeepSea…") and brings the page
back: once a status poll fails (the process is gone) it pokes the relay's
loopback URL every 2 s and probes its own origin, reloading as soon as that
answers with anything but the relay's 503 splash. The poke matters for a page
served straight from the server's port: the relay starts the server on the
next connection to *it*. With no relay the dialog says the server will not
come back up.

## Control routes

`POST /deepsea-reboot/<endpoint>` with the Connection JSON envelope
(`{ type: 'client-request', rpcId, method: <endpoint>, payload: { args } }`,
answered by `{ type: 'server-response', rpcId, result }`), behind DSH's own
request gate (`connection.requestRejection`: the Host/Origin fence and the
browser-session cookie). The browser half reaches them document-relative
through `connection.rpc.call('/deepsea-reboot', …)`.

| Endpoint | Does |
|---|---|
| `status` | busy sessions with their blockers, armed state, relay facts and verdict, `{ pid, port, uptimeSeconds, home }` |
| `now` | reboot now |
| `if-idle` | reboot if nothing is in flight; otherwise `ok: false`, code `deepsea-reboot/busy`, `details.busy[]` with the blockers (`turn` / `queue` / `jobs` / `subagents`) and the status |
| `wait` | arm the when-idle reboot |
| `cancel` | drop it |

`if-idle` is the question a redeploy asks every server: restart if that
interrupts nothing, otherwise say why not. It never arms and never
interrupts.

## Caveats

- Interrupted sessions resume cold on the new process, like a forced move: a
  pending question or approval in them is lost and has to be asked again.
- The SIGTERM follows 400 ms after the reply, so `command/done` and the
  route's response land first. It is the server's ordinary graceful shutdown,
  the same one the relay uses.
- In a framed remote session (@deepsea/remote-workspaces) or an app connected
  to another machine's server, `/reboot` restarts the server the page is
  connected to: the remote one.

## Files

| File | Half | Role |
|---|---|---|
| `reboot.mjs` | host, no Cordis | `busySessions()`, `describeBlockers()`, `parseArgs()`, `relayVerdict()`, `RebootController` (arm / cancel / now / if-idle; 1 s poll, 2 s idle grace) |
| `index.js` | host | the `/reboot` command, the control routes, the optional relay service |
| `src/client/index.tsx` | browser | `commandUi.decorate({ name: 'reboot', ui: { kind: 'action' } })`, the dialog in the `shell.overlay` slot |
| `src/client/dialog-keys.ts` | browser | Enter presses the dialog's default button; identical in every plugin with such a dialog |
| `build.mjs` | | esbuild → `lib/client.js` in the shell's module-loader wrapper |
| `cordis.patch.yml` | | bundle patch inserting the `deepsea-reboot` row |

## Requirements

Harness topics `command-claim-decoration` (`/reboot ` + Enter opens the
dialog like the bare command, instead of running `/reboot status`) and
`modal-width` (the dialog's width).

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
pnpm watch    # rebuild lib/client.js on save (hot-swaps every browser running it)
```

`pnpm install` needs the repository's `harness` link (`dsd link`). The host
half needs a server restart after a change. Try it in a throwaway (`dsd run
release --throwaway-app --scripted --plugins reboot`): a throwaway has no
relay, so a reboot ends its server.
