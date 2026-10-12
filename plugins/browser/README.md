# @deepsea/browser

Browsers for agents: every chat (and every subagent) gets its own Safari
Technology Preview and Chrome windows through `safari_*` and `chrome_*`
tools, plus an isolated page reader for "read this URL" that copes with
JavaScript-rendered pages, host-side waits, YouTube show notes and
element-aware screenshots that the chat shows as pictures.

The plugin owns the MCP forwarding: it holds private MCP connections to
Apple's Safari MCP server (`safaridriver --mcp`) and Google's
`chrome-devtools-mcp`, and registers exactly the tools it wants. No raw server
tool and no `mcp__server__tool` name reaches the model. Host half in plain ESM
JavaScript; a small browser half (`src/client/index.tsx` → `lib/client.js`)
draws the screenshot rows and relays the DeepSea app's window to the server.

It acts on browsers every variant on the Mac shares, so it is machine-wide
(`"deepsea": { "machineWide": … }` in package.json): `dsd run … --plugins all`
leaves it out of throwaways; name it to include it.

## Tools

44 tools, 21 Safari and 23 Chrome. Every parameter, return value and
implementation note: **[docs/tools.md](docs/tools.md)** (generated from the
definitions by `pnpm docs`; `pnpm test` fails when it is stale). The raw
server tools they forward to: [docs/server-tools.json](docs/server-tools.json)
(`pnpm dump:tools`).

| Area | Safari | Chrome |
|---|---|---|
| Windows | `safari_open`, `safari_close` | `chrome_open`, `chrome_close` |
| Navigation and reading | `safari_navigate` (+ `wait`, `then`), `safari_get_page_content` (isolated reader or window), `safari_get_page_structure`, `safari_wait_for`, `safari_get_youtube_notes` | `chrome_navigate` (+ `wait`, `then`), `chrome_get_page_content` (temporary page or window), `chrome_get_page_structure`, `chrome_snapshot`, `chrome_wait_for` |
| JavaScript | `safari_evaluate_expression` (+ `wait`), `safari_evaluate_function` | `chrome_evaluate_expression` (+ `wait`), `chrome_evaluate_function` |
| Interaction | `safari_interact` (a batch), `safari_click`, `safari_hover`, `safari_press_key`, `safari_type_text` (targets: node, selector, text, point) | `chrome_interact` (the same batch format), `chrome_click`, `chrome_fill`, `chrome_hover` (targets: uid, selector, text: no snapshot needed), `chrome_fill_form`, `chrome_press_key`, `chrome_type_text` |
| Screenshots | `safari_get_screenshot` (inline, element crop, + `wait`), `safari_save_screenshot` | `chrome_get_screenshot` (+ `wait`), `chrome_save_screenshot` |
| Diagnostics | `safari_console_messages`, `safari_network_requests`, `safari_get_network_request`, `safari_handle_dialog`, `safari_set_viewport_size` | `chrome_console_messages`, `chrome_network_requests`, `chrome_get_network_request`, `chrome_handle_dialog`, `chrome_set_viewport_size` |

### Waiting (`waiting.mjs`)

One host-side wait engine serves `*_wait_for` and the `wait` parameter of
`*_navigate`, `*_evaluate_expression` and `*_get_screenshot`:
`{ text?: string[], selector?, expression?, settleMs?, timeout? }`. `text`,
`selector` and `expression` are alternatives (the wait ends when any holds);
`settleMs` pauses afterwards, or alone. The page is polled every 100 ms in
in-page slices of at most 5 s (a quarter of `toolCallTimeoutMs`) from a host
loop that owns the deadline (default 30 s), so a long wait never runs into the
MCP call timeout the way `await new Promise(r => setTimeout(r, 12000))` in an
expression does. A timeout is reported, not thrown (`wait timed out after 30s
for selector "#ready"`), and the main action still runs. `then` on
`*_navigate` runs a function body in the loaded page after the wait, so
rebuild → reload → settle → probe is one call.

## Windows and sessions (`windows.mjs`)

- Every agent that uses a browser gets a session index, consecutive over the
  plugin's lifetime. Windows are numbered from 0 per browser within the
  session: `s:0:0`, `s:0:1`, `c:0:0`, …
- **A Safari window is one `safaridriver --mcp` process**: its own
  automation session and STP window, with fresh cookies and JavaScript state.
  This is the only isolation Safari offers, and it is real. The STP banner
  reads "This window is controlled by DeepSea: ‹chat title› · s:0:1." (the MCP
  handshake's client name, set per window).
- **A Chrome window is one page** of a single `chrome-devtools-mcp` instance
  per session, routed by `pageId`; a session's windows share cookies like
  tabs of one browser. Each instance runs Chrome with a throwaway profile in
  a scratch directory, `$TMPDIR/deepsea-browser-profile-<pid>-<session>-…`,
  removed when the instance ends (and swept at the next start when a server
  died first): no saved logins, nothing written outside the temporary
  directory.
- Every window tool takes an optional `windowId`. Omitted: no window opens
  one (the result says `Opened …`), one is used, several use the **most
  recently used** one and the result names the others (`(2 windows open; used
  c:0:1, the most recently used — pass windowId for c:0:0)`). Ids are checked
  against the caller's session: a window of another chat is unreachable.
- **Reopened after Chrome restarts.** Pages remember their last URL. When the
  instance dies (a crash, chrome-devtools-mcp restarting), a tool naming a
  lost window, or naming none when the session had windows, gets that window
  reopened at its URL under the same id; the result starts `Chrome had
  restarted; reopened c:0:4 at <url> (page state was lost).` A call failing
  mid-way with a stale-page message (`No page found`, `Page ids have changed`,
  `Target closed`) is retried once the same way. `chrome_close` forgets lost
  windows.
- A page that fails to load (connection refused, DNS) still leaves Chrome a
  `chrome-error://` page: it is closed, no window is registered, and the error
  names the URL.
- The tool set is static (registered per agent at `agent/created`, and for
  agents already alive when the plugin loads); every call reads `exec.agent`.

## Lifecycle

- Nothing is spawned until a tool needs it. Sessions in the GUI are never
  disposed, so a per-session idle timer (`idleMinutes`, reset by every tool
  call) closes a session's windows and tells the agent (a user-role notice
  with content blocks: a bare string would break every later turn). Agent
  disposal and plugin unload close everything.
- **STP instance ownership** (`servers.mjs`). Apple's driver launches STP on
  a session's first navigation and quits it only when that session ends; with
  other sessions alive at that moment the instance lingers with no windows.
  So live Safari connections are counted: if the first one starts while no
  STP runs, the instance is the plugin's, and when the count is back to zero
  it is quit after 3 s (AppleScript `quit`, then SIGTERM). A connection ending
  cleanly (stdin closed: the driver exits in about 20 ms, inside the MCP
  SDK's 2 s grace before SIGTERM) closes its window; a SIGTERMed driver leaks
  its window. Because STP is shared by every server on the Mac, two variants
  running the plugin can quit each other's instance: the reason it is
  machine-wide.
- **Reader pool** (`reader-pool.mjs`). `safari_get_page_content` with a url
  and `safari_get_youtube_notes` read in isolated readers (their own STP
  windows, "DeepSea: page reader #n"), never in a chat's window. Concurrent
  reads each get a reader; `reader.maxIdle` (1) stay warm (a warm read takes
  1.5–2 s, a cold one about 4 s); the rest close after `reader.idleMinutes`.
  Cold starts are serialized (two new sessions navigating at once can both
  launch STP). A reader releases its page by closing the tab: parking it on
  `about:blank` instead left an orphaned STP instance when a session ended
  right after the navigation.

## Covered windows keep running (`placement.mjs`, `foreground.mjs`)

macOS reports an STP window that opaque windows cover completely as occluded,
and WebKit then sets `document.visibilityState` to `hidden`:
requestAnimationFrame stops and CSS transitions, CSS animations and Web
Animations freeze. A page whose content appears only after an animation (a
Vue/Nuxt `<transition>` layout swap, a fade-in) hangs behind its spinner,
screenshots come back blank, rAF-driven code never advances. Measured (macOS
27, STP):

- Hidden means fully covered by **opaque** windows. The DeepSea app's
  translucent window and partial covers leave the page `visible`.
- Chrome is unaffected: chrome-devtools-mcp (Puppeteer) launches it with
  `--disable-backgrounding-occluded-windows` and
  `--disable-renderer-backgrounding`; covered, stacked or hidden (⌘H) pages
  keep animating.
- Nothing in the driver un-hides a window (`switch_tab`, `set_viewport_size`,
  `create_tab`, `window.focus()`); WebKit's occlusion switch is private API.
- `NSRunningApplication.activateWithOptions` makes STP frontmost but leaves
  automation windows covered; AppleScript `tell application … to activate`
  (an Apple Event STP handles itself) raises them. AppleScript `every window`
  lists only orphaned windows, never live automation windows.
- A window on a Space that is not displayed counts as occluded, so a separate
  Space is no refuge; macOS has no public API to move another app's windows
  between Spaces.

`safari.hiddenWindows` picks the remedy: `park` (default), `activate`, `off`.

### park: never takes focus

Where a window goes depends on what is frontmost when it opens, and again
whenever its page reports `hidden`:

- **This server's DeepSea app, on a large screen** (visible width ≥
  `park.largeScreenWidth`, 1920 pt) **ending within `park.besideMaxFraction`
  (0.72) of it**: the agent's windows open **beside** it: full size, at least
  `park.gap` (12 pt) to its right, cascaded `park.step` lower each, and always
  overhanging the screen's right edge by at least `park.overhang` (8 pt) (a
  window wholly on screen goes hidden as soon as something covers it later).
  The person sees what the agent does; nothing is resized.
- **This server's DeepSea app otherwise** (a laptop screen, or wider than
  that fraction): right-edge slivers as below, and the app is asked to
  **reveal the strip**: its right edge pulled in to end `gap` short of it
  (never below `park.minWidth`), put back when the last parked window closes
  unless the person moved it meanwhile. No Accessibility needed (cooperation,
  below).
- **Any other app**: right-edge slivers on the screen of this server's
  DeepSea app when one is on this Mac (the most recently active, if several),
  so an agent's windows stay with the window that drives them; else on the
  screen of the frontmost app's window. A DeepSea window that is not
  frontmost is never resized.

A **sliver**: the window parked at the right edge of the screen's visible
area with `park.sliver` (48 pt) showing (its close button), each further
window `park.step` (32 pt) lower, full size otherwise: the page keeps its
viewport, screenshots capture all of it, and the person can drag a window in
to watch. Parking happens right after a window opens (on an `about:blank` tab:
a new driver session has no tab, so no script can run before a first
navigation) and before any page tool whose page reports `hidden`; a visible
window is never moved, so one dragged into view stays put. Not applied to the
console, network and dialog tools, nor to reader windows.

What it rests on, measured with an opaque test window over the page:

- An uncovered strip of 8 pt inside the screen keeps a page visible; 2 pt
  does not.
- A window **overhanging the left or right screen edge** is reported visible
  even when its whole on-screen part is covered (by full-width Safari or
  editor windows, titled or borderless), with as little as 2 pt showing; an
  overhang past the bottom edge, and a fully covered window inside the
  screen, are hidden. This is undocumented and **depends on the display
  arrangement**: on an external display placed above a laptop, a window
  overhanging the external display's right edge stayed hidden under a
  full-width window until it reached at least 8 pt below that display's
  bottom, into the empty area beside the laptop. There, **make-room** is the
  real guarantee: when the page is still hidden after parking and the
  frontmost app's window reaches into the strip, DeepSea Window Helper trims
  that window's right edge out of the strip (`park.makeRoom`, never below
  `park.minWidth`) and puts it back when the last parked window closes,
  unless the person moved it meanwhile.
- `window.moveTo` / `resizeTo` work in automation windows but WebKit clamps
  them to the visible frame, so a zoomed window would still cover them;
  AppleScript `set bounds of window id <CG window number>` and Accessibility
  move them without that clamp, without raising them or activating STP.
- WebKit's `screenX` is global but `screenY` counts from the top of the
  window's own screen, so frames are matched either way. The visible frame
  reported for a secondary screen may include its menu bar, so windows beside
  the app cascade from the app window's own top.

Windows are found and moved by **DeepSea Window Helper**
(`apps/macos/WindowHelper/`, README there): a machine-wide background app
launched per command through LaunchServices, so the Accessibility grant
belongs to the helper (one grant for every variant). Install it with
`node apps/macos/WindowHelper/build.mjs --install` (into
`~/Library/Application Support/io.github.taliesinb.deepsea/`), then grant it
Accessibility (`open -W -a "<that path>/DeepSea Window Helper.app" --args
request-access`). Without the grant, `layout` still works and windows are
moved with AppleScript `set bounds` instead (Automation consent); only
make-room needs Accessibility. Without the helper, a hidden page's result
carries a `NOTE:` saying why it could not be parked. Automation windows have
no title an outside observer can read, so a window is identified by matching
the page's own `screenX/screenY/outerWidth/outerHeight` against the helper's
layout.

**Window cooperation with the DeepSea app** (`app-windows.mjs`, the browser
half). The macOS app publishes its window, `{ pid, bundleId, frame, screen: {
frame, visible }, key, active, fullScreen }` in global top-left points, as
`window.__DEEPSEA_APP_WINDOW__` and a `deepsea-app-window` event on every move,
resize, screen or focus change and after each load; it answers `{type:
'window-info'}` with a fresh report and takes `{type: 'set-frame', frame}`
(frames that stay on a screen, at least 320 × 240, not in full screen) on
`webkit.messageHandlers.deepseaApp`, resizing with animation. The browser
half, only where that handler exists, POSTs each report (debounced) to
`./api/deepsea-browser/app-window` and long-polls
`./api/deepsea-browser/app-command?pid=N` for `set-frame` requests, which it
hands to the app. A report counts only when its pid **and** bundle id **and**
frame match a window in the helper's layout, so the app of someone using this
server from another Mac never does. The routes exist only while Safari parking
is on; a server without them answers 404, and the browser half then sends no
reports and asks again once a minute.

**Window size.** STP opens automation windows at 1024 × 768 pt (a 1024 × 664
CSS-px viewport: Tailwind's `lg`, above Bootstrap's 992, so pages get their
desktop layout); screenshots are 2048 × 1328 px on retina displays. The
plugin does not change it.

### activate: takes focus

Before each page tool, if the page is `hidden`: AppleScript `activate` of
STP and `switch_tab` to the window's tab, then a short wait for `visible`.
Keystrokes meant for the person's app then go to STP, so it is not the
default.

### Focus

No `safari_*` tool activates STP (launch, new windows, navigation, clicks).
Chrome activates itself when it launches and on every `new_page`. With
`chrome.keepFocus` (default; off for headless) pages open with `new_page
{background: true}`, and a launch runs under `keepingFocus`
(`foreground.mjs`), which watches the frontmost app every 60 ms and
re-activates the previous one the moment Chrome takes over: a cold launch
holds focus for about 0.1 s.

## Page reads (`page-read.mjs`)

WebKit's extractor (the server's `get_page_content`) returns only rendered
text and always the whole page: closed `<details>`, `aria-expanded="false"`
accordions and unselected tab panels are silently absent, headings come out
as plain lines, link text that also appears in the URL is dropped, and every
icon becomes `![]()`. Its `maxWordsPerParagraph` defaults to 15 (prose
silently cut; the tools default to 2000) and results past about 40 kB come
back as a pointer to a file ("Saved large output to '<path>'"), which is
followed. The read tools run small in-page scripts around the extraction:

| Step | Isolated (url) default | Window default | Does |
|---|---|---|---|
| `prepare` | — | — | the caller's function body, before extraction (dismiss a banner, "show more"); `script` runs after |
| `expand` | on | off | `details.open = true`; clicks `aria-expanded="false"` outside nav/header/footer (never menus, comboboxes or tabs); clicks through each `role=tablist`, appending the other panels under **Hidden tab panels**; the header reports counts |
| probe | when not expanded | when not expanded | counts what stayed collapsed: `NOTE: 14 collapsed <details> sections and 1 tab group not expanded …` |
| `section` / `selectors` / `scope` | `scope: auto` (the main landmark when it holds ≥ 60 % of the text) | `scope: page` | isolated pages are edited in place; windows hide the siblings along the kept subtrees' ancestor chains (`display: none !important`, tagged `data-deepsea-browser-hidden`) and are restored afterwards. `section: "#troubleshooting"` is that heading through the next heading of equal or higher level; a heading in a decorated wrapper (MediaWiki's `<div class="mw-heading"><h2/><span>edit</span></div>`, `¶` / `#` permalinks) counts as wrapped when the wrapper holds that one heading, no block content and at most 24 characters of decoration |
| `markHeadings` | on for `webkitMarkdown` | off | writes `## ` into each heading's first text node so WebKit's markdown carries levels (never replacing framework-owned nodes: React throws on its next render otherwise) |
| `clean` | on for markdown | on for markdown | drops zero-width anchors, alt-less images, icon-only link lines; a `[](url)` left inline gets the URL's last path segment as its text |

**`format: markdown` is the plugin's own serializer in both browsers**
(`dom-markdown.mjs`, run as an evaluate script): headings, nested lists, code
fences with their language, inline code, bold and italic, links, images with
alt, pipe tables (data tables only: layout tables like Hacker News's become
block flow), blockquotes, and shadow DOM (MDN keeps its code examples in
`<mdn-code-example>` shadow roots). Compared with WebKit's markdown on four
real documentation pages it took the same time (5–25 ms) and kept everything
WebKit drops (0 → 18 code fences and 0 → 34 inline-code spans on one page;
8 → 15 headings on another). WebKit's stays available as `webkitMarkdown`;
`textTree`, `json`, `html`, `plainText` and `text` are WebKit's and carry the
node UIDs `safari_interact` needs. Visibility is `checkVisibility()`, which
also sees `content-visibility`: Chrome hides the children of a closed
`<details>` that way while leaving them layout boxes, which fools
`getClientRects()`. A layout tick (`setTimeout`; rAF does not fire in occluded
windows) separates DOM changes from the extraction: changing heading text in
the same tick as opening `<details>` made WebKit's markdown drop the details'
bodies.

**Chrome has the same surface** (`chrome_get_page_content`,
`chrome_get_page_structure`, `chrome-read.mjs`): chrome-devtools-mcp has no
text extractor (its snapshot is the accessibility tree), so markdown is the
serializer above, `plainText` is `innerText` and `html` the body's
`innerHTML`; the other steps are the same scripts through `evaluate_script`.
A url read uses a temporary page of the session's Chrome instance, which
stays warm until the session's idle timer.

`*_get_page_structure` is the map: landmarks, every heading with a CSS
selector (`#id` when unique, else an `nth-of-type` path), collapsed counts and
tab groups, about 1–3 kB for a long documentation page. Reads beyond
`safari.reader.maxChars` are cut, the full text saved to
`$TMPDIR/deepsea-browser-read-<ms>-<pid>.<ext>` and named in the header.

## Screenshots

Apple's `screenshot` captures the whole viewport (its `node` parameter does
nothing). With `querySelector` (`safari-screenshot.mjs`) the element is
scrolled into view, polled with `setTimeout` until its rect and the scroll
offset are stable for three samples (not rAF, which hung the loop in a covered
window), captured, measured again (retaken once if it moved more than 2 px)
and cropped with sharp at device-pixel precision (scale = image width ÷ CSS
viewport, exact for fractional ratios). Not `sips`: its `--cropOffset 0 0`
is treated as unset and crops the centre. Chrome element captures use the
server's own `uid` screenshots.

chrome-devtools-mcp's `take_screenshot` has two success shapes: an image
block, or for a capture of 2 MB or more (a retina viewport of a colourful page
gets there) the text "Took a screenshot of …\nSaved screenshot to
<path>." with the bytes in its temporary directory. Both are handled; the
spilled file and its directory are removed after reading, and the summary
says so. Every other reply shape is an error quoting the server.

Inline images go through the harness's attachment store under the same rule
as its MCP bridge: only when the current model declares image input.
Otherwise the capture is written to
`$TMPDIR/deepsea-browser-<browser>-screenshot-<ms>-<pid>.<ext>` and the
result says `saved to <path>; not shown inline: <why>. View it with
read_image`.

### Screenshots in the chat

The chat draws every tool card through the keyed `tool.call.toolview` slot;
a tool nobody claims gets the generic card, which prints an image block as
its JSON. The browser half claims `chrome_get_screenshot` and
`safari_get_screenshot` with one row (`ScreenshotRow`, `data-tool` /
`data-state` as on the shipped tool rows): collapsed, the window and what was
captured (`c:0:1 · viewport`, `· saved to file` for the file fallback);
expanded, the capture at point size (device pixels ÷ 2), a click opening an
in-page lightbox (fit ↔ 1:1, Escape closes; never `window.open`, which the
macOS app would load into its only window), then the result text with its
`NOTE:`s. The image comes from the session-authorized `loadImage` loader every
toolview receives, because the shared `tool.call.images` gallery slot is
`single` and owned by the `read_image` entry. Claiming a key replaces the
generic card for every shape of the tool, so the row also covers running,
error, interrupted and the file fallback.

## Failure reporting

Every tool shares one wrapper (`explainFailure`, `FAILURE_HINTS` in
`tools.mjs`) that turns a failure into something the model can act on:
`<tool>: server tool <raw name> failed: <server's words>`; MCP-SDK timeouts
(`-32001 Request timed out`) read in terms of `toolCallTimeoutMs` with the
usual causes (a blocking dialog, an endless navigation, a hung script) and the
way out; `Request: {…}` with the call's arguments; and a `Hint:` for known
messages (stale uid → `chrome_snapshot` again; a dialog → `*_handle_dialog`;
page gone → reopen; element not interactive → scroll or wait; `no element
matches` → check the selector; no image input → `read_image`).
`chrome_interact` step reports carry the same hints. Screenshot failures name
the target and the window and quote the server's reply and the content blocks
received; a requested-versus-captured mismatch is a `NOTE:`. Aborts pass
through untouched, so a stopped turn stays a stopped turn.

Environment problems are phrased as things the person must do
(`environment.mjs`), and the session's browser instances are dropped so the
next call starts fresh (`safaridriver --mcp` reads "Allow Remote Automation"
once, at launch): STP or Chrome missing, Remote Automation off (WebDriver's
`Code=6` with that wording), Chrome stuck on a first-launch dialog (a
launch-time `Target closed` from a Chrome that never served a window), and no
GUI login session (a server started over ssh or by a daemon: `safaridriver
--mcp` then exits silently and Chrome crashes; `launchctl print gui/<uid>`
tells).

Tool values are lossless JSON: `undefined` fields are stripped centrally,
since the harness rejects a result holding one.

## Requirements

- **Safari**: Safari Technology Preview 247 or newer (only STP's
  `safaridriver` has `--mcp`; stable Safari's has none, so there is no
  fallback), with **Allow Remote Automation** on: `sudo "/Applications/Safari
  Technology Preview.app/Contents/MacOS/safaridriver" --enable` (admin
  password once, per macOS user) or Develop ▸ Developer Settings in STP.
  `defaults write` does not reach it (a secure per-user store). STP launches on
  demand in the background; the person's own Safari is never touched.
- **Chrome**: Google Chrome, plus `chrome-devtools-mcp`, **pinned exactly in
  this package.json** (1.9.0) and run with the server's own `node`
  (`process.execPath`), so PATH, shebangs and global installs play no part.
  Upgrade: edit the version, `pnpm install`, `pnpm test`, and skim the
  upstream changelog for `take_screenshot` (the spill) and the uid messages
  `FAILURE_HINTS` matches. `chrome.command` set to a path runs that executable
  instead. Launched with `--userDataDir=<scratch>/profile`,
  `--no-usage-statistics`, `--no-performance-crux`, `--headless` with
  `chrome.headless`, and `--ignoreDefaultChromeArg=--enable-automation` (no
  "controlled by automated test software" bar; `chrome.hideAutomationBanner`).
  chrome-devtools-mcp sets a bare process title: `pgrep -f` never sees its
  arguments; count a process's own children instead.
- **Covered Safari windows**: DeepSea Window Helper (above) for `park`.

### A quiet server log

chrome-devtools-mcp prints about a dozen lines of stderr per launch. Each is
switched off at its source where a switch exists; the rest is filtered
(`CHROME_STDERR_NOISE` in `servers.mjs`):

| Line | Off switch |
|---|---|
| `Update available: …` (and a daily `npm view`) | env `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1` |
| `Performance tools may send trace URLs to the Google CrUX API…` | `--no-performance-crux` |
| `The connecting client did not negotiate the MCP roots capability…` | the client declares `roots` and answers with the session's working directory, which also keeps the server's file writes there and in its temporary directory |
| `ExperimentalWarning: localStorage is not available…` | env `NODE_OPTIONS=--localstorage-file=<scratch>/localstorage.json` |
| `chrome-devtools-mcp exposes content of the browser instance…` (3 lines) | none: stderr is piped and these lines dropped |

Everything else goes to the server log as a warning (and the trace as
`chrome-stderr`); `chrome.quietStderr: false` passes every line. The MCP SDK
gives a child only a safe set of environment variables, without `TMPDIR`, so
the plugin passes it: the server's own temporary files then land in the
machine's temporary directory, not `/tmp`. Safari's driver inherits stderr; it
has never been noisy.

## Configuration

```yaml
- insert:
    - id: deepsea-browser
      name: "@deepsea/browser"
      config:                         # all optional, defaults shown
        safari:
          enabled: true
          driver: /Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver
          labelPrefix: 'DeepSea: '    # STP banner prefix
          hiddenWindows: park         # park | activate | off
          park:
            helper: ~/Library/Application Support/io.github.taliesinb.deepsea/DeepSea Window Helper.app
            sliver: 48
            step: 32
            makeRoom: true
            minWidth: 480
            largeScreenWidth: 1920
            besideMaxFraction: 0.72
            gap: 12
            overhang: 8
          reader:
            enabled: true
            maxIdle: 1
            idleMinutes: 30
            maxChars: 120000
        chrome:
          enabled: true
          command: ''                 # '' = the pinned chrome-devtools-mcp
          headless: false             # no visible windows
          hideAutomationBanner: true
          keepFocus: true
          quietStderr: true
          args: []                    # extra chrome-devtools-mcp flags (--executablePath=…, …)
        subagents: true               # delegated child agents get the tools too
        skipPresets: [minimal, minimal-no-tools]
        idleMinutes: 30               # 0 = never close idle windows
        toolCallTimeoutMs: 60000      # per MCP call
        trace: false
```

- `chrome.headless`: Chrome without windows, for agents that only read and
  test pages, for servers without a GUI session (with chrome-headless-shell
  as `--executablePath`), and for tests. Focus-keeping is off then.
- `skipPresets`: sessions on these agent presets never get the tools (chat-only
  presets for very small local models, which a long tool list overwhelms).
  The tools are registered per agent (scoped), which `tools.restrict()`
  exempts, so the gate is here; it is re-evaluated on `agent-preset/selected`,
  since a blank session's preset can change after `agent/created` and
  recomposing keeps the same agent.
- `trace: true` writes `~/Library/Logs/<variant name>/plugins/browser/<ts>-<pid>.jsonl`
  (`@deepsea/logs`): an identity line, then sessions, windows opened, closed,
  lost and reopened, parking decisions, the DeepSea app's first report, and
  unfiltered chrome-devtools-mcp stderr.

Inline screenshots need the `attachments` and `llm` services, and the
DeepSea app's routes the `connection` service; all three are injected
optionally, so a composition without them still gets the tools. Module
changes need a server restart; a rebuilt `lib/client.js` hot-swaps open GUIs.

## Limits

- The reader pool's windows are not parked.
- An STP instance launched while a second automation window opened was once
  seen to stay behind, with that window, after both windows closed; the
  ownership count quit only the first. Not reproduced since.
- A scoped read with `expand` appends hidden tab panels found anywhere on the
  page, not only inside the scope.

## Development

```sh
pnpm install          # also builds lib/client.js (prepare)
pnpm test             # node:test, offline (no browser); then docs/tools.md freshness
pnpm typecheck        # the browser half against the harness's declarations
pnpm docs             # regenerate docs/tools.md after changing a tool
```

`pnpm test` covers the configuration and the chrome-devtools-mcp command
line, the stderr filter, preflight messages, registration per agent
(subagents, presets, unload), the window registry against fake servers (ids,
the most-recently-used default, reopening, failed opens, idle closing), the
tools' result and failure shapes against scripted replies (the screenshot
spill, timeouts, aborts, hints, lossless values, the cut read), the wait
engine, placement against a fake helper and the real app-window registry,
the app-window routes, environment remedies, and the built browser half
under a fake module loader (every row shape, the cooperation against a fake
app). `tests/fake-host.mjs` is the fake host context.

Live scripts, each against `tests/fixtures/read-page.html` served on a free
loopback port, with scratch under `$TMPDIR/deepsea-browser-live-…`:

- `pnpm live:chrome`: **headless** Chrome only, no window on screen. Waits,
  targets, the most-recently-used default, a window reopened after its
  chrome-devtools-mcp is killed, reads (temporary page and window), a refused
  URL, snapshot and interact; afterwards no process and no profile left.
- `pnpm live:safari [--youtube <url>]`: opens STP windows on screen (parked)
  and a reader window; windows, waits, interaction, window and isolated reads,
  screenshots, closing, show notes; afterwards no driver left.
- `pnpm live:parking [--browser safari|chrome] [--cover zoomed|screen|left:F|inset:N] [--borderless] [--screen main|widest|N] [--activate | --no-raise]`:
  covers the screen with an opaque test window (`scripts/occluder-app.swift`,
  a real app, so Accessibility can trim it) before each of five scenarios and
  checks that pages finish their animations (`scripts/animation-page.mjs`: a
  Vue-style rAF + `transitionend` swap, CSS-animation, Web-Animations and rAF
  probes) and that the occluder keeps keyboard focus. Do not click while it
  runs. A titled window leaves its right-edge sliver unoccluded, as real apps
  do, so `--borderless` is the make-room case.
- `pnpm dump:tools [--chrome]`: refresh `docs/server-tools.json` (`--chrome`:
  only chrome-devtools-mcp's part, which starts no browser).

In a server: `dsd run release --throwaway-server --scripted --plugins
browser --patch <file>` with a patch row `- id: deepsea-browser` whose
`config` sets `safari: { enabled: false }` and `chrome: { headless: true }`;
script lines such as `{"cmd":"tool","name":"chrome_open","args":{"url":"…"}}`
then drive real headless Chrome. `--throwaway-app` shows the screenshot rows;
the scripted model declares no image input, so captures arrive as the file
fallback unless the session's model does.
