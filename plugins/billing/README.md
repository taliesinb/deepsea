# @deepsea/billing

A billing observer, a per-session billing store, and a compact composer pill, card and `/billing` report. It changes nothing it observes: no prompt or authentication changes, no forced transport, and no provider calls beyond the plan usage reads and receipt lookups described below.

This is not an invoice: money is a provider's reported charge where one exists, otherwise a marked estimate.

## What it shows

| Source | Implemented evidence | Money |
|---|---|---|
| Anthropic OAuth, native HTTP | Accepted plan-window claim; utilization/reset headers; explicit extra usage; rejected/unknown/unobserved | No conversion of plan tokens into dollars |
| OpenRouter, native HTTP SSE/JSON | Provider `usage.cost` and generation identity | Reported OpenRouter-account charge, not upstream BYOK charges |
| OpenAI Codex OAuth | `5h`/`7d` windows from ChatGPT's usage endpoint (WebSocket, pi-ai's default transport); over HTTP also each response's primary/secondary windows and credit facts | No dollar conversion; quota observation is **not** an Anthropic-style plan claim |
| API-key routes whose model DSH's catalog prices | Normalized token usage × `ctx.llm.resolveModelInfo(provider, model).pricing` | Versioned **model-token estimate** (`~$`); tools, media and contract discounts aren't priced |
| Unsupported/custom transports | Explicit unobserved evidence | Unknown, never an invented zero |

Only scoped inference requests are observed passively. Plan readings (5h/7d windows) are account-wide, so they belong to the **account** (see [Storage](#storage)): every session on that account shows the same reading, and the account's `latest.json` survives a restart, coming back marked stale when old rather than disappearing; a session on a plan route with no reading at all shows the shield with `—`, never the API glyph. A session with nothing recorded yet has no recorded route, so the client also sends the session's selected route (`modelSelection` projection: next, else last used) as `&route=`; it is used only when nothing is recorded for the session and only picks which account reading to show. The newest observed reading of an account wins. Staleness is based on server time: a reading older than `staleAfterMs` (default twenty minutes) is marked stale; the card's Updated row turns orange.

When the **displayed** session has no reading, or one older than `refreshAfterMs` (default five minutes), the host asks DSH for the account's current usage through `ctx.llm.subscriptionUsage(route)` (harness topic `billing-metadata`; implemented for `anthropic-oauth` via Anthropic's usage endpoint and for `openai-codex`/`openai-codex-oauth` via ChatGPT's Codex usage endpoint). That happens at most once per `refreshAfterMs` per account and only while a session on it is displayed; a failure retries after five minutes or the endpoint's `retry-after`, and a read that finds no sign-in yet retries after `usageRefreshMs` (one minute). A sign-in (or refreshed grant) on a plan route — DSH's `credentials/record-updated` for `llm-pi-ai/<route>` — reads that account's usage at once, so `/billing` and the footer show the quota before the first model request (the usage endpoint costs no tokens). A sign-in that adds its route only after storing the grant (`@deepsea/login`) finds no route at that event, so a plan route that first appears in `llm/adapters-updated` is read then too. In between, every model response's own headers keep the reading current. The reading also names the signed-in account when the provider identifies it (the harness's `LlmSubscriptionAccount`: Anthropic's `/api/oauth/profile`, read once per access token; Codex's token claims, no request), and the card lists it as Account (email; hover for the name), Organization (omitted for Anthropic's auto-named personal `…'s Organization`) and Plan (`claude_team` → `Team`). Header readings carry no identity: a connection's account is named by the usage read, and a header reading that arrives before that is held with the connection until it is. Where responses carry no reading — Codex over WebSocket, pi-ai's default — a finished request that reported usage marks the account's reading as behind, and the next display of a session on that account reads usage again (at most once a minute per account). An idle account is never re-read. Credentials never pass through this plugin: the model adapter makes the call with its own refreshed token. Codex readings are `quota` (account windows), not `plan` claims; credit facts come from Codex HTTP headers only.

### Sources

The host groups a session's requests into **sources**: one per connection and model vendor, so OpenRouter's Claude requests are the source "Anthropic" with the OpenRouter glyph, and an OpenRouter connection that served Anthropic and OpenAI models is two sources. Each source has a billing kind, shown as its glyph (the model picker's `RouteIcon`s as local SVG): **plan** (shield), **OpenRouter** (fork), **API key** (`</>`), or **local** (laptop: a model served on this machine, billed in tokens; see below). The **current source** is the source of the session's latest request; the others are history. Vendor names come from the model's router prefix or the connection's catalog provider (`openai-codex` → OpenAI, `deepseek-official` → DeepSeek); an unknown vendor goes by its connection's display name.

### Pill

The pill shows the current source only:

| Current source | Pill |
|---|---|
| Plan | shield + the fuller window's label, ContextMeter's ring and percent (`7d ◔ 31%`); stale readings dim the rings |
| Plan in extra usage | shield + orange `Extra` |
| OpenRouter / API key | glyph + money: reported and estimated amounts added into one figure, `~` and dimmed when an estimate adds 1% or more |
| Local | laptop + tokens (`9.7kT`) |
| Nothing priced | glyph + `$ —` |

A trailing orange info icon means the current source has failed, partial or unpriced requests; a red one means storage failed or the endpoint is unreachable. Earlier sources' gaps never warn. The tooltip spells everything out (`Anthropic plan · 7d 31% used`).

### Card

Clicking opens a card in the stat-dialog skin of the other composer pills (token usage): a heading naming the current billing (`Anthropic plan`, `OpenRouter API billing`, `DeepSeek API billing`, `Local model`) with its window rings (`◔ 5h  ◔ 7d`) or money on the right; then a framed key/value table for the current source in runs: Provider (`OpenRouter / Anthropic`) and Model (vendor prefix dropped) · Account, Organization, Plan (plan) · `5h Quota` / `7d Quota` (time to reset, omitted when it equals the window length; percent; ring) and Updated (only when a minute or more old, orange once stale), Credits (Codex) · Requests (`↑27`, with `↑1 failed` / `↑1 partial` / `↑3 unpriced` in orange beneath) and Cost. With two or more sources a second table lists every source (glyph, vendor, requests, money; the current one tinted) and a Σ Total row of the money spent. A plan's Cost is its API-price equivalent, struck through: what the same tokens would have cost on the provider's per-token API, never charged and never part of the Total. A storage failure adds a warning below.

Amounts are ordinary currency form over the host's exact decimals: two decimals, leading zero, thousands separators (`$0.04`, `$4.20`, `$1,024.10`), `<$0.01` for a positive amount below half a cent; the exact decimal is the hover title. `$` is USD (OpenRouter bills in USD; catalog prices are USD); `EUR`/`GBP` use their symbols, other currencies a code prefix; currencies are never converted or summed together. Money is session history and never goes stale; quota readings age by server time (`staleAfterMs`, default twenty minutes).

### `/billing`

The command answers with one line (`DeepSeek ~<$0.01 · 3 other providers`) followed by a JSON report (`report.mjs`); the browser registers a card for it on the keyed `conversation.chat.commandview` slot, so the transcript shows one billing card per provider, side by side, wrapping at the chat width: this session's sources first (local models with their tokens), then every other provider route DSH serves, with nothing used (`↑0`, `$0.00`; plans still show their account's quota, read on the spot if never read; local models the session never used are left out). The cards are the pill's card for that one source, frozen at the time the command ran. Without the browser half the row shows the line and the JSON.

### API key hint

An API-key or OpenRouter source shows **API Key** `…bbad`: the last four characters of the key its route uses, in the account run. The host finds the route's credential name (`apiKeyEnv`) through `llm.listConfigurableProviders()` and the settings service, resolves it through the credentials service, and keeps only the last four characters (keys shorter than 16 characters show nothing); the result is cached a minute per route. Routes without `apiKeyEnv` (pi-ai's own environment discovery) show no hint.

### Placement

The plugin registers in `conversation.composer.dock` at order -10, before the session stats (order 0), so billing is **leftmost** in the status area and the context meter stays rightmost, away from billing. Natural DOM order, so visual and keyboard order agree.

## Dependencies and coexistence

Host: the harness's `llm` service; `connection` and `commands` are optional subcontexts. The harness topics `billing-metadata` (on `pi-ai-oauth-routes`) provide `pricing`/`listPricing` on resolved model info, route metadata from `listProviders()`, `subscriptionUsage` and `responseCost`; on a harness without them each is absent and the plugin degrades as described. Plan routes are created by signing in (`@deepsea/login`), but nothing here depends on that plugin: OAuth transport and credential refresh remain the provider adapter's. Browser: `slots` plus the platform React modules.

Billing observes provider responses through a reference-counted, versioned passive fetch wrapper (`passive-fetch.mjs`, AsyncLocalStorage-scoped, endpoint-allowlisted). Its broker symbol (`Symbol.for('deepsea.passive-fetch-broker.v1')`) lets a second subscriber join the same wrapper. The OpenRouter parser is selected once per response. Under provider simulation (`DSH_PROVIDER_SIMULATOR`; tools/provider-sim/README.md) requests and responses go to the simulator at `<simulator>/<provider host><path>`; the wrapper reads them as the provider's URLs, so a simulated home is billed exactly as a real one.

## Storage

Everything lives under `$DSH_HOME/plugins/billing/` (config `directory`), as plain files: append-only where history matters, small JSON documents for current values. Directories are 0700, files 0600. Nothing stores prompts, completions, raw headers or credentials.

```
plugins/billing/
  sessions/<session-id>.jsonl          facts for one session, appended, never rewritten
  sessions/<session-id>.json           derived summary (totals, counts, connections), rewritten when the session changes
  accounts/<provider>-<hash8>/         one billed plan account
    identity.json                      email, name, organization, plan, first/last seen
    latest.json                        the current quota reading
    quota.jsonl                        every reading that changed (kind, windows to 0.1 %, resets), appended
  connections/<connection-id>.json     provider, auth kind, label, bound account, a reading not yet tied to an account
  prices/<provider>/<model>/<version>.json   the normalized price table actually used, with its source
```

- **Session fact log.** Live requests append `start` (connection, route, model, purpose), `usage` (DSH's cumulative `TokenUsage`; a later sample replaces an earlier one), `evidence` (outcome, response id, served model, a provider-reported `charge`, plan flag, account key) and `finish` (reason). Complete `request` records come from the history backfill; a `backfill` record marks the backfill done. Loading a session reads only its own file. A torn last line (crash mid-write) is skipped and terminated before the next append; nothing makes the store read-only.
- **Derived, never stored as fact.** Estimates (`~$`) and API-price equivalents are computed at read time from the price tables, so a price change re-derives them; the summary file records the price versions it used. A provider's reported charge is a fact and replaces the estimate of that request; the same provider response reported twice counts once, newest amount.
- **Connections.** A connection is one set of credentials plus settings. DSH has one per provider route today, so every route maps to the **implicit connection** `<route>-global` (`anthropic-oauth-global`), whose provider and auth kind come from the adapter's route metadata (`listProviders()`: `catalogProvider`, `auth`; inferred from the `-oauth` suffix on a harness without route metadata). A `local` connection (a model served on this machine: LM Studio, Apple Foundation, the scripted test model) is billed in **tokens**, the currency `TOK`, shown as T: one T per token the model processed (uncached input, cache writes and output; reasoning is part of output), cache reads free. The counts are the model server's own usage, so the amount is exact (never `~`) and never unpriced; a local request that reports no usage is not counted and is no gap. T is shown as a compact count (`20T`, `1.2kT`, `154kT`, `1MT`; never a decimal below a thousand nor a trailing `.0`), exactly in hover titles (`9,703T`), and beside money in totals (`$1.28 9.7kT`). Its label is the route's display name. Records carry the connection id, so several sign-ins per provider would need no change here.
- **Accounts.** `<provider>-<hash8>`: the first 8 hex digits of SHA-256 over `<provider>:<stable account id>` (the harness's `LlmSubscriptionAccount.id`: Anthropic account/organization uuids, Codex workspace/member ids; email as a fallback). The raw id is not written. Quota is account-wide, so two connections on the same sign-in share one reading and history. API-key connections have no account yet.
- **No lock.** DSH runs one server per home and this process serializes appends per file, so there is no writer lock to go stale.
- Auxiliary LLM calls (title, compaction) are recorded when they carry `sessionId`. Rewind/compaction isn't a refund. A forked session does not inherit its parent's costs (see the backfill). A request still unfinished when the process stopped is incomplete on reload, keeping its usage. Collecting billing never fails inference; a write failure marks storage unhealthy in the card.


## Read access

`GET /api/deepsea-billing/snapshot?sessionId=...[&route=...]` is registered through DSH's authenticated Fetch API, document-relative in the client, with `Cache-Control: no-store`. DSH's own authentication is the only check: anyone DSH admits can read any session's billing, exactly as they can read its transcript. DSH has no per-user or per-session access control (an admitted client can run tools as the host user), so a billing-only restriction would protect nothing. Isolating users from each other would have to happen in DSH for all session data. No HTTP ingestion or account-list endpoint exists.

Trusted host plugins can consume `ctx.deepseaBilling.snapshot(sessionId)` or publish allowlisted observations through `ctx.deepseaBilling.observe(observation)`. There is no browser path to that ingestion method. The optional `/billing` command operates on the calling agent's own session.

## Configuration

All fields are optional.

Counting: a request still in flight is only **pending** (its usage has not arrived). A request that ended in an error or cancellation **before any usage** is counted as **failed (not billed)**, not unpriced: nothing was processed (for example Anthropic's "credit balance is too low" rejection). A request that did process tokens and was then cancelled keeps its usage and is priced normally; one that completed without any usage stays **unpriced**.

### Requests the store never saw (history backfill)

The first time a session is displayed, the host reads its session log (optional `sessionQuery` service) and records, once, every assistant response the store has no live request for: responses from before the store existed, or from a period when it could not write. A live request covers the log messages that fall within its start..finish span (open-ended while in flight), so nothing is counted twice; fork-inherited events are skipped. Plan responses are recorded too (tokens and API-price equivalent, no charge). OpenRouter responses are looked up by generation id through `ctx.llm.responseCost` (harness topic `billing-metadata`; one request each, at most 500 per session, stopped early by a rate limit or auth failure) and recorded with the **reported** charge; a failed lookup leaves the catalog estimate (`~$`, still with the OpenRouter glyph: scope `openrouter-tokens`). The results are appended as `request` records (`history:<seq>`) followed by a `backfill` record (`through`: last log seq, `inheritedEvents`, `added`), so it never runs again for that session; without `sessionQuery` nothing is marked and a later process tries again. The log read and the receipt lookups run outside the session's write queue; the coverage check and the append run inside it. The snapshot that starts a backfill or a plan usage read waits up to five seconds for it; if the work takes longer the snapshot carries `refreshing: true` and the pill re-polls after two seconds.

Model ids may contain `~` (OpenRouter's `~vendor/model-latest` aliases) and are recorded as they are.

### Estimates from DSH's model catalog

With no rate cards, an API-key request is priced from the list prices DSH publishes on resolved model info: the harness's `llm-pi-ai` adapter (topic `billing-metadata`) reports the installed pi-ai catalog's rates as `pricing` (input, output, cache read/write per million tokens, optional input-size tiers, USD, source `pi-ai catalog <date>`). Plan routes (`-oauth`, `openai-codex`) publish no `pricing` and are never charged an estimate; they publish `listPricing` instead, the same model's per-token API list price, which gives the API-price equivalent shown struck through as a plan's Cost. Estimates are computed at read time; each price table used is written once to `prices/` with its version (`pi-ai-catalog-<date>`) and source. Lookups are cached per route/model for ten minutes. On a harness without the `pricing` field, API-key requests stay unpriced (`$ —`). A catalog model without rates, or cache use without a cache rate, stays unpriced rather than assumed free. Anthropic's 1-hour cache-write surcharge is not represented because usage does not distinguish it. An explicit rate card below, when configured, takes precedence.

```yaml
config:
  staleAfterMs: 1200000    # mark a quota reading stale after this long
  refreshAfterMs: 300000   # re-read an older reading while a session on its account is displayed (≥ 60000)
  # directory: /absolute/path/in/an/isolated/home/billing
  rateCards: []
```

### Built-in price lists

Routes whose adapter publishes no prices get a built-in list from [default-rates.mjs](default-rates.mjs): today DSH's own DeepSeek adapters (routes `deepseek-official`, keyed by an API key, and `deepseek-account`, the signed-in DeepSeek Platform account; same per-token prices: `deepseek-flash`, the retired alias `deepseek-v4-flash`, `deepseek-v4-pro`), from DeepSeek's [pricing page](https://api-docs.deepseek.com/quick_start/pricing/) as read on 2026-10-05, version `deepseek-2026-10-05`. DeepSeek charges by time of day: the cards hold peak rates and a `timeOfDay` rule (peak 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday; otherwise half price), applied at each request's start time. Chinese public holidays are off-peak at DeepSeek but not modelled, so a request on one is estimated at the peak rate. A cache hit is `cacheReadPerMillion`; any other input is a cache miss. A configured rate card for the same route and model replaces the built-in one. Update the file (and its `version`) when DeepSeek changes prices.

A rate card is explicit and matches an exact route (`provider` field) and model; it wins over catalog prices. Every card used is recorded under `prices/`. This **synthetic example is not a real model's price**:

```yaml
rateCards:
  - provider: openai
    model: fixture-model
    currency: USD
    version: fixture-v1
    source: https://example.com/prices
    inputMode: exclusive
    inputPerMillion: '2'
    outputPerMillion: '8'
    cacheReadPerMillion: '0.2'
    cacheWritePerMillion: '3'
    maxInputTokens: 128000
    # Optional: rates above are peak rates; outside these UTC hours/days multiply by offPeakFactor.
    timeOfDay:
      peakHoursUtc: [[1, 4], [6, 10]]   # [start, end) whole hours
      peakDays: [1, 2, 3, 4, 5]         # 0 = Sunday
      offPeakFactor: '0.5'
```

`exclusive` means `inputTokens` excludes cache reads/writes, as required by DSH's normalized `TokenUsage` contract. `inclusive` is rejected: normalizing provider-total input is the adapter's job; subtracting cache here would double-subtract it. Missing cache rates with nonzero cache use make the request unpriced. OAuth routes cannot be assigned API rate cards. Context limits avoid applying a short-context price beyond its known range. Sources must be public HTTPS URLs without embedded credentials or query strings. Token prices do not include hosted-tool calls, multimodal fees or negotiated/provider-account charges.

## Build and tests

From this directory:

```sh
pnpm install && pnpm typecheck && pnpm build && pnpm test
```

Real DSH/pi-ai tests, **all provider network replaced with fixtures**, from the repository root (they run in the harness build, through the `harness` link):

```sh
(cd harness && node --import tsx/esm --test "$OLDPWD/plugins/billing/tests/collector-integration.mjs" "$OLDPWD/plugins/billing/tests/integration.mjs")
```

The browser fixture and its exact launch command are in [tests/fixture-server.mjs](tests/fixture-server.mjs). It serves mock data and a shell-shaped dock, not a running server. No provider credentials are needed.

In a real server: `dsd run release --throwaway-server --plugins billing` (tools/dsd/README.md).

## Limitations and next steps

1. Codex WebSocket telemetry through a supported hook; never force SSE to obtain billing data. Until then the usage endpoint stands in, so a Codex reading lags a turn by up to one client poll and does not show credits.
2. OpenRouter generation-lookup reconciliation and more complete BYOK reporting; no extra network calls in this version.
3. Maintained rate-card acquisition, actual served-model/service-tier pricing, multimodal and hosted-tool fees. Current estimates price the explicitly configured requested model's normalized tokens only.
4. A cross-session index (spend by day/account, quota time series) as a derived SQLite database rebuilt from these files, when a report needs it. API-key accounts have no identity yet: the adapter does not expose a key fingerprint.
