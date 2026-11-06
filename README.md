# DeepSea

DeepSea is a customized [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH): a fork of the harness kept as topic branches over its releases
([taliesinb/deepsea-harness](https://github.com/taliesinb/deepsea-harness)),
plus the plugins, the native macOS app and the developer tools in this
repository. Nearly every feature is a plugin; the fork changes the harness
only where no plugin seam exists.

It is a personal setup, developed in the open: macOS first, moving quickly,
with no stability promises.

## Trying it

You need macOS with the Command Line Tools (`swiftc`), Node 22.19+ or 24+,
and pnpm 11. The harness lives in its own repository beside this one
(`harness.lock` names it as `../deepsea-harness`, with the commit pinned):

```sh
git clone https://github.com/taliesinb/deepsea.git
git clone https://github.com/taliesinb/deepsea-harness.git
cd deepsea
node tools/dsd/bin/dsd.mjs link    # build the pinned harness commit, link ./harness to it
node tools/dsd/bin/dsd.mjs play    # the app with every plugin and simulated providers
```

On a fresh Mac, [tools/bootstrap.sh](tools/bootstrap.sh) does all of this
and more: the Command Line Tools, Node and pnpm (no administrator access
needed), both clones in `~/ds`, the harness build and an installed DeepSea
in the Dock. It is safe to run again, and `--help` lists its options:

```sh
curl -fsSL https://raw.githubusercontent.com/taliesinb/deepsea/topic/base/tools/bootstrap.sh -o bootstrap.sh
bash bootstrap.sh
```

`dsd play` starts a throwaway: its own home, server and app, every model
provider simulated with test accounts and a scripted model (type `help` as a
prompt), removed when you quit the app. No keys or accounts are needed.
Installing a variant you keep, and everything else `dsd` does, is in
[tools/dsd/README.md](tools/dsd/README.md).

On Linux, `dsd` installs and runs variants as servers (no app): its relay as
a systemd user unit, reached from another machine's DeepSea, a browser or
the Linux thin client in `apps/linux`. What it needs there, an official Node
build and a C compiler among them, is in the Linux section of
[tools/dsd/README.md](tools/dsd/README.md#linux).

## Branches

| Branch | |
|---|---|
| `integration/base` (default) | everything together: `topic/base` with every topic merged |
| `topic/base` | the baseline: `dsd`, the shared packages, the conventions |
| `topic/<name>` | one feature or one tight cluster of plugins, based on `topic/base` |

The harness repository is arranged the same way: `topic/base` over the
upstream release, its topics listed in [topics.txt](topics.txt), and
`integration/<release>` merging them. Topic and integration branches are
rebased and rebuilt as the work moves; see [AGENTS.md](AGENTS.md).

## Plugins

| Plugin | |
|---|---|
| [command-ask](plugins/command-ask) | `/ask`: side questions about a session, answered from its context while it keeps working |
| [command-import-api-keys](plugins/command-import-api-keys) | `/import-api-keys` from pi, another home, a JSON key map or a `.env` file |
| [command-reboot](plugins/command-reboot) | `/reboot` the server from inside a session |
| [command-tools](plugins/command-tools) | `/tools` lists the agent's tools without a model turn |
| [dev-test-driver](plugins/dev-test-driver) | the halves of `dsd drive` |
| [host-backup](plugins/host-backup) | `/backup` and `/restore` of the whole home as verified ZIPs |
| [host-server-log](plugins/host-server-log) | the server's own log messages in the variant's log |
| [host-tailscale](plugins/host-tailscale) | the variant on a tailnet: Serve path, settings, QR codes, port forwarding |
| [llm-billing](plugins/llm-billing) | per-session cost, plan quota and request counts in the composer; a `/billing` report |
| [llm-local-servers](plugins/llm-local-servers) | local model servers (AFM, llama.cpp, …) started on demand and stopped when idle |
| [llm-prompt-excision](plugins/llm-prompt-excision) | removes configured paragraphs from the system prompt of chosen routes |
| [llm-scripted](plugins/llm-scripted) | a deterministic model scripted by the prompt, for tests |
| [llm-sign-in](plugins/llm-sign-in) | `/login`, `/logout`, `/logins` for provider sign-ins |
| [preset-chat-only](plugins/preset-chat-only) | a tool-less agent preset, for tiny local models |
| [preset-per-model](plugins/preset-per-model) | an agent preset per model |
| [session-export](plugins/session-export) | `/export-workspace`, `/export-session`: a workspace or a session as a ZIP, for another machine |
| [session-import](plugins/session-import) | `/import-claude`, `/import-pi`, `/import-dsh`: transcripts become resumable sessions |
| [session-move](plugins/session-move) | Move to…, Copy to… and Rehome… between workspaces, from the sidebar |
| [session-title-slug](plugins/session-title-slug) | `some-slug: …` as a first prompt names the session |
| [tool-browser](plugins/tool-browser) | per-chat Safari Technology Preview and Chrome windows for agents, a page reader, screenshots in the chat |
| [tool-dash-docsets](plugins/tool-dash-docsets) | search and read documentation from [Dash](https://kapeli.com/dash) |
| [tool-fs-batch](plugins/tool-fs-batch) | batch filesystem tools: `list_dir`, `read_many`, `edit_many`, `search` |
| [tool-rename-chat](plugins/tool-rename-chat) | lets the agent rename a chat whose automatic title is wrong or stale |
| [tool-transcripts](plugins/tool-transcripts) | `transcript_*` tools: agents read other agents' transcripts |
| [tool-wait](plugins/tool-wait) | a `wait` tool with a live progress bar instead of `sleep` |
| [ui-brand-kit](plugins/ui-brand-kit) | re-brands the web GUI from brand profiles (mark, wordmark, fonts, accent colour) |
| [ui-numbered-switching](plugins/ui-numbered-switching) | ⌘1…⌘5 for the five most recently viewed sessions |
| [ui-phone](plugins/ui-phone) | a chat-only layout at phone width |
| [ui-reload-on-restart](plugins/ui-reload-on-restart) | reloads the page when the server comes back on new code |
| [ui-session-reference-picker](plugins/ui-session-reference-picker) | `%` in the composer picks a session to reference |
| [ui-settings-entry](plugins/ui-settings-entry) | the Settings button in the sidebar, and ⌘. to toggle Settings |
| [ui-transcript-margin](plugins/ui-transcript-margin) | space under the last row of a transcript |
| [ui-variant-identity](plugins/ui-variant-identity) | tells variants apart: name, colour, window title |
| [workspace-remote](plugins/workspace-remote) | other DeepSea servers' workspaces in this sidebar |

Each plugin's README is its documentation. A few more plugins drive licensed
software and are kept apart from this repository; `dsd` finds them when they
are present ([LAYOUT.md](LAYOUT.md) §3).

## Layout

| Path | |
|---|---|
| [plugins/](plugins) | one installable package per plugin ([plugins/AGENTS.md](plugins/AGENTS.md)) |
| [packages/](packages) | code shared by plugins and tools |
| [apps/macos/](apps/macos) | the native app, the server host and the window helper |
| [apps/relay/](apps/relay) | the relay each installed variant runs |
| [tools/dsd/](tools/dsd) | `dsd`, the developer CLI: variants, builds, throwaways, topics |
| [tools/provider-sim/](tools/provider-sim) | simulated model providers for tests |
| [harness.lock](harness.lock) | the harness repository and the commit pinned |

[LAYOUT.md](LAYOUT.md) defines names, identifiers and disk locations;
[AGENTS.md](AGENTS.md) is the starting point for coding agents working here.

## License

MIT, see [LICENSE](LICENSE). The harness is DeepSeek Harness, under its own
license in its repository.
