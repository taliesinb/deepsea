/**
 * @deepsea/variant-identity: where a variant's identity comes from and what it
 * becomes in the page. Pure functions; index.js wires them to the web server.
 *
 *   variant.yml   `$DSH_HOME/variant.yml` (written by dsd): `id`, `display`,
 *                 `color`, `throwaway`, flat `key: value` lines
 *   identity      { display, color, versionBadge }: the display name for the
 *                 wordmark and the window title, the whale's colour, and how
 *                 the build-version chip looks
 *
 * The selectors are the ones the DeepSea app's page script uses
 * (apps/macos/Resources/desktop-branding.js), without `!important`, so inside
 * the app the app's own name and colour win.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { variantOf } from '@deepsea/logs'

/** The product title the shipped client renders in the wordmark and `document.title`. */
export const GENERIC_PRODUCT_TITLE = 'DSH Local Build'
/** A throwaway's whale: the orange of the throwaway app's glyph (dsd). */
export const THROWAWAY_COLOR = '#F76B15'

const VARIANT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const THROWAWAY_ID = /^([a-z0-9]+(?:-[a-z0-9]+)*)-([0-9a-f]{6})$/
/** A display name: letters, digits, space, `.`, `_`, `-` (safe in a CSS string and a JS literal). */
const DISPLAY = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u
const NOT_DISPLAY = /[^\p{L}\p{N} ._-]/gu
const HEX = /^#[0-9A-F]{6}$/
/** The stock glyph colour: no tint, the whale follows the theme. */
const STOCK = '#000000'

/**
 * Read flat YAML (`key: value` lines, as dsd writes variant.yml): values may
 * be bare (a trailing ` # comment` is dropped), double-quoted (JSON) or
 * single-quoted; `true` / `false` are booleans. Other lines are ignored.
 * @param {string} text
 * @returns {Record<string, string | boolean>}
 */
export function parseFlatYaml(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line.trimEnd())
    if (!m) continue
    const raw = m[2]
    let value
    const double = /^"(?:[^"\\]|\\.)*"/.exec(raw)
    const single = /^'(?:[^']|'')*'/.exec(raw)
    if (double) {
      try { value = JSON.parse(double[0]) } catch { continue }
    } else if (single) {
      value = single[0].slice(1, -1).replaceAll("''", "'")
    } else {
      value = raw.replace(/(^|\s+)#.*$/, '').trim()
      if (value === 'true') value = true
      else if (value === 'false') value = false
    }
    out[m[1]] = value
  }
  return out
}

/**
 * The variant's configuration, or undefined when the home has no variant.yml.
 * @param {string} home - `$DSH_HOME`.
 */
export function readVariant(home) {
  let text
  try {
    text = readFileSync(join(home, 'variant.yml'), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
    throw error
  }
  return parseFlatYaml(text)
}

/**
 * A variant's display name (LAYOUT.md §1): `release` → `DeepSea`, `personal`
 * → `DeepSea Personal`, `personal-3f9a1c` → `DeepSea Personal 3f9a1c`,
 * `release-3f9a1c` → `DeepSea 3f9a1c`.
 * @param {string} id
 */
export function displayNameOf(id) {
  const throwaway = THROWAWAY_ID.exec(id)
  if (throwaway) return `${displayNameOf(throwaway[1])} ${throwaway[2]}`
  if (id === 'release') return 'DeepSea'
  return `DeepSea ${id.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ')}`
}

/**
 * Check and normalize the plugin row's config.
 * @param {unknown} input
 * @returns {{ display?: string, color?: string, versionBadge?: 'subtle' | 'stock' }}
 */
export function resolveConfig(input) {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('variant-identity: the config is an object with display, color and versionBadge')
  const unknown = Object.keys(input).filter(key => !['display', 'color', 'versionBadge'].includes(key))
  if (unknown.length > 0) throw new TypeError(`variant-identity: unknown config key ${unknown.map(key => JSON.stringify(key)).join(', ')} (display, color, versionBadge)`)
  const out = {}
  if (input.display !== undefined) {
    if (typeof input.display !== 'string' || (input.display !== '' && !DISPLAY.test(input.display))) {
      throw new TypeError(`variant-identity: display must be '' or 1-64 letters, digits, spaces, '.', '_', '-', got ${JSON.stringify(input.display)}`)
    }
    out.display = input.display
  }
  if (input.color !== undefined) {
    const color = typeof input.color === 'string' ? input.color.toUpperCase() : undefined
    if (color === undefined || (color !== '' && !HEX.test(color))) throw new TypeError(`variant-identity: color must be '' or #rrggbb, got ${JSON.stringify(input.color)}`)
    out.color = color === STOCK ? '' : color
  }
  if (input.versionBadge !== undefined) {
    if (input.versionBadge !== 'subtle' && input.versionBadge !== 'stock') throw new TypeError(`variant-identity: versionBadge must be 'subtle' or 'stock', got ${JSON.stringify(input.versionBadge)}`)
    out.versionBadge = input.versionBadge
  }
  return out
}

/**
 * What the page shows: variant.yml's `display` and `color` (derived for a
 * variant.yml without them), then the config's keys over those. A home
 * without variant.yml shows only what is configured.
 * @param {{ display?: string, color?: string, versionBadge?: 'subtle' | 'stock' }} config - resolved config.
 * @param {Record<string, unknown> | undefined} variant - variant.yml, if any.
 * @param {string} home - `$DSH_HOME`, for the id when variant.yml has none.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ display: string, color: string, versionBadge: 'subtle' | 'stock', notes: string[] }}
 */
export function resolveIdentity(config, variant, home, env = process.env) {
  const notes = []
  let display = ''
  let color = ''
  if (variant !== undefined) {
    const id = typeof variant.id === 'string' && VARIANT_ID.test(variant.id) ? variant.id : variantOf(home, env)
    const throwaway = variant.throwaway === true || (id !== undefined && THROWAWAY_ID.test(id))
    const derived = id === undefined ? '' : displayNameOf(id)
    if (typeof variant.display === 'string' && variant.display.trim() !== '') {
      display = variant.display.replace(NOT_DISPLAY, '').trim().slice(0, 64).trim()
      if (display !== variant.display) notes.push(`variant.yml display ${JSON.stringify(variant.display)} shown as ${JSON.stringify(display || derived)}`)
      if (display === '') display = derived
    } else {
      display = derived
    }
    if (typeof variant.color === 'string' && variant.color !== '') {
      const value = variant.color.toUpperCase()
      if (HEX.test(value)) color = value === STOCK ? '' : value
      else notes.push(`variant.yml color ${JSON.stringify(variant.color)} is not #rrggbb; the whale stays stock`)
    } else if (throwaway) {
      color = THROWAWAY_COLOR
    }
  }
  if (config.display !== undefined) display = config.display
  if (config.color !== undefined) color = config.color
  const versionBadge = config.versionBadge ?? (display !== '' || color !== '' ? 'subtle' : 'stock')
  return { display, color, versionBadge, notes }
}

/**
 * The `<style>` row for an identity, '' when it changes nothing. The
 * wordmark span (`_localBuildTitle` with a build version, else
 * `_fallbackBrandName`) collapses its text (`font-size:0`; `display:flex`
 * drops the empty line box) and shows the name in a `::before` at the
 * shipped size. CSS modules compile to `<hash>_<local>`, so the selectors
 * match the stable `_<local>` part; `span[class*=…]` outranks the module's
 * single-class rule.
 * @param {{ display: string, color: string, versionBadge: 'subtle' | 'stock' }} identity
 */
export function identityStyle({ display, color, versionBadge }) {
  const rules = []
  if (display !== '') {
    rules.push('span[class*="_localBuildTitle"],span[class*="_fallbackBrandName"]{display:flex;font-size:0}')
    rules.push(`span[class*="_localBuildTitle"]::before{content:"${display}";font-size:12px;line-height:13px}`)
    rules.push(`span[class*="_fallbackBrandName"]::before{content:"${display}";font-size:17px;line-height:24px}`)
  }
  if (versionBadge === 'subtle') {
    rules.push('span[class*="_buildVersion"]{color:inherit;background:none;opacity:.4;padding:0;border-radius:0}')
  }
  // The expanded brand row and the collapsed rail's toggle; the whale is `fill="currentColor"`.
  if (color !== '') rules.push(`span[class*="_brandMark"],span[class*="_railMark"]{color:${color}}`)
  return rules.join('\n')
}

/**
 * The body script row: put the display name in place of the generic product
 * title in `document.title`, now and whenever the client rewrites it
 * (`"<session> — DSH Local Build"`). Inside the DeepSea app its own name
 * (`__DEEPSEA_APP__.name`, set at document start) is used instead.
 * @param {string} display
 * @returns {string} classic-script text (no `</script`).
 */
export function titleScript(display) {
  return '(function(){'
    + `var G=${JSON.stringify(GENERIC_PRODUCT_TITLE)},N=${JSON.stringify(display)};`
    + 'function fix(){var A=globalThis.__DEEPSEA_APP__,L=(A&&A.name)||N,t=document.title;'
    + 'if(t.indexOf(G)!==-1)document.title=t.split(G).join(L)}'
    + 'var el=document.querySelector("title");'
    + 'if(el)new MutationObserver(fix).observe(el,{childList:true,characterData:true,subtree:true});'
    + 'fix();})();'
}

/**
 * The whale favicon in one colour.
 * @param {string} template - favicon.svg with `__COLOR__` as its fill.
 * @param {string} color - #RRGGBB.
 */
export function faviconSvg(template, color) {
  return template.replaceAll('__COLOR__', color)
}
