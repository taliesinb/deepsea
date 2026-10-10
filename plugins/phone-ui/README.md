# @deepsea/phone-ui

A chat-only session on phone-width viewports, in the full GUI and in the
`?embed=<sessionId>` page alike, and in the macOS app's **View ▸ Mobile**.
Two halves: a host `<style>` row that strips the desktop chrome and tightens
what remains (plus a head script that lets iOS Safari finish loading), and a
browser bundle that replaces the composer card with a bottom **tongue** and
a full-screen text entry.

The client has no responsive CSS. At iPhone width (390–430 CSS px) a session
keeps its desktop chrome:

- the **session header**: title, agent-preset chip, menu, right-dock toggle,
  and the **Chat | Trajectory** tabs (76px);
- an **icon row under every message**: copy, feedback, branch, usage and time
  pills, clock, under assistant turn tails and user bubbles;
- the **composer dock**: turn and token pills and the context meter.

Below `maxWidth` this plugin hides all three; the transcript, approvals and
the queue dock are untouched, and anything wider (an iPad in portrait is
768–834px) keeps the full chrome. It also tightens what remains: the
transcript's 32px side padding becomes 8px (the composer follows, so text and
composer share one edge), fenced code blocks lose their banner row (language
and Copy, also on blocks without a language), code blocks and the user's own
bubbles get 6px corners, and boxed blocks get less padding.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxWidth` | `640` | the media query's `max-width`, CSS px, integer `320`–`1200` |
| `header` | `true` | hide the session header with its tabs; in the macOS app only the tabs (below) |
| `messageActions` | `true` | hide the per-message icon rows (assistant turn tails, user and steering bubbles; the user row's clock goes with them) |
| `stats` | `true` | hide the composer dock (stats pills and context meter) |
| `sideMargin` | `8` | transcript and composer side padding, CSS px, integer `0`–`64`; the client's own is 32 (text) and 16 (composer), and `32` leaves both alone |
| `codeHeaders` | `true` | hide the code-block banner row |
| `smallRadius` | `true` | 6px corners on code blocks (from 16px) and user bubbles (from 20px) |
| `compactBlocks` | `true` | less padding inside boxed blocks: code blocks, tool-call input and output sections, slash-command output, context-injection bodies, table cells, blockquotes, user bubbles |
| `deferHmrStream` | `true` | open the client-HMR event stream 250 ms after `load` (below); on every viewport |

Every flag `false` and `sideMargin: 32` leave only the browser half.

```yaml
- insert:
    - id: deepsea-phone-ui
      name: "@deepsea/phone-ui"
      config:
        maxWidth: 480
        messageActions: false
```

The style is written into the page when it loads: a new configuration needs
a server restart and a page reload.

## The mobile composer

In the phone view the composer card is hidden and replaced by:

- **Tongue**: a grey tab (`--dsw-specific-input-major`) flush with the
  bottom edge, centred, with 14px top corners and a chevron. While the agent
  runs, a **red stop square** sits beside it (the session's `cancel()`,
  what the stock stop button calls). The back-to-bottom control moves to the
  bottom-right corner, level with the tongue.
- **Entry sheet** (the chevron): full screen, the same grey, a plain
  `<textarea>`: no placeholder, no attach, permission or model controls, no
  slash menu; **Enter inserts a newline**; 16px text, so iOS does not zoom.
  The bar at the bottom: **⌄** (minimise, framed, far left) folds the sheet
  back into the tongue and keeps the text *and the caret*; **✕** (abandon,
  red) asks "Abandon message?" (Cancel / Abandon) before clearing; **↑**
  (send, blue) is the only way to submit and is disabled while the text is
  empty or a submission is in flight. The sheet follows
  `window.visualViewport`, so when the iOS keyboard comes up it shrinks
  above the keys and the bar stays visible (iOS covers the layout viewport
  instead of shrinking it). The ↑ ↓ ✓ strip above the keyboard is Safari's
  own form-accessory bar; a page cannot remove it.

Send goes through the session's input actions (`setDraft`, then `submit`),
so admission, queueing while a turn runs and steering behave exactly as for
the stock composer, a blank session's first message included; minimise
writes the text to the session's draft too, so it persists like any draft.
The component is mounted on `conversation.input.dock` (session scope) and
renders through portals to `<body>`. While it is active it stamps
`<html data-deepsea-phone-ui-composer>`, and the stock composer is hidden
under that attribute only: without the bundle the stock composer stays.

## The macOS app: View ▸ Mobile

Every host rule is emitted twice: inside the `max-width` media query and
under `<html data-deepsea-view="mobile">`, the attribute the macOS app's
View ▸ Mobile stamps (it also resizes the window to 390×844; View ▸ Desktop
undoes both). The browser half watches the same attribute and a
`matchMedia` on the width the host half publishes as
`--deepsea-phone-ui-max-width`. Anything that sets the attribute gets the
phone view at any window width:

```js
document.documentElement.dataset.deepseaView = 'mobile'   // delete it to go back
```

In the macOS app (`<html data-platform="darwin">`, the client's macOS
layout) the session header is the window's title bar: the traffic lights,
the closed sidebar's controls and the window drag region live in it. There
`header` hides only the tabs and the header shrinks to its title row; in a
browser the whole header goes. The entry sheet starts its text below the
traffic lights.

## iOS Safari "never finishes loading" (`deferHmrStream`)

iOS Safari keeps its loading indicator running for as long as a
server-sent-events stream opened *during* the load stays open, and the
client-HMR plugin opens `/plugins/events` in its `apply`, mid-load, so the
page looked as if it never finished loading on an iPhone. The host half adds
a head `<script>` that wraps `window.EventSource`: for that one URL, while
`document.readyState !== 'complete'`, it returns a stand-in that creates the
real stream 250 ms after `load` and forwards `add/removeEventListener`,
`close`, `readyState` and the `on*` handlers; every other stream, and any
created after load, is the real class. The stand-in has a plain prototype on
purpose: `EventSource.prototype`'s accessors are brand-checked. Hot reload
still works through it.

## How it works

The host half pushes one style row (and the head script) into the web
server's `webserver/index-inject` table. Every hook is an unhashed attribute
the client renders itself; CSS-module classes compile to `<hash>_<local>`
and are named by their local only for blocks with no attribute of their
own, scoped under one that has. The `data-slot="…"` outlets are the slot
system's own `display:contents` wrappers around every rendered slot.

| What | Hook |
|---|---|
| header | `[data-slot="conversation.header"] > header`; its tabs `[data-conversation-tabs]` (`ui-conversation` `ConversationHeader.tsx`, `ConversationSession.tsx`) |
| assistant icon row | `[data-turn-tail][data-actions-reveal] > div:not([data-slot])`: the turn tail's own row, its only child without `data-slot`; the `conversation.chat.turnTail` outlet beside it stays (`ui-chat` `TurnTailNodeView.tsx`) |
| user icon row | the second child of `userRow` under the node outlet of a `[data-chat-flow-kind="user"]` or `"steering"` item (`ui-chat` `MessageItem.tsx`) |
| composer dock | `[data-slot="conversation.composer.bar"] div:has(> [data-slot="conversation.composer.dock"])`: the InputBar's dock wrapper, with the context meter inside it (`ui-conversation` `InputBar.tsx`; `:has()` needs Safari 15.4) |
| side padding | `--dsh-composer-side-clearance` on `[data-conversation-content][data-content-phase]` (read by the composer) and the padding of the message column's parent (ChatView's `.scroll`), the column being `[data-chat-flow]` without `data-step-process-content` (a step group's own column) |
| code blocks | `.md-code-block`, the block's one unhashed class (`ui-primitives` `CodeBlock.tsx`); it defines `--dsl-code-block-border-radius` on itself, read by banner, block and `<pre>`; the banner wrapper is the child holding `[data-code-block-banner]`. Without the banner the `<pre>` gets the top radii too |
| boxed blocks | `[data-context-injection-body]`; tool calls' `[class*="_ioSection"]` inside `[data-chat-call-id]`; slash-command output `pre[class*="_body"]` inside `[data-variant="others"]`; table cells (the outer edges stay 0, so the table lines up with the text); `blockquote` |
| back-to-bottom control | `[data-conversation-scroll] [class$="_toBottomSlot"]` (browser half) |

**Cascade:** the client's stylesheets come after this `<style>` in the
document, so a rule that only ties the stock rule's specificity loses, in
the media query only, because the flag copy's `html[…]` adds specificity.
Every rule out-ranks its stock counterpart: two attributes where the stock
rule is a class (`[data-conversation-content][data-content-phase]` over
`.body`), the attribute twice over `.markdown blockquote`, and explicit
first and last cells over `.tableScroll td:first-child`.

Measured in the macOS app at 390×844, by the media query and by View ▸
Mobile alike (identical computed styles): header hidden but for the title
row (51px), tabs gone, text, composer and code blocks at x = 8, icon rows
and dock and banners `display: none`, code blocks and bubbles 6px, the
tongue 60×44 at the bottom centre; at 1280×860 every value is the client's
own.

## Limits

- The collapsed sidebar rail of the full GUI at phone width, and the right
  dock (its toggle goes with the header), are untouched.
- In the light appearance the tongue, like the stock composer card, is a
  white tab with a faint edge.
- Hiding the tabs leaves a session on whichever view it shows.

## Development

```sh
pnpm install          # also builds lib/client.js (prepare)
pnpm test             # the stylesheet, the config and the head script (node:test)
pnpm typecheck        # browser half against the harness's declarations
pnpm watch            # rebuild lib/client.js on save (hot-swaps a GUI serving it)
```

In the macOS app: `dsd run release --throwaway-app --scripted --plugins
phone-ui` (tools/dsd/README.md), then `dsd drive view mobile` (or `resize
390x844` for the media query alone) and `snapshot --window`. Drive the
composer with real input (`click`, `type`): React's controlled textarea
ignores a synthetic `input` event.
