# apps/macos/bundle — the self-contained DeepSea.app and its DMG

A `DeepSea.app` that carries everything it runs: its own Node, the harness
and every plugin as a production closure, the relay, and an updater. Drag it
to Applications, open it, and a DeepSea is running — no checkout, no `dsd`,
no Homebrew, nothing installed outside the bundle except the variant's home.

| File | Role |
|---|---|
| `fetch-node.mjs` | the official Node LTS build for this architecture, SHA-256 verified against `SHASUMS256.txt` |
| `stage.mjs` | the production closure: every first-party harness package and every plugin packed to a tarball, then installed into one project whose `pnpm.overrides` pin each first-party name to its tarball (peers included), third parties from the registry |
| `assemble.mjs` | the app: the wrapper (`../build.mjs`) plus Node, the staged closure, the relay and `home-setup.mjs` in `Contents/Resources`; pruned, every Mach-O signed, the styled DMG with the embedded file icon |
| `home-setup.mjs` | run by the app at every launch: the variant's home as `dsd` would make it |
| `release.mjs` | build number → DMG → `.sha256` → GitHub Release under tag `<variant>-<build>` |
| `../Sources/EmbeddedServer.swift` | starts the bundled relay (unless one is listening), stops it on quit |
| `../Sources/Updater.swift` | checks the release feed, offers, downloads, verifies, swaps the bundle in place, relaunches |
| `../Tools/make-dmg-background.swift`, `make-dmg-icon.swift` | the DMG window's backdrop and the disk-image icon |

```sh
node apps/macos/bundle/fetch-node.mjs
node apps/macos/bundle/stage.mjs                       # pnpm 12 (found on PATH, ~/Library/pnpm/bin, or via npx)
node apps/macos/bundle/assemble.mjs --variant release   # dist/bundle/DeepSea.app + DeepSea-<version>-<build>.dmg
node apps/macos/bundle/release.mjs --variant release    # all of the above, then gh release create
```

Needs the harness build `dsd` links at `<repo>/harness` and `apps/relay`
(the relay topic; `integration/base` has both). Command Line Tools' `swiftc`,
`hdiutil`, Finder (for the DMG window layout) — no Xcode.

## The app is a variant

The bundled app **is** the variant it was built for (LAYOUT.md §1):
`--variant release` gives `DeepSea.app`, bundle id
`io.github.taliesinb.deepsea.release`, home `~/.deepsea/release`, port block
3200; `--variant canary` gives `DeepSea Canary.app`, `….canary`,
`~/.deepsea/canary`, the block in its `variant.yml`. Only where the code lives
differs from a `dsd build <v> --install` of the same variant: inside the
bundle, run with the bundle's Node, and the relay started by the app rather
than by a LaunchAgent. Everything else — the home, `variant.yml`, the web
profile with the plugins installed as bundles (`deepsea-bundles.json`
records them, as dsd's `installBundles` does), the `logs`/`support`/`source`
links, the log directory, the standing token in `<home>/relay/state.json` —
is what dsd writes, so the two can take a variant over from each other:

- Start the bundled app on a Mac that has `dsd build release --install`:
  its relay is already listening on the block's +3, so the app uses it and
  starts nothing of its own.
- Run `dsd build release --install` on a Mac that has only the bundled app:
  dsd reads the same `variant.yml`, replaces the profile links with its
  build's, and installs the LaunchAgent; the app then finds that relay.

### Launch

1. `home-setup.mjs` (with the bundled Node, under a second): creates the home
   if absent, writes `variant.yml` once (`source: bundle`), runs the harness's
   own `initProfile`, then links every `@deepsea/*` plugin from
   `Resources/deepsea/node_modules` into the profile — re-pointed on every
   launch, so a moved app bundle is harmless.
2. If nothing listens on the relay port: the relay, with the same arguments
   `dsd` writes into a LaunchAgent, pointing at the bundle's `dsh` and the
   variant's home; it starts `dsh web` on the first connection with the
   standing token as `DSH_LAUNCH_TOKEN` (harness topic `launch-token`),
   through the person's login shell. Environment for the server: `DSH_HOME`,
   `DEEPSEA_VARIANT`, `DEEPSEA_APP_BUNDLE` (what the `app-setup` plugin arms
   on), `DEEPSEA_APP_VERSION`, and the bundled Node plus
   `<home>/plugins/app-setup/bin` first on `PATH`.
3. The wrapper's ordinary path: `url` and `fallbackUrl` are the relay, the
   token file is the relay's state file; the relay's "starting" page shows
   until the server answers.
4. Quit: SIGTERM to the relay this app started, which stops its server's
   process group. A relay that was already there is left alone.

Paths handed to Node are realpaths (`realpath(3)`, not Foundation's
`resolvingSymlinksInPath`, which strips `/private` back off): the relay
decides whether it is the main module by comparing `import.meta.url` with
`argv[1]`, and under a symlinked directory (`/tmp` → `/private/tmp`) it would
otherwise load and exit 0 — measured.

## Thin clients: `--remote`

```sh
node apps/macos/bundle/assemble.mjs --remote <node>.example.ts.net/deepsea --name "DeepSea Office"
node apps/macos/bundle/release.mjs  --remote … --name … --repo <org>/<private repo> [sign-in flags]
```

The same wrapper, DMG, icon and updater, with nothing inside: no Node,
harness, relay or home. The window opens the given DeepSea over the
tailnet, admitted by the Mac's Tailscale identity (the tailscale plugin's
route). About 1 MB; the DMG 2 MB. Bundle id
`io.github.taliesinb.deepsea.remote-<host-slug>`, blue whale (never
mistaken for a local app), release channel `remote-<host-slug>`, so one
repository publishes a thin client per host and per person beside the full
app, and each updates only from its own channel. The name is yours
(`--name`; default `DeepSea <Host>`); the DMG is `<Name-with-dashes>-…dmg`,
which is also the updater's second lock on a release.

### Private release feeds

A thin client names its host in the channel and its person in the title,
so its releases belong on a **private** repository, which GitHub refuses to
serve anonymously. The updater authenticates **as the person**
(`SignIn.swift`), trying in order: a stored sign-in → a built-in token
(`--update-token-env VAR`, a fine-grained PAT scoped to the repo, Contents:
read) → the person's own `gh auth token` → anonymous → **Sign in…**.

*Sign in…* is GitHub's web application flow with PKCE and a **loopback
callback**: the browser opens `github.com/login/oauth/authorize`, the
person clicks Authorize, GitHub redirects to
`http://127.0.0.1:47831/deepsea-updates/callback` — a listener the app
runs for the duration — the code is exchanged, the app comes to the front
with the token stored (0600, `~/Library/Application Support/<bundle id>/`;
not the Keychain: an ad-hoc app's identity is its cdhash, different after
every update). Fallback (`Use a Code Instead`, or no secret baked): the
device flow — a code to type at `github.com/login/device`, polled on a
background thread. Everything is a sheet on the window; the page keeps
working.

What to register, once: a **GitHub App** (`Contents: read` on the release
repository, *Device Flow* on, *user token expiration* opted out), installed
on that repository by an org owner; its **client id** (`--update-client-id`,
public) and **client secret** (`--update-client-secret-env VAR`, baked in:
GitHub requires it for the exchange even with PKCE, and with the callback
pinned to loopback it lets nobody obtain anyone's code) go into the build;
the **callback URL** above must be registered on the app exactly — GitHub
matches it character for character, and a mismatch shows "redirect_uri is
not associated with this application" (measured). People never see any of
this: Sign in… → Authorize → done, once per Mac. Measured against a real
private repository: anonymous feed 404 → signed-in 200 → asset through the
API `url` with `Accept: application/octet-stream` (the browser URL of a
private asset 404s) → install and relaunch. 401 on a stored sign-in deletes
it and offers again; 404 on a valid one means the app is not installed on
the repository yet, and says so.

### Download page

```sh
node apps/macos/bundle/download-page.mjs --out downloads.html \
  --app "DeepSea|taliesinb/deepsea|release|#000000" \
  --app "DeepSea Office|<org>/<private repo>|remote-<host-slug>|#0090FF"
```

One self-contained HTML file: an icon per app, click to download the
newest release of its channel, version and size underneath. GitHub has no
stable "latest of this channel" URL, so the page is generated with each
channel's current asset link (resolved through `gh api` with the updater's
two locks) and regenerated after each release; a variant with no readable
release renders greyed out with the reason in its tooltip. Private links
work in a browser signed in to GitHub with access to the repository. The
icons are what macOS itself draws (`Tools/app-icon-png.swift`,
`NSWorkspace.icon(forFile:)` on a throwaway *registered* bundle — an
unregistered `.app` yields the generic document icon).

## Updates

`Updater.swift` reads `GET /repos/<repo>/releases?per_page=30` ten seconds
after launch, every six hours, and on **Check for Updates…** (⌘⇧U), and
takes the newest non-draft, non-prerelease release whose tag is
`<variant>-<build>` and whose DMG is named `<Name-with-dashes>-…dmg` — so one
repository publishes every variant side by side and a canary never offers
itself a release build. A newer build is offered with its notes (Install and
Relaunch / Later / Skip This Version); install = download → SHA-256 against
the `.sha256` asset → `hdiutil attach` → copy beside the running bundle →
old bundle to the Trash → rename → relaunch once this process has exited.
Preflight refuses a translocated copy (running from the DMG) and an
unwritable parent directory, with the fix in the message. Build numbers
(`CFBundleVersion`) are `YYYYMMDDnn`; a dev build is `0` and sees every
release as newer. `defaults write <bundle id> deepsea.update.autoInstall
-bool true` installs without the prompt (headless tests); `--no-update`
builds leave the item disabled.

## The DMG

Finder lays the window out itself against the mounted read-write image
(`osascript`: icon view, 128 px icons, the app and an Applications link on a
rendered backdrop with the whale, no toolbar or sidebar), then the image is
converted to a compressed read-only `ULMO`. The volume wears the disk-image
icon (`.VolumeIcon.icns`, copied *after* Finder's pass, which drops it; its
`com.apple.provenance` stripped, or Finder ignores it; `SetFile -a C` needs
Xcode — without it the volume shows the generic icon, the file still gets
its own). The `.dmg` file's icon is embedded **inside the UDIF container**
with `hdiutil udifrez` (resource type `icns`, id −16455): file bytes, so it
survives HTTP downloads, shared folders and every copy — a resource-fork
icon (`NSWorkspace.setIcon`) is an xattr and is stripped by all of those.

## Sizes (2026-10-22, harness 0.2.1-alpha.1, 2 plugins)

Staged closure 597 MB → pruned 311 MB (declarations, source maps, `.ts`
sources, READMEs, test directories, other platforms' node-pty prebuilds,
three.js `examples`/`src`, and the 259 MB LibreOffice engine behind Office →
PDF previews unless `--with-office`) → app 312 MB → DMG 65 MB.

## Signing

Ad hoc by default: Gatekeeper says "cannot verify" on a downloaded DMG until
the person right-clicks → Open once. `--sign "Developer ID Application: …"`
signs for real (hardened runtime, timestamp) — every inner Mach-O too, since
a hardened signature over a bundle with unsigned binaries is rejected at
launch — and notarization is a separate `xcrun notarytool submit`.

## Release pipeline

`.github/workflows/release-app.yml`: Run workflow (variant, notes, draft),
or a `release:` commit on the default branch. A `macos-26` runner (the
wrapper's `NSGlassEffectView` needs the macOS 26 SDK) clones the harness
beside the checkout at the pinned commit, builds it with `dsd builds make`,
and runs `release.mjs` with the repository's own token.
