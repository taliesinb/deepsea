# @deepsea/tool-system-permissions

A `seek_system_permission` tool that makes sure macOS privacy permissions
(Screen Recording, Accessibility, Microphone, Camera, Input Monitoring, Full
Disk Access, Automation of an app) are granted to the app the agent's
commands run under, before the agent needs them.

```
🛡 System permissions  DeepSea Server · 1/4
   ✓  Accessibility              To click through the installer.
   ?  Screen Recording           To take screenshots of the prototype.   [Grant] [Deny]
   ?  Microphone                 To record the demo's narration.         [Grant] [Deny]   (orange: a stale entry)
   ✗  Automation: System Events  To read the frontmost window's title.
```

## Why

macOS charges every privacy check made by an agent's shell commands,
`osascript`, `screencapture` and the browsers its tools launch to the
*responsible process*: the variant's server host app, "DeepSea [<V>] Server"
(`io.github.taliesinb.deepsea.<v>.server`, LAYOUT.md §6), never the DeepSea
app the person is looking at. For Screen Recording macOS does not wait for
the person: the first unpermitted call fails at once and only a notification
appears, so an agent that simply retries races the person to System
Settings. And a row that looks switched on can be *stale*: its stored code
requirement belongs to an earlier build of the server host, so tccd ignores
it, and switching it off and on does not help; only removing it does.

This tool does the waiting: it checks in fresh processes, shows the person
what is missing with Grant and Deny, opens the right System Settings pane,
removes stale entries itself, and returns only once each permission is
granted or denied.

## The tool

```
seek_system_permission(permissions: { permission: string, justification: string }[])
```

Each `justification` is required: one sentence (no line breaks, at most 200
characters) shown to the person beside the permission, saying what the agent
will do with it. A missing, empty, multi-line or overlong one fails the call
(`INVALID_PERMISSION`, or the harness's argument check for a missing key).
macOS's own dialogs cannot carry it (below).

| Permission | Covers | Probe (preflight, never prompts) | Grant | Pane (`x-apple.systempreferences:com.apple.preference.security?…`) |
|---|---|---|---|---|
| `screen-recording` | `screencapture`, ScreenCaptureKit, window grabs | `CGPreflightScreenCaptureAccess` | macOS's alert (`CGRequestScreenCaptureAccess`), which lists the app and leads to the pane; a later Grant: the pane (and the app in Finder while still unlisted) | `Privacy_ScreenCapture` |
| `accessibility` | UI scripting, synthetic clicks and keys, reading UI elements | `AXIsProcessTrusted` (which lists the app, switched off) | the pane | `Privacy_Accessibility` ("Device Control and Data Access" since macOS 27) |
| `microphone` | audio capture | `AVCaptureDevice authorizationStatusForMediaType:` | macOS's Allow / Don't Allow (`requestAccessForMediaType:`) | `Privacy_Microphone` |
| `camera` | video capture | as Microphone | as Microphone | `Privacy_Camera` |
| `input-monitoring` | global keyboard and mouse event taps | `IOHIDCheckAccess(ListenEvent)` | as Screen Recording (`IOHIDRequestAccess`) | `Privacy_ListenEvent` |
| `full-disk-access` | Mail, Messages, Safari data, other apps' containers | open a directory only Full Disk Access may read (`~/Library/Safari`, `~/Library/Mail`, …; the refused read lists the app, switched off) | the pane | `Privacy_AllFiles` |
| `automation:<bundle id>` | Apple events to that app (`osascript`, AppleScript, JXA) | `AEDeterminePermissionToAutomateTarget` without asking | macOS's Allow / Don't Allow (the same call, asking; the target is launched hidden first if it is not running) | `Privacy_Automation` |

Names are forgiving (`screen`, `Screen Recording`, `fda`, `mic`); Automation
targets take a bundle id or one of `system-events`, `finder`, `safari`,
`safari-technology-preview`, `terminal`, `music`, `mail`, `messages`, `notes`,
`calendar`, `reminders`, `photos`, `xcode`, `google-chrome`. These classes are
the ones an agent's commands run into; Contacts, Calendars, Photos and
Location are left out until an agent needs them.

What the call does:

1. Probes every requested permission in one fresh process. If all are
   granted it returns at once ("All granted already: …").
2. Otherwise every missing one is a question mark with **Grant** and
   **Deny**. Grant removes a stale entry (below), then puts one window in
   front of the person (**What Grant does**, below): macOS's Allow / Don't
   Allow, or the System Settings pane. Pressing it again opens the pane.
   Deny marks the permission as refused by the person.
3. Every open row is probed again every `pollSeconds` (1.5 s), each time in a
   fresh `osascript` (preflight results are cached per process, and only a
   child of this server is charged to the server host). A permission switched
   on in System Settings turns into a tick, Grant pressed or not.
4. **Notice**: nothing is granted without a click. After `noticeSeconds`
   (60 s) with nothing happening (no click, no row changing), the macOS app
   shows the card in a floating panel, with the session's workspace and
   title, over whatever the person is doing (below).
5. The call returns once every row is a tick or a cross. There is no timeout;
   the turn's Stop ends it (`ABORTED`), and the open rows become cancelled.

Rows that cannot be granted here (restricted by a configuration profile, an
Automation target that is not installed) are crosses from the start.

The result tells the model which permissions are granted (already, or after
how long), which the person denied, which cannot be granted and why, which
stale entries were removed, and not to try again for the denied ones unless
asked. The value (also the card's `presentationMeta`, marked `deepsea:
'system-permissions'`) is `{ outcome: 'granted' | 'not-granted' |
'not-applicable', platform, subject: { name, bundleId, app }, waitedSeconds,
permissions: [{ id, name, justification, state, status, already?, deniedIn?,
waitedSeconds?, staleReset?, resetCommand? }] }`.

A grant reaches every process started after it, which is what the probe (a
fresh process) shows, so the server does not need restarting for the agent's
commands. A program already running before the grant may need restarting.
For Full Disk Access, the harness's own file tools run inside the long-lived
server process and may not see the grant until the server restarts.

On a host that is not macOS the tool returns at once with `outcome:
'not-applicable'`.

A system-prompt section (`tool:deepsea-tool-system-permissions`,
`promptHint`) tells the model to call the tool before screenshots, UI
automation and the like, and never to retry a capture that failed for lack of
permission.

### What Grant does

One window in front of the person, never two:

| Classes | Grant | Why |
|---|---|---|
| Microphone, Camera, Automation | the first Grant on a never-asked row: macOS's Allow / Don't Allow alone (an Automation target that is not running is launched hidden and asked); a switched-off row, or any later Grant: the pane | the dialog is the grant. Don't Allow is recorded (status denied): the row becomes a cross, and the result says the person denied it in macOS's own dialog |
| Accessibility, Full Disk Access | the pane | the probe itself makes tccd list the app there, switched off (`AXIsProcessTrusted`; the refused read: "recording denied"), so the person only switches it on |
| Screen Recording, Input Monitoring | the first Grant on a never-asked row: the request API alone (`CGRequestScreenCaptureAccess`, `IOHIDRequestAccess`); a listed (switched-off) row, or any later Grant: the pane, and the server host shown in Finder while the probe says it is still not listed (tccd's preflight authValue 1 / `IOHIDCheckAccess` 2) | nothing lists the app silently, but the request's alert ("… would like to …", Open System Settings / Deny) does, and its Open System Settings lands on the pane with the row there. Its Deny is not recorded: the row stays a question mark (Deny on the card refuses it) |

Accessibility's request alert (`AXIsProcessTrustedWithOptions` with the
prompt) is never raised: the plain trust check lists the app silently, so the
pane alone is one window less. Which call lists the app silently was found on
macOS 27.2 with throwaway test apps (tccd's log: a `Modify` or `Create` event
for the bundle, and a preflight answering denied instead of unknown
afterwards): `AXIsProcessTrusted` lists it, also from an `osascript` child; a
refused Full Disk Access read lists it; for Screen Recording neither the
preflight, `SCShareableContent` nor a capture does, nor for Input Monitoring
the preflights, an event tap or an `IOHIDManager` open. Dragging the app in
from Finder (upstream's computer-use helper, `experimental/cua-macos`, guides
that) is the fallback when the alert did not list it.

What macOS's dialogs say is fixed: the Microphone, Camera and Automation
dialogs show the server host's usage strings (`NSMicrophoneUsageDescription`,
`NSCameraUsageDescription`, `NSAppleEventsUsageDescription`, written when the
server host is built, apps/macos). That is why the agent's sentence goes on
the card.

### The floating panel

A call nobody acts on should not wait unseen in a session the person is not
looking at, or while DeepSea is behind other windows. So the package root's
browser half, in every page of the macOS app (`__DEEPSEA_APP__.showPanel`,
apps/macos → Floating panels), asks the running route every 2 s, and when a
call's `noticeAt` (its last activity plus `noticeSeconds`) has passed, the
app shows the card in a floating panel: above other windows, on every Space,
without taking focus. Its first line names the session ("‹workspace› /
‹title›", the default workspace by its sidebar name).

- Grant and Deny in the panel are the card's: the same routes and state; the
  inline card follows.
- The panel closes by itself a moment after the call ends (every row a tick
  or a cross, or the turn stopped).
- Closed by the person, it comes back only after another `noticeSeconds` of
  the call still waiting, and never twice at once: the app keeps one panel
  per id across its windows and tells every page when one opens or closes.
- In a plain browser or a thin client without the panel API, nothing extra
  shows: the inline card waits.

The panel shows a small standalone page (`GET
/api/deepsea-tool-system-permissions/panel`, [panel-page.mjs](panel-page.mjs),
[src/panel](src/panel) → `lib/panel.js`) rather than the GUI at a special
address: it loads at once, with no client shell to boot and hide, behind the
same authentication (the panel shares the app's cookies), and it draws the
rows from the card's own model and stylesheet. Clicking the session line does
nothing yet.

### Stale entries

The probe reads tccd's own record of each probe from the unified log (`log
show`, no Full Disk Access needed): the preflight's `authValue` (0 denied, 1
not determined, 2 allowed), matched by the probe's `msgID`, which tells a
switched-off row from a missing one for Screen Recording and Accessibility;
and any `Failed to match existing code requirement for subject <server host>
and service <service>` line, which marks the row **stale** (an orange
question mark). This runs at the first probe and at most every 5 s while a
row is being granted.

Grant on a stale row first removes that entry:

```
/usr/bin/tccutil reset <Service> <server host bundle id>
```

with exactly one service (`ScreenCapture`, `Accessibility`, `Microphone`,
`Camera`, `ListenEvent`, `SystemPolicyAllFiles` or `AppleEvents`: tccutil
adds the `kTCCService` prefix itself) and exactly the server host's bundle id,
never `All` and never without a bundle id. It runs only for a row the probe
judged stale (never-asked rows are not reset), at most once per call and row,
and only when the responsible app is a DeepSea server host
(`io.github.taliesinb.deepsea.<v>.server`); for any other app (a `dsh` started
from a terminal, say) nothing is reset. Grant then goes on as for a
never-asked permission (macOS's dialog or alert, or the pane).
`tccutil` needs the bundle registered with LaunchServices, as an installed
server host is. If the reset fails, the row stays stale and the
model is told how the person removes the entry by hand (select it, −). The
user's own tccd performs the reset; no administrator password is involved
(Chromium does the same for its own Screen Recording entry).

## Commands

`/system-permissions` (registered by the package root, which holds the
prober, the calls and the panel; the tools row joins agent presets and has
none of them):

| Command | Does |
|---|---|
| `/system-permissions` or `/system-permissions status` | one refined probe of every class; replies with a table, permission → `granted`, `denied`, `stale` or `not asked` (Automation targets also `not running`). Full Disk Access reads `denied` when not granted: its refused read records the row switched off. Automation lists System Events always, and every other target the tool names (`automation:<name>` list above) whose answer says something: a target that is not running cannot be asked without launching it, one not installed is left out |
| `/system-permissions remove` | removes every privacy grant and row of this variant's server host: `/usr/bin/tccutil reset <Service> <server host bundle id>` for ScreenCapture, Accessibility, Microphone, Camera, ListenEvent, SystemPolicyAllFiles and AppleEvents (every Automation target at once). Only this server host's id, refused for any app that is not a DeepSea server host, never `All`. No confirmation step. Replies with what was reset, and tccutil's message for any failure |
| `/system-permissions add` | starts a call for every class and Automation: System Events, each justified by `/system-permissions add`, shown at once in the floating panel (naming the session the command was run in), and live in the command's row in the session, which is all there is without the app (a plain browser) |

The chat shows a command's reply in a monospace block (no Markdown), so the
`status` and `remove` tables are aligned text. The command's row is this
package's keyed `conversation.chat.commandview` entry: the reply for `status`
and `remove`, the live card for `add` (its reply names the call: `call:
command-<id>`). `add`'s call is not a tool call: the model never sees it.

## The card

The keyed `tool.call.toolview` entry for `seek_system_permission`: a header
(shield, "System permissions", the server host's name and how many are
granted) and one row per permission: a mark, the name, the agent's
justification (secondary text, cut with an ellipsis, whole in its tooltip)
and Grant and Deny while the row is open. Where the card is narrower than
520px (a phone) the justification wraps under the name. There is no state column: the mark carries the state
(✓ granted; ? not yet, pulsing while being granted, orange when stale; ✗
denied, unavailable or cancelled), and the row's tooltip, also the mark's
accessible name, gives the short state ("granted after 42s", "switched off",
"stale entry", "app not running", "waiting", "restricted", "cancelled").

While the call runs the card asks the status route every second. The first
time it has an open row it opens any collapsed "Called tools" group around it
(the standard and compact chat views fold a running turn's tool calls) and
scrolls it into view, handing the keyboard focus back; once the turn has
ended it folds like any tool call. A settled card draws the result's
`presentationMeta`; a cancelled call (whose result carries none) is drawn
from the root row's record of it, which survives a reload and a server
restart.

Copy: the `card` section of [locale/en.json](locale/en.json) and
[locale/zh.json](locale/zh.json), whose keys must match (the tests check).

## Two rows

The package inserts two rows (plugins/AGENTS.md → Presets, "Two rows, one
package"):

| Row | Module | Title | Where | Holds |
|---|---|---|---|---|
| `deepsea-tool-system-permissions-tools` | `@deepsea/tool-system-permissions/tools` ([tools.js](tools.js)) | System permission tool | the agent presets that have upstream's `@deepseek-ai/dsh-tool-bash`; disabled globally | the tool, the prompt hint, `pollSeconds`, `noticeSeconds`, `promptHint` |
| `deepsea-tool-system-permissions` | `@deepsea/tool-system-permissions` ([index.js](index.js)) | System permission controls | global | the prober and the running and finished calls (service `deepseaSystemPermissions`), the routes, the card, `fakeStateFile` |

The tools row joins the presets that have `bash`: these permissions guard
what the agent's shell commands do. In rc.1 that is `standard`, `ptc` and
`cordis`. Without the root row the tool still works on a macOS prober of its
own, but no card can grant or deny: only Stop moves it.

The plugin is **machine-wide** (`deepsea.machineWide`): it asks macOS for
prompts and opens System Settings for the server host app, which a throwaway
shares with the variant that started it. `dsd run … --plugins all` leaves it
out of throwaways; naming it includes it (use `fakeStateFile` there).

## How it works

- [permissions.mjs](permissions.mjs): the classes (ids, aliases, TCC
  services, pane anchors) and the instructions the model relays.
- [macos/probe.jxa](macos/probe.jxa): the probes and triggers, JavaScript for
  Automation through `osascript -l JavaScript` (no build step): `probe <id>…`
  prints the statuses and the responsible app (`responsibility_get_pid_responsible_for_pid`,
  `proc_pidpath`, its bundle's name and id); `trigger <id>` asks macOS and
  stays alive while an asynchronous prompt is open; `selftest` checks the
  Objective-C methods the triggers use without calling them.
- [macos.mjs](macos.mjs): runs the script, refines from tccd's log, launches
  Automation targets, opens panes, resets stale entries.
- [command.mjs](command.mjs): `/system-permissions` (Commands, above).
- [fake.mjs](fake.mjs): the test prober (below).
- [seek.mjs](seek.mjs): one call's session (rows, polling, Grant, Deny,
  notice time, cancellation), the registry, the tool and its text.
- [index.js](index.js) (root row) routes, behind DSH's authentication:
  - `GET /api/deepsea-tool-system-permissions/status?callId=…&sessionId=…` →
    `{ running, snapshot: { subject, rows, startedAt, finishedAt,
    noticeAt, noticeMs }, now[, fake: { events }] }`; `403` for another session's
    call, `404` for an unknown one. Finished calls are kept, the last 200, in
    `$DSH_HOME/plugins/tool-system-permissions/calls.json`.
  - `POST /api/deepsea-tool-system-permissions/action` with a JSON body `{
    action: 'grant' | 'deny', permission, callId, sessionId }` → `{ ok }`;
    `404` when the call or the row is no longer open, `415` without
    `content-type: application/json`.
  - `GET /api/deepsea-tool-system-permissions/running` → `{ calls: [{ callId,
    sessionId, noticeAt, noticeMs, open, total }], now }`: the calls with an
    open row, for the notices.
  - `GET /api/deepsea-tool-system-permissions/panel?callId=…&sessionId=…&panel=…`:
    the floating panel's page, with the session's workspace (registry
    `workspaceRegistry`) and title (`sessionController`).
- [src/client](src/client) → `lib/client.js`: the card ([model.ts](src/client/model.ts)
  holds its pure part, [styles.ts](src/client/styles.ts) its stylesheet) and
  the notices ([notice.ts](src/client/notice.ts)).
- [src/panel](src/panel) → `lib/panel.js`: the floating panel's page script,
  plain DOM over the card's model and stylesheet.

## Configuration

```yaml
- id: deepsea-tool-system-permissions-tools
  config:
    pollSeconds: 1.5        # between probes of the open rows
    noticeSeconds: 60       # inactivity before the macOS app shows the card in a floating panel (0: never)
    promptHint: true        # the system-prompt section
- id: deepsea-tool-system-permissions
  config:
    fakeStateFile: ''       # test mode (below)
```

### Test mode

With `fakeStateFile` set, the root row's prober never runs `osascript`,
`tccutil` or `open`: it reads the statuses from that JSON file at every probe
and only records what it would have done (the status route's `fake.events`,
and the server log): triggers, panes, Finder reveals, and resets with the
exact `tccutil` argv:

```json
{ "subject": { "name": "DeepSea Test Server" },
  "states": { "accessibility": "granted", "microphone": "stale" } }
```

A class the file does not name is `not-determined`; rewrite the file to flip
one. After a recorded reset, a class the file still calls `stale` reads as
`not-determined` until the file changes. A throwaway with it:

```sh
dsd run release --throwaway-app --detach --scripted --plugins tool-system-permissions --patch fake.yml
# fake.yml: - id: deepsea-tool-system-permissions
#             config: { fakeStateFile: /path/to/state.json }
```

and a scripted prompt line `{"cmd":"tool","name":"seek_system_permission","args":{"permissions":[{"permission":"screen-recording","justification":"To take screenshots of the prototype."}]}}`.

## Development

```sh
pnpm install          # also builds lib/client.js (prepare)
pnpm test             # permissions, probes and log parsing, the session (Grant per class, Deny, notice time, stale reset, cancellation), the command (status, remove's exact tccutil argv, add), the four routes, the notices' decisions, the panel page, the card's model and dictionaries
pnpm typecheck        # browser half against the harness's declarations
osascript -l JavaScript macos/probe.jxa probe screen-recording microphone   # the real preflight, charged to whatever app runs your shell
```
