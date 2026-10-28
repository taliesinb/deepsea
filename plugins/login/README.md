# @deepsea/login

Sign-ins to provider plans and other browser (OAuth) sign-ins, from the chat
and from the Models page. llm-pi-ai registers each flow with
`ctx.authorization`: plans (Anthropic Claude Pro/Max, ChatGPT/Codex, GitHub
Copilot, …) and pay-per-use OAuth (OpenRouter, …).

```text
/login FLOW [oauth]            start a sign-in; its route appears once it is authorized
/login FLOW <address>          finish it with the address a browser on another machine ended on
/login                         the flows offering a sign-in (= /logins available)
/logout FLOW                   delete a stored sign-in
/logins [list]                 flows whose sign-in is stored
/logins available [STRING]     flows offering a sign-in, optionally filtered
/logins pending                attempts in flight
/logins cancel [FLOW]          withdraw one or every pending attempt
```

Each command shows its result in the plugin's own chat card, where a sign-in
link is one click.

## Pickers and placeholders

- A bare `/login` (Enter on it, or picking it from the slash menu) opens a
  searchable picker of the sign-in flows: the route's name (`Anthropic Plan`,
  `OpenRouter OAuth`), the flow name, and `signed in` on the active ones. A
  flow offering several methods gets one row per method (every pi-ai flow
  has one, `oauth`). The pick runs `/login <flow>` like a typed line, card
  included.
- A bare `/logout` opens the same picker over the active sign-ins only.
- After `/login ` and `/logout ` the composer placeholder lists the flow names
  (`[anthropic, github-copilot, …] [oauth | <address>]`): the ones registered when the
  plugin loads, else pi-ai 0.87.1's set (`KNOWN_FLOWS`).
- Both pickers read `GET /api/deepsea-login/flows` (name, label, route, kind,
  vendor, methods, active, pending; no secrets) each time they open. They are
  `ctx.commandUi` decorations: typed arguments still go straight to the host
  command. DSH's command system has no as-you-type completion for arguments,
  so the picker is where the names are offered.

## Add login (Settings → Models → Plans)

The Plans section of the Models page ends in an **Add login** button (the
`settings.models.section-actions` seat, key `plans`; absent on a harness
without it). Its dialog:

- lists the plan sign-ins (flows whose route llm-pi-ai classifies as
  `subscription`: Anthropic, GitHub Copilot, Kimi For Coding, Meta, OpenAI
  Codex, xAI) by vendor, marking the signed-in ones; pay-per-use OAuth flows
  (OpenRouter, Radius) are not plans and are left to `/login`;
- starts the same attempt `/login` would (`POST /api/deepsea-login/start`; a
  pending one is reused), and answers the flow's own questions inline: a
  choice (Codex: browser or device code) as buttons, a text field (Copilot:
  Enterprise domain) as an input;
- shows **Authorize in browser** with the short URL beside it
  (`claude.ai/oauth/authorize`), plus the device code when there is one. Both
  are real links: a new tab in a browser, `open` through the DeepSea app's
  `__DEEPSEA_APP__.openExternal`. Nothing opens by itself;
- while the flow takes one (`paste: true` in the status), a field for the
  address the browser ended on (below), sent as `POST
  /api/deepsea-login/answer { flow, paste }`;
- polls `GET /api/deepsea-login/status?flow=` every second while pending
  ("Waiting for authorization…"), then shows "Signed in as <email>" (the
  account from `llm.describeSignIn`), the error, or "Sign-in cancelled" with
  Back / Try again;
- **Cancel** (and closing the dialog) cancels the attempt
  (`POST /api/deepsea-login/cancel`), which also frees the flow's callback
  port.

All routes sit behind DSH's own authentication; the POSTs require a JSON
body, so a cross-site form cannot reach them without a CORS preflight the
server never answers.

## Opening the sign-in page

- When `/login` returns a sign-in URL, typed (`command/executed`, emitted only
  to the client that ran it) or picked, the browser half opens it in the
  user's own browser: the DeepSea app's `__DEEPSEA_APP__.openExternal`
  (native, no click needed; also from a framed remote session through
  `window.top`), else `window.open` in a new tab, which a browser may block
  if the Enter that ran the command is too long ago.
- The card says "If the sign-in page didn't open, click this link: …", and
  its link opens in the user's browser too: the card wraps its Markdown in
  its own `MarkdownDelegateProvider`, so the chat's link setting (default:
  the sidebar browser) does not apply. A sign-in page needs the browser
  holding the provider session, and its redirect goes to a loopback
  callback.

## A browser on another machine

pi-ai's loopback flows redirect to `http://localhost:<port>/callback`
(Anthropic: 53692) on the machine running the server. When the server is
another machine's (a remote workspace, a tailnet URL, a phone), the browser
lands on its own machine's loopback, where nothing listens, and the page does
not load. Those flows also ask, racing the callback, for the address the
browser ended on (pi-ai's `manual_code`); this plugin never puts that question
to anyone, since the callback usually wins, but holds it on the attempt:

- the card adds, when the sign-in URL's `redirect_uri` is a loopback address,
  "If the browser ends on a `localhost:53692/callback` page that does not
  load, copy its address and run `/login anthropic <address>`";
- `/login FLOW <address>` (a word with `://`, `=` or `#`, so never a method)
  hands the address, or a bare `code#state`, to the pending attempt and waits
  up to 30 s for it: "Signed in to anthropic.", the provider's error (a wrong
  or stale code), or that the sign-in is still finishing. With no attempt
  waiting, or a flow that takes no address, it says so;
- the Add login dialog shows a field for it while the flow takes one.

Whichever comes first wins: once the callback succeeds the question is
withdrawn, and a later paste is refused. The code in the address is good only
once and only with the attempt's own PKCE verifier, which never leaves the
server; a `/login` line is still recorded in the session like any command.
The DeepSea apps save the copy: the macOS app and the Linux client forward a
sign-in page's loopback callback port from its server's machine before they
open it, also for a session framed through remote-workspaces (apps/macos,
apps/linux). The paste remains for a plain browser, and for a forward that
cannot be made.

## Requirements

Harness topics `pi-ai-oauth-routes` (llm-pi-ai keeps each OAuth sign-in on
its own route: provider `X` gets a route `X-oauth` with its grant at the
credential key `llm-pi-ai/X-oauth`, separate from route `X` and its API key)
and, for Add login, `settings-models-signins`. Without the first, this plugin
lists no flows.

## Behaviour

- **Flow names** are the credential keys without the `llm-pi-ai/` scope and
  the `-oauth` suffix: `/login anthropic` authorizes `anthropic-oauth`.
- **Plan or not** is llm-pi-ai's call, not this plugin's: it classifies each
  `-oauth` route from pi-ai's `isSubscription`, so the route is called
  `Anthropic Plan` in the model picker and billing, but OpenRouter's sign-in
  (which issues a pay-per-use key) `OpenRouter OAuth`.
- **The route appears with the sign-in.** Once a sign-in is authorized, its
  route is added as an empty profile through `ctx.settings`, in the form
  namespace llm-pi-ai reports for it (`listConfigurableProviders()` →
  `settingsNs`, `settingsPath`): the same write the Models page makes,
  persisted in the profile's `cordis.patch.yml`. A sign-in in progress,
  cancelled or failed adds nothing, so it shows no provider in the model
  picker or on the Models page. A route that already exists, even as an empty
  profile, is reused and never overwritten.
- **The result** is the provider's browser URL as a Markdown link (plus a
  device code when the flow has one). The browser callback completes the
  sign-in, or the address pasted with `/login FLOW <address>` when the
  browser is on another machine (above). With no URL within 30 s (paused while
  a question is open) the attempt is withdrawn.
- **Prerequisite questions** (account type, domain, login method) are asked
  in the initiating session through `ctx.userQuestions`; nothing is chosen
  automatically. Secret prompts are refused: API keys belong on the Models
  page.
- **`/logout`** deletes the stored sign-in, and the route with it while the
  route is still the empty profile a sign-in added; a route you customized
  stays (without its sign-in). It forgets the sign-in locally and does not
  revoke it at the provider. A Plans card with a red dot therefore means a
  sign-in that exists but is broken: its grant is missing, or the provider
  refused a refresh.

## Files

| File | Role |
|---|---|
| `index.js` | host half: the three commands and the Add login routes (`runLogin`, `runLogout`, `runLogins`, `signInRoutes` are exported for tests) |
| `src/client/index.tsx`, `style.css` | browser half: the keyed `conversation.chat.commandview` card for all three, the `/login` / `/logout` pickers |
| `src/client/plans.tsx` | the Models page's **Add login** button and dialog |
| `src/client/browser.ts` | opening a sign-in page in the user's own browser |
| `build.mjs` | esbuild → `lib/client.js` in the shell's module-loader wrapper |
| `cordis.patch.yml` | bundle patch inserting the `deepsea-login` row |

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

`pnpm install` needs the repository's `harness` link (`dsd link`).
