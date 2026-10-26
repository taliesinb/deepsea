# @deepsea/session-title-slug

Name a session **when you create it**: start the first prompt of a New
Session with a slug and a colon,

```
foo-bar-baz: rename the widget and add tests
```

and the session is titled `foo-bar-baz`. Without a slug, the automatic
title takes the same form (below). While you type, the session's
**New Session** row in the sidebar previews the slug; if the prefix stops
matching, the row goes back to "New Session". The prompt reaches the model
**unchanged** (the slug is a useful hint about the task).

**Ghost rows.** Select another session and a typed-into New Session does not
vanish: a dimmed row (the slug, or "New Session") stays under its Workspace
header; click it to return to the draft. A New Session with an empty draft
leaves no ghost.

## Slug grammar

`^\s*([a-z0-9][a-z0-9_-]*):(?=\s|$)`: lowercase ASCII letters, digits, `-`,
`_`, starting with a letter or digit; the colon must be followed by
whitespace or end the text; at most 64 characters.

| Text | Title |
|---|---|
| `foo-bar-baz: do it` | `foo-bar-baz` |
| `fix_login2: the form…` | `fix_login2` |
| `Note: something` | none (capitalized prose never matches) |
| `http://example.com` | none (colon not followed by whitespace) |
| `foo:bar` | none |

The slug is used verbatim as the title. Only the **first** prompt of a
session counts; later prompts never rename, and a title the person chose
before the first prompt (a sidebar Rename) is kept. One grammar
(`slug.mjs`) serves both halves.

## How it works

**Host half** (`index.js`). On the session's first human prompt
(`user/message` with `source.kind: 'user'`, counted in the session's log)
it parses the slug and calls `ctx.sessionTitle.rename(session, slug)`. That
writes a `session/title` event with `source.kind: 'user'`, the same as a
sidebar Rename: the title service treats it as pinned, so the pending
automatic title generation is superseded and later prompts schedule none.
It runs on the server, so it covers every client, including a remote shell
framing one of this server's sessions.

**Automatic titles are slugs too.** The bundle patch also sets `style: slug`
on the harness titler's row, `session-title-llm` (harness topic
`title-slug`), so a prompt without a slug gets a `foo-bar-baz` title as well,
and chat-title's `rename_chat` (which inherits that style) agrees. A patch
layer replaces a row's whole config, so the row restates the base bundle's
values (a test keeps them equal). A profile that prefers prose titles sets
`style: natural` on that row in its own `cordis.patch.yml`, with the same
other values.

**Browser half** (`src/client/`):

1. **Observe.** An invisible entry in the session-scoped list slot
   `conversation.input.dock` (rendered above the composer, hero layout
   included) reads `useInput(s => s.draft)` and `useSession(s => s.blank)`.
2. **Preview** (`preview.ts`). While the session is blank and the draft
   starts with a slug, the plugin rewrites the text of that session's row
   title (`[data-row-key="session:<id>"] > span[class$="_title"]`, while the
   row has no `_time` cell). The row renders `blank ? t('session.new') :
   title` and the server keeps `blank` until the first `turn/start`, so no
   rename or store write can change that label; the browser occupies a
   `single` slot and locale namespaces have one owner, so the DOM is the only
   seam. The original label is kept in
   `data-deepsea-session-title-slug-label`, the written slug in
   `data-deepsea-session-title-slug-preview`; a label is restored only while
   the span still shows exactly the slug written and the row is still blank,
   so the real title rendered after acceptance is never clobbered. A
   `MutationObserver` re-applies after remounts.
3. **Ghost rows** (`ghosts.ts`). The browser lists a blank session only
   while it is current, but the session survives on the server (New Session
   reuses it) and its draft is persisted per session by ui-conversation
   (`localStorage['dsh.conversation.<id>'].draft`, a string or `{ text,
   references }`). For every blank, non-current session with a non-empty
   persisted draft the plugin inserts a clone of a real session row
   (selection, drag, menu and identity artefacts stripped, `opacity: .5`)
   inside a shallow clone of the row's HoverCard wrapper (the group section
   spaces *wrappers*, so a bare row would sit 2px off and shift every row
   below it), right after the Workspace header
   `data-row-key="workspace:<id>"`, marked
   `data-deepsea-session-title-slug-ghost="<sessionId>"`, labelled with the
   draft's slug or the localized "New Session" (`workspace` locale,
   `session.new`). Wrappers are detected structurally (the element holding
   exactly that one row), because ui-primitives hashes its classes
   `_root_<hash>_<n>`. Click or Enter → `ctx.uiWorkspace.openSession(id)`;
   the real blank row then renders and the ghost is reconciled away. A
   collapsed Workspace shows no ghost. Ghosts survive reloads, since both
   the session and the draft persist.

The browser half renames nothing; the host half does.

## For other browser plugins

While loaded, the browser half publishes
`globalThis.__DEEPSEA_SESSION_TITLE_SLUG__ = { parseSlug }`. A plugin that
draws New Session rows of its own (the remote-workspaces plugin's framed
remote sessions) uses it to show the same live preview without a build-time
dependency, and shows none when this plugin is absent.

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

`pnpm test` covers the grammar, the host half's rename rule and `apply`, and
which ghosts exist. In a server: `dsd run release --throwaway-app --scripted
--plugins session-title-slug` (tools/dsd/README.md), click New Session, type
`foo-bar: ` and send.
