# @deepsea/ui-settings-entry

The way into the web GUI's **Settings**:

- the **Settings** button at the foot of the sidebar, where upstream shows
  an account menu (**More**: Settings, Feedback, the DeepSeek sign-in). Its
  bundle patch turns off upstream's account launcher, `ui-settings-account`,
  and the settings shell then shows its own button. That plugin's other
  parts go with it: the Account section of Settings, the DeepSeek account
  sign-in and its quota notice. Settings → Built-in plugins turns it back on;
- **⌘.** (Ctrl+. off Apple devices), which opens the Settings panel and
  closes it when it is open, in Safari, Chrome and the DeepSea macOS app,
  where **Settings… (⌘,)** in the app menu does the same through this
  plugin.

## Why ⌘. and not ⌘,

Safari takes ⌘, as its own Settings… menu command before WebKit hands the
key to the page: no `keydown` reaches it, so no page can claim the chord
(vscode.dev hit the same wall,
[microsoft/vscode#149478](https://github.com/microsoft/vscode/issues/149478)).
Chrome does deliver ⌘,, but one chord should work in both. ⌘. reaches the
page in Safari and Chrome, and `preventDefault` suppresses the browser's own
use of it (Safari's View ▸ Stop). The client's own Settings command
(Keyboard shortcuts in Settings) is ⌥⌘, on the Web and cannot be bound to
⌘., which the client does not accept as a Web binding.

The macOS app owns its menu bar, so its Settings… item is a real ⌘,. Its
action runs a script in the page that dispatches this plugin's chord as a
synthetic `keydown` on `window` (`key: '.'`, `code: 'Period'`, `metaKey`)
and reads `dispatchEvent`'s result: `false` means the plugin claimed it;
otherwise the app dispatches the client's own Settings command (⌥⌘,), so a
server without the plugin still works (apps/macos). The listener therefore stays on `window` and accepts
untrusted events.

## How it works

The host half is an empty `apply` that lets the server serve the bundle.

`src/client/index.ts` installs one capture-phase `keydown` listener on
`window`. On the chord it calls `preventDefault` and `stopPropagation`, so
neither the browser nor the shell's shortcut dispatcher sees the key, then
toggles the panel (`src/client/toggle.ts`).

The panel's open state belongs to the settings shell (`ui-settings-general`):
the store of its `sidebar.settings` slot entry, whose `create()` hands out the
shell's one instance, the one its sidebar launcher and its own Settings
command (⌥⌘, on the Web) drive. The toggle reads that instance's `open` and
calls its `open` or `close` action, so it works whatever the sidebar's foot
shows. Until the shell is mounted (it mounts once the page may read the
server's settings) the chord does nothing and warns on the console
(`[deepsea-ui-settings-entry] no-shell`), which the macOS app copies into
its run log.

The chord is exact: the primary modifier alone (⌘ without ⌃ on Apple
devices, ⌃ without ⌘ elsewhere; no ⌥ or ⇧), not a key repeat, and `key ===
'.'` or `code === 'Period'` or `code === 'NumpadDecimal'` (the keypad's, and
how System Events sends ⌘.). A non-Latin layout may report another `key` for
the period key; `code` still matches.

## Development

```sh
pnpm install          # also builds lib/client.js (prepare)
pnpm test             # the chord and the toggle against a fake shell (node:test, no browser)
pnpm typecheck
pnpm watch            # rebuild lib/client.js on save (hot-swaps a GUI serving it)
```

In the macOS app: `dsd run release --throwaway-app --plugins ui-settings-entry`
(tools/dsd/README.md), then `dsd drive type --key cmd+.` twice. The app's
input events are real key events, as from a keyboard; a browser
automation's synthetic events would bypass the browser's own menu handling
and prove nothing about which chords reach a page.
