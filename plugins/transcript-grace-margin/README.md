# @deepsea/transcript-grace-margin

Empty space under the last row of a session's transcript, so the bottom of a
long, active session reads as the end of it. Host only: one injected `<style>`
rule, no browser half.

Without it the last row stops 16px above the sticky composer, and the
composer seat's 36px fade band covers most of that: at the bottom of a long
session the transcript looks as if it continued under the composer. With the
default margin the last turn sits 176px above the composer, clear of the fade.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `margin` | `160` | px of empty space after the transcript's last row; integer `0`–`600`, `0` adds no rule |

```yaml
- insert:
    - id: deepsea-transcript-grace-margin
      name: "@deepsea/transcript-grace-margin"
      config:
        margin: 200
```

The rule is written into the page when it loads, so a new margin needs a
server restart and a page reload.

## How it works

The host half pushes one row into the web server's `webserver/index-inject`
table:

```css
[data-conversation-scroll] [data-chat-flow]:not([data-step-process-content]) { padding-bottom: 160px }
```

The hooks are unhashed data attributes the client renders itself; its
CSS-module classes compile to `<hash>_<local>` names and are not used:

- `[data-conversation-scroll]`: the active-phase scroller
  (`ui-conversation` `ConversationContent.tsx`), which holds the transcript
  and the sticky composer seat;
- `[data-chat-flow]`: the message column inside it (`ui-chat` `ChatView.tsx`).
  A step group's own column (`ChatGroupSeat.tsx`) carries the same attribute
  and also `data-step-process-content`; it is left alone, so expanded groups
  keep their geometry.

The padding is part of the column's box, so it counts in the scroller's
`scrollHeight` and in the size ChatView's `ResizeObserver` reports: following
the live tail (`scrollTop = scrollHeight`), the at-bottom test and the
back-to-bottom control (sticky to the scroller, placed after the column) all
land on the padded end, and turn navigation measures rows relative to the
scroller. A blank session's hero layout renders no chat column and keeps its
geometry.

Measured in the macOS app at 1280×860: last row to composer 176px at the
bottom, distance to the bottom 0 on every sample while a reply streams.

## Development

```sh
pnpm test     # the config, the rule and the index-inject row (node:test, no server)
```

In a server: `dsd run release --throwaway-app --scripted --plugins
transcript-grace-margin` (tools/dsd/README.md), then a long scripted reply.
