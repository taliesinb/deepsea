# tools/provider-sim — simulated model providers

A loopback HTTP server that stands in for model providers, so DeepSea can be
tested end to end (models, routes, billing, sign-in) without real accounts.
It runs no inference: replies are scripted exactly as with the scripted model
(`packages/script`: JSONL commands, or the plain prompts `say <text>` and
`help`), but put on the wire in each provider's own protocol, and every
request is charged to an account that keeps real-looking credit, balance and
usage.

## How DeepSea reaches it

The harness baseline redirects every model provider's host when
`DSH_PROVIDER_SIMULATOR` names a loopback URL (`provider-simulation.ts` in
`@deepseek-ai/dsh-llm`): `https://openrouter.ai/api/v1/models` becomes
`<simulator>/openrouter.ai/api/v1/models`. Everything else in the stack (the
provider SDKs inside pi-ai, DeepSeek's own adapter, llm-billing's account reads)
runs unchanged. A provider the simulator does not serve answers 501, so a
simulated home never reaches a real service.

```sh
dsd run release --throwaway-app --simulated                      # openrouter + deepseek test accounts
dsd run release --throwaway-app --simulated --accounts openrouter-low,deepseek-empty
dsd run release --throwaway-app --simulated --accounts openrouter=sk-or-mine   # a persistent account
dsd run release --throwaway-app --simulated --accounts anthropic,anthropic-max  # API key and a signed-in Plan
dsd run release --throwaway-app --simulated --accounts standard,codex-plus-signed-out  # a Plan configured, signed out
dsd sim status | start | stop | accounts [<provider>] | fixtures
dsd sim account openrouter sk-or-mine --set '{"usageMicros": 0}'
dsd sim account anthropic max@example.com --set '{"plan": "max20"}'      # an email: a Plan account
```

`--simulated` starts the simulator if it is not running (one per checkout,
running that checkout's providers, so a worktree that changes the simulator
tests its own; all share one store; left running, `dsd sim stop` ends this
checkout's), creates the throwaway's
accounts, puts their keys in the server's environment and the routes they
need in its profile patch, and sets `DSH_PROVIDER_SIMULATOR`.

## Accounts

An account is created the first time a credential is used: any API-key
string, or an email address signed in through a simulated sign-in page (kind
`email`). New key accounts start with $10 of credit or balance. Money is kept
in micro-dollars and spent at the model's catalog prices (pi-ai's generated
catalog, the same one DeepSea uses), from the script's `usage` command or an
estimate of four characters per token.

`fixtures/<provider>.json` name starting points (`dsd sim fixtures` lists them all): each has a provider, a credential,
the environment variable the key goes in, the rows its route needs, and a
starting state. A throwaway gets fresh accounts, its id appended to each
credential (before the `@` of an email: `max+3275dd@example.com`), so no two
throwaways share one; `name=<credential>` uses that credential as it is, for
an account that persists across runs.

A sign-in fixture (`kind: email`, `signIn: <route>`) starts the throwaway signed in, without a browser: dsd asks the simulator for tokens (`POST /_sim/sign-in`) and writes the grant pi-ai would have stored after a browser sign-in into the throwaway's `.credentials.yaml` (credentials-local's record `llm-pi-ai/<route>`: `{ type: oauth, access, refresh, expires }`). A throwaway holds one sign-in per route.

Every sign-in fixture also comes **signed out**, as `<name>-signed-out` (`anthropic-max-signed-out`, `codex-plus-signed-out`, `kimi-plan-signed-out`, …; dsd derives them, so `dsd sim fixtures` lists them with `signedOut: true` and a new Plan fixture gets one without a second entry): the same account is created in the simulator with the fixture's state and the route's rows go into the profile, so the Models page shows the Plan, but no grant is stored. `run` prints the account with `signedOut: <route>`; signing in through the simulated sign-in page with that email (`max+3275dd@example.com`) then stores a grant for that account, as a real sign-in does. It replaces a signed-in fixture of the same route, so `standard,anthropic-max-signed-out` is the standard set with the Anthropic Plan signed out. This is the starting state; to sign a running throwaway out, use the sign-in UI (llm-sign-in's Log out keeps the route).

The store is `~/.deepsea/_sim/sim.sqlite` (SQLite in WAL mode, every change in
an immediate transaction, so several simulators or tools can share it);
`~/.deepsea/_sim/sim.json` records the running simulator, and its run logs are
in the machine log directory's `sim/`.

## Providers

One module and one document each, in `providers/`, with the test accounts in
`fixtures/<name>.json`:

| Provider | Hosts | Fixtures |
|---|---|---|
| [OpenRouter](providers/openrouter.md) | `openrouter.ai` | `openrouter`, `openrouter-low`, `openrouter-empty` |
| [DeepSeek](providers/deepseek.md) | `api.deepseek.com` | `deepseek`, `deepseek-empty` |
| [Anthropic](providers/anthropic.md), API key and Plan | `api.anthropic.com`, `claude.ai`, `platform.claude.com` | `anthropic`, `anthropic-low`, `anthropic-max`, `anthropic-max-80` (and each Plan's `-signed-out`) |
| [OpenAI](providers/openai.md), API key and the ChatGPT/Codex Plan | `api.openai.com`, `auth.openai.com`, `chatgpt.com` | `openai`, `openai-low`, `codex-plus`, `codex-pro-80` (and each Plan's `-signed-out`) |
| [Gemini](providers/gemini.md) | `generativelanguage.googleapis.com` | `gemini`, `gemini-low` |
| [Moonshot](providers/moonshot.md): Kimi API key and the Kimi Code Plan | `api.moonshot.ai`, `.cn`, `api.kimi.com`, `auth.kimi.com`, `www.kimi.com` | `kimi`, `kimi-plan` (and `kimi-plan-signed-out`) |
| [Z.ai](providers/zai.md) | `api.z.ai`, `open.bigmodel.cn` | `zai`, `zai-empty` |

Both wire formats stream (server-sent events) or answer whole, with text,
reasoning, tool calls and usage. A script plays across a turn as with the
scripted model: one response per request, counted by the assistant messages
since the prompt (the user message that starts the turn; context the harness
adds after it is ignored), with the same interpreter: batches, loops,
values and `expect` work as there, from the text of the tool results the
request carries (no structured `result`, no `globals` from earlier
scripts; plugins/llm-scripted/README.md → The provider simulator). A
result without a usable id (Gemini before 3) is matched to its call by tool
name. `error` answers the HTTP status of its kind (with `Retry-After`), and
with `times` only for its first attempts. The harness's own side requests
are answered as the scripted model answers them, never by replaying the
session's script (which would play, and charge, its turn again): the session
titler's request gets the script's `title` (else "scripted session"), and a
compaction request gets "Summary: a simulated session."

The simulator's own endpoints are under `/_sim/`: `status`, `accounts`
(`?provider=`), `POST account` (`{ provider, kind, credential, state }`
creates an account or merges `state` into it; `kind` is `key` or `email`), and
`POST sign-in` (`{ provider, email, plan?, accessSeconds? }`: the account,
created if new, and fresh tokens, as the provider's token endpoint answers),
for providers with a Plan sign-in.

## Adding a provider

1. List every endpoint DeepSea's stack calls for it: pi-ai's provider code
   (`dist/api/*.js`, `dist/auth/oauth/*.js` and the `*.models.js` catalogs
   under the harness build's `packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/`),
   the harness's adapters and sign-in flows (`packages/llm/`), and llm-billing's
   account reads (`plugins/llm-billing`).
2. Write `providers/<name>.mjs` (see `providers/index.mjs` for its exports;
   `common.mjs`'s `generate()` plays the script in the OpenAI or Anthropic
   wire format; `wire-responses.mjs` (OpenAI Responses), `wire-gemini.mjs`
   and `wire-completions.mjs` (chat-completion dialects) for others; a new
   wire format gets its own file), answering exactly those endpoints in
   the provider's own shapes and errors, and `providers/<name>.md`.
3. Add `fixtures/<name>.json`: a key fixture names the environment variable
   the route reads its key from (`env`) and the rows the route needs
   (`settings`); a Plan fixture names its route (`signIn`), and gets its
   `-signed-out` form for free.
4. Test it in `tests/<name>.test.mjs`, then in a `--simulated` throwaway with
   the plugins that use it (llm-billing, llm-sign-in).

## Tests

`node --test tests/*.test.mjs`. dsd's own tests provision a Plan fixture and
check the credentials document it writes, and its `-signed-out` form (the
account and rows, no record).

## Not simulated yet

Each provider's document lists its gaps. Across providers: after a turn
that failed (pi-ai drops the failed reply, so the next prompt follows the
failed one, or shares the message carrying its tool results), a script or
`say`/`help` starts a new turn, but any other text is read as context, and
the failed script plays again: start the next prompt with a script, or a
new session.
