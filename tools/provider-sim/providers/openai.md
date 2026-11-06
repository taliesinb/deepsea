# OpenAI (simulated)

| Host | Endpoints | Account |
|---|---|---|
| `api.openai.com` | `POST /v1/responses` (streamed and whole), `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/models/<id>` (`Authorization: Bearer sk-…`) | a key: a credit balance; none left is 429 `insufficient_quota` |
| `auth.openai.com` | `GET /oauth/authorize` (the sign-in page), `POST /oauth/authorize`, `POST /oauth/token` (`authorization_code`, `refresh_token`); the device-code login: `POST /api/accounts/deviceauth/usercode`, `GET`/`POST /codex/device` (the page), `POST /api/accounts/deviceauth/token` | |
| `chatgpt.com` | `POST /backend-api/codex/responses` (server-sent events), `GET /backend-api/wham/usage` | an email: a ChatGPT Plan (below) |

What uses them: the `openai` route is pi-ai's `openai-responses` API
(`https://api.openai.com/v1`, always streamed, `store: false`); the
`openai-codex-oauth` route is pi-ai's ChatGPT Plus/Pro sign-in
(`auth/oauth/openai-codex.js`) and `openai-codex-responses` API; the
harness's `subscription-usage.ts` reads `wham/usage` and the token's claims;
the llm-billing plugin reads the `x-codex-*` headers of Codex responses. Nothing
in the stack calls chat completions for `openai`; they are served for an
`openai-completions` route pointed at the API.

## Responses

The Responses API's own events (`wire-responses.mjs`), each `event:` plus a
`data:` line with `type` and `sequence_number`: `response.created`,
`response.in_progress`, per output item `response.output_item.added` …
`response.output_item.done` (a `think` is a `reasoning` item with a
summary, and `encrypted_content` when the request includes
`reasoning.encrypted_content`; a `say` a `message` of `output_text`; a
`tool` a `function_call` `fc_…` whose `call_id` is the script's id), and
`response.completed` with the Response and its usage (`input_tokens`
counting cached ones, `cached_tokens`, `reasoning_tokens`); `end
max-tokens` is `response.incomplete` with `max_output_tokens`. A whole
Response (`stream` not true) has the same `output`. The conversation is
read from the `input` items pi-ai replays (`store: false`): earlier
reasoning, messages and function calls, then `function_call_output`.

An API key account is charged at the catalog price of `openai/<model>`, the
price tier above `inputTokensAbove` and the request's `service_tier` (flex
half, priority double), as pi-ai's `calculateCost` prices it. Errors are
OpenAI's `{ error: { message, type, param, code } }` with an `x-request-id`:
no key and a key not starting `sk-` (or an account with `revoked: true`) are
401 (`invalid_api_key`); the script's `error` kinds are `rate_limit_exceeded`
(429, `retry-after`), `insufficient_quota` (429; also an empty balance),
`server_is_overloaded` (503), `server_error`, `timeout`,
`context_length_exceeded`, `invalid_request_error`; `network` drops the
connection. Request bodies may be compressed (`content-encoding` zstd, gzip,
deflate, br; the server decodes them for every provider).

## Plans

The sign-in page (`auth.openai.com/oauth/authorize`, as pi-ai's Codex login
sends a person there; the harness rewrites the link) is a form: an email
address and a plan (Plus, Pro; "Unchanged" keeps an existing account's, a new
one gets Plus). It accepts only a loopback `redirect_uri` (pi-ai's
`http://localhost:1455/auth/callback`) and redirects there with `code`,
`scope` and `state`. The token endpoint (form-encoded) checks the PKCE
verifier against the challenge and the redirect URI, and answers
`{ id_token, access_token, refresh_token, expires_in, token_type, scope }`:
the access token is a JWT (ten days) whose `https://api.openai.com/auth`
claim carries `chatgpt_account_id`, `chatgpt_plan_type`, `chatgpt_user_id`
and `chatgpt_account_user_id`, and `https://api.openai.com/profile` the
email (what pi-ai and `subscription-usage.ts` read; the signature is random,
the simulator looks tokens up). Refresh tokens `rt_…` are single use: a
second use is 401 `refresh_token_reused`. The device-code login (pi-ai's
"Device code login (headless)") issues a code `XXXX-XXXXX`, polls 403 until
the code is entered with an email on `/codex/device`, then answers the
authorization code and PKCE verifier pi-ai exchanges.

A Plan has a five-hour (primary) and a weekly (secondary) window of tokens
(input, output and cache writes, cache reads at a tenth): Plus 2M / 20M, Pro
12M / 120M. A window starts with its first request and empties when it
ends. Codex requests need `stream: true` and `store: false` (else 400, as
ChatGPT answers) and a `chatgpt-account-id` matching the token (else 403);
an expired token is 401 `token_expired`. Every Codex response carries
`x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at,reset-after-seconds}`
and `x-codex-credits-*` (no credits). The request that crosses 100% is
served; the next one is 429 `{ error: { type: "usage_limit_reached",
plan_type, resets_at, resets_in_seconds } }` until the window resets (pi-ai:
"You have hit your ChatGPT usage limit (pro plan). Try again in ~300
min."). `wham/usage` reports `plan_type`, `email`, `rate_limit.allowed`,
`limit_reached` and both windows (`used_percent` in whole percent,
`limit_window_seconds`, `reset_after_seconds`, `reset_at`; a window not
started resets a full length from now).

| Fixture | Account |
|---|---|
| `openai`, `openai-low` | OpenAI API key (`OPENAI_API_KEY`, route `openai`): $10, 5¢ of credit |
| `codex-plus` | ChatGPT Plus, `plus@example.com`, signed in to `openai-codex-oauth` |
| `codex-pro-80` | ChatGPT Pro with the primary window at 80% (`pro80@example.com`) |

A Plan fixture is signed in by dsd through `/_sim/sign-in` (the grant
`{ type: oauth, access, refresh, expires }` in `.credentials.yaml`; pi-ai's
own login also stores `accountId`, which it reads from the token anyway).
`codex-plus` and `codex-pro-80` both sign in to `openai-codex-oauth`, so they
do not go together.

## WebSocket: pin the transport to SSE

pi-ai's Codex transport defaults to `auto`: it first opens a WebSocket
(`wss://chatgpt.com/backend-api/codex/responses`, Node's global
`WebSocket`), and falls back to server-sent events over `fetch` only when
that fails before the response starts. The harness's provider simulation
wraps `globalThis.fetch` only, and Node's `WebSocket` does not use it
(checked on loopback), so under simulation that WebSocket would go to the
real `chatgpt.com` with the simulated token. The Codex fixtures therefore
set `transport: sse` on the `openai-codex-oauth` route; a simulated home
that signs in to Codex without one of them should set it too
(`llm-pi-ai.providers.openai-codex-oauth.transport: sse`). The simulator
serves the SSE path (pi-ai sends it zstd-compressed); it has no WebSocket
endpoint, since nothing could reach one until the harness redirects
WebSockets as well.

## Not simulated yet

OpenAI: the WebSocket transport and its `previous_response_id`
continuation; stored responses (`store: true`, `GET /v1/responses/<id>`,
`previous_response_id` over HTTP); model checks (any model id is served;
an unknown one is free); per-key rate limits other than the script's
`error`; `x-ratelimit-*` beyond fixed values; images and files. Codex:
credits, the code-review window and promos (always none); a model not
offered on a plan; `id_token` signatures and the JWKS.
