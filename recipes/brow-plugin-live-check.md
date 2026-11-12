# Live check of tool-brow against a throwaway brow daemon

What: run `@deepsea/tool-brow` in a throwaway server, pointed at a
real brow daemon in a temporary home, and drive its tools with
scripted prompts. The exact commands are in
[plugins/tool-brow/README.md](../plugins/tool-brow/README.md)
→ Development; this file records why they look the way they do.

- **Temporary daemon home under `/tmp`, short.** `mktemp -d /tmp/bs-ds-XXXX`:
  the socket is `<home>/run/daemon.sock`, and Unix socket paths stop at
  about 104 bytes; `$TMPDIR` on macOS is already ~50.
- **Headless Chrome only** (`BROW_CONFIG='{"chrome":{"headless":true},
  "defaultBrowser":"chrome",…}'`): no window appears, no GUI lock is needed.
  The first call installs Chrome for Testing into that home (~190 MB, a few
  seconds); `rm -rf` the home afterwards.
- **`daemon.exitWhenIdleSeconds: 60`** so a forgotten daemon goes away by
  itself. It counts connections too, so it stays while the throwaway is
  connected; but start the throwaway within the minute after the daemon.
- **`autostart: false` in the `--patch` row** so the plugin can never start a
  daemon in the person's default home if the socket path is wrong.
- **The scripted model declares no image input**: screenshots come back as
  "not shown inline …; saved to …" (the inline path is covered by
  `pnpm test`). Delete `$TMPDIR/deepsea-tool-brow-screenshot-*`
  afterwards.
- **Restart and notices**: stop the daemon and start it with
  `"idleMinutes": 1`; the server log shows the reconnect within a second (the
  trace: `session-open … "via":"session.resume"`), the next call starts with
  `NOTE: the brow daemon restarted …`, and about a minute later `dsd drive
  events last` shows the injected `[browser] Closed idle browser window(s) …`
  notice. `stop` then `start` at once is safe since the daemon removes its
  socket only while it is still its own.
- **A cancel**: `prompt … --no-wait` a slow `browser_eval` (an awaited 25 s
  timeout), then `dsd drive cancel last`: the tool result is `ABORTED` (a
  stopped row, not a failure) and the trace has `"cancelled":true`.
- **A failure**: a click on text that is not there fails with the daemon's
  text, the window in front (`[chrome:0:0] browser_act: … FAILED: …`) and its
  `Hint:`; a `browser_script` run whose `expect` fails is a successful call
  whose report says `FAILED`.
- **Done**: `pnpm dsd stop <id>`, the daemon's `stop`, `rm -rf` the home and
  the screenshot files, and `pgrep -fl <home>` shows nothing. Never touch the
  default home's daemon (the installed app's).
