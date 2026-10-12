# DeepSea Window Helper

A small background app (no Dock tile, no window) that finds and moves windows
for the browser plugin (`plugins/browser`, `placement.mjs`): it keeps an
agent's Safari Technology Preview windows where a covered page still runs,
and makes room for them when another app's window is in the way.

It is machine-wide (LAYOUT.md §1, §6): one `DeepSea Window Helper.app`, bundle
id `io.github.taliesinb.deepsea`, in
`~/Library/Application Support/io.github.taliesinb.deepsea/`, used by every
variant on the Mac. Moving another app's windows needs Accessibility; a
separate bundle means the grant belongs to the helper, once, rather than to
whichever DeepSea server ran a script.

| File | Role |
|---|---|
| `main.swift` | the helper: one command per launch, one JSON object on stdout |
| `build.mjs` | compiles and signs the bundle; `--install` installs it |

## Building and installing

```sh
node apps/macos/WindowHelper/build.mjs --out <dir>   # <dir>/DeepSea Window Helper.app
node apps/macos/WindowHelper/build.mjs --install     # into ~/Library/Application Support/io.github.taliesinb.deepsea/
open -W -a ~/Library/Application\ Support/io.github.taliesinb.deepsea/DeepSea\ Window\ Helper.app --args request-access
```

It needs the Command Line Tools' `swiftc` (no Xcode). `build()` and
`install()` are exported for `dsd`. The bundle is signed ad hoc with a
designated requirement on its identifier (`designated => identifier
"io.github.taliesinb.deepsea"`): a plain ad-hoc signature is identified by its
code hash, so macOS would drop the Accessibility grant after every rebuild
(the privacy log says "Failed to match existing code requirement"). The
install replaces the installed copy only when the executable or the
Info.plist changed.

`request-access` shows macOS's own prompt, which leads to the right settings
pane (Privacy & Security ▸ Accessibility); enable "DeepSea Window Helper"
there. Without the grant, `layout` still works and the plugin moves windows
with AppleScript instead (Automation consent); only `make-room`, `restore`
and `move` need Accessibility.

## Commands

Launched through LaunchServices, so the helper is its own responsible
process for macOS's privacy checks:

```sh
open -W -g -n -a "DeepSea Window Helper.app" --stdout OUT --stderr ERR --args <command> [options]
```

`open --stdout` appends to its file: a caller gives each call a fresh file.
A call takes about 100 ms. Every command prints one JSON object and exits 0;
a failure is `{"ok": false, "error": "…"}` (exit 1). Coordinates are global
points with the origin at the top-left of the primary screen.

| Command | Does |
|---|---|
| `request-access` | macOS's Accessibility prompt; `{ accessibility }` |
| `layout` | `{ accessibility, screens: [{ frame, visible }], frontmost: { pid, bundleId, name }, windows: [{ id, pid, owner, bundleId, bounds, alpha }] }`: every on-screen window of the normal layer, front to back. No permission needed; titles are not read (they need Screen Recording) |
| `make-room --width N [--min-width M] [--exclude-bundle ID]…` | narrows the frontmost app's windows that reach into the N-point strip at the right edge of their screen's visible area (left edge kept, never below M, default 480); `{ pid, bundleId, name, strip, changed, trims: [{ before, after }], reason? }` |
| `restore --pid P --frame x,y,w,h --expect x,y,w,h` | puts a window of P back to `--frame` if it is still at `--expect`; `{ changed, after?, reason? }` |
| `move --pid P --match x,y,w,h --to x,y [--size w,h]` | moves (and resizes) the window of P whose frame matches within 2 points; `{ after }` |

Facts the commands rest on (macOS 27, Safari Technology Preview):

- `AXPosition` / `AXSize` move a window without raising it or activating its
  app (z-order and frontmost app unchanged).
- `move --size` sets position, then size, then position again: a size
  applied while the window is still on a smaller screen is clamped to it.
- `make-room` works on every window of the frontmost app, not only the
  focused one: an app may have no key window (borderless windows never
  become key).
- `layout` reads `CGWindowListCopyWindowInfo` and `NSScreen` (frame and
  visible frame, which gives the Dock's side and size); automation windows
  have no title an observer can read, so the plugin matches them by frame.
