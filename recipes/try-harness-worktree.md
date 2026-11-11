# Try harness changes while working on them

A harness checkout can run in a throwaway as it is, uncommitted changes
included: no commit, no `dsd topics integrate`, no shared build.
`--harness-worktree` takes a path, or a topic's name for its worktree
`<worktrees>/harness-<topic>` (LAYOUT.md §2).

dsd never installs or builds the checkout, so build it first, and again
after each edit:

```sh
cd <harness checkout>
pnpm install --frozen-lockfile   # once
pnpm run build                   # after each edit
```

## Which checkout

A topic's worktree holds that topic on its parent alone, without the
other harness topics. Two consequences:

- **The DeepSea macOS app does not load it.** The app's page relies on
  harness `topic/darwin-web-shortcuts`; without it the client stops at
  "Failed to load plugins" (`dsh-client-shortcuts`). Run the topic's
  worktree server-only and use the page in a browser:

  ```sh
  pnpm dsd run release --throwaway-server --detach --scripted --plugins all --harness-worktree <topic>
  pnpm dsd drive -v <id> url     # open its login URL in a browser
  ```

- **Plugins that need another harness topic** (their `"deepsea": {
  "requires" }`) may fail to load; `--plugins` can leave them out.

To try changes in the app, with every other topic present, work in a
scratch harness worktree of the integration instead, and move the
finished change onto its topic afterwards:

```sh
git -C <harness repo> worktree add --detach <worktrees>/harness-scratch integration/<upstream>
# edit, install, build there, then:
pnpm dsd play --harness-worktree <worktrees>/harness-scratch
```

## Look, or drive

From this repository's main checkout:

```sh
pnpm dsd play --harness-worktree <path | topic>      # the app in front of you
pnpm dsd run release --throwaway-app --detach --scripted --plugins all --harness-worktree <path | topic>
pnpm dsd drive -v <id> run <script.drive>            # tools/dsd/README.md, Drive scripts
pnpm dsd stop <id>
```

Use the `id` the run prints. Add `--simulated` for provider sign-in and
billing states, `--throwaway` (behind a relay) for `restart-server`, and
`--display-name 'DeepSea <Name>'` for an app named without the
throwaway's hex suffix. Plugins come from the checkout dsd runs in, or
from a DeepSea commit with `--source <ref>`.

- **Rebuild, then restart.** A running throwaway keeps the build it
  started with; stop it before rebuilding the checkout, then start a new
  one. A build older than the checkout's last commit is reported when the
  throwaway starts; edits made after the last build are not detected.
- **The harness's own evidence** (its recorded-session and browser
  snapshots) runs with `dsd test harness <topic>`, not in a throwaway.
