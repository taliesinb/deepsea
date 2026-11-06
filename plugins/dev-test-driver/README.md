# @deepsea/dev-test-driver

The halves of `dsd drive` inside a throwaway. The server half: plain JSON
over HTTP on a throwaway server's own port, calling the services the GUI
calls, so an agent can create sessions, run prompts and commands, wait for
turns and read what happened from a shell, without a browser and without
decoding session logs. The browser half (`src/client/index.ts`): what only
the page can do, on `window.__DEEPSEA_TEST_DRIVER__` for the app's
automation channel; today `openSession(id)` (`dsd drive open-session`),
the verb a sidebar row's click runs.

`dsd run` loads it into every throwaway. Use it through `dsd drive`
(tools/dsd/README.md); with `--scripted` every prompt is a script of the
model's exact reply (plugins/llm-scripted), so a whole turn is
deterministic:

```sh
dsd run release --throwaway-server --detach --scripted --plugins llm-billing
dsd drive create-session --title billing-test
dsd drive prompt last - <<'EOF'
{"cmd": "tool", "name": "bash", "args": {"command": "echo ok", "description": "Print ok"}}
{"cmd": "expect", "contains": "ok"}
{"cmd": "say", "text": "Done."}
{"cmd": "usage", "input": 1200, "output": 85}
EOF
dsd drive command last /billing
dsd stop
```

## Operations

Each is `POST /deepsea-test-driver/<op>` with a JSON object body; the reply
is `{ "ok": true, "value": … }` or `{ "ok": false, "error": { "code",
"message" } }`. The route, the state file (`run/test-driver.json`) and the
page global keep the plugin's former name, `test-driver`: they are wire
names that `dsd drive` and the app call, also in builds from before the
rename.

| Op | Body | Value |
|---|---|---|
| `health` | — | pid, port, home, uptime, and loader rows that should run but do not (pending, loading, failed) |
| `create-session` | `cwd?`, `preset?`, `model?` (`provider/model[:effort]`), `title?` | the session id and its workspace: the one for `cwd`, else the default workspace (made as the GUI would on first use) |
| `prompt` | `sessionId`, `text`, `mode?` (`queue` / `steer`), `wait?`, `timeoutMs?` | acceptance and the event seq it starts from; with `wait`, also what `wait` returns |
| `wait` | `sessionId`, `since?`, `timeoutMs?` (default 120 s) | `idle`, the agent's status, the next seq, and a summary of the events from `since` |
| `command` | `sessionId`, `line` | the command's execution: id and result |
| `events` | `sessionId`, `since?`, `types?` (`tool/*` matches a prefix), `limit?` (default 200) | the raw session events |
| `cancel` | `sessionId` | acceptance |
| `sessions` | — | the session list |
| `invoke` | `namespace`, `method`, `args?` | any method the GUI's gateway exposes |

The summary has the number of turns, how the last one ended (`completed`,
`aborted`, or `error` with its code and message), the assistant's text
blocks, how many reasoning blocks there were, each tool call with its
outcome and output, and command results.

## Safety

- It arms only in a throwaway home (`variant.yml` says `throwaway: true`);
  anywhere else it logs a warning and registers nothing.
- Each server process makes a new bearer token and writes it, with the
  port, to `$DSH_HOME/run/test-driver.json` (mode 0600). Requests need that
  token, must come from loopback, and must not carry an `Origin` header, so
  no web page can reach the driver.
- It runs nothing a user could not do in the GUI; `invoke` reaches only the
  gateway's existing methods.

## Development

```sh
pnpm install && pnpm test
```

`driver.mjs` holds the pure parts (request checks, the summary, event
selection); `index.js` the route and operations.
