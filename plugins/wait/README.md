# @deepsea/wait

A `wait` tool for agents, in place of `bash "sleep N; echo done"`. Because the
tool is *told* how long it waits, the chat draws the call as a live progress
bar with two buttons:

```
🕐 Wait  dev server to come up  ▕████████░░░░░░░░░░▏ 4 s / 10 s   [Skip] [Abort]
```

| Button | What the model receives |
|---|---|
| **Skip** | A normal result, early: `Wait skipped by the user after 4 s of the requested 10 s. Treat this exactly like the timeout having elapsed and carry on (…)`. For "I can see it's already done" or plain impatience. |
| **Abort** | An **error** result (code `USER_ABORTED_WAIT`): `user aborted sleep: the user pressed Abort after 4 s of the requested 10 s wait (dev server to come up). Do not start another wait; ask the user what they want to do instead.` The model stops and asks. |
| *(nothing)* | `Waited 10 s.` when the time elapses. |
| *Stop generating* | The turn's cancellation reaches the tool as `exec.signal`; the timer is cleared and the call settles with the registry's own `ABORTED` code (the row reads "interrupted after …"). |

Settled rows keep a static bar: full for a completed wait, the elapsed fraction
in the accent colour for a skipped one, in the error colour for an aborted one.

## Tool

```
wait(seconds: number, reason?: string)
```

- `seconds`: `0 < seconds ≤ maxSeconds` (default 3600), fractions allowed. Over
  the cap the call fails with `INVALID_WAIT`, telling the model to call again
  for longer periods.
- `reason`: a few words shown beside the bar ("dev server to come up").
- Concurrency-safe: it may overlap sibling calls of the same batch.
- Registered globally (stateless), so subagents get it too.
- Result value (also the row's `presentationMeta`, marked `deepsea: 'wait'`):
  `{ outcome: 'completed' | 'skipped', requestedSeconds, waitedSeconds,
  startedAt, endedAt }`.

A system-prompt section (`tool:deepsea-wait`, `promptHint: true`) steers the
model from bash `sleep` to `wait`; it is emitted only for scopes that see the
tool.

## How it works

- **Host half** ([index.js](index.js), [wait.mjs](wait.mjs)):
  `createWaitRegistry()` holds one entry per pending call (`callId →
  { sessionIds, startedAt, deadline, timer, settle }`); the tool body awaits
  the entry's promise. Two Fetch routes behind DSH's own authentication:
  - `GET /api/deepsea-wait/status?callId=…&sessionId=…` → `{ pending,
    startedAt, deadline, requestedMs, reason, now }`. `now` is the server
    clock, so the browser draws the bar against the clock that owns the
    deadline.
  - `POST /api/deepsea-wait/control` with a JSON body `{ action: 'skip' |
    'abort', callId, sessionId }` → `{ ok }`; `404` once settled, `403` when
    the session does not own the call (`sessionId` must be the agent's
    `session.id` or `agent.id`), `415` without `content-type:
    application/json`, so a cross-site form cannot reach it.

  Unloading the plugin fails every pending wait (`WAIT_UNLOADED`), so no call
  hangs.
- **Browser half** ([src/client/index.tsx](src/client/index.tsx) →
  `lib/client.js`): a keyed `tool.call.toolview` entry for `wait` on the
  shipped `DisclosureRow` chrome, with `data-tool="wait"` and `data-state` as
  on the shipped tool rows. Running: it fetches the status once for the
  browser↔server clock offset (until then: the `tool/call` event time on the
  block), ticks every 100 ms, holds the bar at 99 % until the `tool/result`
  event lands, and POSTs the verdicts. Settled: it classifies the block:
  `presentationMeta.deepsea === 'wait'` → completed or skipped;
  `USER_ABORTED_WAIT` → aborted; `ABORTED` / `ABORTED_BEFORE_DISPATCH` →
  interrupted; anything else → the first line of the error. One `<style>`
  element (`#deepsea-wait-style`, classes `deepsea-wait-*`) carries the hover
  states.

Two harness details the design depends on:

- `defineTool`'s `output.schema` is the author DSL, not JSON Schema:
  requiredness is `required: true` *per property*; a `required: [...]` array
  fails with `UNSUPPORTED_SCHEMA`.
- The registry substitutes its canonical `ABORTED` result only for a body that
  *succeeded* after cancellation; a rejecting body keeps its own error. The web
  GUI cancels with a plain object as the signal's reason, so rejecting with
  `signal.reason` would print `Error: [object Object]`; the registry therefore
  throws a `HarnessError` with code `ABORTED` itself.

## Configuration

```yaml
- insert:
    - id: deepsea-wait
      name: "@deepsea/wait"
      config:
        maxSeconds: 3600    # longest single wait
        promptHint: true    # system-prompt section steering the model to `wait`
```

## Development

```sh
pnpm install          # also builds lib/client.js (prepare)
pnpm test             # the registry, the tool and the two routes (node:test)
pnpm typecheck        # browser half against the harness's declarations
pnpm watch            # rebuild lib/client.js on save (hot-swaps a GUI serving it)
```

In a server: `dsd run release --throwaway-app --scripted --plugins wait`
(tools/dsd/README.md); a script line `{"cmd":"tool","name":"wait","args":{"seconds":30}}`
draws the bar, and `dsd drive click --text Skip` presses a button.
