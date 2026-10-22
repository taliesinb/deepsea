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
