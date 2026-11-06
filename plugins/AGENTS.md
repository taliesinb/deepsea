# AGENTS.md — plugins

One directory per plugin, each an installable npm package. Names follow
[LAYOUT.md](../LAYOUT.md) §1: directory `plugins/<name>`, package
`@deepsea/<name>`, loader row id `deepsea-<name>`.

## A plugin directory

```
plugins/<name>/
  package.json        name, dsh.bundle.patch (and dsh.client for a browser half), scripts
  cordis.patch.yml    the bundle row(s) this package inserts when installed; at least one
                      row is named after the package (dsd loads the plugin through it)
  index.js            host half (Node): apply(ctx, config)
  src/client/         browser half, if any (TypeScript/TSX)
  build.mjs           builds lib/client.js (esbuild)
  tests/              node:test, run by `pnpm test`
  README.md           what it does, configuration, how it works, limits
```

The harness topics a plugin needs are declared in its package.json,
`"deepsea": { "requires": ["<harness topic>", …] }`; `dsd topics` reads them.

Dependencies on the harness are `link:` devDependencies through the
`harness` link (`link:../../harness/packages/...`), for types and tests only.

## Names

Every name a plugin puts into a namespace it shares with the harness or
with other plugins carries a DeepSea prefix, so it can never collide with an
upstream name and can be found by searching for `deepsea`.

A plugin's own name is `<family>-<subject>`, lowercase kebab, at most three
words, never `deepsea` inside (the scope and the row prefix supply it):

- the family is the plane or registry it contributes to, in upstream's
  words: `tool-` (model tools), `command-` (slash commands), `ui-` (browser
  only), `llm-` (model providers and request shaping), `session-`,
  `workspace-`, `preset-`, `host-` (server infrastructure), `dev-` (test
  only);
- the subject is the name the person or the model already uses: the tool
  (`tool-wait`), the command (`command-reboot` for `/reboot`) or the product
  (`host-tailscale`); the role, not the mechanism (`llm-sign-in`, not
  `-oauth`).

Its English title (`locale/en.json`, `meta.title`) is for people, in
sentence case with the family noun where it helps ("Server reboot",
"Browser tools"); Settings shows the row id beside it.

| Namespace | Form | Example |
|---|---|---|
| Plugin directory, package, loader row | `plugins/<name>`, `@deepsea/<name>`, `deepsea-<name>` | `plugins/command-reboot`, `@deepsea/command-reboot`, `deepsea-command-reboot` |
| Cordis plugin `name` export | the loader row id | `deepsea-command-reboot` |
| Services a plugin provides (`ctx.provide`) | `deepsea<Feature>` | `deepseaBilling` |
| Fetch routes (`ctx.connection.fetch`, under `/api`) | `/api/deepsea-<name>/…` | `/api/deepsea-billing/snapshot` |
| Web server routes (outside `/api`) | `/deepsea-<name>/…` | `/deepsea-test-driver/health` |
| HTTP headers of our own | `x-deepsea-<name>[-…]` | `x-deepsea-tailscale` |
| CSS classes, DOM ids, `data-*` attributes | `deepsea-<name>-…`, `data-deepsea-…` | `deepsea-billing-pill` |
| Page globals | `__DEEPSEA_<NAME>__` | `__DEEPSEA_APP__` |
| Browser storage keys, `Symbol.for` keys | `deepsea.<name>.<key>` | `deepsea.ui-numbered-switching.slots` |
| Config schema `vendor` | the loader row id | `deepsea-llm-billing` |

Names the model or the person sees keep their meaning and stay as they are:
tool names (`list_dir`, `wait`), slash commands (`/reboot`), setting labels.

**Wire names are protocol.** Routes, headers, page globals, services and
remote or event names, archive suffixes and formats, preset ids
(`minimal-no-tools`) and CSS classes or `data-deepsea-*` attributes that
apps and themes may target keep their names when a plugin is renamed: each
is an explicit constant, not derived from the package name, with a one-line
comment saying it is a wire name kept from the old name. That is why some
examples above carry a plugin's former name. What a plugin persists under
its name moves with it:

- `$DSH_HOME/plugins/<old>/`: the plugin reads `plugins/<new>/`, and when
  it starts with only the old directory present it renames it itself;
- browser storage `deepsea.<old>.<key>`: the browser half reads the old key
  once when the new one is absent, writes the new one and removes the old;
- profile-patch rows `id: deepsea-<old>`, state directories and a variant's
  plugin list: dsd migrates homes (tools/dsd/README.md → Renamed plugins),
  from its table of renames, `tools/dsd/lib/renames.mjs`, where every old
  name is added.

Contracts between plugins, so plugins ported separately agree (the first
column holds wire names, which keep a renamed plugin's former name):

| Contract | Provided by | Used by |
|---|---|---|
| service `deepseaBilling` (session snapshots) | `llm-billing` | (tests) |
| environment `DEEPSEA_RELAY` (the URL of the relay that started this server; absent without one) | the relay (`apps/relay`) | `command-reboot`, `host-backup`, `host-tailscale` |
| service `deepseaSessionOwners` (which login drives which session) | `host-tailscale` | `llm-billing` |
| service `deepseaRemoteWorkspaces` (remote session rows) | `workspace-remote` (browser half) | `ui-numbered-switching` |
| headers `x-deepsea-tailscale: 1`, `x-deepsea-tailscale-self: 1`, `x-deepsea-tailscale-admitted: user\|cookie\|public`, `x-deepsea-tailscale-login: <login>` on proxied requests | `host-tailscale` | `session-import` (the first two); the plugin itself |
| header `x-deepsea-relay: starting\|failed` on the relay's 503 while `dsh web` starts | the relay | the macOS app (shows the relay's page), `command-reboot` |
| route `<serve path>/api/deepsea-tailscale/loopback-forward?port=<n>` (WebSocket) and its refusal header `X-DeepSea-Forward-Error` | `host-tailscale` | the macOS app |
| attribute `data-deepsea-remote-session` on remote session rows | `workspace-remote` | `ui-numbered-switching` |
| page global `__DEEPSEA_SESSION_TITLE_SLUG__` (`{ parseSlug }`) | `session-title-slug` | `workspace-remote` (slug previews on its New Session rows) |

A plugin that uses a contract whose provider is not ported yet keeps the use
(optional, as before) under the new name. `dialog-keys.ts` (Enter presses a
dialog's default button) is copied into each plugin with a dialog; keep the
copies identical.

## Host half

- Register through `ctx` (tools, commands, Fetch routes, listeners); wrap
  anything Cordis does not manage in `ctx.effect(() => … return dispose)`.
- `inject` names required services; an optional one is reached with
  `ctx.inject([name], callback)` or `ctx.get(name)`.
- Export a `Config` schema; invalid configuration fails the load before
  `apply` runs. A later patch layer replaces a row's whole `config`.
- Host module edits need a server restart; module-source hot reload is off.
- Log with `ctx.logger` (`info`, `warn`, `error`, `debug`). The harness keeps
  no log sink after startup; `plugins/host-server-log` writes the messages to the
  server's standard error, which `dsd` captures into the throwaway's server
  log (`dsd run` loads it into every throwaway). Messages logged at startup,
  before host-server-log is active, are written when it starts, from the logger's
  buffer, except `debug` ones (the buffer keeps info and above).
- State goes under `$DSH_HOME/plugins/<name>/`, traces and logs under the
  variant's log directory (LAYOUT.md §4-5), scratch under
  `$TMPDIR/deepsea-<name>-…`.
- Logs and traces go through `@deepsea/logs` (`packages/logs`; dependency
  `"@deepsea/logs": "link:../../packages/logs"`): `createTrace` for an
  optional JSONL trace (configured with `trace: true`), `openRunLog` for a
  log per run or per child process, `pluginLogDirectory` for anything else.
  Never copy its code into a plugin.
- **Machine-wide plugins.** A plugin that acts on something outside its
  variant (a browser it drives, local model servers it starts and stops, a
  Tailscale Serve path, a licensed external program) declares it in
  package.json: `"deepsea": { "machineWide": "<what it controls>" }`.
  `dsd run … --plugins all` leaves such plugins out of throwaway variants
  (naming one includes it), so a throwaway never acts on a resource a real
  variant is using.
- Fetch routes (`ctx.connection.fetch.register`) sit behind DSH's own
  authentication; a state-changing route takes POST with a JSON body so a
  cross-site form cannot reach it without a CORS preflight.

## Presets

A DeepSea plugin is a global plugin by default: its bundle patch inserts a
Host row, and Settings → Built-in plugins lists it under Global plugins. A
plugin that is **preset-capable** may join the harness's agent presets
instead, where it lists under Session plugins, as upstream's `tool-fs` and
`tool-jobs` do. Preset-capable means everything it registers works from an
agent preset's context, which is shared by the agents of that preset and
mounted once per preset: tools, system-prompt sections and runtime-context
lines, read Host services (`inject`, `ctx.get`). No routes, no browser
half, no service another row reads (a preset that publishes one outside an
`isolate` realm fails to mount), nothing process-wide; and it must load
without failing, since one failed row fails the whole preset. It declares
the presets it joins in package.json:

```json
"deepsea": { "presets": { "joinWith": ["@deepseek-ai/dsh-tool-fs-search"] } }
```

`joinWith` (one module name or a list) means: every agent preset, as
composed for the web profile, whose plugin list has an enabled row of one
of these modules (inside a group too). Its own row (the one its bundle patch
inserts, named after the package) is added right after that row, and the
global one is disabled. Name upstream modules, not row ids or preset ids,
so the rule holds when upstream adds, renames or reorders presets; pick the
upstream tool the plugin goes with, so it joins exactly the presets that
have that capability (a preset without tools, such as `minimal-no-tools`,
never gets one). dsd writes the presets at each install and the person's
edits win (tools/dsd/README.md → Generated presets). A row's `config` in a
preset is set there, in the Web preset editor or in a `--patch` row for
its own id (which dsd carries into the presets). The plugin's README says
what it joins with and why.

## Browser half

- Declared by `{ "dsh": { "client": { "platform": "web" } } }` and the
  `./client` export (`lib/client.js`); the bundle must exist when the server
  starts.
- The bundle is a CJS module wrapped in
  `window.__ModuleLoader__.load({ id: '<package name>', factory })`. Only the
  shell's platform modules stay external: `react`, `react/jsx-runtime`,
  `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-ui-primitives`. Everything else is inlined.
  Mirror: `harness/packages/client/web/src/platform.ts`.
- Runtime imports of other `@deepseek-ai/*` client packages are forbidden;
  `import type {}` is how slot declarations are pulled in.
- UI is contributed through slots (`ctx.slots.inject(name, () =>
  ctx.slots.register(...))`); components never see `ctx`. Reference:
  `harness/docs/subsystems/slots.md`.
- Rebuilding `lib/client.js` hot-swaps every browser running the plugin.

## Testing

- `pnpm test` (node:test) for host logic and pure client helpers;
  `pnpm typecheck` against the linked harness packages.
- Exercise a plugin in a throwaway (AGENTS.md → Trying and testing has the
  table): `dsd run release --throwaway-server --scripted --plugins <name>`
  (tools/dsd/README.md), never in the instance the user is working in. With `--scripted` every prompt is a JSONL script
  of the model's exact reply, so turns, tool calls and their UI can be
  tested without an API key (plugins/llm-scripted/README.md). Drive it
  from the shell with `dsd drive` (create-session, prompt, command, events;
  plugins/dev-test-driver/README.md) rather than through a browser. For a
  browser half, use `--throwaway-app`: the real macOS app, hidden, driven
  with `dsd drive` (wait-page, click, hover, type, eval, describe, snapshot) or a
  `dsd script` (tools/dsd/README.md), so what you check is what the person
  sees. For anything that depends on the server going away and coming back
  (`/reboot`, `/restore`, a cold start), use `--throwaway`: the same app
  behind a relay, as an installed variant runs; `dsd logs <id> server
  --follow` shows each start.
- Anything that touches model providers (routes, the model picker, sign-in,
  keys, billing, quotas, errors from a provider) is tested with
  `--simulated` (tools/provider-sim/README.md): every provider is replaced
  by the local simulator, with test accounts that keep credit, balance and
  usage, and the same scripts. The default accounts (`standard`) give every
  provider route a key or a signed-in Plan; name others for edge states
  (`--accounts standard,anthropic-max-80,openrouter-empty`). An interactive
  sign-in works too: the hidden app records the sign-in page instead of
  opening a browser (`dsd drive -v <id> opened`), you `load` it, fill in an
  email and submit. Real accounts are used only by the user, or with their
  go-ahead.
- To hand the user a build to try, `dsd play` (visible, every plugin,
  simulated providers); say which accounts it has (the `simulated` field of
  its output).
- Before calling a topic done, check it beside the others: `dsd topics
  check` (conflicts) and, after `dsd topics integrate`, a throwaway from
  `--source integration/base --plugins all`.
