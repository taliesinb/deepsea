# @deepsea/message-stash

A stash for messages you are writing in the composer: set a draft aside with
one key, bring it back with another. Nothing to do with git. Browser only.

| Chord | |
|---|---|
| **Ctrl+S** | Push the composer text onto the stash; the composer clears. |
| **Ctrl+S, S** | A second Ctrl+S within the double-tap window (default 1 s) opens the stash. |
| **Ctrl+R** | Cycle: the top stashed message replaces the composer text; whatever was in the composer goes to the bottom of the stash. Repeated Ctrl+R walks the whole stash as a ring. |

Literal Ctrl on every platform (⌘S / ⌘R stay the browser's). The chords act
from the composer and from anywhere that is not a text field; another input,
textarea or editable region keeps its own Ctrl+S / Ctrl+R.

## Pop only on send

A message brought into the composer by Ctrl+R (or by choosing it in the
stash) is *checked out*: it stays in the stash until it is actually sent.

- **Send it** (edited or not): it is popped.
- **Ctrl+R again**: your edits are written back into that entry, it moves to
  the bottom, and the next entry comes up.
- **Ctrl+S**: the entry is updated with your edits and moved to the top; the
  composer clears.
- **Clear the composer by hand**: the checkout ends; the entry stays as it
  was.

Ctrl+R with unstashed text in the composer parks that text at the bottom of
the stash before bringing the top entry in, so nothing typed is lost. Ctrl+R
on an empty stash does nothing.

## The stash (Ctrl+S, S)

Newest first. Each row: the text (clipped to four lines), how long ago it was
stashed or last edited, the session it came from, and "in composer" for the
checked-out entry. Hover or ↑/↓ selects; **Enter** or a click restores the
entry into the composer of the session the stash was opened from; **⌫ /
Delete** or the row's × deletes it; **Clear** (pressed twice) empties the
stash; **Escape** closes.

A count button sits in the composer tool row (left of the model picker)
while the stash is non-empty; clicking it opens the stash.

## Settings

**Settings → General → "Stash view on Ctrl+S, S within"**: the double-tap
window: 300 ms, 500 ms, 750 ms, 1 s (default), 1.5 s, 2 s, or Off (the stash
then opens only from the count button). Applied immediately.

## Where it lives

In the browser's localStorage (`deepsea.message-stash.v1`; the setting in
`deepsea.message-stash.settings`), so it survives restarts of the server and
of the app or browser. It is per browser profile and origin: the macOS app,
Chrome, the phone (Tailscale URL) and a throwaway each have their own stash,
shared by every session shown there. One stash across every client would
need host-side storage behind a Fetch route; not built.

## What is stashed

The composer's clipboard projection: plain text with reference chips in
their clipboard form. Attachments are not stashed and stay in the composer.

## How it works

- `src/client/stash.ts`: the pure model (ordered entries + one checkout;
  `push`, `cycle`, `restore`, `pop`, `release`; the localStorage codec).
  `tests/stash.test.ts`.
- `src/client/keys.ts`: chord recognition, the double-tap detector, the
  focus rule. `tests/keys.test.ts`.
- `src/client/controller.ts`: persistence, the per-session composer
  registrations, the "was it sent?" observation, the stash view's open state.
- `src/client/settings.tsx`: the Settings → General row over a persisted
  `createSnapshotStore`.
- `src/client/index.tsx`: the Cordis `apply`. One capture-phase `keydown`
  listener on `window`; a hidden per-session watcher in
  `conversation.input.dock` (reports the live draft, the input phase and
  every local submission echo, `pendingSubmissions`, which is how a send is
  detected, since a send clears the draft synchronously); the count button
  in `conversation.input.right`; the stash in `shell.overlay`; the settings
  row in `settings.general.item`.
- `index.js`: host half, an empty `apply`.

The seams are all upstream's: `useInput(s => s.draft)` and
`inputActions.setDraft` (refused while the input phase is not `plain`, a
claimed slash command), `useSession(s => s.pendingSubmissions)`, the
`data-composer-input` attribute to find the focused composer. A
checked-out entry is released when the draft goes blank *after* having been
seen non-blank (`seenText`), with a 2 s grace window in which a send echo
still pops it: the draft is also blank for a moment right after
`setDraft(text)` and right after a send.

## Develop

```sh
pnpm install --ignore-scripts
pnpm test && pnpm typecheck && pnpm build
```

Try it: `dsd run release --throwaway-app --visible --scripted --plugins message-stash`.

No config. No harness topic required (`deepsea.requires` is empty).
