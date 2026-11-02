# @deepsea/numbered-switching

The **five most recently viewed sessions** hold the numbers **1–5**, drawn on
their sidebar rows in the status column (the one the Workspace folder icon
sits in). **⌘1…⌘5** (Ctrl+1…5 off Apple platforms) switch to the holder of
that number.

```
📂 widgets
 1 gamma session          5min        ← digit green: finished while you were away
 5 beta coding session    5min
 ● remote session         5min        ← not in the recent five
 2 Hello                  5min
```

## Rules

- **Stable numbers.** A session keeps its number for as long as it stays in
  the recent set; switching around with ⌘N or by clicking never renumbers
  anything, it only refreshes recency.
- **Least recently viewed is evicted.** Opening a *novel* session (by click,
  search result or **New Session (+)**; ⌘N only ever reaches holders) seats it
  in the first empty slot; when all five are taken it takes the slot of the
  holder viewed **longest ago**. A New Session that is later sent keeps its
  number (same session id; only the title changes).
- **Gone means free.** A holder that is archived or otherwise disappears from
  the session list frees its slot.
- **Empty slot**: the chord is claimed but nothing happens.
- **Pure browser state.** Nothing is written to the server. The slot table
  lives in `sessionStorage` (`deepsea.numbered-switching.slots`): per window,
  it survives a reload and dies with the window.

## Where the chord works

| Surface | ⌘1…⌘5 reach the page? |
|---|---|
| **The DeepSea macOS app** | **yes**: its menus define no ⌘digit equivalents, so AppKit hands the chord to the web view |
| Chrome | no: ⌘1…⌘8 select tabs, ⌘9 the last tab; never delivered to a page |
| Safari | no: ⌘1…⌘9 open Favorites or tabs before WebKit sees them |

The numbers are drawn everywhere regardless (they mark the recent five even
where a browser owns the chord), and the plugin claims the chord wherever it
does arrive.

## Remote workspaces

While the remote-workspaces plugin is loaded, sessions of mirrored remote
servers take part exactly like local ones: viewing one numbers it, it evicts
and gets evicted by the same rule, its number is drawn on its remote row, and
⌘N brings its frame back. Slot keys are `local:<sessionId>` and
`remote:<workspaceId>:<sessionId>` (`src/client/targets.ts`).

The coupling is optional and runtime-only. The remote plugin provides the
browser service `deepseaRemoteWorkspaces`:

| Method | Does |
|---|---|
| `getSelection()` | the `{ workspaceId, sessionId }` on screen, or `undefined` while no remote panel shows |
| `has(selection)` | whether that remote session still exists |
| `open(selection)` | brings its frame on screen |
| `subscribe(listener)` | calls `listener` on every change of the above; returns the unsubscribe |

and stamps its session rows with
`data-deepsea-remote-session="<workspaceId>:<sessionId>"`. This plugin reaches
the service through `ctx.inject(['deepseaRemoteWorkspaces'], …)`, which runs
only while it exists. While it is absent (not installed, gone for a moment
during a bundle hot-swap, or not yet up at boot) remote holders are *kept*:
they show no row and ⌘N does nothing for them until the plugin returns or the
eviction rule removes them. They are freed only when `has()` says so.

An embedded page (`?embed=<sessionId>`, what a remote frame shows) runs this
plugin too but stays inactive: the frame is a same-origin iframe and shares
the tab's `sessionStorage`, so an active framed instance would overwrite the
outer window's table.

## How it works

Browser-only (`dsh.client.platform: web`); `index.js`, the host half, only
logs. `src/client/`:

| File | Role |
|---|---|
| `slots.ts` | the pure slot model: `touch` (seat or bump, evicting the least recently viewed), `prune`, `slotOf` / `holderOf`, `restoreSlotState` (validates the stored table) |
| `targets.ts` | the slot-key codec: `local:<id>` / `remote:<ws>:<id>` |
| `chord.ts` | which keydown is a chord |
| `index.ts` | `apply`: follows the selection (local, and remote when present), owns the table, installs the keydown capture, the badges and the panel watcher |
| `badges.ts` | the DOM reconciler that draws the numbers on the sidebar rows, and `rowKey` (which session a row stands for) |

**Current session.** ui-workspace keeps the selection private, but the
Session Controller list exposes it as local reference counts: the current
session is the one row with `retainedBy.mainView > 0`, the derivation the
Workspace browser uses for its row highlight. It counts only while no global
main panel is showing (`usePanelInfo().activePanelId === null`, read by a
renderless `shell.overlay` entry), so Settings or a remote frame covering the
retained local session does not make it "viewed". The plugin subscribes to
`sessions.list` (and `workspaces.list` for `archivedSessionIds`, and the
remote service when present) and turns every change of the current key into
one `touch`.

**Switching.** `ctx.uiWorkspace.openSession(id)`, the verb a row click runs
(it also returns the main view to the Conversation when a panel such as
Settings is showing).

**Chord.** One capture-phase `keydown` listener on `window`: the primary
modifier only (⌘ without ⌃ on Apple platforms, ⌃ without ⌘ elsewhere; no ⌥ or
⇧; not a repeat), the digit from `code` (`Digit1…`, `Numpad1…`) or else
`key`, so a non-Latin or AZERTY layout and the keypad both work.
`preventDefault` and `stopPropagation` run before any editor keymap sees it.

**Badges (DOM patch).** The Workspace browser's per-row seat
`sidebar.session.row.leading` is mounted only while a row is idle (a status
dot replaces it), and a number must show in every state, so the numbers are
patched onto the rendered rows. A local row is identified by its
`data-row-key="session:<id>"`, a remote row by `data-deepsea-remote-session`.
A `MutationObserver` re-applies after React re-renders (one reconcile per
frame; a timer stands in for animation frames while the document is hidden,
since a background window gets none).

Geometry: a local session row is `padding-inline-start: calc(8px +
var(--dsh-workspace-indent))` (`depth * 12px`, 0 under a top-level
Workspace), a remote row `padding: 0 8px`; then a 16px status slot, then the
title. The Workspace header has the same padding and a 16px icon slot, so the
digit goes **on the status slot**, lined up with the folder or chevron: a
16px-wide `position: absolute` span offset by the row's computed
`padding-inline-start`. The row's own layout is untouched.

Status under a digit: whatever the slot shows (a status `StateDot`, the
ongoing spinner, the idle row's leading seat, a remote running dot or
spinner) is hidden (`visibility`, marked
`data-deepsea-numbered-switching-hidden`, restored when the badge goes) and
the digit takes over a status dot's `data-state` color: green done, amber
warning, red error, blue *pulsing* ongoing, with the tokens of
`StateDot.module.css`; an idle row's digit stays gray. The hover card still spells the status out. A badged
row carries `data-deepsea-numbered-switching-positioned` (inline `position:
relative`, the value Rows.module.css already uses for drag markers), and the
badge is `<span data-deepsea-numbered-switching-badge aria-hidden
title="⌘3">3</span>`. Colors are the shell's `--dsw-alias-label-tertiary` /
`-secondary` (selected row).

The stylesheet is one `<style data-deepsea-numbered-switching>` element per
plugin instance, re-appended whenever it goes missing, and the badge's
layout-critical properties are also inline: on a reconnect or bundle
hot-swap the new instance can apply before the old one is disposed, and a
shared sheet would be removed under it.

Skipped rows: ghost rows of the session-title-slug plugin
(`[data-deepsea-session-title-slug-ghost]`), search results (`<button
role="treeitem">`) and the clones the Workspace browser animates out (they
drop their `data-row-key`).

`SLOT_COUNT` in `src/client/index.ts` sets the number of slots (5; at most 9,
as ⌘digit has nine). No runtime configuration.

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

`pnpm test` covers the slot model, the key codec, row identity and the
chord. In a server:
`dsd run release --throwaway-app --scripted --plugins numbered-switching`
(tools/dsd/README.md), open a few sessions, then `dsd drive type --key cmd+2`
sends a real ⌘2 to the app.

## Troubleshooting

| Symptom | Cause |
|---|---|
| The chord does nothing in Chrome or Safari | The browser owns ⌘digit; use the macOS app. |
| No numbers, the console line `[numbered-switching] ⌘1…⌘5 …` present | The session rows lost their `data-row-key="session:<id>"` (Rows.tsx). |
| Numbers in the wrong place | The badge sits on the 16px slot after the row's leading padding; if Rows.module.css moved or resized the status slot, adjust `SLOT_WIDTH_PX` / `setBadge` in `badges.ts`. |
| A numbered running session shows no dot | By design: the digit pulses blue instead; green, amber and red likewise replace the dot. |
| Remote rows never get a number | The remote plugin is absent, or its rows lack `data-deepsea-remote-session`. The console shows `remote workspaces joined the numbering` when the service was found. |
| Numbering reset after a reload | `sessionStorage` unavailable (private mode): the numbering is per window and best-effort. |
| A New Session row shows a number | It already held a slot when + reused the blank session (same id), by design. |
