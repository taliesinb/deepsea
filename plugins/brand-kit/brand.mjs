/**
 * @deepsea/brand-kit: what a brand is and what it becomes in the page. Pure
 * functions over a profile's resolved form (absolute file paths), shared by
 * the host half (index.js), the profile store (profiles.mjs) and the CLI.
 *
 * Every key is optional; '' / absent keeps that part of the shipped look:
 *
 *   name              wordmark beside the sidebar mark; occupying that cell
 *                     also removes the build-version chip (one slot fallback)
 *   mark              absolute path of an .svg or .png shown in place of the
 *                     whale: sidebar brand row, collapsed rail, empty-session hero
 *   markMode          'mask' (default): a CSS mask filled with the text colour,
 *                     so a monochrome mark follows the theme like the whale;
 *                     'image': the file as it is
 *   headline          empty-session headline (shipped "Into the Unknown")
 *   turnStatus        replaces "Deep diving" in the running-turn label
 *   hidePreviewBadge  hide the "Preview" badge after the headline
 *   accent            #rrggbb re-pointing the shipped blue ramp; accentDark
 *                     the 600 step (hover, pressed), derived when absent
 *   fontsDir, fonts   `@font-face` rows [{ file, family, weight, style }]
 *   brandFont         wordmark typography { family, weight, size, lineHeight, letterSpacing, offsetY }
 *   headlineFont      headline typography, the same keys
 */
import { existsSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'

/** The plugin's Fetch routes (below /api). Mirrored in src/client/profiles-card.tsx. */
export const API_PATH = '/api/deepsea-brand-kit'

/** Shipped strings the browser half replaces (src/client/index.tsx matches them verbatim). */
export const SHIPPED = { headline: 'Into the Unknown', turnStatus: 'Deep diving' }

export const MARK_EXTENSIONS = ['.svg', '.png']
export const FONT_EXTENSIONS = ['.woff2', '.woff', '.ttf', '.otf']
/** MIME types of the files the asset route serves. */
export const ASSET_TYPES = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.svg': 'image/svg+xml', '.png': 'image/png' }

/** Text safe inside CSS `content` and JSON without escaping. */
const SAFE_TEXT = /^[^<>"\\]{0,80}$/
const HEX = /^#[0-9a-f]{6}$/i
/** A CSS font-family list: names, quotes, commas, hyphens. */
const FONT_FAMILY = /^[A-Za-z0-9 ,"'-]{1,120}$/
const FONT_FILE = /^[A-Za-z0-9._-]+$/

function fail(message) { throw new Error(`brand-kit: ${message}`) }

function text(input, key) {
  if (input[key] === undefined) return ''
  const value = String(input[key])
  if (!SAFE_TEXT.test(value)) fail(`${key} must be at most 80 characters without < > " or backslash, got ${JSON.stringify(value)}`)
  return value
}

function hex(input, key) {
  if (input[key] === undefined || input[key] === '') return ''
  const value = String(input[key])
  if (!HEX.test(value)) fail(`${key} must be a #rrggbb colour, got ${JSON.stringify(value)}`)
  return value
}

function number(input, key, min, max, fallback) {
  if (input[key] === undefined || input[key] === null || input[key] === '') return fallback
  const value = Number(input[key])
  if (!Number.isFinite(value) || value < min || value > max) fail(`${key} must be a number in ${String(min)}..${String(max)}, got ${JSON.stringify(input[key])}`)
  return value
}

function typography(input, key, defaults) {
  const raw = input[key] === undefined ? {} : input[key]
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(`${key} must be an object`)
  const family = raw.family === undefined ? '' : String(raw.family)
  if (family !== '' && !FONT_FAMILY.test(family)) fail(`${key}.family must be a CSS font-family list, got ${JSON.stringify(family)}`)
  return {
    family,
    weight: number(raw, 'weight', 100, 900, defaults.weight),
    size: number(raw, 'size', 8, 96, defaults.size),
    lineHeight: number(raw, 'lineHeight', 8, 120, defaults.lineHeight),
    letterSpacing: number(raw, 'letterSpacing', -0.2, 1, defaults.letterSpacing),
    offsetY: number(raw, 'offsetY', -12, 12, defaults.offsetY),
  }
}

/** The shell's own wordmark and headline typography. */
export const BRAND_FONT = { weight: 600, size: 18, lineHeight: 24, letterSpacing: 0, offsetY: 0 }
export const HEADLINE_FONT = { weight: 500, size: 26, lineHeight: 32, letterSpacing: 0, offsetY: 0 }

/**
 * @typedef {{ family: string, weight: number, size: number, lineHeight: number, letterSpacing: number, offsetY: number }} Typography
 * @typedef {{ file: string, family: string, weight: number, style: 'normal' | 'italic' }} FontFace
 * @typedef {{ name: string, mark: string, markMode: 'mask' | 'image', headline: string, turnStatus: string,
 *   hidePreviewBadge: boolean, accent: string, accentDark: string, fontsDir: string, fonts: FontFace[],
 *   brandFont: Typography, headlineFont: Typography }} Brand
 */

/**
 * Fill in defaults and reject malformed values; files that do not exist fail.
 * @param {unknown} raw - a profile in resolved form (resolveProfile), possibly absent.
 * @returns {Brand}
 */
export function normalizeBrand(raw) {
  const input = raw !== null && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {}
  const mark = input.mark === undefined ? '' : String(input.mark)
  if (mark !== '') {
    if (!isAbsolute(mark)) fail(`mark must be an absolute path, got ${JSON.stringify(mark)}`)
    if (!MARK_EXTENSIONS.includes(extname(mark).toLowerCase())) fail(`mark must be an .svg or .png file, got ${JSON.stringify(basename(mark))}`)
    if (!existsSync(mark) || !statSync(mark).isFile()) fail(`mark file not found: ${basename(mark)}`)
  }
  const markMode = input.markMode === undefined ? 'mask' : input.markMode
  if (markMode !== 'mask' && markMode !== 'image') fail(`markMode must be 'mask' or 'image', got ${JSON.stringify(markMode)}`)
  const fontsDir = input.fontsDir === undefined ? '' : String(input.fontsDir)
  if (fontsDir !== '') {
    if (!isAbsolute(fontsDir)) fail(`fontsDir must be an absolute path, got ${JSON.stringify(fontsDir)}`)
    if (!existsSync(fontsDir) || !statSync(fontsDir).isDirectory()) fail(`fontsDir not found: ${fontsDir}`)
  }
  const fontsRaw = input.fonts === undefined ? [] : input.fonts
  if (!Array.isArray(fontsRaw)) fail('fonts must be a list of { file, family, weight?, style? }')
  const fonts = fontsRaw.map((row, index) => {
    if (row === null || typeof row !== 'object') fail(`fonts[${String(index)}] must be an object`)
    const file = String(row.file ?? '')
    if (!FONT_FILE.test(file) || !FONT_EXTENSIONS.includes(extname(file).toLowerCase())) {
      fail(`fonts[${String(index)}].file must be a .woff2/.woff/.ttf/.otf file name, got ${JSON.stringify(file)}`)
    }
    if (fontsDir === '') fail('fonts given without fontsDir')
    if (!existsSync(join(fontsDir, file))) fail(`font file not found: ${file}`)
    const family = String(row.family ?? '')
    if (!FONT_FAMILY.test(family) || family.includes(',')) fail(`fonts[${String(index)}].family must be one family name, got ${JSON.stringify(family)}`)
    const style = row.style === undefined ? 'normal' : row.style
    if (style !== 'normal' && style !== 'italic') fail(`fonts[${String(index)}].style must be 'normal' or 'italic'`)
    return { file, family, weight: number(row, 'weight', 100, 900, 400), style }
  })
  const hidePreviewBadge = input.hidePreviewBadge === undefined ? false : input.hidePreviewBadge
  if (typeof hidePreviewBadge !== 'boolean') fail('hidePreviewBadge must be true or false')
  return {
    name: text(input, 'name'),
    mark,
    markMode,
    headline: text(input, 'headline'),
    turnStatus: text(input, 'turnStatus'),
    hidePreviewBadge,
    accent: hex(input, 'accent'),
    accentDark: hex(input, 'accentDark'),
    fontsDir,
    fonts,
    brandFont: typography(input, 'brandFont', BRAND_FONT),
    headlineFont: typography(input, 'headlineFont', HEADLINE_FONT),
  }
}

/**
 * Lighter and darker steps of the shipped blue ramp, as the share of the
 * accent mixed into white (light steps) or black (dark steps), in oklab.
 */
const RAMP = {
  light: { 50: 8, '50p': 10, 75: 13, 100: 18, 200: 33, 300: 55, 400: 80, 450: 90 },
  dark: { 800: 50, 900: 38, 950: 30 },
}

/**
 * The accent rule: the shipped `--dsw-static-deepseek-*` ramp, and the
 * `--dsw-static-blue-*` steps feature CSS uses directly, redefined from one
 * colour. `html>body` outranks the theme sheet, which the client loads after
 * the index-inject rows (a specificity tie would lose).
 * @param {string} accent - #rrggbb.
 * @param {string} accentDark - #rrggbb for the 600 step, or '' to derive it.
 */
export function accentStyle(accent, accentDark) {
  const lines = []
  const put = (step, value) => { lines.push(`--dsw-static-deepseek-${step}:${value};--dsw-static-blue-${step}:${value};`) }
  for (const [step, share] of Object.entries(RAMP.light)) put(step, `color-mix(in oklab,${accent} ${String(share)}%,white)`)
  put(500, accent)
  put(600, accentDark === '' ? `color-mix(in oklab,${accent} 85%,black)` : accentDark)
  for (const [step, share] of Object.entries(RAMP.dark)) put(step, `color-mix(in oklab,${accent} ${String(share)}%,black)`)
  // The one alias set to a literal blue instead of a ramp step (light theme).
  lines.push(`--dsw-alias-brand-primary-new-colorprimary-new-color:${accent};`)
  return `html>body,html>body[data-ds-dark-theme]{${lines.join('')}}`
}

function fontRule(selector, font, extra = []) {
  const parts = [...extra, `font-weight:${String(font.weight)}`, `font-size:${String(font.size)}px`, `line-height:${String(font.lineHeight)}px`, `letter-spacing:${String(font.letterSpacing)}em`]
  if (font.family !== '') parts.unshift(`font-family:${font.family}`)
  if (font.offsetY !== 0) parts.push(`transform:translateY(${String(font.offsetY)}px)`)
  return `${selector}{${parts.join(';')}}`
}

/**
 * The URL the page fetches one of a profile's files from: the asset route,
 * document-relative so a path-stripping proxy mount (`/deepsea/`) resolves it
 * like the site root.
 * @param {string} profile - profile name.
 * @param {'mark' | 'font'} kind
 * @param {string} file - file name.
 */
export function assetUrl(profile, kind, file) {
  const query = new URLSearchParams({ s: profile, k: kind, f: file })
  return `.${API_PATH}/asset?${query.toString()}`
}

/**
 * The `<style>` row for a brand: font faces, the classes the browser half's
 * components wear, the headline, the badge and the accent. '' for the
 * shipped look.
 * @param {Brand} brand
 * @param {string} profile - the profile its files are served from.
 */
export function brandStyle(brand, profile) {
  const rules = []
  for (const font of brand.fonts) {
    const ext = extname(font.file).toLowerCase()
    const format = ext === '.woff2' ? 'woff2' : ext === '.woff' ? 'woff' : ext === '.ttf' ? 'truetype' : 'opentype'
    rules.push(`@font-face{font-family:"${font.family}";font-weight:${String(font.weight)};font-style:${font.style};font-display:swap;src:url(${assetUrl(profile, 'font', font.file)}) format("${format}")}`)
  }
  if (brand.name !== '') rules.push(fontRule('.deepsea-brand-kit-name', brand.brandFont, ['white-space:nowrap']))
  if (brand.mark !== '') {
    const url = assetUrl(profile, 'mark', basename(brand.mark))
    rules.push(brand.markMode === 'mask'
      ? `.deepsea-brand-kit-mark{display:block;flex:none;background:currentColor;-webkit-mask:url(${url}) center/contain no-repeat;mask:url(${url}) center/contain no-repeat}`
      : '.deepsea-brand-kit-mark{display:block;flex:none;object-fit:contain}')
  }
  if (brand.headline !== '' || brand.headlineFont.family !== '') {
    // The headline's only stable handle: CSS modules compile to `<hash>_<local>`.
    rules.push(fontRule('[class*="_titleGroup"]>span:first-child', brand.headlineFont))
  }
  if (brand.hidePreviewBadge) rules.push('[class*="_titleGroup"]>[class*="_previewBadge"]{display:none}')
  if (brand.accent !== '') rules.push(accentStyle(brand.accent, brand.accentDark))
  return rules.join('\n')
}

/**
 * What the browser half reads (`globalThis.__DEEPSEA_BRAND_KIT__`).
 * @param {Brand} brand
 * @param {string} profile
 * @returns {{ name: string, headline: string, turnStatus: string, mark: { url: string, mode: 'mask' | 'image' } | null }}
 */
export function clientPayload(brand, profile) {
  return {
    name: brand.name,
    headline: brand.headline,
    turnStatus: brand.turnStatus,
    mark: brand.mark === '' ? null : { url: assetUrl(profile, 'mark', basename(brand.mark)), mode: brand.markMode },
  }
}

/**
 * The absolute path of a file a brand names, or undefined: the asset route
 * serves nothing else.
 * @param {Brand} brand
 * @param {string} kind - 'mark' | 'font'.
 * @param {string} file - file name.
 */
export function assetPath(brand, kind, file) {
  if (kind === 'mark') return brand.mark !== '' && basename(brand.mark) === file ? brand.mark : undefined
  if (kind === 'font') return brand.fonts.some(font => font.file === file) ? join(brand.fontsDir, file) : undefined
  return undefined
}
