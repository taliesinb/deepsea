/**
 * Docset HTML → Markdown, with section scoping.
 *
 * Docset pages are static HTML (no scripts to run), so the conversion happens
 * in-process: linkedom parses, the page is stripped of navigation chrome, ONE
 * region is selected (the anchor from the URL fragment, an explicit section,
 * or the main content), and turndown renders it. Extras that plain turndown
 * gets wrong on documentation:
 *
 * - MathML (`<math>`, e.g. nLab) → `$…$` / `$$…$$` LaTeX via mathml-to-latex,
 *   with the styled letters of Unicode's math alphanumeric block folded back to
 *   `\mathcal{C}`, `\mathbb{R}`, plain italics, … (the library leaves them as
 *   glyphs). An embedded `<annotation encoding="application/x-tex">` wins.
 * - Sphinx MathJax spans (`span.math` holding `\(…\)`) are emitted raw as `$…$`
 *   instead of being markdown-escaped.
 * - `<pre>` blocks become fenced code with the language taken from Sphinx /
 *   highlight.js / Prism class conventions (`highlight-python`, `language-js`).
 * - Sphinx API signatures (`dt.sig`) become bold code lines; `dd` bodies follow.
 * - Links are resolved against the page URL, so a link into another docset
 *   page is itself a valid `dash_get_page` URL.
 * - Inline SVG (diagrams) → `[diagram]`; images → `[image: alt]` (swapped in the
 *   DOM beforehand — turndown drops text-less elements before rules run).
 *
 * Anchor forms understood (the `#fragment` of a Dash `load_url`):
 *   `#torch.Tensor.view`                           element id
 *   `#//apple_ref/cpp/Method/torch.Tensor.view`    `<a name="…">` Dash anchor (raw or percent-decoded)
 *   `#//dash_ref_<id>/Type/Name/0`                 Dash TOC anchor carrying an element id
 */

import { parseHTML } from 'linkedom'
import { MathMLToLaTeX } from 'mathml-to-latex'
import TurndownService from 'turndown'
import { tables } from 'turndown-plugin-gfm'

const HEADINGS = 'h1,h2,h3,h4,h5,h6'
const MAIN_CANDIDATES = ['main', '[role="main"]', 'article', '#content', '.document', '.body', '#main', '#Content']
/** Always removed before anything else is measured or rendered. */
const STRIP = 'script,style,noscript,template,link,meta,iframe,object,embed,nav,aside,footer,[role="navigation"],[role="banner"],[role="contentinfo"],[role="search"],.headerlink,.sphinxsidebar,[aria-hidden="true"],[class*="breadcrumb"],.rating,.d-print-none,.toggle-label'

/** Element id carried by a Dash `load_url` fragment, plus the raw fragment for `<a name>` lookups. */
export function parseFragment(url) {
  let fragment
  try { fragment = new URL(url).hash.replace(/^#/, '') } catch { return undefined }
  if (fragment === '') return undefined
  let decoded = fragment
  try { decoded = decodeURIComponent(fragment) } catch { /* keep raw */ }
  const dashRef = /^\/\/dash_ref_([^/]+)\//.exec(decoded)
  if (dashRef) return { id: dashRef[1], raw: fragment, decoded }
  if (decoded.startsWith('//dash_ref/')) return { raw: fragment, decoded }
  return { id: decoded, raw: fragment, decoded }
}

const levelOf = (el) => Number(el.tagName.slice(1))
const isHeading = (el) => /^H[1-6]$/.test(el?.tagName ?? '')
const textLength = (el) => el.textContent.replace(/\s+/g, ' ').trim().length

function findByName(document, ...names) {
  for (const name of names) {
    if (name === undefined) continue
    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const hit = document.querySelector(`a[name="${escaped}"],[id="${escaped}"]`)
    if (hit) return hit
  }
  return null
}

/** The element an anchor lookup should render: heading extents, whole `dl`s for `dt`s, parents of thin anchors. */
function extentOf(el) {
  let node = el
  if ((node.tagName === 'A' || node.tagName === 'SPAN') && textLength(node) < 2) {
    if (isHeading(node.nextElementSibling)) node = node.nextElementSibling
    else if (isHeading(node.parentElement)) node = node.parentElement
    else node = node.parentElement ?? node
  }
  if (node.tagName === 'DT' && node.parentElement?.tagName === 'DL') node = node.parentElement
  if (isHeading(node)) return { nodes: headingExtent(node), label: node.textContent.trim() }
  return { nodes: [grow(node)], label: undefined }
}

/**
 * An anchor that lands on a bare header (rustdoc: `<details><summary><section
 * id="method.push">…</section></summary><div class="docblock">…</div></details>`)
 * grows into enclosing containers until it carries some text — but never into
 * an ancestor holding most of the page.
 */
function grow(node) {
  const pageChars = textLength(node.ownerDocument.body ?? node.ownerDocument.documentElement)
  let current = node
  while (textLength(current) < 120) {
    const parent = current.parentElement
    if (!parent || parent.tagName === 'BODY' || parent.tagName === 'HTML') break
    if (textLength(parent) > Math.max(2000, pageChars * 0.5)) break
    current = parent
  }
  return current
}

/** Heading through the last sibling before the next heading of the same or a higher level. */
function headingExtent(heading) {
  const level = levelOf(heading)
  const nodes = [heading]
  for (let sibling = heading.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
    if (isHeading(sibling) && levelOf(sibling) <= level) break
    // Sphinx-style: a following <section> that starts with a deeper heading belongs to us; one starting with a higher one does not.
    const first = sibling.tagName === 'SECTION' ? sibling.querySelector(HEADINGS) : null
    if (first && levelOf(first) <= level) break
    nodes.push(sibling)
  }
  return nodes
}

/** Outline of a (stripped) region: every heading with the `section` value that selects it. */
export function outlineOf(root) {
  const out = []
  for (const h of root.querySelectorAll(HEADINGS)) {
    const text = h.textContent.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const id = h.id || (h.parentElement?.tagName === 'SECTION' || h.parentElement?.className?.includes?.('section') ? h.parentElement.id : '') || ''
    out.push({ level: levelOf(h), text, id: id || null })
  }
  return out
}

/** Match a heading by its text (numbering like "2.1." ignored), unique or first. */
function headingByText(document, wanted) {
  const norm = (s) => s.replace(/^\s*[\d.]+\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase()
  const target = norm(wanted)
  if (target === '') return null
  const all = [...document.querySelectorAll(HEADINGS)]
  return all.find(h => norm(h.textContent) === target) ?? all.find(h => norm(h.textContent).startsWith(target)) ?? null
}

/** Resolve an explicit `section` value to an element (or null). */
function selectSection(document, section) {
  const bare = section.startsWith('#') ? section.slice(1) : section
  const direct = findByName(document, bare, safeDecode(bare))
  if (direct) return direct
  try {
    const hit = document.querySelector(section)
    if (hit) return hit
  } catch { /* not a selector */ }
  return headingByText(document, bare)
}

function safeDecode(text) {
  try { return decodeURIComponent(text) } catch { return undefined }
}

/**
 * @param {string} html
 * @param {object} options
 * @param {string} options.url - the page URL (fragment = default anchor; base for links)
 * @param {string} [options.section] - `"page"`, `"outline"`, `#id`, `id`, a CSS selector, or heading text
 * @param {'markdown' | 'html'} [options.format]
 * @returns {{ title: string, content: string, scope: object, outline?: object[], pageChars: number }}
 */
export function convertPage(html, { url, section, format = 'markdown' }) {
  const { document } = parseHTML(html)
  const title = (document.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim()
  stripChrome(document)
  const pageChars = textLength(document.body ?? document.documentElement)
  const body = document.body ?? document.documentElement
  const notes = []

  if (section === 'outline') {
    const outline = outlineOf(pickMain(body, pageChars).el)
    return { title, content: '', scope: { kind: 'outline', target: null, label: null, chars: 0 }, outline, pageChars, notes }
  }

  let nodes
  let scope
  const anchor = section === undefined ? parseFragment(url) : undefined
  if (section !== undefined && section !== 'page') {
    const el = selectSection(document, section)
    if (!el) {
      const outline = outlineOf(pickMain(body, pageChars).el)
      const error = new Error(`section "${section}" not found on ${title || url}`)
      error.outline = outline
      throw error
    }
    const extent = extentOf(el)
    nodes = extent.nodes
    scope = { kind: 'section', target: section, label: extent.label ?? null }
  } else if (anchor) {
    const el = findByName(document, anchor.id, anchor.raw, anchor.decoded, anchor.id !== undefined ? safeDecode(anchor.id) : undefined)
    if (el) {
      const extent = extentOf(el)
      nodes = extent.nodes
      scope = { kind: 'anchor', target: `#${anchor.decoded}`, label: extent.label ?? null }
    } else {
      notes.push(`anchor #${anchor.decoded} not found; returning the main content`)
    }
  }
  if (nodes === undefined) {
    const main = pickMain(body, pageChars)
    nodes = [main.el]
    scope = { kind: 'page', target: main.reason, label: null }
  }

  resolveLinks(document, url)
  const container = document.createElement('div')
  for (const node of nodes) container.appendChild(node.cloneNode(true))
  const chars = textLength(container)
  scope.chars = chars

  if (format === 'html') return { title, content: container.innerHTML.trim(), scope, pageChars, notes }
  replaceGraphics(container, document)
  // Hand turndown HTML text, not linkedom nodes: it re-parses with domino, whose
  // DOM implements what the GFM table rule needs (`table.rows`); linkedom's does not.
  const markdown = tidy(turndown().turndown(container.innerHTML))
  return { title, content: markdown, scope, pageChars, notes }
}

/**
 * Inline SVG (nLab diagrams, icons) and images have no text, so turndown drops
 * them as "blank" before any rule can run; swap them for text placeholders first.
 */
function replaceGraphics(container, document) {
  for (const svg of [...container.querySelectorAll('svg')]) {
    const label = svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent?.trim() || ''
    const large = Number(svg.getAttribute('width')) > 40 || Number(svg.getAttribute('height')) > 40 || /nlab-diagram|diagram|equation/.test(svg.parentElement?.className ?? '')
    if (!large && label === '') { svg.remove(); continue }
    const placeholder = document.createElement('span')
    placeholder.textContent = label ? ` [diagram: ${label}] ` : ' [diagram] '
    svg.replaceWith(placeholder)
  }
  for (const img of [...container.querySelectorAll('img')]) {
    const alt = img.getAttribute('alt')?.trim() ?? ''
    if (alt === '') { img.remove(); continue }
    const placeholder = document.createElement('span')
    placeholder.textContent = ` [image: ${alt}] `
    img.replaceWith(placeholder)
  }
}

function stripChrome(document) {
  for (const el of [...document.querySelectorAll(STRIP)]) el.remove()
  // <header>: chrome when body-level or when it wraps navigation; an article's own header stays.
  for (const header of [...document.querySelectorAll('header')]) {
    const parent = header.parentElement
    if (!parent || parent.tagName === 'BODY' || parent.parentElement?.tagName === 'BODY' || header.querySelector('nav,ul')) header.remove()
  }
}

/** The main landmark when it holds ≥ 60 % of the stripped page text, else the body. */
function pickMain(body, pageChars) {
  for (const selector of MAIN_CANDIDATES) {
    const el = body.querySelector(selector)
    if (!el) continue
    const share = pageChars === 0 ? 0 : textLength(el) / pageChars
    if (share >= 0.6) return { el, reason: `${selector} (${Math.round(share * 100)}% of the page text)` }
  }
  return { el: body, reason: 'whole page' }
}

function resolveLinks(document, baseUrl) {
  // Heading self-links (MDN: <h2><a href="#attributes">Attributes</a></h2>) → plain text.
  for (const a of [...document.querySelectorAll('h1 a[href^="#"],h2 a[href^="#"],h3 a[href^="#"],h4 a[href^="#"],h5 a[href^="#"],h6 a[href^="#"]')]) {
    a.replaceWith(document.createTextNode(a.textContent))
  }
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? ''
    if (href === '' || /^(javascript|mailto|data):/i.test(href)) continue
    try { a.setAttribute('href', new URL(href, baseUrl).toString()) } catch { /* leave as is */ }
  }
}

// ------------------------------------------------------------------ turndown

let service
function turndown() {
  if (service) return service
  service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', hr: '---' })
  service.use(tables)
  service.remove(['button', 'select', 'input'])


  service.addRule('mathml', {
    filter: (node) => node.nodeName.toLowerCase() === 'math',
    replacement: (_c, node) => {
      const latex = mathToLatex(node)
      if (latex === '') return ''
      const display = node.getAttribute('display') === 'block' || /equation/.test(node.parentElement?.className ?? '')
      return display ? `\n\n$$\n${latex}\n$$\n\n` : `$${latex}$`
    },
  })
  service.addRule('sphinxMath', {
    filter: (node) => (node.nodeName === 'SPAN' || node.nodeName === 'DIV') && /(^|\s)math(\s|$)/.test(node.className ?? ''),
    replacement: (_c, node) => {
      const math = node.querySelector('math')
      if (math) {
        // KaTeX / MathJax server-side output: the MathML (with its TeX annotation) is the source of truth.
        const latex = mathToLatex(math)
        const display = node.nodeName === 'DIV' || node.querySelector('.katex-display') || math.getAttribute('display') === 'block'
        return latex === '' ? '' : display ? `\n\n$$\n${latex}\n$$\n\n` : `$${latex}$`
      }
      const raw = node.textContent.trim()
      const inline = /^\\\((.*)\\\)$/s.exec(raw)
      if (inline) return `$${inline[1].trim()}$`
      const block = /^\\\[(.*)\\\]$/s.exec(raw)
      if (block) return `\n\n$$\n${block[1].trim()}\n$$\n\n`
      return node.nodeName === 'DIV' ? `\n\n$$\n${raw}\n$$\n\n` : `$${raw}$`
    },
  })

  service.addRule('pre', {
    filter: 'pre',
    replacement: (_c, node) => {
      const code = node.textContent.replace(/\n+$/, '')
      const fence = code.includes('```') ? '````' : '```'
      return `\n\n${fence}${languageOf(node)}\n${code}\n${fence}\n\n`
    },
  })

  service.addRule('signature', {
    filter: (node) => node.nodeName === 'DT',
    replacement: (content, node) => {
      const text = node.textContent.replace(/\s+/g, ' ').replace(/[¶#]\s*$/, '').trim()
      if (text === '') return ''
      const isSig = /(^|\s)sig(\s|$)/.test(node.className ?? '') || node.querySelector('code,.sig-name')
      if (isSig) return `\n\n**\`${text}\`**\n\n`
      // Sphinx field lists: <dt><strong>a</strong><span class="classifier">array_like</span></dt>
      const classifier = node.querySelector('.classifier')
      if (classifier) {
        const name = text.slice(0, text.length - classifier.textContent.trim().length).trim()
        return `\n\n**${name}** (${classifier.textContent.trim()})\n\n`
      }
      return `\n\n**${text}**\n\n`
    },
  })
  service.addRule('definition', { filter: 'dd', replacement: (content) => `${content.trim()}\n\n` })
  service.addRule('admonition', {
    filter: (node) => node.nodeName === 'DIV' && /(^|\s)(admonition|note|warning|seealso|versionchanged|versionadded|deprecated)(\s|$)/.test(node.className ?? ''),
    replacement: (content) => `\n\n${content.trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`,
  })
  service.addRule('admonitionTitle', {
    filter: (node) => node.nodeName === 'P' && /admonition-title/.test(node.className ?? ''),
    replacement: (content) => `**${content.trim()}**\n\n`,
  })
  return service
}

function languageOf(pre) {
  const classes = []
  for (let el = pre; el && classes.length < 12; el = el.parentElement) {
    classes.push(String(el.className ?? ''))
    if (el !== pre && el.tagName !== 'DIV') break
  }
  const inner = pre.querySelector('code')
  if (inner) classes.unshift(String(inner.className ?? ''))
  for (const cls of classes) {
    const m = /(?:^|\s)(?:highlight|language|lang|brush:?\s*)-?([A-Za-z0-9+#_-]+)/.exec(cls)
    if (!m) continue
    const lang = m[1].toLowerCase()
    if (['default', 'pycon', 'python3', 'ipython3'].includes(lang)) return 'python'
    if (['text', 'none', 'notranslate', 'plain'].includes(lang)) return ''
    return lang
  }
  return ''
}

// --------------------------------------------------------------------- math

function mathToLatex(node) {
  const annotation = node.querySelector('annotation[encoding="application/x-tex"]')
  if (annotation && annotation.textContent.trim() !== '') return annotation.textContent.trim()
  let latex
  try {
    latex = MathMLToLaTeX.convert(node.outerHTML)
  } catch {
    latex = node.textContent
  }
  return normalizeMathText(latex).replace(/\s+/g, ' ').trim()
}

/**
 * Fold Unicode's math alphanumeric symbols (U+1D400 block) back into LaTeX. Each styled
 * alphabet in U+1D400–U+1D6A3 is a 52-letter run (A–Z, a–z); the gaps in the
 * italic/script/fraktur/double-struck runs are the letters that live in the
 * Letterlike Symbols block (ℎ, ℬ, ℂ, …), listed explicitly.
 */
const ALPHABETS = [
  [0x1D400, 'mathbf'], [0x1D434, ''], [0x1D468, 'mathbf'], [0x1D49C, 'mathcal'], [0x1D4D0, 'mathcal'],
  [0x1D504, 'mathfrak'], [0x1D538, 'mathbb'], [0x1D56C, 'mathfrak'], [0x1D5A0, 'mathsf'], [0x1D5D4, 'mathsf'],
  [0x1D608, 'mathsf'], [0x1D63C, 'mathsf'], [0x1D670, 'mathtt'],
]
const LETTERLIKE = {
  'ℎ': ['h', ''],
  'ℬ': ['B', 'mathcal'], 'ℰ': ['E', 'mathcal'], 'ℱ': ['F', 'mathcal'], 'ℋ': ['H', 'mathcal'], 'ℐ': ['I', 'mathcal'], 'ℒ': ['L', 'mathcal'], 'ℳ': ['M', 'mathcal'], 'ℛ': ['R', 'mathcal'], 'ℯ': ['e', 'mathcal'], 'ℊ': ['g', 'mathcal'], 'ℴ': ['o', 'mathcal'],
  'ℭ': ['C', 'mathfrak'], 'ℌ': ['H', 'mathfrak'], 'ℑ': ['I', 'mathfrak'], 'ℜ': ['R', 'mathfrak'], 'ℨ': ['Z', 'mathfrak'],
  'ℂ': ['C', 'mathbb'], 'ℍ': ['H', 'mathbb'], 'ℕ': ['N', 'mathbb'], 'ℙ': ['P', 'mathbb'], 'ℚ': ['Q', 'mathbb'], 'ℝ': ['R', 'mathbb'], 'ℤ': ['Z', 'mathbb'],
}
const GREEK_BOLD_ITALIC = 0x1D6A8 // bold Greek run (Α…ω plus a few symbols), then italic at +0x3A, bold italic +0x74, sans bold +0xAE, sans bold italic +0xE8
const GREEK = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡϴΣΤΥΦΧΨΩ∇αβγδεζηθικλμνξοπρςστυφχψω∂ϵϑϰϕϱϖ'

export function normalizeMathText(text) {
  let out = ''
  for (const ch of text.replace(/[\uFE00-\uFE0F]/g, '')) {
    const cp = ch.codePointAt(0)
    if (cp < 0x2100) { out += ch; continue }
    const letterlike = LETTERLIKE[ch]
    if (letterlike) { out += wrap(letterlike[0], letterlike[1]); continue }
    if (cp >= 0x1D400 && cp < 0x1D6A4) {
      const alphabet = ALPHABETS.findLast(([start]) => cp >= start)
      const offset = cp - alphabet[0]
      if (offset < 52) { out += wrap(String.fromCharCode(offset < 26 ? 65 + offset : 97 + offset - 26), alphabet[1]); continue }
    }
    if (cp >= GREEK_BOLD_ITALIC && cp < 0x1D7CC) {
      const offset = (cp - GREEK_BOLD_ITALIC) % 0x3A
      const run = Math.floor((cp - GREEK_BOLD_ITALIC) / 0x3A)
      const letter = GREEK[offset]
      if (letter !== undefined) { out += wrap(letter, run === 0 || run === 2 ? 'mathbf' : ''); continue }
    }
    if (cp >= 0x1D7CE && cp <= 0x1D7FF) { out += String((cp - 0x1D7CE) % 10); continue }
    out += ch
  }
  // mathml-to-latex wraps single italic letters as \mathit{x}: plain italics are LaTeX's default.
  return out.replace(/\\mathit\{([A-Za-z])\}/g, '$1')
}

const wrap = (letter, command) => command === '' ? letter : `\\${command}{${letter}}`

// -------------------------------------------------------------------- tidy

function tidy(markdown) {
  return markdown
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\\\[(diagram|image)(: [^\]]*)?\\\]/g, '[$1$2]')
    .trim()
}
