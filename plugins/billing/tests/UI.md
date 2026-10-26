# Billing browser fixture

This fixture uses the real billing component and the checkout's platform positioning/dismissal hooks. It does not boot DSH, access a DSH home, load provider credentials, or call a model. Its mock request interceptor requires the document-relative endpoint `/fixture/api/deepsea-billing/snapshot`; a leading-slash production fetch fails the fixture.

From this package:

```sh
pnpm typecheck
node --test tests/client.test.mjs
pnpm build
node tests/fixture-server.mjs
```

Open the printed `/fixture/` URL. Optional `PORT` selects a port. The server bundles into memory; restart it after source edits. Only this plugin's `pnpm build` writes its own `lib/client.js`.

## Browser checks

Each case button loads one mock snapshot and opens the card: `api-one`, `sub-one`, `sub-then-or`, `or-then-sub`, `multi`, `codex`, `sub-extra`, `sub-stale`, `unpriced`, `local`, `all-subs`, `current-failed`, `empty`, `storage-error`, `forbidden`, `delayed`, `wrong-session`. The page loads DSH's real theme tokens (`ui-theme/src/styles/design-platform.css`) and draws ContextMeter's exact ring beside the pill for comparison.

On a fresh page, evaluate `await window.billingFixture.run()`. It checks the plan pill and card, Escape and trigger-focus restoration, warnings for the current source only, no previous-session flash while a snapshot is pending, hidden-dock and unmount abort cleanup, 403 and misaddressed snapshots clearing account data, and the storage-failure warning. `window.billingFixture.requests` records requests and aborts; `select(case, sessionId?)` loads a case.
