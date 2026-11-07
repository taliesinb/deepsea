# @deepsea/llm-scripted

A model whose replies are scripted by the prompt, for testing. Each user
message that starts with `{` is a script, one JSON command per line (JSONL),
and the model answers with exactly what the script says: text, reasoning,
tool calls, usage, provider errors. No API key, no network, the same output
every time.

It registers the route `scripted` with the model `script` (shown as
"Script"). `dsd run <variant> --throwaway-server --scripted` loads it and
makes it the throwaway's default model. A named variant with `plugins:
all` loads it too, as one more model to pick, never its default.

```jsonl
{"cmd": "think", "text": "Plan: list the files."}
{"cmd": "say", "text": "Looking now.", "chunks": 4, "chunkDelay": 0.05}
{"cmd": "tool", "name": "bash", "args": {"command": "ls", "description": "List files"}, "id": "ls"}
{"cmd": "expect", "tool": "ls", "contains": "README"}
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
  `line 3: unknown cmd "sya"`, and the turn ends with that error.
- Each user message carries its own script; the script in the latest
  message the user typed is the one that runs. Context the harness adds as
  user-role messages of its own (runtime and time context) is skipped.

## Commands

Every line is an object with `cmd` and that command's fields; unknown
commands and unknown fields are errors.

| `cmd` | Fields | Effect |
|---|---|---|
| `say` | `text`; `chunks` (≥ 1), `chunkDelay` (seconds) | a text block, streamed in `chunks` pieces `chunkDelay` apart |
| `think` | as `say` | a reasoning block |
| `tool` | `name`; `args` (object, default `{}`), `id` | a tool call. Consecutive `tool` lines are parallel calls in one response. A tool call ends the response: the harness runs the tools and asks again, and the script continues after them |
| `expect` | `contains`, `equals` and/or `isError`; `tool` (an `id`) | checks a result of the tool calls just before it (the last one, or the one named by `tool`); a mismatch fails the request (`SCRIPT_EXPECTATION`) with what was expected and what came back |
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

Placement rules, checked with the rest: `end` is last; at most one
`title`; `expect` comes directly after tool calls (or another `expect`),
and an `expect` naming a `tool` names one of those calls; tool `id`s are
unique.

## How a script runs across responses

The script is split into responses, each ending after a run of tool calls.
Which response comes next is the number of assistant messages after the
script's user message, so the same transcript always gives the same answer
and a retry repeats the same response. Tool call ids are
`scripted-<script hash>-<response>-<id or line>`. A script that ends with
tool calls answers "Script finished." once their results are in.

## Side calls

Requests that are not the conversation's own turn get fixed answers: the
session titler gets "scripted session" (or the script's `title`), and
compaction gets "Summary: a scripted session."

## Not yet

Images and files in replies; scripts spanning several user messages.

## Development

```sh
pnpm install && pnpm test
```

`@deepsea/script` (packages/script, shared with the provider simulator) parses and validates; `adapter.mjs` is
the `LlmAdapter`; `index.js` registers it (config: `route`, default
`scripted`).
