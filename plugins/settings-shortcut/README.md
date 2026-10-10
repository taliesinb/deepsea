# @deepsea/settings-shortcut

**⌘.** (Ctrl+. off Apple devices) opens the web GUI's **Settings** panel, and
closes it when it is open. Works in Safari, Chrome, a Safari web app and the
DeepSea macOS app, where **Settings… (⌘,)** in the app menu does the same
through this plugin.

## Why ⌘. and not ⌘,

Safari, and a Safari "Add to Dock" web app, take ⌘, as their own Settings…
menu command before WebKit hands the key to the page: no `keydown` reaches
it, so no page can claim the chord (vscode.dev hit the same wall,
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
otherwise the app clicks the same controls itself, so a server without the
plugin still works. The listener therefore stays on `window` and accepts
untrusted events.

## How it works

Browser only; the host half is an empty `apply` that lets the server serve
the bundle.

`src/client/index.ts` installs one capture-phase `keydown` listener on
`window`. On the chord it calls `preventDefault` and `stopPropagation`, so
neither the browser nor the shell's shortcut dispatcher sees the key, then
toggles the panel (`src/client/toggle.ts`):

- the trigger's `aria-expanded` is `false`: click the sidebar's Settings
  trigger;
- it is `true`: click the panel's close button, so the shell restores focus
  as for a mouse close.

The panel's open state belongs to the settings shell (`ui-settings-general`);
no service, slot or route opens it from outside, so its own controls are the
seam. The shell's CSS-module classes compile to `<hash>_<local>`, so the
`_local` suffixes are stable across client builds:

| What | Selector |
|---|---|
| trigger | `[class$="_settingsArea"] button[aria-haspopup="dialog"]`, else `button[aria-haspopup="dialog"][class*="_trigger"]` |
| close | `[role="dialog"][class$="_panel"] button[class$="_close"]` |

The macOS app's fallback uses the same selectors. When the controls are not
found the plugin does nothing and warns on the console
(`[deepsea-settings-shortcut] no-trigger` / `no-close`), which the macOS app
copies into its run log.

The chord is exact: the primary modifier alone (⌘ without ⌃ on Apple
devices, ⌃ without ⌘ elsewhere; no ⌥ or ⇧), not a key repeat, and `key ===
'.'` or `code === 'Period'` or `code === 'NumpadDecimal'` (the keypad's, and
how System Events sends ⌘.). A non-Latin layout may report another `key` for
the period key; `code` still matches.

## Development

```sh
pnpm install          # also builds lib/client.js (prepare)
pnpm test             # the chord and the toggle (node:test, no browser)
pnpm typecheck
pnpm watch            # rebuild lib/client.js on save (hot-swaps a GUI serving it)
```

In the macOS app: `dsd run release --throwaway-app --plugins settings-shortcut`
(tools/dsd/README.md), then `dsd drive type --key cmd+.` twice. The app's
input events are real key events, as from a keyboard; a browser
automation's synthetic events would bypass the browser's own menu handling
and prove nothing about which chords reach a page.
