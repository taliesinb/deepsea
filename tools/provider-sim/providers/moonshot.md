# Moonshot AI and Kimi Code (simulated)

| Host | Endpoints | Account |
|---|---|---|
| `api.moonshot.ai`, `api.moonshot.cn` | `POST /v1/chat/completions` (streamed and whole), `GET /v1/models` | a key (`Bearer`): a balance; none left is 429 `exceeded_current_quota_error` |
| `api.kimi.com` | `POST /coding/v1/messages` (Anthropic messages, streamed and whole), `GET /coding/v1/models` | a Kimi Code key (`x-api-key` or `Bearer sk-…`) or a signed-in email (`Bearer` access token): a Plan |
| `auth.kimi.com` | `POST /api/oauth/device_authorization`, `POST /api/oauth/token` (`urn:ietf:params:oauth:grant-type:device_code`, `refresh_token`) | |
| `www.kimi.com` | `GET /code/authorize_device?user_code=…` (the page), `POST /code/authorize_device` | |

pi-ai reaches these as three providers: `moonshotai` and `moonshotai-cn`
(`openai-completions`, `MOONSHOT_API_KEY`, prices from their catalogs) and
`kimi-coding` (`anthropic-messages` at `https://api.kimi.com/coding`, a
`KIMI_API_KEY` or the Kimi Code sign-in of `auth/oauth/kimi-coding.js`, whose
route is `kimi-coding-oauth`, "Kimi For Coding Plan"). Nothing in the stack
reads a Moonshot balance (`/v1/users/me/balance`) or Kimi Code usage
(`/coding/v1/usages`): llm-billing estimates from tokens, and the harness's
`subscription-usage.ts` reads only Anthropic and Codex. So neither is served.

## The Kimi API

Chat completions put reasoning in `reasoning_content` and, as Moonshot does,
the final usage inside the choice (`choices[0].usage`, with Kimi's
`cached_tokens`), which pi-ai reads through its `choice.usage` fallback; tool
arguments stream in pieces. Errors are Moonshot's `{ error: { message, type } }`:
401 `incorrect_api_key_error` (no key) and `invalid_authentication_error` (a
Kimi Code sign-in token, as the platforms are separate), 404
`resource_not_found_error` for a model not in the catalog, 429
`exceeded_current_quota_error` "Your account <uid><ak-…> is suspended, please
check your plan and billing details" when the balance is spent, and the
script's `error` kinds as `rate_limit_reached_error`, `engine_overloaded_error`,
`server_error`, `invalid_authentication_error`, `exceeded_current_quota_error`,
`invalid_request_error`.

## Kimi Code

The sign-in is an RFC 8628 device-code grant, as pi-ai's `loginKimiCoding`
runs it: the device authorization answers a `user_code` (`ABCD-EFGH`), a
`device_code`, `verification_uri_complete`
`https://www.kimi.com/code/authorize_device?user_code=…` (under simulation the
harness rewrites the link to the simulator's page), `interval` 5 and
`expires_in` 1800. The page shows the code (filled from the link), an email
address and a plan (Go, Plus, Pro, Max, Ultra; "Unchanged" keeps an existing
account's plan, a new one gets Pro), with Authorize and Deny. Until then the
token endpoint answers 400 `authorization_pending`; then a JWT-shaped access
token (fifteen minutes) and refresh token (used once: a refresh issues a new
pair; a used or unknown one is 400 `invalid_grant`, which pi-ai treats as a
dead sign-in), or 400 `access_denied`, `expired_token`, `invalid_grant`.
Device codes in progress are kept in the simulator process (the page and the
poll reach the same one); tokens are rows of the store.

A Plan (an email signed in, or a Kimi Code key) counts every
`/coding/v1/messages` request against a five-hour window (Go 50, Plus 200, Pro
800, Max 2000, Ultra 5000 requests; it starts with its first request and empties
when it ends). A full window is Kimi Code's 403 "You've reached your 5-hour
usage limit. …" (`permission_error`); `k3`/`k3-256k` on Go and
`kimi-for-coding-highspeed` below Pro are its 401 "Your current subscription
does not have access to …". Generations are recorded at catalog prices (the
harness shows them as the API-price equivalent) but cost the Plan nothing.
Errors are Anthropic-shaped (`{ type: "error", error: { type, message } }`),
401 "Invalid Authentication" for an unknown or expired access token, and the
script's `error` kinds as Anthropic's types.

| Fixture | Account |
|---|---|
| `kimi` | Kimi API key (`MOONSHOT_API_KEY`, route `moonshotai`): $10 |
| `kimi-plan` | Kimi Code Plan, Pro, `kimi@example.com`, signed in to `kimi-coding-oauth` |
| `kimi-plan-signed-out` | the same account and route, not signed in (no grant stored) |

`kimi-plan` is signed in as every Plan fixture is (`/_sim/sign-in`, the grant
pi-ai stores: `{ type: oauth, access, refresh, expires }`); `/login` → "Kimi
For Coding Plan" signs in through the page instead.

## Not simulated yet

Kimi Code's weekly and monthly quotas, extra usage, the concurrency limit and
`/coding/v1/usages`; its OpenAI-protocol endpoint (`/coding/v1/chat/completions`)
and `api.kimi.ai`; the Kimi API's balance endpoint, rate limits (only the
script's `error`), files and `slow_down` on a too-fast device poll. A request
is not checked for the `reasoning_content` Kimi demands on assistant tool-call
messages when thinking is on, and `thinking: { type: "disabled" }` does not
silence a script's `think`. The Kimi Code page is the simulator's own; the real
verification URL's path is assumed.
