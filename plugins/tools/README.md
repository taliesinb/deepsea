# @deepsea/tools

`/tools` lists the tools the session's agent can call, without a model turn
(a command never becomes a model message, so it costs no tokens), in its own
chat card.

```
/tools                  every visible tool, sorted by name
/tools *session*        glob on the name: * any run, ? one character, case-insensitive
/tools chrome_ safari_  bare words: substring of the name; a word no name contains
                        matches descriptions instead; several patterns combine with OR
/tools wait             an exact name, or a pattern with a single match, opens that row
```

## The card

- **Header** like every command row: `tools`, the patterns, `39 tools` /
  `2 of 39 tools`, and `ptc` when the agent's tools are presented through
  `run_code`. Clicking it folds the table.
- **Table**: name | arguments | description, one row per tool with a divider
  between tools, every row rendered (no inner scroll). The name column fits
  the longest name and never truncates; the arguments column fits its
  longest list but is capped at 30% of the card, so the description keeps
  priority. Optional parameters are dimmed everywhere (no `?`, no
  "required" label). The arguments cell shows at most three names (required
  first), space-separated, then `…`: only whole names, so a narrow column
  shows fewer. Hovering it lists every parameter as name | type. The
  description is the first sentence of the tool's description, one line.
- **Clicking a row expands it** to the full description (Markdown), a
  divider, then a table of the parameters: name | type (`string`, `a|b` for
  enums, `string[]`) | description, the last column wrapping.
- Below about 520px of card width the arguments column is dropped (its width
  goes to zero rather than `display: none`, since the expanded row's
  `colspan` would otherwise re-create the third column of the fixed layout).
- An error (`No tools match zzz (39 visible).`) shows in the header, red.

The card is the keyed `conversation.chat.commandview` entry for `tools`;
its classes are `deepsea-tools*`, its stylesheet a `<style data-deepsea-tools>`.

## What "visible" means

The list is `ctx.tools.schemas(agent)`: the registry's view for the agent's
scope, which is the one the model's request is built from. Preset
restrictions (`ctx.tools.restrict`, e.g. Minimal mode, the no-tools presets)
and the agent's own scoped registrations apply. Under the `ptc`
presentation the model is sent only `run_code` and calls the rest through
it; the card still lists them all. The mode comes from the registry's
`modeFor(scope)`, which is private in the harness's TypeScript (no public
accessor exists); when it is missing the mode is left out. Subagents are not
addressed: `/tools` always lists the session's top-level agent. DSH has no
deferred-tool mechanism, so every registered tool the scope allows is listed.

## Result format

The command's result text is a count line followed by a JSON listing
(`listing.mjs`: `encodeListing` / `decodeListing`, version `v: 1`) with
every matched tool's name, first sentence, description (capped at 4000
characters) and parameters (descriptions capped at 1000). A client without
the card (another UI, the generic command row) shows the count line and the
JSON. About 1 KB per tool in the session log.

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

`pnpm test` covers matching, parameter entries, the listing round trip and
`apply` against a fake registry; `pnpm typecheck` the browser half. Host
module edits need a server restart; `pnpm build` / `pnpm watch` rebuilds
`lib/client.js`, which hot-swaps into open GUIs (`pnpm install` runs
`prepare`, which builds it too).

In a server: `dsd run release --throwaway-app --scripted --plugins tools`,
then `dsd drive command last /tools` for the result text, or type `/tools`
in the app for the card (tools/dsd/README.md).
