# Rebuilding the variant you run in

When the person asks to "rebuild release" (or whichever variant hosts your
session; `DEEPSEA_VARIANT` and `DSH_HOME` name it), the install restarts the
relay and the server your session runs on. Your turn, and every process it
started, goes down with them. Follow these steps in this order.

## 1. Commit what is shipping

A variant builds from a commit (`source:` in its `variant.yml`, normally
`integration/base`), never from a working tree. Being asked to rebuild with a
fix means you may commit that fix on its topic, in the topic's worktree
(`dsd worktree add <topic>`). Shared files edited in the main checkout stay
uncommitted unless the person says otherwise. Uncommitted changes are not in
the build.

## 2. Integrate, after a dry run

```sh
pnpm -s dsd topics integrate --dry-run   # in the main checkout
```

Read `dirty` and the `(new merge)` entries before integrating. A topic with
uncommitted work, or with commits from minutes ago, may belong to another
agent working right now: integrating it ships its committed half to the
person's own variant. Ask the person whether it should go in. To leave a
topic's plugin out of a variant, replace `plugins: all` in its `variant.yml`
with an explicit list (`variantPlugins` in `tools/dsd/commands/variant.mjs`;
there is no "all but" form). A plugin added later then needs adding there by
hand. Then:

```sh
pnpm -s dsd topics integrate
```

A failed "collecting unused builds" at the end leaves the integration in
place. It is only the clean-up.

## 3. Build without installing, in the foreground

```sh
pnpm -s dsd build release        # no --install: needs no --self
```

This makes the immutable build (`~/.deepsea/_builds/deepsea-<12 hex>`) and,
on macOS, the app in a temporary directory. It never touches the home, the
profile, the relay or the server, so the running variant is safe, and build
failures show up here while you can still report them. Check its `plugins`
list.

## 4. Install from a detached process, then end the turn

`dsd build <v> --install` refuses the hosting variant unless `--self`. It
writes the profile's bundles and replaces the app in `~/Applications`, then
reloads the relay job (`launchctl bootout` + `bootstrap`). That stops the
server, and launchd kills the server's process group, which includes your
shell. So the install runs in a session of its own, after a delay long
enough for your last message to be sent:

```sh
LOG=<main checkout>/private/rebuild-release-$(date +%Y%m%dT%H%M%S).log
perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV' /bin/sh -c \
  "sleep 20; cd <main checkout> && pnpm -s dsd build release --install --self > '$LOG' 2>&1; echo exit=\$? >> '$LOG'" \
  < /dev/null > /dev/null 2>&1 & disown
```

- `setsid` (macOS has no `setsid` command, hence perl) gets it out of the
  server's process group. `nohup` alone does not.
- The log goes in `private/` (git-ignored). Give the person its path.
- In the same final message, tell the person that the chat will drop for a
  moment and reconnect on the new build, and what to check afterwards.
  Don't start other work after scheduling the install.

## 5. After it reconnects

The next turn runs on the new server. Check:

- the log ends in `exit=0`;
- `variant.yml` has `build: <the integration commit>` and a fresh
  `installed:`;
- the change itself (here: the server log of the new run, under
  `~/Library/Logs/<bundle id>/server/`).

If the log shows a failure, nothing after the failing step ran. A failure
before the relay reload leaves the old server running. One after it leaves
the relay job as written: `dsd run release` starts it again.
