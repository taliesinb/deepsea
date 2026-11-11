# AGENTS.md — DeepSea

**DeepSea** is a customized DeepSeek Harness (DSH): a fork of DSH kept as
topic branches over upstream releases (`harness/`), plus the plugins, native
apps and tools in this repository. This file is the starting point for agents
working here. Names, identifiers and disk locations are defined in
[LAYOUT.md](LAYOUT.md); plugin conventions in
[plugins/AGENTS.md](plugins/AGENTS.md).

> **Running instances are not yours to change.** You are probably talking to
> the user through a DeepSea or DSH instance running on this machine. Its
> home (`~/.deepsea…`, `~/.dsh…`), its profile patches (`patchReload: live`
> applies edits the moment they are saved), its installed plugin bundles
> (rebuilding one hot-swaps the browser) and its server process are off
> limits unless the user explicitly asks. Trial work goes into a throwaway
> home or a variant the user has named for the purpose.

## Ground rules

- **Remotes.** This repository is public as `taliesinb/deepsea`, the harness
  fork as `taliesinb/deepsea-harness`. Push only when the user asks, following
  the local policy (Commits, below). Topic and integration branches are
  rebased and rebuilt, so their pushes use `--force-with-lease`.
- **Public.** Everything tracked is published: no
  host names, tailnet or MagicDNS names, macOS account names, logins, LAN
  addresses, personal names or `/Users/<login>` paths in code, comments, docs
  or commit messages. Use `<host>`, `<user>`, `<node>.example.ts.net`,
  `/Users/USER/…`, `user@example.com`. Machine-specific facts go in
  `private/`. The one personal name is the copyright holder in `LICENSE`.
- **`private/`** is git-ignored and machine-local: research, handoff notes,
  bookkeeping (for example which commits a topic was assembled from). Never
  reference its contents from tracked files beyond naming a path.
- **Features are plugins.** Change the harness only where no plugin seam
  exists, and then as a topic (below), never as a loose commit.
- **No explanatory text in the UI.** Labels, placeholders, short status lines
  and error messages only; explanations go in the README.
- **Docs own their layer.** A plugin's README owns that plugin; recipes own
  system-level stories; this file owns conventions. Cross-reference, do not
  duplicate.
- **Commits.** Commit only when the user asks. The local policy for commits
  and pushes, if there is one, is the main checkout's `private/AGENTS.md`. Features often require rounds of experimentation from the user to dial in behaviors, and we do not wish these to produce chains of small commits.

## Trying and testing

Everything runs in **throwaways**: a home, server and app of their own,
removed when stopped, never touching the user's instances. No real keys or
accounts are needed: every model provider can be **simulated**
(tools/provider-sim/README.md) with test accounts that keep credit, Plan
usage windows and prices, and the replies are scripts
(plugins/llm-scripted/README.md; type `help` as a prompt for the table).

| To | Run |
|---|---|
| hand the user something to try | `dsd play` (the app, visible, every plugin, every provider simulated with a key or a signed-in Plan; quitting it throws it away) |
| test a plugin's server half | `dsd run release --throwaway-server --detach --scripted --plugins <names>` |
| test what a person sees | `dsd run release --throwaway-app --detach --scripted --plugins <names>`: the macOS app, hidden |
| test restarts and cold starts | `--throwaway` instead: the app behind a relay, as installed |
| involve providers (models, sign-in, billing, quotas, provider errors) | add `--simulated` (default accounts `standard`; `--accounts openrouter-low,anthropic-max-80,codex-plus-signed-out` for edge states; `dsd sim fixtures` lists them) |
| run everything together | add `--source integration/base` (after `dsd topics integrate`) |
| drive it | `dsd drive -v <id> prompt - \| command /x \| open-session \| wait-page \| click \| hover \| type \| eval \| snapshot --window \| opened \| restart-server` (a prompt with no session goes to the latest, or a new one; read the snapshot PNGs) |
| rerun checks after each rebuild | a plugin: `plugins/<name>/tests/*.drive` (drive operations as lines, with `expect`, `let`, `try`), run by `dsd test plugins <name>`; a harness topic: its snapshot scenarios, run by `dsd test harness <topic> [<scenario>…] [--web]` (tools/dsd/README.md → Drive scripts, Testing a topic) |
| find an option | `dsd <command> --help`; `--get <path>` prints one field of any command's JSON (`--get id`, `--get summary.text`) |
| change a plugin's config in a throwaway | `--patch <file>` with a row `- id: <its row id>` and `config:` (it replaces that row's whole config) |
| read its logs | `dsd logs <id> [server \| app \| relay \| plugin <name>] [--follow]` |
| change an account mid-test | `dsd sim account <provider> <credential> --set '{…}'` (credential from `run`'s output) |
| bring an old DSH home (`~/.dsh…`) into a variant | `dsd adopt <old home> <v> --dry-run`, then without `--dry-run`; to try it first, `--throwaway --throwaway-app --detach --simulated` instead of `<v>` (reads the old home, never writes it) |
| finish | `dsd stop <id>` (always your own: `-v <id>` / `<id>`, never another agent's; never `dsd gc` while others work) |

The details: tools/dsd/README.md, plugins/AGENTS.md → Testing. Real
accounts are used only by the user, or with their go-ahead; a real key
never goes into a throwaway that agents drive.

## Repository layout

See LAYOUT.md §3. In short: `plugins/<name>/` (one installable package
each), `apps/macos/` and `apps/linux/` (native shells), `tools/dsd/` (the
developer CLI, `dsd`), `tools/` (bootstrap and uninstall),
`recipes/`, `harness.lock` (the harness repository and the commit pinned),
`harness` (git-ignored link to that commit's build), `private/` (git ignored). 

## Topic branches

Both this repository and the harness fork are kept as **topic branches**:

- A topic is one feature or one tight cluster of related plugins, on its own
  branch `topic/<name>`, based on its parent: `topic/base`, or another topic
  (stacked).
- Each repository has a baseline, its `topic/base`, which every integration
  starts from. In the harness it is the upstream release plus what every
  DeepSea variant always has (no Web preview notice); a change that belongs
  in every variant and every throwaway goes there, not into a topic. Moving
  to a new upstream release is rebasing the harness `topic/base` onto it,
  then its topics.
- `topics.txt` lists the harness topics in merge order with their parents.
  This repository's topics are simply its `topic/*` branches: a topic
  declares the harness topics it needs in its plugins' package.json
  (`"deepsea": { "requires": ["llm-route-metadata"] }`), so starting a topic
  edits no shared file. `dsd topics` lists both, with what each requires and
  how far it is behind its parent.
- `dsd topics check` merges every pair of topics and each repository's
  whole integration in memory, without touching a working tree, and reports
  conflicts. `dsd topics integrate` rebuilds the integration branches,
  `integration/<upstream>` in the harness and `integration/base` here,
  by merging the topics in order; `dsd run <v> --source integration/base`
  runs everything together. In the harness integration, dsd makes the
  generated files again (the lockfile, every output a harness `verify-<x>`
  gate checks, the graph docs last, and the translation record of any
  README pair whose record conflicted); a gate no generator can satisfy
  (a persistence-type change without its acknowledgement record) is
  reported under `warnings`.
- **Only `topic/base` touches shared files and the harness pin.** Plugin
  topics add their own directories; registries that list plugins or recipes
  are derived by scanning, not edited by hand, so topics do not conflict.
- **The main checkout stays on `topic/base`**, in both repositories (this
  one, and the harness repository `harness.lock` names). Base changes are
  made there. Integration branches are only built (`dsd topics integrate`)
  and run (`--source integration/base`); never check one out or commit on
  it, since the next integration replaces it. An agent that edits a shared
  file in the main checkout leaves the edit uncommitted for the user and
  says so in its report.
- **`topic/base` is append-only while topics are in progress.** A change to
  base is a new commit, and each topic takes it with a plain `git rebase
  topic/base`; rewriting base would force every topic through `--onto`.
  Folding base's commits into their final form waits until no topic is in
  progress.
- **Final form first.** A topic's commits introduce names, paths and wording
  in their final form. Unless it has already been pushed, a rename or tweak found later should be folded into the
  commit that introduced the thing (`git commit --fixup` /
  `--fixup=amend:`, then `git rebase -i --autosquash`) before the topic is
  considered done, not left as a trailing commit. Consult the user if this rule would involve complex rebasing, affect already-pushed work, or cross multiple topics. 
- After base or a parent topic changes, `dsd topics rebase` rebases every
  topic onto its parent (with `--onto` from the fork point, so a rewritten
  parent's old commits are not replayed; worktrees relinked; dirty or
  conflicting topics left alone and reported), and `dsd topics integrate`
  rebuilds the integrations.
- Work on a topic in its own worktree (LAYOUT.md §2), so agents can work on
  topics in parallel without sharing a working tree: `dsd worktree add
  <topic>` creates the branch from `topic/base`, the worktree, its `harness`
  link and the pre-commit check. Use that worktree's own dsd
  (`pnpm dsd …` there): plugins and the pin come from the checkout dsd
  belongs to.
- **Every commit is scanned** by the pre-commit hook (`dsd check --staged`):
  local account paths, private addresses, tailnet names, email addresses,
  and the machine-local patterns in `private/check-patterns.txt`. A hit
  blocks the commit. Text a test needs as it is (a fake home path, a
  private address in a resolver test) ends its line with a `dsd-check:
  allow` comment; never commit with `--no-verify`.

## The plugin model in one page

DSH is a tree of Cordis plugins. A plugin exports `apply(ctx, config)` (or
`{ name, inject, apply }`, or a `Service` subclass); everything it registers
through `ctx` is undone when it unloads; a plugin whose `inject` names a
missing service waits silently. A plugin package may have a browser half
(`./client`, declared by `dsh.client` in package.json) that the web shell
loads as a client plugin and that contributes UI through typed slots. Details
and conventions: [plugins/AGENTS.md](plugins/AGENTS.md).

Authoritative references for the fork of DSH itself, which is rooted in `harness/`:

| Topic | Path |
|---|---|
| First plugin, tools, config, packaging | `docs/user/develop/basic/` |
| Services and events | `docs/user/develop/framework/` |
| Cordis tutorial / primer / API | `docs/cordis-tutorial/`, `docs/cordis-primer.md`, `docs/cordis-api/` |
| Architecture, profile and bundle layering | `docs/architecture.md` |
| Config schema catalog | `docs/config-catalog.md` |
| Tool catalog | `docs/tool-catalog.md` |
| Web client, slots, client modules | `docs/subsystems/web-client.md`, `slots.md`, `client-modules.md` |
| Client house rules | `packages/client/AGENTS.md` |
| CLI flags, profiles, layer precedence | `apps/cli/reference/README.md` |

Verify against the checkout; this file summarizes, the code is the truth.

## Recipes

After any non-trivial completed task, write or update a recipe in
`recipes/`: one topic per file, exact commands and configuration, the reasons
behind non-obvious choices, and what failed and why. Index it here.

| Recipe | For |
|---|---|
| [rebuild-own-variant.md](recipes/rebuild-own-variant.md) | rebuilding and installing the variant your own session runs in (`build --install --self`, detached) |
