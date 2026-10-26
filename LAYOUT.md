# DeepSea layout — names, identifiers and disk locations

**Status: agreed (2026-10-07 review), not yet implemented.** Each rule lands
in the topic that first creates the thing it names (see AGENTS.md), so no
later rename is needed.

## 1. Names and identifiers

**DeepSea** is the combination of the custom DeepSeek Harness (DSH) fork and
this plugin set. Every install is a **variant** with an id `<v>`
(lowercase, `[a-z0-9-]`); the everyday install is the variant **`release`**.
One string names a variant everywhere: its **variant name**
`io.github.taliesinb.deepsea.<v>`, which is also its app's bundle id.

| Concept | `release` | Any other variant `<v>` (e.g. `personal`, `preview`) |
|---|---|---|
| Variant name = app bundle id | `io.github.taliesinb.deepsea.release` | `io.github.taliesinb.deepsea.<v>` |
| Server host bundle id | `<variant name>.server` | same |
| Relay LaunchAgent label | `<variant name>.relay` | same |
| Relay systemd user unit (Linux) | `<variant name>.relay.service` | same |
| Logs | `~/Library/Logs/<variant name>/` | same |
| Application Support | `~/Library/Application Support/<variant name>/` | same |
| DSH home (`DSH_HOME`) | `~/.deepsea/release/` | `~/.deepsea/<v>/` |
| Backups | `~/.deepsea/_backups/release/` | `~/.deepsea/_backups/<v>/` |
| Display name | **`DeepSea`** | `DeepSea <V>` (title case: `DeepSea Personal`) |
| Native app / server host | `DeepSea.app`, `DeepSea Server.app` | `DeepSea <V>.app`, `DeepSea <V> Server.app` |
| Tailscale Serve path (default; §7) | **`/deepsea/`** | `/deepsea-<v>/` |

**Rule: what a person reads or types leaves `release` out** (the display
name, the app's file name, the Tailscale URL); everything else carries it.
Those are the only two forms, and they cannot collide: `/deepsea/` and
`/deepsea-<v>/` are separate Serve mount points, and no variant is called
plain "DeepSea".

Components append to the variant name (`.server`, `.relay`), so every file,
job and directory of one variant starts with the same string, next to the
ones macOS creates itself for that bundle id (`~/Library/Caches/`,
`WebKit/`, `Preferences/`, `HTTPStorages/`): `ls ~/Library/*/<variant name>*`
finds a variant, and removing a variant removes that prefix.

**Machine-wide things use the bare root** `io.github.taliesinb.deepsea`,
which no variant uses: the window helper (`DeepSea Window Helper.app`, bundle
id `io.github.taliesinb.deepsea`) and installer logs
(`~/Library/Logs/io.github.taliesinb.deepsea/`). Variant ids cannot contain a
dot, so nothing collides and no variant id is reserved.

**Throwaway variants** are made by `dsd` for development and tests: id
`<parent>-<hex>`, six random hex digits after the variant whose
configuration they inherit (`personal-3f9a1c`: variant name
`io.github.taliesinb.deepsea.personal-3f9a1c`, home
`~/.deepsea/personal-3f9a1c/`, display name `DeepSea Personal 3f9a1c`; a
throwaway of `release` is `DeepSea 3f9a1c`). A named variant's id never ends
in `-` plus six hex digits, so the two cannot collide. Throwaways have no
Tailscale Serve path.

Code-level names:

| Thing | Name |
|---|---|
| Plugin directory | `plugins/<name>` (short, no product prefix: `tailscale`, `login`, `billing`) |
| Plugin package | `@deepsea/<name>` (also the client bundle's module id) |
| Loader row id | `deepsea-<name>` (prefixed so it never collides with an upstream row) |
| Page globals set by the native app | `__DEEPSEA_APP__` (identity, `openExternal`, view mode) |
| Environment variables of our own | `DEEPSEA_VARIANT`, `DEEPSEA_ROOT` (default `~/.deepsea`), `DEEPSEA_LOG_ROOT`, `DEEPSEA_WORKTREES`; `DEEPSEA_RELAY` (set by the relay for the `dsh web` it starts: the relay's URL) |
| Temporary files | `$TMPDIR/deepsea-<component>-…` (never bare `/tmp`) |
| Settings section labels | the plain name of the service or feature ("Tailscale"), never a description of it |

Upstream names stay upstream's: `DSH_HOME`, `__DSH_TRANSPORT__`, `@deepseek-ai/*`,
`dsh` (the CLI). The harness fork changes its built-in default home from
`~/.dsh` to `~/.deepsea/release` (a small fork topic), so a DeepSea `dsh`
started without `DSH_HOME` never touches a stock DSH install; launchers still
set `DSH_HOME` explicitly.

## 2. Working copies

`<repo>` is wherever this repository is checked out; nothing depends on that
location, and every path in the repository is relative to it.

| What | Where |
|---|---|
| This repository | `<repo>` |
| The harness fork | its own repository, named in `harness.lock` (path relative to the main checkout `<repo>`, also from a worktree) with the commit this repository pins; `<repo>/harness` is a git-ignored link to that commit's build |
| Topic worktrees of this repository | `<repo>-worktrees/<topic>/` (a sibling of the checkout) |
| Topic worktrees of the harness fork | `<repo>-worktrees/harness-<topic>/` |

`DEEPSEA_WORKTREES` overrides the worktree directory; `dsd` derives
it, so it is never typed by hand. Worktrees live outside the checkout so that
package managers, type checkers and searches in one never see the others.

### Builds

Variants run immutable builds, one per commit, shared by every variant and
worktree that needs that commit:

```
~/.deepsea/_builds/
  harness-<commit>/        the harness fork at one commit, installed and built
  deepsea-<commit>/        this repository at one commit, plugins built, using
                           harness-<the commit it pins>/
```

- `dsd` builds a commit once, under a lock, so two agents never build the
  same commit at once, and never rebuilds a build in place: a new commit is a
  new build, and moving a variant to it is a stop and a start. No server ever
  runs from a tree that is being built.
- A topic worktree of this repository uses the build of the harness commit
  it pins as its `harness/`, rather than checking out and building its own.
  Only harness topic worktrees build the harness themselves (incrementally
  after the first time).
- Throwaway variants may run straight from a worktree instead of a build, so
  a plugin under development can be rebuilt and reloaded in place; named
  variants always run a build.
- On APFS, pnpm installs are copy-on-write clones of pnpm's shared store, so
  a build's `node_modules` costs little disk; a harness build's output is
  about 400 MB.
- `dsd gc` removes builds that no variant and no worktree uses.

Names under `~/.deepsea/` that are not variant homes start with `_`, which
no variant id may contain, so they never collide with one: `_builds/`,
`_backups/`, and `_sim/`, the provider simulator's accounts
(tools/provider-sim/README.md).

Private plugins are not part of this layout yet: they arrive last, as an
`extras` topic, whose shape is decided then.

## 3. Repository tree

```
AGENTS.md          how agents work here (start here)
LAYOUT.md          this file
topics.txt         the harness topics and their order (this repository's topics are its branches)
apps/macos/        native app, server host, window helper (Swift)
apps/relay/        the relay every installed variant runs (§6; Node, no dependencies)
apps/linux/        Electron client
plugins/<name>/    one installable package per plugin; plugins/AGENTS.md
packages/<name>/   code shared by plugins and tools (`@deepsea/<name>`, no dependencies)
tools/dsd/         `dsd`, the developer CLI: variants, topics, worktrees
tools/provider-sim/ simulated model providers for tests (`dsd run … --simulated`)
tools/             bootstrap and uninstall (plain shell, for fresh machines)
recipes/           one file per completed setup or change (later)
harness.lock       the harness repository and the commit pinned
harness            git-ignored link to the pinned commit's build (made by dsd)
private/           machine-local, git-ignored
```

Beside it, `<checkout>-extras/` (default `~/ds/deepsea-extras`, or
`DEEPSEA_EXTRAS`): a separate, private repository of plugins that
are not published with this one, in the same `plugins/<name>/` layout
(packages `@deepsea/<name>`), with a `harness` link the main checkout's
`dsd link` keeps on its pin. dsd finds a plugin there when this repository
has none of that name (tools/dsd/README.md).

The native apps live in `apps/`, not inside a plugin: they are the product's
shell, used by every variant whether or not any particular plugin is
installed.

## 4. Per-home state

Everything DSH itself owns stays where DSH puts it (`sessions/`,
`attachments/`, `storages/`, `cache/`, `profiles/`, `.credentials.yaml`).
dsd installs a variant's plugins into `profiles/web/` as bundles (its
`package.json` and `node_modules/@deepsea/`; tools/dsd/README.md), as
`dsh plugin add` would.
Plugin state lives in the home, one directory per plugin, never suffixed
with the variant (the home already is the variant):

```
~/.deepsea/<v>/
  variant.yml              the variant's configuration (written by `dsd`)
  adopted.json             what `dsd adopt` brought from old DSH homes, per source (tools/dsd/README.md)
  plugins/<name>/          e.g. plugins/billing/, plugins/tailscale/state.json,
                           plugins/tailscale/session-owners.json,
                           plugins/remote-workspaces/workspaces.json
  logs -> ~/Library/Logs/<variant name>/
  support -> ~/Library/Application Support/<variant name>/
  source -> the build (or, for a throwaway, the worktree) this variant runs
```

**The home is the variant's front door.** Everything about a variant is
reachable from it through these three links, which `dsd` creates and repairs
from `variant.yml` (it never makes links in the other direction, so nothing
outside the home depends on them):

- `logs`: the variant's log directory (§5). DSH writes its own startup
  failure reports to `$DSH_HOME/logs/startup-*.log`; through the link they
  land beside the app, relay and server logs. On Linux the link points to
  `${XDG_STATE_HOME:-~/.local/state}/<variant name>/`.
- `support`: the variant's Application Support directory (§6): server host
  app and relay link. On Linux `${XDG_DATA_HOME:-~/.local/share}/<variant
  name>/`, holding the relay link. Absent for throwaways, which install
  nothing there.
- `source`: which code the variant runs, so `ls -l` answers that question.

The backup plugin records links as links, so logs (which hold the launch
token) never enter a backup, and a restore recreates the links. Deleting a
home deletes only the links; `dsd` removes a variant by its variant name, in
the home and in `~/Library`, so nothing is left behind.

Files a plugin produces for the user follow the same rule: where the caller
names a path (a saved screenshot, an exported transcript) that path wins,
relative to the session's working directory; otherwise the plugin writes
under `$DSH_HOME/plugins/<name>/`, so outputs are per variant like
everything else. Backups are the one exception: they sit beside the homes,
in `~/.deepsea/_backups/<v>/` (§1), because a backup inside the home would
include itself.

## 5. Logs (macOS)

```
~/Library/Logs/<variant name>/                0700
  app/<ts>-<pid>.log                          native app, one file per run
  app/latest.log -> …
  app/snapshots/
  relay/<ts>-<pid>.log
  relay/launchd.log                           plist StandardOut/Err only (Linux: relay/systemd.log, the unit's)
  relay/console.log                           a throwaway relay's stdout/err (dsd run --throwaway)
  server/<ts>-<pid>.log                       one per `dsh web` start; 0700 dir, 0600 files (launch token)
  plugins/<name>/<ts>-<pid>.jsonl             one trace per server process
~/Library/Logs/io.github.taliesinb.deepsea/   machine-wide (bare root)
  installer/<ts>-<pid>.log
  builds/<ts>-harness-<12 hex>-<pid>.log      one per shared build (§2)
```

For example, with `release`, `personal` and one throwaway:

```
~/Library/Logs/
  io.github.taliesinb.deepsea/installer/2026-10-07T15-40-02-8812.log
  io.github.taliesinb.deepsea.release/
    app/2026-10-07T19-04-14-4410.log
    app/latest.log -> 2026-10-07T19-04-14-4410.log
    server/2026-10-07T09-12-40-4398.log
    relay/2026-10-07T09-12-39-4390.log
    plugins/browser/2026-10-07T09-12-40-4398.jsonl
  io.github.taliesinb.deepsea.personal/
    app/…  server/…  relay/…  plugins/…
  io.github.taliesinb.deepsea.personal-3f9a1c/
    app/…  server/…
```

The directory names the variant and the component; the file name only the
run. A file's identity is its first line:

```
2026-10-07T19:04:14+01:00 io.github.taliesinb.deepsea.release app pid 4410 DeepSea 0.2.1 (fe14ac9)
```

`dsd logs <ref> --export` writes a copy with the identity in its name
(`deepsea.release-app-2026-10-07T19-04-14.log`) for attaching elsewhere.

- `<ts>` is local time `yyyy-MM-ddTHH-mm-ss` (sortable, no colons). Each
  file's first line states the start time in ISO 8601 with UTC offset, the
  pid, the variant and the executable and version; every later timestamp is
  ISO 8601 with offset.
- The writer keeps a `latest` symlink and prunes its own directory at start:
  the newest 20 runs and anything younger than 14 days (snapshots: newest 50).
- One helper decides the directory (`packages/logs`, used by plugins and
  dsd; the macOS app has a Swift copy): the variant from `DEEPSEA_VARIANT` if
  set, else from `DSH_HOME` (`~/.deepsea/<v>` → `<v>`); the parent
  directory from `DEEPSEA_LOG_ROOT` if set, else the platform default.
- Plugin traces default to their `plugins/<name>/` directory; a trace is on
  only when configured.
- Linux: the same tree under `${XDG_STATE_HOME:-~/.local/state}/<variant name>/`.

## 6. Application Support and launchd

```
~/Library/Application Support/<variant name>/
  DeepSea[ <V>] Server.app                  server host (TCC identity of the server)
  deepsea-relay                             named node symlink the host starts
~/Library/Application Support/io.github.taliesinb.deepsea/
  DeepSea Window Helper.app                 machine-wide
~/Library/LaunchAgents/<variant name>.relay.plist
~/Applications/DeepSea[ <V>].app            the app (§1); a Dock tile only with `dsd build --install --dock`
```

Throwaway variants install nothing here: `dsd` runs their apps and relay as
child processes from a temporary build directory, with no LaunchAgent and no
LaunchServices registration.

**How an installed variant runs.** Installing is `dsd`'s job (`dsd build <v>
--install`); a plugin never installs or reinstalls anything machine-wide, so
no button can take down the server it runs in.

```
launchd ── <variant name>.relay (RunAtLoad, KeepAlive)
  └─ DeepSea[ <V>] Server.app   server host: spawns its arguments, forwards signals; macOS
     │                          charges privacy prompts of everything below to this bundle
     └─ deepsea-relay <build>/apps/relay/relay.mjs     always listening on the block's +3
        └─ dsh web (the variant's build, through the login shell, so agents get the
                    person's PATH), started on the first connection, restarted by the relay
```

- **Linux** has no app, server host or Application Support: `dsd build <v>
  --install` writes `${XDG_CONFIG_HOME:-~/.config}/systemd/user/<variant
  name>.relay.service` (enabled for `default.target`, `Restart=always`)
  running `deepsea-relay` (the node link in the support directory, §4)
  directly; the user manager stands where launchd does, from login to the
  last logout, or always when the account lingers.
- The LaunchAgent and the server host name the build path itself, never
  `<home>/source` (nothing outside the home depends on the home's links).
- The relay (`apps/relay`) is part of every installed variant, with or
  without the tailscale plugin. While `dsh web` starts it answers 503 with
  `x-deepsea-relay: starting` and a page that reloads itself; the app shows
  that page.
- Clients on this machine (the app's fallback URL) reach `dsh web` through
  the relay. The relay keeps a standing token in `<home>/relay/state.json`
  (0600; the app's token file) and starts `dsh web` with it as its launch
  token (`DSH_LAUNCH_TOKEN`, harness topic `launch-token`), so
  `/?token=<standing token>` always logs in and DSH's own browser cookie
  then admits the client, across restarts.
- Clients on the tailnet come through Tailscale Serve to the relay, which
  hands them to the tailscale plugin's proxy on the block's +4: Tailscale
  identity, the proxy's own token and cookie (per variant:
  `deepsea-tailscale-<v>`, `Path=<serve path>`). Without the plugin, tailnet
  requests are refused.

## 7. Network

- Tailscale Serve paths default to §1's. On a Mac with several accounts the
  paths and ports are machine-wide: `dsd new` records each variant's port
  block and Serve path in its `variant.yml`, picks the first free block (no
  listener on any of its ten ports, no other variant of this account
  recording it), and when another account already serves the default path
  uses `/deepsea-<user>/` (release) or `/deepsea-<v>-<user>/`. The tailscale
  plugin never replaces a Serve mapping it does not own (one whose target is
  not this variant's relay).
- Ports: each variant gets a block of ten from 3200 (`release`: 3200, then 3210,
  3220, …), clear of a stock DSH on 3080-31xx: `dsh web` on the block's first
  port, relay on `+3`, Tailscale proxy on `+4`. The block is recorded in the
  variant's `variant.yml`, nowhere else. Throwaways take free ports instead.
  A machine may give each account a range of its own (`dsd new --ports`,
  `DEEPSEA_PORTS`): blocks and throwaways' ports are then taken there.
- A variant may be served from a tailscaled of the account's own
  (`tailscaleSocket` in `variant.yml`), whose node is the person's alone, on
  a machine whose own node is not theirs (tools/dsd/README.md, Linux).
