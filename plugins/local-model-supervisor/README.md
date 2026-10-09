# @deepsea/local-model-supervisor

Local model servers hosted by DeepSea itself: started when a session needs
them, reused across sessions, and stopped once no session does. The default
configuration runs AFM, the OpenAI-compatible server for Apple's on-device
Foundation model, behind the `apple` provider, so it never has to be started
by hand or kept alive by a terminal.

A model server is a machine-wide resource: every variant on the machine
talks to the same port. The package says so (`"deepsea": { "machineWide": … }`),
so `dsd run … --plugins all` leaves it out of throwaway variants.

## Behaviour

| Situation | What happens |
|---|---|
| A session selects a model whose provider a server carries | The server is started (one start at a time) and polled until its health URL answers 2xx |
| Another session (or variant) uses the same provider | The running server is reused; no second process |
| The server is already healthy when first needed (started by hand, by launchd, or by another variant) | **Adopted**: used, and never stopped by this plugin |
| Idle past `idleMinutes` and no live session selects its providers | An owned server gets SIGTERM, then SIGKILL after five seconds |
| The server exits or crashes | Logged; it starts again on the next matching activity |
| The plugin unloads or DeepSea shuts down | Owned servers are stopped; adopted ones are left alone |

A start is triggered by `model/selection` (the model was picked, so warm-up
begins before the first message) and kept fresh by `request/header` (every
request). Owned servers are checked for idleness once a minute.

## Configuration

```yaml
servers:
  - id: afm                     # unique name: logs and messages
    providers: [apple]          # llm provider ids whose traffic it serves
    command: afm                # executable, found on PATH; spawned without a shell
    args: ['--port', '9997']
    healthUrl: http://127.0.0.1:9997/v1/models   # 2xx = healthy; must not need authentication
    idleMinutes: 15             # stop window; 0 or absent: never idles out
    startupTimeoutMs: 90000     # spawn-to-healthy deadline (default 60000)
    env: {}                     # extra environment for the server
    logDirectory: /abs/path     # optional; default below
```

That is the bundle's default. Two servers may not claim the same provider,
and unknown fields are rejected, so a mistake fails the load instead of being
ignored. A profile override of the row's `config` replaces the whole value.

Each start writes a run log, the server's stdout and stderr, through
`@deepsea/logs` to `plugins/local-model-supervisor/<id>/<ts>-<pid>.log` in
the variant's log directory (`~/Library/Logs/<variant name>/`;
`$DSH_HOME/logs/` for a home outside DeepSea): the first line names the
time, variant, server, pid and command; `latest.log` points at the newest;
the newest twenty runs and any younger than fourteen days are kept. Starts,
stops, adoptions and failures are logged through `ctx.logger`.

### The `apple` provider

The default matches an `apple` provider in `$DSH_HOME/settings.yaml`
(`llm-pi-ai.providers.apple`, `api: openai-completions`,
`baseURL: http://127.0.0.1:9997/v1`, model `foundation`). AFM needs no key,
but pi-ai insists on one or an `Authorization` header, so the provider sets a
dummy `Authorization: Bearer x`. Always pass `--port`: when its port is taken,
AFM silently picks an ephemeral one, which the provider's `baseURL` cannot
follow. AFM answers only once Apple Intelligence is enabled and its model has
downloaded (System Settings → Apple Intelligence & Siri).

## Limits

- "No session needs it" is approximated: no live agent whose current model
  selection (pending, else last used) names one of the server's providers,
  plus the idle window. Sessions stay loaded after their window closes; the
  idle window covers that lag. Sessions of other variants are not seen, so a
  server idle here can be stopped while another variant still uses it; that
  variant starts it again on its next request.
- A session that runs on the default model and never selects one starts the
  server at its first request, which can fail once while the server comes up.
  Selecting the model warms it up.
- Only processes this plugin spawned are ever stopped. A server left behind
  by a DeepSea that was killed outright (no shutdown) is adopted at the next
  start, so it then runs until stopped by hand.

## Development

```sh
pnpm install && pnpm test
```

`supervisor.mjs` holds the configuration and the per-server state
(`Supervisor`: `touch`, `sweep`, `stopOwned`); `index.js` wires it to session
events and the sweep timer. The tests run
fake servers (`tests/fake-server.mjs`) on free ports: start, reuse, adoption,
idle sweep, crash and restart, startup deadline, a missing command, and
SIGKILL escalation. They never start a real model server.

In a throwaway, name it explicitly (`dsd run release --throwaway-server
--plugins local-model-supervisor`): with the default configuration it starts
AFM as soon as a session selects the `apple` provider.
