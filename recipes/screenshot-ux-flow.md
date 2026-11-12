# Screenshot a UX flow

To see what a feature looks like step by step, without anyone clicking
through it: a drive script walks the flow in a throwaway app, and
`--shots <dir>` collects its snapshots as numbered PNGs with an index.

Throwaways only. dsd never drives the person's own variants, and a
throwaway's app is the real macOS app, hidden, with scripted model replies.

## Steps

1. Start a throwaway with the app and the plugins the flow needs. Add
   `--harness-worktree` for uncommitted harness changes
   (recipes/try-harness-worktree.md: a topic's worktree on the current
   harness `topic/base`, or a scratch worktree of the integration when the
   flow needs other topics too):

   ```sh
   pnpm dsd run release --throwaway-app --detach --scripted --plugins <names | all> [--harness-worktree <path>]
   ```

2. Write the flow as a drive script (tools/dsd/README.md, Drive scripts).
   Put a `snapshot` at each moment worth seeing, named with `--name`:

   ```sh
   # approval.drive: a tool call that needs the person's approval, asked and answered
   wait-page --expression "return !!window.__DEEPSEA_TEST_DRIVER__" --timeout 90
   create-session --title approval
   let s sessionId
   sleep 2
   open-session ${s}
   prompt --no-wait - <<EOF
   {"cmd": "tool", "name": "bash", "args": {"command": "echo hi > /tmp/approval-demo.txt", "description": "write outside", "sandbox_permissions": "danger-full-access", "justification": "the file lives outside the workspace"}}
   {"cmd": "say", "text": "wrote it"}
   EOF
   wait-page --text "Allow once" --timeout 20
   snapshot --window --name approval-asked
   click --text "Allow once"
   wait ${s} --timeout 30
   wait-page --text "wrote it"
   expand
   snapshot --window --name approval-done
   ```

   `expand` opens the finished Turn's work (its control, groups and tool
   rows), which a completed Turn otherwise shows folded; a shot of the tool
   call's input and output needs it.

3. Run it, then look through `<dir>/index.md` (each shot under the step that
   took it) or the PNGs:

   ```sh
   pnpm dsd drive -v <id> run approval.drive --shots /tmp/approval-shots
   ```

   A rerun replaces the shots. Edit, rebuild, restart the throwaway, rerun:
   the same names make before and after easy to compare.

4. `pnpm dsd stop <id>`.

For a plugin, keep the script as `plugins/<name>/tests/<flow>.drive`; then
`pnpm dsd test plugins <name> --shots <dir>` starts the throwaway, runs it
and stops it in one go.

## What a snapshot is

- `snapshot --window`: the page as the window shows it (2× pixels).
- `snapshot '<css>'`: that element, with a margin; `--shots` copies the
  element image (the reply also has the whole page with the element
  outlined).
- WebKit's snapshot does not render `backdrop-filter`: translucent menus
  and popups show what is behind them sharply.

## Things that cost time

- **A turn that waits for the person** (an approval, a question) never
  finishes by itself: send it with `prompt --no-wait`, `wait-page` for the
  panel, snapshot, answer with `click`, then `wait <session>` for the turn.
  A plain `prompt` would wait until it timed out.
- **Approval comes from the model asking for it.** A bash write outside the
  workspace in the default mode, or any write in Read Only, is denied by
  the sandbox without a prompt; the tool call has to request
  `sandbox_permissions` with a `justification` to get the panel.
- **Server-driver prompts do not use the composer's settings.** Choosing
  Read Only in the composer and then `prompt` from the driver runs in the
  session's own mode. To test what the composer sends, click into
  `[data-composer-input]`, `type` the text and `type --key Enter`, as a
  person would.
- **Side effects are real.** The throwaway's server runs as you, with your
  home directory: a scripted `echo > ~/x` writes to your real home. Keep
  scripted writes in the workspace or under `/tmp`.
- **The hidden window is never active**: `requestAnimationFrame` does not
  fire (some animations and echoes only settle after a reload), CSS `:hover`
  and `:focus-within` do not match, and controls shown only on hover need
  `hover` (script-revealed) or `eval` with `.click()`. `run --visible`
  shows the window when a flow depends on it.
- **A fresh throwaway's page may not be ready**: the first `open-session`
  fails with "the test driver's browser half is not loaded". Start the
  script with `wait-page --expression "return !!window.__DEEPSEA_TEST_DRIVER__" --timeout 90`.
- **`open-session` straight after `create-session`** can fail with
  "sessions.retain: unknown session" while the page has not heard of the
  blank session yet: put `sleep 2` between them.
- **Tool calls are collapsed** under "Completed in …", then the group
  ("Called tools", "Read files and searched code", …), then each "Tool call"
  row. `expand` (the last Turn), `expand <turn>` or `expand --all` opens
  them all, as clicks would; `expand --collapse` closes them. The tool list
  then scrolls by itself, inside the chat's own scroller.
  To show a later call, `scrollIntoView({ block: 'start' })` its row rather
  than scrolling the page.
- **`click` sends no modifier keys.** For an Option-click (or Shift, Cmd),
  `eval` a dispatched event: `el.dispatchEvent(new MouseEvent('click', {
  bubbles: true, altKey: true }))`, then wait a moment before the snapshot.
- **`expect` values are words a shell would split**, so quotes are removed:
  `expect = "true"` compares with the JSON `true`, not the string an
  attribute returns. Match text with `expect ~ ^true$`.
- **Harness plugins that are opt-in bundles** load in a throwaway through a
  `--patch` file with an `insert:` row (`- insert: [{ id: <id>, name: '<package>' }]`).
  `drive health` lists the loader rows that failed or are stuck.
- **A wait-page that times out says what the page shows** (text, open
  dialogs): read it before guessing at selectors. `dsd drive -v <id>
  describe '<css>'` gives an element's record, and the harness's own web
  tests (`apps/web/tests/*.e2e.ts`) show stable selectors
  (`[data-composer-input]`, `[aria-label^="Access mode"]`).
