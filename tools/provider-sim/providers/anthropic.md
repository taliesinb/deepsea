# Anthropic (simulated)

| Host | Endpoints | Account |
|---|---|---|
| `api.deepseek.com` | `POST /anthropic/v1/messages` (DeepSeek's own adapter), `POST /chat/completions`, `/v1/chat/completions`, `GET /models`, `GET /user/balance` | a balance; empty is 402 |
| `api.anthropic.com` | `POST /v1/messages` (`x-api-key`, or an OAuth `Bearer sk-ant-oat…` with the `oauth-2025-04-20` beta), `GET /v1/models`, `GET /api/oauth/usage`, `GET /api/oauth/profile` | a key: a credit balance, too low is 400 `invalid_request_error`; an email: a Plan (below) |
| `claude.ai` | `GET /oauth/authorize` (the sign-in page), `POST /oauth/authorize` | |
| `platform.claude.com` (and `console.anthropic.com`) | `POST /v1/oauth/token` (`authorization_code`, `refresh_token`) | |

Anthropic answers in its own error shapes (`{ type: "error", error: { type,
message }, request_id }`, a `request-id` header): 401 `authentication_error`
(no key, a bad or expired OAuth token, an OAuth token without the beta), 400
for a missing `anthropic-version`, and the script's `error` kinds as
`rate_limit_error` (429), `overloaded_error` (529), `api_error`,
`timeout_error`, `billing_error`, `invalid_request_error`.

## Plans

The sign-in page (`claude.ai/oauth/authorize`, as pi-ai's
`loginAnthropic` sends a person there; under simulation the harness rewrites
the link) is a form: an email address and a plan (Pro, Max 5×, Max 20×;
"Unchanged" keeps an existing account's plan, a new one gets Max 5×). It
accepts only a loopback `redirect_uri` (pi-ai's `http://localhost:53692/callback`)
and redirects there with `code` and `state`. The token endpoint exchanges the
code (single use, ten minutes; the PKCE verifier is accepted without being
checked) for an access token `sk-ant-oat01-…` (one hour) and a refresh token
`sk-ant-ort01-…` (used once: a refresh issues a new pair). Tokens are rows of
the store's `tokens` table, tied to the account.

A Plan has a five-hour and a seven-day window of tokens (input, output and
cache writes, cache reads at a tenth): Pro 1M / 10M, Max 5× 5M / 50M, Max
20× 20M / 200M. A window starts with its first request and empties when it
ends. Every Plan response carries Anthropic's `anthropic-ratelimit-unified-*`
headers (status `allowed`, `allowed_warning` from 80%, per-window utilization
and reset); the request that crosses 100% is served, the next one is 429
`rate_limit_error` with status `rejected` and `retry-after` until the reset.
`/api/oauth/usage` reports `five_hour` and `seven_day` (`utilization` in
whole percent, `resets_at`, null before the window starts) and
`/api/oauth/profile` the account (email, uuid) and organization
(`organization_type` `claude_pro` / `claude_max`, `rate_limit_tier`), the
fields the harness's `subscription-usage.ts` reads.

| Fixture | Account |
|---|---|
| `anthropic`, `anthropic-low` | Anthropic API key (`ANTHROPIC_API_KEY`, route `anthropic`): $10, 5¢ of credit |
| `anthropic-max` | Anthropic Plan, Max 5×, `max@example.com`, signed in to `anthropic-oauth` |
| `anthropic-max-80` | the same with the five-hour window at 80% (`max80@example.com`) |
| `anthropic-max-signed-out`, `anthropic-max-80-signed-out` | the same accounts and route, not signed in (no grant stored) |

A sign-in fixture (`kind: email`, `signIn: <route>`) starts the throwaway
signed in, without a browser: dsd asks the simulator for tokens
(`/_sim/sign-in`) and writes the grant pi-ai would have stored after a
browser sign-in into the throwaway's `.credentials.yaml` (credentials-local's
record `llm-pi-ai/<route>`: `{ type: oauth, access, refresh, expires }`). A
throwaway holds one sign-in per route, so `anthropic-max` and
`anthropic-max-80` do not go together.

## Not simulated yet

Anthropic: `count_tokens`, message batches, files; the separate Opus and
Sonnet weekly windows and extra usage (always reported off); rate limits of
API keys (only the script's `error`); the usage endpoint's own rate limit.
