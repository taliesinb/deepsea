# @deepsea/session-reference-picker

`%` in the composer opens a picker of **sessions only**, each named
`workspace/session`, newest activity first. Picking one inserts the same
session-reference chip the built-in `@` picker inserts, so the model gets the
referenced session the usual way.

```
%rel          widgets / fix-login-redirect        2min
              widgets / release-notes             4h
```

## Behavior

- The list holds ordinary sessions other than the current one: no subagent
  sessions, no blank New Session, nothing archived (as the sidebar hides
  archived sessions).
- Rows read `workspace / session`, the separator dimmed, with a compact age
  of the last activity (`now`, `2min`, `4h`, `3d`), newest first. The workspace is its stored
  title (the default workspace's is `default-workspace`).
- `%foo` matches `foo` anywhere in `workspace/session`, case-insensitively.
- `%foo/bar` matches `foo` in the workspace name and `bar` in the session
  name. Either half may be empty: `%foo/` lists one workspace, `%/bar`
  searches session names across all workspaces.
- A session registered to no workspace is named after its working directory
  (`(unregistered)` when it has none).
- A pick inserts the chip `@[workspace/session](dsh-session:…)`, the
  canonical mention the server's session-reference resolver reads: the
  session is found by its id in the URI, the label is only for reading.

## How it works

Browser-only (`dsh.client.platform: web`); `index.js`, the host half, only
logs. The browser half registers one input trigger source
(`ctx.inputTriggers.registerSource`) on `%`, named
`deepsea-session-reference-picker`, without a group title. Each candidate is
named `workspace/session` (its identity, and what a pick inserts) and drawn
from `labelSegments`: workspace, a dim ` / `, session. It builds the
catalog from the Session Controller list and the Workspace list on every
query (`src/client/catalog.ts`) and owns the chips it inserts: their source
is its name, and its codec sends the mention unchanged
(`src/client/mention.ts` encodes the URI as the harness does).

Requires the harness topics **`input-triggers`**: stock DSH accepts only `/`
and `@` as triggers; that topic lets a plugin register any single
punctuation character, with ordinary whitespace and punctuation token
boundaries; and **`trigger-label-segments`**, which renders a candidate's
`labelSegments` (pieces of its title in normal or quiet ink).

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

`pnpm test` covers the catalog, the filter, the label segments, the ages,
the mention and the source's registration. In a server: `dsd run release --throwaway-app
--scripted --plugins session-reference-picker` (tools/dsd/README.md), create
a few sessions, then type `%` in the composer.
