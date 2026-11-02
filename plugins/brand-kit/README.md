# @deepsea/brand-kit

Re-brands the DeepSea web GUI: a mark and a wordmark for the sidebar and the
empty-session hero, web fonts, typography, an accent colour, and the two
shipped strings that have no slot ("Into the Unknown", "Deep diving"). **The
plugin ships no brand and its row has no config.** A brand is a *profile*, a
directory in the plugin's state directory, managed from the bundle's card in
the Plugins panel or from `cli.mjs`. No active profile is the shipped look,
so the plugin can sit in every variant untouched.

## A profile

```
$DSH_HOME/plugins/brand-kit/
  state.json                 { "active": "Acme" }   ('' or absent: the shipped look)
  profiles/
    Acme/
      profile.json
      mark.svg               files are flat, named from profile.json
      Serif-Light.woff2
```

```jsonc
{
  "name": "Acme",                     // sidebar wordmark; replaces "DSH Local Build" and the version chip
  "mark": "mark.svg",                 // .svg or .png in this directory; replaces the whale (sidebar, rail, hero)
  "markMode": "mask",                 // mask (default): monochrome, filled with the text colour | image: as it is
  "headline": "Into the Abyss",       // the empty-session headline
  "turnStatus": "Working",            // replaces "Deep diving" in the running-turn label ("Working for 12s ···")
  "hidePreviewBadge": true,           // hide the "Preview" badge after the headline
  "accent": "#7678ed",                // re-points the shipped blue ramp (links, buttons, bubbles, tabs…)
  "accentDark": "#6163ea",            // the 600 step (hover, pressed); derived when absent
  "fonts": [{ "file": "Serif-Light.woff2", "family": "My Serif", "weight": 300 }],   // style: normal | italic
  "brandFont":    { "family": "\"My Serif\", Georgia, serif", "weight": 300, "size": 22, "lineHeight": 24, "letterSpacing": 0, "offsetY": -1 },
  "headlineFont": { "family": "\"My Serif\", Georgia, serif", "weight": 300, "size": 32, "lineHeight": 36 }
}
```

Every key is optional. Defaults: `brandFont` 18px/24 weight 600 (the shell's
own), `headlineFont` 26px/32 weight 500. Profile names are 1–41 letters,
digits, spaces, `.`, `_`, `-`, starting with a letter or digit, and unique
regardless of case (`Acme` and `acme` are one directory on macOS); file names
`[A-Za-z0-9][A-Za-z0-9._-]*` with the extensions above; colours `#rrggbb`;
texts at most 80 characters without `< > " \`; 8 MB per file, 24 MB per
archive. A profile that does not validate (edited by hand, a file removed) is
marked on the card and, when active, reported there while the shipped look
stands in: the GUI never loses its brand to a typo.

## Managing profiles

**The card**: Plugins panel ▸ `@deepsea/brand-kit`.

| Control | Does |
|---|---|
| **Active** | which profile the GUI shows, or None. Changing it writes `state.json` and reloads the page (the brand is rendered into the boot document); the reloaded page opens the card again |
| **New** | an empty profile (the shipped look) named in the field beside it |
| **Import…** | a new profile from a `.brand.zip` (or a hand-made zip: profile.json and its files at the root; one wrapping folder is accepted), named after the file (`Acme.brand.zip` → `Acme`, `Acme 2` when taken). The archive is checked in a hidden staging directory first; a bad one leaves nothing behind |
| **Edit** | every key: the wordmark, the mark (upload an `.svg` or `.png`; Mask or Image), the headline, the turn status, the Preview badge, the accent, font files (upload `.woff2`, `.woff`, `.ttf`, `.otf`; family, weight, style), the wordmark's and headline's typography (empty number fields show the shell's values). **Save** validates on the host; saving the active profile reloads |
| **Duplicate** | a copy with its files, `<name> copy` |
| **Rename** | inline; Enter saves, Escape cancels. The active pointer follows |
| **Export** | downloads `<name>.brand.zip`: profile.json and the files it names |
| **Delete** | after an inline confirmation; deleting the active profile restores the shipped look |

A font's `family` is the name `brandFont.family` / `headlineFont.family`
must use; the file's own internal name does not matter. Files a profile no
longer names stay in its directory but are left out of its export.

The Plugins panel lists the profile's installed bundles, so the card appears
when the plugin is installed as a bundle (`dsh plugin --profile web add
<plugins/brand-kit>`, or Plugins ▸ Add plugin with the directory's absolute
path). A row loaded by path (as `dsd run --plugins brand-kit` does) applies
the active profile but has no page in the panel; provision it with the CLI.

**The CLI**, for provisioning a variant without its GUI open (`$DSH_HOME`
selects the home):

```sh
node cli.mjs import ./acme-brand --name Acme --apply     # a directory (profile.json and its files) or a .brand.zip
node cli.mjs list | active | apply <name|none> | export Acme acme.brand.zip
```

`import` refuses an existing name unless `--replace`; a directory import
copies profile.json and its asset files only. Both paths use the same store
and validation; a change is visible on the next page load, no restart.

## How it works

| What | Mechanism |
|---|---|
| Mark, wordmark, hero mark | The browser half occupies `sidebar.brand.mark`, `sidebar.brand.name` and `conversation.hero.brand.mark` (all `single`, so a registration replaces the shipped fallback). The name cell's fallback is the product title and the build-version chip together, so both go. |
| `markMode: mask` | `.deepsea-brand-kit-mark{background:currentColor;mask:url(…)}`: theme-following like the shipped whale (`fill="currentColor"`), and tinted by whatever colours the whale. `image` renders an `<img>`. |
| Headline, turn status | Locale-owned (`hero.headline`, `chat.deepDiving`; one occupant per namespace, no slot), so a MutationObserver replaces the text in place: the headline's text node (`[class*="_titleGroup"] > span:first-child`), and "Deep diving" at the start of every text node and `data-shimmer-text` copy inside `[data-chat-running]`. React rewrites the running label as its clock ticks; the observer follows. Only the English strings are matched. |
| Fonts, typography, badge, accent | One `<style>` row on `webserver/index-inject`: `@font-face` rules with document-relative URLs (so a path-stripping proxy mount such as `/deepsea/` works), `.deepsea-brand-kit-name`, the headline selector, `[class*="_previewBadge"]{display:none}`, and the accent block. |
| Accent | The shipped `--dsw-static-deepseek-*` ramp, and the `--dsw-static-blue-*` steps feature CSS uses directly, redefined on `html>body` from one colour, lighter and darker steps by `color-mix(in oklab, …)`. `html>body` outranks the theme sheet, which the client loads after the index-inject rows. |
| Files | `GET /api/deepsea-brand-kit/asset?s=<profile>&k=mark\|font&f=<file>` serves only files a profile names; `cache-control: private, max-age=3600`. |
| Host → browser | A `global` row publishes `__DEEPSEA_BRAND_KIT__ = { name, headline, turnStatus, mark }`; the browser half reads it when it starts. |
| Apply | `webserver/index-inject` is emitted for every page render, so the host reads `state.json` per request: applying a profile is a reload, never a restart. |
| Card | `plugins.bundle.config` keyed by the package name; its styles (`deepsea-brand-kit-*` classes) are a `<style data-deepsea-brand-kit>` the browser half adds. The reload after Active or Save leaves `deepsea.brand-kit.reopen` in sessionStorage, and the new page calls `pluginNavigation.openBundle`. File choosers are the card's own hidden inputs (`data-deepsea-brand-kit-input="import" \| "mark" \| "font"`). |

With [variant-identity](../variant-identity/README.md), a profile with a
`name` replaces the wordmark cell that plugin restyles, so the variant name
shows only in the window title; a masked mark takes the variant's colour
like the whale. Inside the DeepSea app the same holds for the app's own
identity rules.

## Routes

All below `/api`, behind DSH's own authentication. A state-changing request
must carry `content-type: application/json` (actions) or
`application/octet-stream` (files), which a cross-site form cannot send
without a CORS preflight; anything else is refused with 415.

| Route | Does |
|---|---|
| `GET /api/deepsea-brand-kit` | the card's state: `active`, `effective`, `activeError?`, `profiles: [{ name, profile, error? }]` |
| `POST /api/deepsea-brand-kit` | `{ action, name, to?, profile? }`: `apply` (`name: ''` for none), `create`, `save` (`profile` is the new profile.json), `duplicate` (`to` optional), `rename`, `delete`; answers the new state, or it with `error` (400) |
| `POST /api/deepsea-brand-kit/upload?name=&kind=mark\|font&file=` | the body as a file of that profile (`uploaded`) |
| `POST /api/deepsea-brand-kit/import?file=` | the body (a zip) as a new profile named after `file` (`created`) |
| `GET /api/deepsea-brand-kit/export?name=` | `<name>.brand.zip` |
| `GET /api/deepsea-brand-kit/asset?s=&k=&f=` | a file a profile names |

## Files

| File | Role |
|---|---|
| `index.js` | host half: the rows, the routes |
| `brand.mjs` | what a brand is: validation, the generated CSS and payload |
| `profiles.mjs` | the profile store: directories, state.json, zip export and import |
| `cli.mjs` | the command line |
| `src/client/index.tsx` | browser half: the slots, the text swaps, the card's registration |
| `src/client/profiles-card.tsx`, `style.css` | the card |
| `build.mjs` | esbuild → `lib/client.js` in the shell's module-loader wrapper |
| `cordis.patch.yml` | bundle patch inserting the `deepsea-brand-kit` row |

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

`pnpm install` needs the repository's `harness` link (`dsd link`). The tests
work in scratch directories only. To see the card in a throwaway
(`dsd run release --throwaway-app`, without `--plugins brand-kit`, so the
row is not loaded twice), install the plugin through Plugins ▸ Add plugin
with this directory's absolute path; the profile links it, so a rebuilt
`lib/client.js` hot-swaps into the page. Host changes need a restart.
