# @deepsea/session-move

Move and copy sessions between workspaces from the sidebar.

- **Move to…** (session menu) moves a session, with its subagent sessions,
  to another workspace: one of this machine's, another directory (registered
  as a workspace on the way), or a destination another plugin adds (another
  host's workspaces, with `workspace-remote`).
- **Copy to…** stores a copy under a new id and leaves the source as it is,
  running or not. It starts on the session's own workspace, so it doubles as
  Duplicate; the copy is opened once made.
- **Rehome workspace…** (workspace menu) moves every session of a workspace
  to another one, reports what it skipped, and can delete the emptied
  workspace.
- **Drag and drop:** dropping a session row on another workspace group in the
  grouped sidebar moves it at once. A move the Host refuses opens Move to…
  with that workspace chosen.

A session whose agent has work in flight (a turn, background jobs, running
subagents) is not moved silently: the dialog lists that work and offers to
interrupt it and move. A copy of a running session asks whether to copy only
up to the last completed turn (the default) or what has been recorded so far.
By default the agent is told on its next step that its session was moved or
copied, and where; untick the option to leave it out.

## How it works

The browser half (`src/client`) is the whole feature; the host half only
carries the bundle. The moves and copies are the Host's own `session.move`,
`session.moveMany` and `session.copy` (harness topic `session-relocation`),
which relocate or store the session logs, keep the cached titles, and leave
the agent its notice. The menu actions are `ctx.contextMenus` contributions,
gated on the Remote access the page has for `session/move` and
`session/copy`; drops come through `ctx.uiWorkspace.handleSessionDrop`
(harness topic `workspace-seats`); the dialogs are one `shell.overlay` entry.

Destinations of other plugins come through the browser service
`deepseaSessionMove` (`src/client/face.ts`): a contribution lists headed
groups of `{ key, title, path }` entries after this machine's workspaces, and
a pick of one of them is handed to its `run`, which answers `{ ok: true,
summary? }` or a refusal in the Host's vocabulary (`session/move-live`,
`session/copy-live` with `details.blockers`), so the dialog treats it like
the Host's own. Rehome stays on this machine.

## Limits

- Copy keeps its own Host operation rather than upstream's `session.fork`:
  a fork copies one log in place, and its subagent records would still name
  the source's subagent sessions.
- The destination list shows full paths, not `~`-abbreviated ones.
