# @deepsea/llm-scripted

A model whose replies are scripted by the prompt, for testing. Each user
message that starts with `{` is a script, one JSON command per line (JSONL),
and the model answers with exactly what the script says: text, reasoning,
tool calls, checks on what came back, loops, usage, provider errors. No API
key, no network, the same output every time.

It registers the route `scripted` with the model `script` (shown as
"Script"). `dsd run <variant> --throwaway-server --scripted` loads it and
makes it the throwaway's default model. A named variant with `plugins:
all` loads it too, as one more model to pick, never its default.

```jsonl
{"cmd": "think", "text": "Plan: list the files."}
{"cmd": "say", "text": "Looking now.", "chunks": 4, "chunkDelay": 0.05}
{"cmd": "tool", "name": "bash", "args": {"command": "ls", "description": "List files"}, "id": "ls"}
{"cmd": "expect", "value": "tools.ls.text", "contains": "README"}
{"cmd": "say", "text": "Done."}
{"cmd": "usage", "input": 1200, "output": 85, "cacheRead": 900}
```

## Which prompts are scripts

- A prompt whose text does not start with `{` (leading whitespace ignored)
  is a plain prompt: `say <text>` (one line) gets the reply `<text>`, `help`
  a Markdown table of these and of every script command with its fields,
  and anything else the reply "Awaiting orders, m'lord".
- A prompt that does is parsed and validated **in full before anything
  runs**. Any problem fails the request with an API error (code
  `SCRIPT_INVALID`, status 400) listing every bad line, e.g.
  `line 3: unknown cmd "sya"` or `line 4, body[1]: say needs "text"`, and
  the turn ends with that error.
- Each user message carries its own script; the script in the latest
  message the user typed is the one that runs. Context the harness adds as
  user-role messages of its own (runtime and time context) is skipped.

## Commands

Every line is an object with `cmd` and that command's fields; unknown
commands and unknown fields are errors. `batch` and `loop` hold commands of
their own.

| `cmd` | Fields | Effect |
|---|---|---|
| `say` | `text`; `chunks` (≥ 1), `chunkDelay` (seconds) | a text block, streamed in `chunks` pieces `chunkDelay` apart |
| `think` | as `say` | a reasoning block |
| `print` | `value` (default `"tools.last"`); `prefix`, `maxChars` (default 4000), `chunks`, `chunkDelay` | a text block showing a value, to see what a script is working with (Values, below) |
| `tool` | `name`; `args` (object, default `{}`), `id`; `chunks` (≥ 1), `chunkDelay` (seconds) | a tool call, its arguments streamed in `chunks` pieces `chunkDelay` apart (a long `write` as a model streams it). It ends the response: the harness runs it and asks again, and the script continues after it |
| `batch` | `cmds` (a list of commands) | runs `cmds` in one response: their tool calls go out together, and the script continues once all their results are in |
| `expect` | `value` (default `"tools.last.text"`); `equals` (any JSON), `contains` (text), `matches` (a regular expression) | checks a value against the context (Values, below); a mismatch fails the request (`SCRIPT_EXPECTATION`) with what was expected and what is there |
| `loop` | `values`, `body` (a command or a list); `id`, `limit`, `delay` (seconds) | runs `body` once per item of the list `values` gives (at most `limit` items), sleeping `delay` between iterations (Loops, below) |
| `save` | `locals`, `globals` (objects of name → value) | writes values into the context (Values, below) |
| `sleep` | `time` (seconds, ≤ 600) | waits; a cancelled turn ends it at once |
| `usage` | `input`, `output`; `cacheRead`, `cacheWrite`, `reasoning` | the token usage to report for this response (otherwise four characters per token) |
| `error` | `kind`; `message`, `status`, `retryAfter` (seconds), `times` | fails the request as a provider error of that kind. With `times: n` it fails only the first n attempts, so the harness's retry can succeed |
| `end` | `reason`: `stop` (default) or `max-tokens` | the finish reason; must be the last line |
| `title` | `text` | the session's title, when the titler asks during this script (so only a session's first script sets it); one per script |

Error kinds and what they become:

| `kind` | Code | Status |
|---|---|---|
| `rate-limit` | `RATE_LIMIT` | 429 |
| `overloaded` | `SERVER` | 529 |
| `server` | `SERVER` | 500 |
| `timeout` | `TIMEOUT` | 504 |
| `network` | `TRANSPORT` | — |
| `auth` | `INVALID_CREDENTIAL` | 401 |
| `quota` | `QUOTA` | 402 |
| `context-length` | `CONTEXT_WINDOW_EXCEEDED` | 400 |
| `invalid-request` | `INVALID_REQUEST` | 400 |

Placement rules, checked with the rest: `end` is the last line; at most one
`title`; neither is inside a `batch` or `loop`; no `batch` inside a `batch`
(a loop inside one included); tool `id`s are unique in the script. A tool
`id`, a `title`, a loop's `id`, `limit`, `delay` and `body`, and a batch's
`cmds` are written out, never value expressions.

## How a script runs

A script runs top to bottom. **A tool call ends the response**: the harness
runs it, sends its result back and asks again, and the script continues
after it. To send several tool calls in one response, put them in a
`batch`; the script continues once all their results are in. So

```jsonl
{"cmd": "tool", "name": "bash", "args": {"command": "sleep 120; echo done", "description": "Sleep", "run_in_background": true}, "id": "bash"}
{"cmd": "tool", "name": "job_output", "args": {"job_id": {"$value$": "tools.bash.result.jobId"}, "wait": true, "timeout_ms": 150000}, "id": "wait"}
```

is two responses, and the second call reads the job id the first returned,
while

```jsonl
{"cmd": "say", "text": "Reading both."}
{"cmd": "batch", "cmds": [
  {"cmd": "tool", "name": "read", "args": {"path": "a.txt"}},
  {"cmd": "tool", "name": "read", "args": {"path": "b.txt"}}]}
{"cmd": "say", "text": "Done."}
```

(on one line in a real script) is two responses: the text and both calls,
then "Done.". Whether the harness then runs a batch's calls at the same time
is its own scheduling (tools may be exclusive).

Each request replays the script from the top to the response it is at
(the number of assistant messages after the script's message): the earlier
responses produce nothing, sleep for no time, fire no `error` and check no
`expect`; their `save`s and loops run, and their tool calls' results are
taken from the conversation. So the same transcript always gives the same
answer, and a retry repeats the same response. Tool call ids are
`scripted-<script hash>-<response>-<key>`, where the key is the call's `id`
(or its place: `3` for line 3, `3_1` for the second command inside it),
then `-<index>` for each loop around it. A response with nothing to show
(the script already ended, or only `save` or `expect` were left) answers
"Script finished.".

## Values

**Value expressions.** `{"$value$": V}` anywhere in a command (any field,
at any depth) is replaced by what V evaluates to, just before the command
runs. A `"$splat$": V` key merges the object V gives into the object holding
it (later keys win); a list entry `{"$splat$": V}` splices in the list V
gives. What a value loads is data: it is not evaluated again. V is one of:

| V | Gives |
|---|---|
| `"<path>"` | the value at a dotted path, e.g. `"tools.bash.result.jobId"`; a number segment indexes a list (`"tools.last.args.paths.0"`) |
| `{"type": "load", "path": "<path>"}` | the same |
| `{"type": "toString", "value": V}` | V as a string: a string as it is, anything else as JSON |
| `{"type": "stringSub", "str": "…", "lhs": "…", "rhs": V}` | `str` with every `lhs` replaced by V as a string |
| `{"type": "literal", "value": …}` | the value as written, not evaluated |
| `{"type": "range", "start": 0, "stop": n, "step": 1}` | `[start, start + step, …]` up to `stop`, excluded, as Python's `range` (`start` and `step` optional; each a whole number or a V giving one; at most 10,000 numbers) |

**The JSON context** is `{"tools", "locals", "globals", "loop"}`:

- `tools`: each finished tool call of this script, under `last`, its tool
  name (`bash`, `job_output`) and its `id` if it has one (an `id` wins over
  a name; in a loop, the latest iteration's), as `{name, args, result,
  text, duration, error, ok}`: the arguments sent (values evaluated), the
  tool's structured result (what Inspect shows; `null` for a failure), the
  text the model saw, seconds, the failure (`{message, info?}`, else
  `null`) and whether it succeeded. A batch's calls are recorded in order,
  so `last` is its last call.
- `locals`: what this script's `save` commands wrote.
- `globals`: what any `save` in this conversation wrote, this script's
  earlier lines included. Keep a job id for a later script:
  `{"cmd": "save", "globals": {"sleep_id": "tools.last.result.jobId"}}`,
  then `{"$value$": "globals.sleep_id"}` there.
- `loop`: the iterations of the loops the command is in (Loops, below).

**`save`** evaluates each value (a V, as above), all against the context
as it was, then writes them: `{"cmd": "save", "locals": {"a": "locals.b",
"b": "locals.a"}}` swaps. A `"$splat$": V` entry writes every key of the
object V gives (`{"globals": {"$splat$": "locals"}}` keeps all locals).
Names have no dots.

**`expect`** checks a V (`value`, default `"tools.last.text"`, the text
the model saw from the last tool call) with `equals` (deep equality, any
JSON), `contains` and `matches` (the value must be a string); every check
given must hold. It goes anywhere: `{"cmd": "expect", "value":
"tools.wait.ok", "equals": true}`, `{"cmd": "expect", "value":
"loop.this.index", "equals": 2}`. A value that is not there fails it too.

**`print`** shows a V (`value`, default `"tools.last"`: the last tool
call's whole record) as a text block: a string as it is in a plain fenced
block (a tool's output keeps its lines), anything else as JSON indented
by 2 in a `json` block, the fence longer than any run of backticks inside.
`prefix` goes on the line above; past `maxChars` characters the value is
cut and the count of the rest follows the block. A bare `{"cmd":
"print"}` after a tool call shows what came back.

**Failures.** A path that is not there, a splat of the wrong kind or a
field that is wrong once evaluated fails the request with an API error
(code `SCRIPT_VALUE`, status 400) naming the line, the field and what the
context has instead, e.g. `line 2: args.job_id: "tools.bash.result.jobId":
no "bash" in tools (it has "last", "job_output")`.

**Where the context comes from.** It is rebuilt from the conversation on
every request (How a script runs, above): the scripts before this one are
replayed for their `globals`, then this script's earlier responses. The
structured result, error and duration of each call come from the harness's
`tools/result` event and are kept in memory (the last 1000 calls): after a
server restart, earlier calls have `result: null` and `duration: null`,
and their `text`, `args` and `ok` from the conversation. Globals before a
compaction are gone with the scripts that saved them.

## Loops

```jsonl
{"cmd": "loop", "values": {"type": "range", "stop": 3}, "id": "i", "delay": 0.5, "body": {"cmd": "tool", "name": "bash", "args": {"command": {"$value$": {"type": "stringSub", "str": "echo N", "lhs": "N", "rhs": "loop.i.value"}}, "description": "Echo"}}}
```

runs `body` (one command, or a list) once per item of the list `values`
gives: three `bash` calls, each its own response, half a second apart. In
a `batch` they would go out together in one response, the delay between
them as they stream. `values` is a V, so it may be a tool's result
(`"tools.list.result.jobs"`). `limit` keeps the first n items.

Inside the body, `loop.this` is the innermost iteration, and `loop.<id>`
the iteration of the loop with that `id`, each `{id, index, value, count,
last}`: the loop's `id` (or `null`), the index from 0, the item, how many
items the loop runs (after `limit`) and whether this is the last. Both hold
only inside their loop: after it, `loop.this` is the enclosing loop's again
and `loop.<id>` is gone. A script runs at most 100,000 commands, loops
included.

## Side calls

Requests that are not the conversation's own turn get fixed answers: the
session titler gets "scripted session" (or the script's `title`), and
compaction gets "Summary: a scripted session."

## The provider simulator

The provider simulator (tools/provider-sim) plays the same scripts with the
same interpreter, in each provider's wire protocol. It sees only the text
of tool results, so there `result` is `null` and `duration` is `null`, and
`globals` do not carry over from earlier scripts.

## Not yet

Images and files in replies; conditions.

## Development

```sh
pnpm install && pnpm test
```

`@deepsea/script` (packages/script, shared with the provider simulator)
holds the grammar (`grammar.mjs`), value expressions (`values.mjs`) and the
interpreter (`run.mjs`); `adapter.mjs` is the `LlmAdapter`; `index.js`
registers it (config: `route`, default `scripted`) and listens to
`tools/execute` and `tools/result` for the scripts' own calls (ids
`scripted-…`).
