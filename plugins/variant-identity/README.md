# @deepsea/variant-identity

Tells DeepSea variants apart in any browser. Every variant serves the same
client build, so without this plugin their windows look the same: the same
whale, the same "DSH Local Build" wordmark and window title, the same
build-version chip. With it:

- the sidebar wordmark reads the variant's display name (`DeepSea Personal`),
- the whale in the sidebar (expanded row and collapsed rail) and the tab's
  favicon take the variant's colour,
- the window or tab title reads `<session> — DeepSea Personal`,
- the build-version chip under the wordmark loses its box and sits at 40 %
  opacity in the text colour.

Host-only: no browser bundle, nothing to build.

## Where the identity comes from

The variant itself: `$DSH_HOME/variant.yml`, written by dsd
(tools/dsd/README.md → Variants), read when the server starts:

```yaml
id: personal
display: DeepSea Personal
color: "#30A46C"
```

| `variant.yml` | Display name | Colour |
|---|---|---|
| `display` / `color` given | that name (characters other than letters, digits, space, `.`, `_`, `-` are dropped) | that `#rrggbb`; `#000000` is the stock whale |
| no `display` | derived from `id` (LAYOUT.md §1): `release` → `DeepSea`, `personal` → `DeepSea Personal`, throwaway `personal-3f9a1c` → `DeepSea Personal 3f9a1c`, `release-3f9a1c` → `DeepSea 3f9a1c`; without an `id`, from the home's directory name in the DeepSea root | |
| no `color` | | stock for a named variant; `#F76B15` for a throwaway (an id ending in `-` and six hex digits, or `throwaway: true`), the orange of the throwaway app's whale |
| no `variant.yml` (a stock DSH home) | none | none |

So a variant needs no configuration, and on a home without `variant.yml`
the plugin changes nothing unless configured. A malformed value in
`variant.yml` is cleaned or dropped with a warning in the server log, never
fatal.

## Configuration

The row's config overrides `variant.yml` key by key; every key is optional.

```yaml
- id: deepsea-variant-identity
  config:
    display: DeepSea Lab     # the name; '' keeps the shipped "DSH Local Build"
    color: '#0090FF'         # #rrggbb; '' (or #000000) keeps the stock whale
    versionBadge: subtle     # subtle | stock; default subtle when a name or colour applies
```

`display` is 1–64 letters, digits, spaces, `.`, `_`, `-`, starting with a
letter or digit (it lands in a CSS string and a script literal); anything
else, an unknown key, or a colour other than `#rrggbb` fails the load. Quote
the colour in YAML: a bare `#` starts a comment.

## How it works

| What | Mechanism |
|---|---|
| Wordmark | A `{ kind: 'style' }` row on the web server's `webserver/index-inject` table. The wordmark span (`_localBuildTitle`, or `_fallbackBrandName` in a build without a version) gets `display:flex;font-size:0` and a `::before{content:"<name>"}` at the shipped size (12px/13px, or 17px/24px); `display:flex` drops the empty text's line box, so the row keeps its height. |
| Whale | Same row: `span[class*="_brandMark"],span[class*="_railMark"]{color:…}`. The whale is `fill="currentColor"`. |
| Version chip | Same row: `span[class*="_buildVersion"]{color:inherit;background:none;opacity:.4;padding:0;border-radius:0}`. |
| Window title | A `{ kind: 'script', placement: 'body' }` row: a `MutationObserver` on `<title>` puts the name in place of "DSH Local Build" whenever the client writes the title. |
| Favicon | With a colour, exact routes `/favicon.svg` and `/favicon-dark.svg` (the two icons the page links, for light and dark) serve the whale in that colour, `cache-control: no-store`. Named routes answer before the static frontend's fallback. |

The client's CSS modules compile to `<hash>_<local>` class names, so every
selector matches the stable `_<local>` suffix; `span[class*=…]` outranks the
module's single-class rule, so no `!important` is needed. "DSH Local Build"
itself is the `common` locale namespace's `brand.localBuild`, which has one
occupant, and `DocumentTitle` rewrites `document.title` on mount; restyling
the existing span and watching the title change nothing else.

### In the DeepSea app

The macOS app applies the same identity in its own windows from its own name
and glyph colour (`apps/macos/Resources/desktop-branding.js`): the same
selectors, as `!important` rules, and `__DEEPSEA_APP__ = { name, glyphColor }`
set at document start. Inside the app, then, the app's identity wins: its
rules outrank the plugin's, and the title script uses `__DEEPSEA_APP__.name`
when it is set. A variant's app and the plugin read the same `display` and
`color`, so they agree; a server without this plugin still reads right in its
app, and the plugin is what makes a browser tab read right.

A plugin that occupies the sidebar's `sidebar.brand.name` slot replaces the
wordmark cell and with it the rule's target; the title still carries the
variant name.

## Development

```sh
pnpm install && pnpm test
```

`pnpm install` needs the repository's `harness` link (`dsd link`). The tests
use scratch homes only. In a throwaway (`dsd run release --throwaway-app
--plugins variant-identity`), the browser tab and the page outside the app's
own rules show the derived name and the orange whale.
