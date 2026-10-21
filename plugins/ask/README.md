# @deepsea/ask

Side questions about a session ("by the way, what did we change in the
parser?"), answered from the session's own context while it keeps working,
in a side thread that never enters the conversation the model sees. Like
Claude Code's `/btw`, with follow-ups in a panel.

```
/ask what is the agent doing right now?     ask, and open the side panel
/ask                                        open the side panel
```

## What you see

- **The side panel**: a right-sidebar tab, *Side questions*, holding the
  session's side thread. Under each question: a link icon (scrolls the chat
  to the question's marker and flashes it), where the main conversation was
  (`turn 4, step 2` while a turn ran, `after turn 4` between turns), the
  time (its tooltip: model, cached and new input tokens, output tokens,
  duration) and a copy icon for the question. Then the read-only tool calls
  behind the answer, and the answer as Markdown while it streams, with a
  copy icon at its bottom right on hover. The input at the bottom asks the
  next question (Enter; Shift+Enter for a new line). While an answer
  streams, a red Cancel beside Ask stops it. At the left: Clear (after a
  confirmation) deletes the thread; Export writes it as Markdown to
  `asks-<session id>-<date>.md` in the session's directory (exporting again
  the same day replaces that file).
- **Torn edges** separate questions asked in materially different
  contexts: a later main turn (`turn 2` to `turn 3`; steps within a turn,
  and `turn 2` to `after turn 2`, do not count), or more than ten minutes
  apart (longer than any provider's default prompt-cache lifetime). One
  also closes the thread when the next question would be such a start: the
  main conversation has begun a later turn, or the last question is ten
  minutes old.
- **Markers**: a "?" in the chat's left gutter for each question, at the
  turn it was asked during, which is the state the answer saw; at most
  three per turn, the rest folded into "+n". While the turn is still
  running the marker sits where the question was asked; once the turn ends
  it moves to the turn's end, where it stays visible when the turn's work
  is folded. Clicking one opens the panel on that question and flashes it.
- **Streaming**: the host publishes the growing answer every 80 ms and the
  panel polls every 150 ms while an answer is streaming.
- The composer clears as soon as you press Enter; the main turn is never
  touched.

## How an answer is made

Every question is **rebased** on the main conversation as it is now (the
model Claude Code's `/btw` uses):

1. the session's derived history, exactly as the main agent's last request
   sent it: system prompt, developer messages, the conversation, up to the
   last point where every tool call has its result (asked mid-turn, calls
   still running are left out, because providers reject a call without its
   result), with the latest request header's tool schemas and tool history;
2. the side thread: a note saying this is a side conversation, which tools
   it may use and that the main conversation may have moved on, then the
   newest `historyExchanges` earlier questions and answers, each marked with
   when it was asked;
3. the new question, after a plain-text account of the work in progress
   (what the assistant said, the tool calls still running, results already
   in).

Part 1 is a prefix of the main conversation's own last request, so the
provider's prompt cache, which the running main turn keeps warm, is reused:
only the side thread and the answer are new tokens. The route is the
session's (provider, model, reasoning effort, temperature) unless `provider`
and `model` are configured; the request carries the session id, so
`@deepsea/billing` counts it.

**The cache race.** A question asked while the main agent's request is
still reading its input (a cold cache being rebuilt) would write the whole
prefix a second time. The plugin watches the main agent's model requests
(`llm/stream`) and waits, up to `waitForMainSeconds`, for that request's
first output, when its cache entry becomes readable.

**Tools.** The side model is sent the main conversation's full tool list (a
different list would break the cached prefix), but only the tools in
`tools` run, through the session's own tool pipeline (`ctx.tools.execute`,
with the session's sandbox and policies); any other call gets an error
result naming the tools that are available. Up to `maxToolRounds` rounds;
the panel shows one line per call.

**What is stored.** The question and answer are logged as the `/ask`
command's `command/run` and `command/done` (log-only events, never sent to
the model); the thread itself (questions, positions, answers, tool lines,
usage) is one JSON file per session under
`$DSH_HOME/plugins/ask/sessions/`. An answer interrupted by a server restart
is marked as failed.

## Configuration

All optional, on the `deepsea-ask` row (a patch replaces the whole `config`):

| Key | Default | Meaning |
|---|---|---|
| `provider`, `model` | `''` | Answer with this route instead of the session's; set both or neither. The prompt cache is only reused with the session's own route. |
| `tools` | `read`, `read_many`, `read_image`, `list_dir`, `glob`, `grep`, `search` | Tools the side model may run; `[]` for none. |
| `maxToolRounds` | `8` | Rounds of tool calls per answer. |
| `historyExchanges` | `20` | Earlier side questions replayed with each new one. |
| `waitForMainSeconds` | `60` | Longest wait for an in-flight main request's first output; `0` never waits. |
| `maxAnswerTokens` | `8192` | Output cap for one request, reasoning included; a cut-off answer ends with `[truncated]`. |
| `maxQuestionChars` | `4000` | Longer questions are refused. |
| `timeoutSeconds` | `300` | An answer is abandoned after this long. |

## Limits

- The answer sees what the session has logged: a reply still streaming is
  not in the log until it ends.
- Earlier side answers are replayed as text; their tool calls are not.
- Questions asked back to back during a running turn put their markers in
  nearly the same place until the turn ends.
- Earlier questions are replayed exactly as they were sent (with the
  work-in-progress account of that moment), so a follow-up's request repeats
  the previous one up to its question; the previous answer, being output,
  is always new input.
- A read-only tool whose policy asks for approval (a read outside the
  sandbox, say) raises the approval prompt in the main chat.
- The `/ask` command row is hidden with a stylesheet rule (the harness's
  list of hidden command rows is fixed); a client without this plugin shows
  it as a plain command row.
- A session that has made no model request and whose agent names no model
  cannot answer.

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

`pnpm test` covers the replayed prefix, the side thread, route and position,
the tool loop (allowed, refused, capped), max tokens, errors and
cancellation, and the thread store; `pnpm typecheck` the browser half.

In a server: `dsd run release --throwaway-app --scripted --plugins ask`. The
scripted model answers every side question "Awaiting orders, m'lord"; send
a script with a slow tool call (`prompt - --no-wait`) and ask while it runs
to see the running-turn marker (tools/dsd/README.md).

Started from [dsh-command-btw](https://github.com/wszw142857-beep/dsh-command-btw)
(MIT); rewritten.
