# @deepsea/tool-wait

A `wait` tool for agents, in place of `bash "sleep N; echo done"`. Because the
tool is *told* how long it waits, the chat draws the call as a live progress
bar with two buttons:

```
🕐 Wait  dev server to come up                 ▕████░░░░▏ 10m37s / 40m [Skip] [Abort]
```

| Button | What the model receives |
|---|---|
| **Skip** | A normal result, early: `Wait skipped by the user after 4 s of the requested 10 s. Treat this exactly like the timeout having elapsed and carry on (…)`. For "I can see it's already done" or plain impatience. |
| **Abort** | An **error** result (code `USER_ABORTED_WAIT`): `user aborted sleep: the user pressed Abort after 4 s of the requested 10 s wait (dev server to come up). Do not start another wait; ask the user what they want to do instead.` The model stops and asks. |
| *(nothing)* | `Waited 10 s.` when the time elapses. |
| *Stop generating* | The turn's cancellation reaches the tool as `exec.signal`; the timer is cleared and the call settles with the registry's own `ABORTED` code (the row reads "interrupted after …"). |

The bar shows only while the wait runs. A settled row has the verdict in its
place: `waited 10s`, `skipped after 4s of 10s`, `aborted by user after 4s of
10s` (in the error colour), `interrupted after …` (in the warning colour), or
the first line of an error.

The row spans the chat column: the bar, the time and the buttons (or the
verdict, once settled) sit at its right edge and
the reason takes the rest, cut with an ellipsis only when it does not fit
(hover for the whole of it). When space runs short the bar shrinks first, to
40px; on a row narrower than 400px (a phone) it is dropped and the time
carries the progress. Times are compact (`4s`, `2.3s`, `10m37s`, `40m`,
`1h5m`); the running clock keeps its seconds (`10m0s`) and reserves the width
of its longest text, so the bar does not shift as it ticks. The copy is
localized in English and Chinese (`10分37秒 / 40分钟`, 跳过, 中止): the `card`
section of [locale/en.json](locale/en.json) and [locale/zh.json](locale/zh.json),
whose keys must match (the tests check); other languages fall back to English.

## Two rows

The package inserts two rows (plugins/AGENTS.md → Presets, "Two rows, one
package"):

| Row | Module | Title | Where | Holds |
|---|---|---|---|---|
| `deepsea-tool-wait-tools` | `@deepsea/tool-wait/tools` ([tools.js](tools.js)) | Wait tool | the agent presets that have upstream's `@deepseek-ai/dsh-tool-jobs`; disabled globally | the `wait` tool, the prompt hint, the config |
| `deepsea-tool-wait` | `@deepsea/tool-wait` ([index.js](index.js)) | Wait controls | global | the pending waits (service `deepseaWait`), the two routes, the browser half |

The tools row joins the presets through `"deepsea": { "presets": { "joinWith":
["@deepseek-ai/dsh-tool-jobs"], "module": "@deepsea/tool-wait/tools" } }`:
waiting goes with background jobs and bash. In rc.1 that is `standard`, `ptc`
and `cordis`, so Settings → Built-in plugins lists "Wait tool" under Session
plugins; `minimal` and `minimal-no-tools` have no `wait`. A subagent gets the
tool when its preset has it; a person's own preset gets it by adding the row
in the preset editor.

The root row stays global because a preset row can serve neither routes
(they would be registered once per preset) nor a browser half. Each wait the
tool starts goes into the root's registry, read when the wait starts
(`ctx.get('deepseaWait')`), so the card's Skip and Abort reach a wait started
in any preset. Preset rows mount before Host rows, so the tools row never
requires the service; without the root row the tool still waits, but nothing
can skip or abort it (only the turn's cancellation ends it early).

## Tool

```
wait(seconds: number, reason?: string)
```

- `seconds`: `0 < seconds ≤ maxSeconds` (default 3600), fractions allowed. Over
  the cap the call fails with `INVALID_WAIT`, telling the model to call again
  for longer periods.
- `reason`: a few words shown beside the bar ("dev server to come up").
- Concurrency-safe: it may overlap sibling calls of the same batch.
- In the presets above (Two rows), subagents included.
- Result value (also the row's `presentationMeta`, marked `deepsea: 'wait'`):
  `{ outcome: 'completed' | 'skipped', requestedSeconds, waitedSeconds,
  startedAt, endedAt }`.

A system-prompt section (`tool:deepsea-tool-wait`, `promptHint: true`) steers the
model from bash `sleep` to `wait`; it is emitted only for scopes that see the
tool.

## How it works

- **Host half** ([index.js](index.js), [tools.js](tools.js),
  [wait.mjs](wait.mjs)): the root's `createWaitRegistry()`, provided as
  `deepseaWait`, holds one entry per pending call (`callId → { sessionIds,
  startedAt, deadline, timer, settle }`); the tool body (tools row) starts the
  entry there and awaits its promise. Two Fetch routes on the root, behind
  DSH's own authentication:
  - `GET /api/deepsea-wait/status?callId=…&sessionId=…` → `{ pending,
    startedAt, deadline, requestedMs, reason, now }`. `now` is the server
    clock, so the browser draws the bar against the clock that owns the
    deadline.
  - `POST /api/deepsea-wait/control` with a JSON body `{ action: 'skip' |
    'abort', callId, sessionId }` → `{ ok }`; `404` once settled, `403` when
    the session does not own the call (`sessionId` must be the agent's
    `session.id` or `agent.id`), `415` without `content-type:
    application/json`, so a cross-site form cannot reach it.

  Unloading the root row fails every pending wait (`WAIT_UNLOADED`), so no
  call hangs; so does unloading a tools row for the waits it started without
  the root.
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
  element (`#deepsea-wait-style`, classes `deepsea-wait-*`) carries the
  layout and the hover states; it widens `DisclosureRow`'s text area (sized to
  its content by default) through the row's `contentClassName`. The copy is
  the locale namespace `deepsea-tool-wait`, registered from the locale files'
  `card` sections (`inject: ['slots', 'locale']`); the duration forms are
  [src/client/format.ts](src/client/format.ts).

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

The config is the tools row's: the row in a preset, set in the Web preset
editor, or in a profile or `--patch` row for its id, which dsd carries into
the presets at its next install:

```yaml
- id: deepsea-tool-wait-tools
  config:
    maxSeconds: 3600    # longest single wait
    promptHint: true    # system-prompt section steering the model to `wait`
```

The root row `deepsea-tool-wait` takes no config. Before the split these keys
lived on it; a `config` still set on `deepsea-tool-wait` is now ignored (it
validates, and nothing reads it): move it to `deepsea-tool-wait-tools`.

## Development

```sh
pnpm install          # also builds lib/client.js (prepare)
pnpm test             # the registry, the tool, both rows (routes, service, fallback), the row's durations and dictionaries (node:test)
pnpm typecheck        # browser half against the harness's declarations
pnpm watch            # rebuild lib/client.js on save (hot-swaps a GUI serving it)
```

In a server: `dsd run release --throwaway-app --scripted --plugins tool-wait`
(tools/dsd/README.md); a script line `{"cmd":"tool","name":"wait","args":{"seconds":30}}`
draws the bar, and `dsd drive click --text Skip` presses a button.
