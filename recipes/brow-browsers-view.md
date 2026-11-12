# The Browsers view: trying it, testing it, what it needs from Brow

The Browsers view (plugins/tool-brow, README → Browsers view) is a
`conversation.view` beside Chat: one row per browser page of the displayed
Session, with a viewport thumbnail, the page's details and its controls. The
existing slot is enough; no harness topic is needed. The plugin README owns
the routes, the archive's contents and the export limits; this recipe owns how
to run and check it.

## What it needs from Brow

The view works against any Brow daemon, but complete records need one with
`window.thumbnail` and `window.records` (Brow's protocol.md). With them:
thumbnails are scaled by the browser at the size the client asks for, and a
download carries the page's original response HTML (Chrome), every call and
result and the original screenshots, kept by the daemon across restarts.
Without them (method-not-found only), the plugin falls back to a resized
screenshot and to records it observed itself, marked as such in the archive.
Any other native error is reported, never silently replaced by the fallback.

So rolling the view out is two steps: update the Brow app (its daemon), then
rebuild the variant with this topic.

## Run it in a throwaway

1. In `plugins/tool-brow`: `pnpm install --frozen-lockfile`, then
   `pnpm typecheck && pnpm build && pnpm test`.
2. Give the throwaway a Brow daemon of its own, never the person's: a short
   absolute home (the socket path must stay short), `BROW_HOME` set for every
   command, mode `isolated`, Chrome headed (`chrome.headless: true` shows the
   dotted placeholder instead), `pruneOldBuilds: false` so the shared Chrome
   for Testing build is reused. A Brow build from a checkout:
   `node scripts/package-app.mjs --source worktree --out <dir>` there, then
   `BROW_HOME=<home> BROW_MENU=0 <dir>/Brow.app/Contents/MacOS/brow-app run`.
3. A patch pointing the plugin at it:

   ```yaml
   - id: deepsea-tool-brow
     config:
       brow: { socket: <home>/run/daemon.sock, autostart: false }
   ```

4. `pnpm dsd run release --throwaway --visible --detach --scripted --simulated --plugins tool-brow --patch <patch>`
   (`--throwaway`, not `--throwaway-app`: `drive restart-server` needs the relay).
5. `pnpm dsd drive -v <id> create-session --preset standard`, then a scripted
   prompt (`prompt last -`) that calls `browser_open` for two URLs with a
   1280×800 viewport, `open-session last`, `click --text Browsers`.
6. Check with `eval`: row count, each `<img>`'s `naturalWidth` against its
   rendered width × `devicePixelRatio`, image height against the details
   panel's, and the authenticated routes. `snapshot --window` for a picture;
   copy it out before `dsd stop`, which removes the throwaway's logs.
7. After server edits: `drive restart-server`, open the pages again, `reload`.
   After client edits: `pnpm build`, `reload`.
8. Stop the throwaway, then its Brow daemon (`BROW_HOME=<home> brow stop`).

Headed browser operations take Brow's GUI lock
(`node <brow checkout>/scripts/gui-lock.mjs run --label <label> -- …`).

## Pitfalls found on the way

- **Thumbnails at CSS size are blurry.** The client measures the slot with a
  ResizeObserver and asks for CSS size × `devicePixelRatio` (bounded); the
  server caches per page revision and requested size.
- **The frame belongs to the image.** A rounded border on a full-width cell
  shows grey bars beside narrow images; the border and radius are on the
  `<img>` itself, constrained by the slot.
- **Transcript resize handles leak into plugin views.** The harness renders
  `[data-width-handle]` strips as direct children of
  `[data-conversation-content]`, outside the view's scroll area, so hiding
  only the composer leaves full-height hit targets over the rows. Hide the
  direct handles under the same view-scoped `:has(...)` selector as the
  composer; never globally, so Chat keeps its resizing. Drafts does the same.
- **A blob download can cancel the app's other fetches.** Starting a download
  and immediately refetching the page list made that fetch fail in WKWebView;
  the regular poll picks up the change instead.
- **A Brow daemon started under a restricted sandbox** inherits it and cannot
  start Chrome. Restart only the throwaway's own daemon from an unrestricted
  shell; never the person's.
- **Automatic unzipping** of a downloaded archive is a browser or OS setting;
  no response header asks for it.
