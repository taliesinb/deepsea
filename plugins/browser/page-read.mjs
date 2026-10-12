/**
 * One page read, shared by the isolated reader (reader-pool.mjs) and window
 * mode (tools.mjs: the *_get_page_content and *_get_page_structure tools).
 *
 * WebKit's extractor (the server's get_page_content) follows *rendered*
 * visibility: text inside a closed <details>, an aria-expanded="false"
 * accordion, or a non-selected tab panel is in the DOM but never comes back,
 * and the extraction always covers the whole page (nav, header, footer
 * included). This module runs small in-page scripts around the extraction:
 *
 *   prepare  → user script run BEFORE extraction (the existing `script` runs after)
 *   expand   → open <details>, click accordion buttons, harvest hidden tab panels
 *   scope    → confine the extraction to `selectors`, a heading `section`, or the
 *              page's main landmark; isolated pages are edited in place, windows
 *              are hidden-and-restored (display:none on the siblings of the kept
 *              subtrees' ancestor chains)
 *   markHeadings → prefix h1–h6 text with "## " so WebKit's markdown (which
 *              emits headings as plain lines) carries levels; webkitMarkdown,
 *              isolated only — `markdown` (dom-markdown.mjs) has native headings
 *   probe    → when nothing was expanded, count what is collapsed and say so
 *   clean    → strip WebKit-markdown litter (empty images/links, blank runs)
 *
 * Every script is a function body for evaluate_javascript (`return` a value).
 * Parameters are embedded with JSON.stringify — never string-concatenated.
 */

import { domMarkdownScript } from './dom-markdown.mjs'
import { parseJsonText, unwrapPageContent } from './servers.mjs'

/** `markdown` is the plugin's serializer (dom-markdown.mjs); `webkitMarkdown` is WebKit's own; the rest are WebKit's. */
export const FORMATS = ['markdown', 'webkitMarkdown', 'plainText', 'text', 'textTree', 'html', 'json']
const MARKDOWN_LIKE = new Set(['markdown', 'webkitMarkdown'])
export const SCOPES = ['auto', 'main', 'page']

/** Landmarks whose collapsed widgets are navigation chrome, not content. */
const CHROME = 'nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [role=complementary], [role=menu], [role=menubar], [role=listbox], [role=dialog], [role=search]'
/** Expanders that must not be clicked blindly: menus, comboboxes, tabs (handled separately), summaries (handled via details.open). */
const NOT_CLICKABLE = 'summary, [role=tab], [aria-haspopup], [role=combobox], [role=menuitem], input, select, textarea'
const MAIN = 'main, [role=main], article, #content, #main, #main-content'
const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role=heading]'
/** Elements whose presence makes a heading's ancestor a section container rather than a mere heading wrapper (see scopeScript). */
const BLOCK_CONTENT = 'p, ul, ol, dl, table, pre, blockquote, figure, img, iframe, section, article'
/** Text a heading wrapper may carry beside the heading itself ("edit", "[edit source]", "¶", "#", "Copy link"). */
const MAX_WRAPPER_DECORATION_CHARS = 24
const MAX_CLICKS = 50
const MAX_TAB_PANEL_CHARS = 4000

const helpers = `
const CHROME = ${JSON.stringify(CHROME)};
const HEADINGS = ${JSON.stringify(HEADINGS)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inChrome = (el) => el.closest(CHROME) !== null;
const visible = (el) => el.getClientRects().length > 0;
const level = (el) => { const m = /^H([1-6])$/.exec(el.tagName); if (m) return Number(m[1]); const a = Number(el.getAttribute('aria-level')); return a >= 1 && a <= 6 ? a : 2; };
const textOf = (el) => (el.innerText ?? el.textContent ?? '').replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim();
const cssPath = (el) => {
  if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id) && document.querySelectorAll('#' + el.id).length === 1) return '#' + el.id;
  const parts = [];
  let cur = el;
  while (cur && cur !== document.body && parts.length < 8) {
    if (cur.id && /^[A-Za-z][\\w-]*$/.test(cur.id) && document.querySelectorAll('#' + cur.id).length === 1) { parts.unshift('#' + cur.id); return parts.join(' > '); }
    const tag = cur.tagName.toLowerCase();
    const same = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [cur];
    parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(cur) + 1) + ')' : tag);
    cur = cur.parentElement;
  }
  return 'body > ' + parts.join(' > ');
};
`

/** Open collapsed content: <details>, aria-expanded accordions, and (by clicking through them) tab panels. */
export function expandScript() {
  return `${helpers}
const stats = { details: 0, buttons: 0, tabs: 0, tabPanels: [] };
for (const d of document.querySelectorAll('details:not([open])')) { if (inChrome(d)) continue; d.open = true; stats.details++; }
if (stats.details > 0) await sleep(50);
for (const b of document.querySelectorAll('[aria-expanded="false"]')) {
  if (stats.buttons >= ${MAX_CLICKS}) break;
  if (inChrome(b) || b.matches(${JSON.stringify(NOT_CLICKABLE)}) || !visible(b)) continue;
  try { b.click(); stats.buttons++; } catch {}
}
if (stats.buttons > 0) await sleep(300);
for (const list of document.querySelectorAll('[role=tablist]')) {
  if (inChrome(list)) continue;
  const tabs = [...list.querySelectorAll('[role=tab]')];
  if (tabs.length < 2) continue;
  const selected = tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0];
  const group = list.getAttribute('aria-label') || '';
  const panelFor = (tab) => {
    const byId = tab.getAttribute('aria-controls') && document.getElementById(tab.getAttribute('aria-controls'));
    if (byId) return byId;
    const panels = [...document.querySelectorAll('[role=tabpanel]')].filter((p) => visible(p) && (list.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING));
    return panels[0] ?? null;
  };
  for (const tab of tabs) {
    if (tab === selected) continue;
    try { tab.click(); } catch { continue; }
    await sleep(120);
    const panel = panelFor(tab);
    stats.tabs++;
    stats.tabPanels.push({ group, tab: textOf(tab), text: panel ? (panel.innerText ?? '').trim().slice(0, ${MAX_TAB_PANEL_CHARS}) : '' });
  }
  try { selected.click(); } catch {}
  await sleep(120);
}
return stats;`
}

/** Count what expand would have opened (used to annotate reads that did not expand). */
export function probeScript() {
  return `${helpers}
let details = 0, buttons = 0, tabGroups = 0;
for (const d of document.querySelectorAll('details:not([open])')) if (!inChrome(d)) details++;
for (const b of document.querySelectorAll('[aria-expanded="false"]')) if (!inChrome(b) && !b.matches(${JSON.stringify(NOT_CLICKABLE)}) && visible(b)) buttons++;
for (const l of document.querySelectorAll('[role=tablist]')) if (!inChrome(l) && l.querySelectorAll('[role=tab]').length > 1) tabGroups++;
return { details, buttons, tabGroups };`
}

/**
 * Confine the page to a set of subtrees.
 * @param {{ selectors?: string[], section?: string, scope: 'auto' | 'main' | 'page', isolated: boolean }} params
 */
export function scopeScript(params) {
  return `${helpers}
const P = ${JSON.stringify(params)};
const bodyChars = (document.body.innerText ?? '').length;
let nodes = [];
let label = 'page';
if (P.selectors && P.selectors.length > 0) {
  for (const s of P.selectors) { try { nodes.push(...document.querySelectorAll(s)); } catch (e) { return { error: 'invalid selector ' + JSON.stringify(s) + ': ' + e.message }; } }
  if (nodes.length === 0) return { error: 'no element matches selectors ' + JSON.stringify(P.selectors) };
  label = 'selectors ' + P.selectors.join(', ');
} else if (P.section) {
  let h; try { h = document.querySelector(P.section); } catch (e) { return { error: 'invalid section selector: ' + e.message }; }
  if (!h) return { error: 'section heading not found: ' + P.section };
  if (!h.matches(HEADINGS)) { const inner = h.querySelector(HEADINGS); if (inner) h = inner; }
  const hl = h.matches(HEADINGS) ? level(h) : 7;
  // A heading wrapped in its parent(s): the section's siblings live one level up. The wrapper may carry
  // decorations beside the heading — MediaWiki's <div class="mw-heading"><h2/><span class="mw-editsection">edit</span></div>,
  // permalink anchors ("¶", "#") — but never a second heading or block content (then it is the section itself).
  const ht = textOf(h);
  const wrapsHeading = (el) => {
    if (el === document.body || el.querySelectorAll(HEADINGS).length !== 1 || el.querySelector(${JSON.stringify(BLOCK_CONTENT)})) return false;
    const extra = textOf(el).replace(ht, '').trim();
    return extra.length <= ${MAX_WRAPPER_DECORATION_CHARS};
  };
  let anchor = h;
  while (anchor.parentElement && wrapsHeading(anchor.parentElement)) anchor = anchor.parentElement;
  nodes.push(anchor);
  for (let sib = anchor.nextElementSibling; sib; sib = sib.nextElementSibling) {
    // The section ends at the next heading of the same or a higher level, whether it is the sibling itself or wrapped inside it.
    const next = [sib.matches(HEADINGS) ? sib : null, ...sib.querySelectorAll(HEADINGS)].filter(Boolean);
    if (next.some((n) => level(n) <= hl)) break;
    nodes.push(sib);
  }
  label = 'section ' + P.section + ' (' + textOf(h).slice(0, 60) + ')';
} else if (P.scope === 'main' || P.scope === 'auto') {
  const main = document.querySelector(${JSON.stringify(MAIN)});
  if (main) {
    const share = bodyChars > 0 ? (main.innerText ?? '').length / bodyChars : 0;
    if (P.scope === 'main' || share >= 0.6) {
      nodes = [main];
      label = main.tagName.toLowerCase() + (main.id ? '#' + main.id : '') + ' (' + Math.round(share * 100) + '% of page text)';
    } else {
      return { scope: 'page', chars: bodyChars, reason: 'main landmark holds only ' + Math.round(share * 100) + '% of the text' };
    }
  }
}
if (nodes.length === 0) return { scope: 'page', chars: bodyChars };
const keep = new Set(nodes);
let hidden = 0;
if (P.isolated) {
  document.body.replaceChildren(...nodes);
} else {
  const ancestors = new Set();
  for (const n of nodes) for (let a = n.parentElement; a && a !== document.body; a = a.parentElement) ancestors.add(a);
  const chain = new Set([...keep, ...ancestors]);
  for (const el of chain) {
    const parent = el.parentElement;
    if (!parent) continue;
    for (const sib of parent.children) {
      if (chain.has(sib) || sib.hasAttribute('data-deepsea-browser-hidden')) continue;
      sib.setAttribute('data-deepsea-browser-hidden', sib.style.getPropertyValue('display') + '|' + sib.style.getPropertyPriority('display'));
      sib.style.setProperty('display', 'none', 'important');
      hidden++;
    }
  }
}
const chars = nodes.reduce((sum, n) => sum + (n.innerText ?? '').length, 0);
return { scope: label, chars, hidden, matched: nodes.length };`
}

/** One layout tick after DOM mutations (setTimeout, not rAF: rAF does not fire in occluded windows). */
export const SETTLE_SCRIPT = 'await new Promise((resolve) => setTimeout(resolve, 80)); return true;'

/** Undo scopeScript's window-mode hiding. */
export const RESTORE_SCRIPT = `
let restored = 0;
for (const el of document.querySelectorAll('[data-deepsea-browser-hidden]')) {
  const [display, priority] = el.getAttribute('data-deepsea-browser-hidden').split('|');
  el.style.removeProperty('display');
  if (display) el.style.setProperty('display', display, priority);
  el.removeAttribute('data-deepsea-browser-hidden');
  restored++;
}
return restored;`

/**
 * Prefix heading text with "## " so WebKit's markdown output carries heading levels (isolated only).
 * The marker is written into the heading's first real text node rather than replacing its children:
 * removing framework-owned DOM nodes (React et al.) makes the next re-render throw and unmount content.
 */
export const MARK_HEADINGS_SCRIPT = `${helpers}
let marked = 0;
for (const h of document.querySelectorAll(HEADINGS)) {
  if (!visible(h) || !textOf(h)) continue;
  const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) { if (/[^\\s\\u200B-\\u200D\\uFEFF]/.test(node.data)) break; }
  if (!node) continue;
  node.data = '#'.repeat(level(h)) + ' ' + node.data.replace(/^\\s+/, '');
  marked++;
}
return marked;`

/** Page outline for safari_get_page_structure. */
export const STRUCTURE_SCRIPT = `${helpers}
const bodyChars = (document.body.innerText ?? '').length;
const landmarks = [...document.querySelectorAll('header, nav, main, article, aside, footer, form, [role=banner], [role=navigation], [role=main], [role=complementary], [role=contentinfo], [role=search], [role=region][aria-label], [role=region][aria-labelledby]')]
  .filter((el) => visible(el))
  .slice(0, 40)
  .map((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined, label: el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && textOf(document.getElementById(el.getAttribute('aria-labelledby')) ?? el)) || undefined, selector: cssPath(el), chars: (el.innerText ?? '').length }))
  .map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)));
const main = document.querySelector(${JSON.stringify(MAIN)});
const headings = [...document.querySelectorAll(HEADINGS)].slice(0, 200).map((h) => {
  const entry = { level: level(h), text: textOf(h).slice(0, 120), selector: cssPath(h) };
  if (inChrome(h)) entry.chrome = true;
  if (!visible(h)) entry.hidden = true;
  return entry;
});
let details = 0, collapsedDetails = 0, buttons = 0;
for (const d of document.querySelectorAll('details')) { if (inChrome(d)) continue; details++; if (!d.open) collapsedDetails++; }
for (const b of document.querySelectorAll('[aria-expanded="false"]')) if (!inChrome(b) && !b.matches(${JSON.stringify(NOT_CLICKABLE)}) && visible(b)) buttons++;
const tablists = [...document.querySelectorAll('[role=tablist]')].filter((l) => !inChrome(l)).slice(0, 20).map((l) => {
  const tabs = [...l.querySelectorAll('[role=tab]')];
  return { label: l.getAttribute('aria-label') || undefined, selector: cssPath(l), tabs: tabs.map((t) => textOf(t).slice(0, 60)), selected: tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true') };
}).map((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined)));
return {
  title: document.title,
  url: location.href,
  chars: bodyChars,
  main: main ? { selector: cssPath(main), chars: (main.innerText ?? '').length } : null,
  landmarks,
  headings,
  collapsed: { details: collapsedDetails, detailsTotal: details, buttons, tablists },
  forms: document.forms.length,
  iframes: document.querySelectorAll('iframe').length,
  links: document.links.length,
};`

/** Label for a link whose text WebKit dropped: the URL's last path segment, else its host. */
function linkLabel(url) {
  try {
    const parsed = new URL(url)
    const segment = parsed.pathname.split('/').filter(Boolean).pop()
    return segment ? decodeURIComponent(segment) : parsed.host
  } catch {
    return url
  }
}

/**
 * Strip WebKit-markdown litter: zero-width anchors, alt-less images, icon-only link lines, trailing spaces,
 * blank runs. WebKit emits `[](url)` for a link whose text also appears in its URL (e.g. `mcp-remote` →
 * npmjs.com/package/mcp-remote); inline, such a link gets the URL's last path segment back as its text.
 */
export function cleanMarkdown(text) {
  const lines = text
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/!\[\]\([^)\s]*\)/g, '')
    .split('\n')
    .filter(line => !/^\s*(?:\[\]\([^)\s]*\)\s*)+$/.test(line))
    .map(line => line.replace(/\[\]\(([^)\s]+)\)/g, (_m, url) => `[${linkLabel(url)}](${url})`).replace(/\[\]\(\)/g, '').replace(/[ \t]+$/, ''))
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}

/**
 * Fill in mode-dependent defaults for a read.
 * @param {object} args - tool arguments
 * @param {boolean} isolated
 */
export function planRead(args, isolated) {
  const format = args.format ?? 'markdown'
  const selectors = Array.isArray(args.selectors) && args.selectors.length > 0 ? args.selectors : undefined
  const section = typeof args.section === 'string' && args.section.trim() !== '' ? args.section.trim() : undefined
  if (selectors !== undefined && section !== undefined) throw new Error('pass either selectors or section, not both')
  return {
    format,
    maxWordsPerParagraph: args.maxWordsPerParagraph ?? 2000,
    includeURLs: args.includeURLs ?? true,
    nodeIds: isolated ? 'none' : (args.nodeIds ?? 'interactive'),
    prepare: typeof args.prepare === 'string' && args.prepare.trim() !== '' ? args.prepare : undefined,
    expand: args.expand ?? isolated,
    selectors,
    section,
    scope: args.scope ?? (isolated ? 'auto' : 'page'),
    markHeadings: args.markHeadings ?? (isolated && format === 'webkitMarkdown'),
    clean: args.clean ?? MARKDOWN_LIKE.has(format),
    script: typeof args.script === 'string' && args.script.trim() !== '' ? args.script : undefined,
    skipContent: args.skipContent === true,
  }
}

/**
 * Run one read against an already-navigated page.
 * @param {(name: string, args: object) => Promise<string>} call - MCP tool call returning text
 * @param {ReturnType<typeof planRead>} request
 * @param {boolean} isolated - the page is disposable (edit in place) vs. the user's window (hide and restore)
 */
export async function extractPage(call, request, isolated) {
  const evalJs = async (body) => {
    const value = parseJsonText(await call('evaluate_javascript', { expression: body }))
    return value === 'undefined' ? undefined : value
  }
  const out = { format: request.format, notes: [] }

  if (request.prepare !== undefined) {
    const value = await evalJs(request.prepare)
    if (value !== undefined) out.prepareResult = value
  }

  if (!request.skipContent) {
    let expanded
    if (request.expand) {
      expanded = await evalJs(expandScript())
      if (expanded && typeof expanded === 'object') {
        out.expanded = { details: expanded.details ?? 0, buttons: expanded.buttons ?? 0, tabs: expanded.tabs ?? 0 }
      }
    }
    let scoped
    if (request.selectors !== undefined || request.section !== undefined || request.scope !== 'page') {
      scoped = await evalJs(scopeScript({ selectors: request.selectors, section: request.section, scope: request.scope, isolated }))
      if (scoped && typeof scoped === 'object' && typeof scoped.error === 'string') throw new Error(scoped.error)
      if (scoped && typeof scoped === 'object') {
        out.scope = { scope: scoped.scope, chars: scoped.chars ?? 0, ...(scoped.reason ? { reason: scoped.reason } : {}) }
      }
    }
    // Let layout catch up with the DOM changes above. Observed: rewriting heading text in the same tick as opening
    // <details> makes WebKit's markdown extraction drop the details' bodies (textTree keeps them); a tick in between fixes it.
    const mutated = request.prepare !== undefined || request.expand || scoped !== undefined
    if (mutated) await evalJs(SETTLE_SCRIPT)
    if (request.markHeadings && isolated && request.format === 'webkitMarkdown') {
      await evalJs(MARK_HEADINGS_SCRIPT)
      await evalJs(SETTLE_SCRIPT)
    }
    try {
      if (request.format === 'markdown') {
        const envelope = await evalJs(domMarkdownScript({ maxWordsPerParagraph: request.maxWordsPerParagraph, includeURLs: request.includeURLs }))
        if (envelope === undefined || typeof envelope !== 'object' || typeof envelope.content !== 'string') throw new Error('markdown serializer returned no content')
        Object.assign(out, { url: envelope.url, title: envelope.title, content: envelope.content })
      } else {
        Object.assign(out, await unwrapPageContent(await call('get_page_content', {
          format: request.format === 'webkitMarkdown' ? 'markdown' : request.format,
          region: 'entire_page',
          maxWordsPerParagraph: request.maxWordsPerParagraph,
          includeURLs: request.includeURLs,
          shortenURLs: false,
          nodeIds: request.nodeIds,
        })))
      }
    } finally {
      if (!isolated && scoped && typeof scoped === 'object' && (scoped.hidden ?? 0) > 0) {
        try { await evalJs(RESTORE_SCRIPT) } catch { /* the page may have navigated away */ }
      }
    }
    if (!request.expand) {
      const probe = await evalJs(probeScript())
      if (probe && typeof probe === 'object' && ((probe.details ?? 0) + (probe.buttons ?? 0) + (probe.tabGroups ?? 0)) > 0) {
        out.collapsed = { details: probe.details ?? 0, buttons: probe.buttons ?? 0, tabGroups: probe.tabGroups ?? 0 }
        out.notes.push(`${describeCollapsed(out.collapsed)} not expanded; their text is missing above — pass expand: true to include it.`)
      }
    }
    if (expanded && Array.isArray(expanded.tabPanels) && expanded.tabPanels.length > 0) {
      const panels = expanded.tabPanels.filter(panel => panel.text !== '')
      if (panels.length > 0) {
        out.content += `\n\n## Hidden tab panels (expanded)\n${panels.map(panel => `\n### ${panel.group ? `${panel.group}: ` : ''}${panel.tab}\n${panel.text}`).join('\n')}`
      }
    }
    if (request.clean && MARKDOWN_LIKE.has(request.format)) out.content = cleanMarkdown(out.content)
  } else {
    out.content = ''
  }

  if (request.script !== undefined) {
    const value = await evalJs(request.script)
    if (value !== undefined) out.scriptResult = value
  }
  return out
}

/** "14 collapsed <details>, 2 accordion buttons and 1 tab group" */
export function describeCollapsed(counts) {
  const parts = []
  if (counts.details > 0) parts.push(`${counts.details} collapsed <details> section${counts.details === 1 ? '' : 's'}`)
  if (counts.buttons > 0) parts.push(`${counts.buttons} collapsed accordion button${counts.buttons === 1 ? '' : 's'}`)
  if (counts.tabGroups > 0) parts.push(`${counts.tabGroups} tab group${counts.tabGroups === 1 ? '' : 's'}`)
  if (parts.length <= 1) return parts[0] ?? 'nothing'
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** Model-facing outline for safari_get_page_structure. */
export function renderStructure(value) {
  const s = value.structure
  const lines = [
    value.mode === 'window' ? `[${value.windowId}]${value.opened ? ' (opened)' : ''}` : value.browser === 'chrome' ? '[temporary Chrome page]' : '[isolated reader]',
    `Title: ${s.title}`,
    `URL: ${s.url}`,
    `Text: ${s.chars.toLocaleString('en-US')} chars${s.main ? `; main content: ${s.main.selector} (${s.main.chars.toLocaleString('en-US')} chars, ${s.chars > 0 ? Math.round(s.main.chars / s.chars * 100) : 0}%)` : '; no main landmark'}`,
    `Forms: ${s.forms}; iframes: ${s.iframes}; links: ${s.links}`,
  ]
  if (s.landmarks.length > 0) {
    lines.push('', 'Landmarks:')
    for (const l of s.landmarks) lines.push(`  ${l.tag}${l.role ? `[role=${l.role}]` : ''}${l.label ? ` "${l.label}"` : ''} → ${l.selector} (${l.chars.toLocaleString('en-US')} chars)`)
  }
  const content = s.headings.filter(h => !h.chrome)
  if (content.length > 0) {
    lines.push('', 'Headings (content):')
    for (const h of content) lines.push(`  ${'  '.repeat(Math.max(0, h.level - 1))}h${h.level} ${h.text}${h.hidden ? ' [collapsed]' : ''} → ${h.selector}`)
  }
  const chrome = s.headings.filter(h => h.chrome)
  if (chrome.length > 0) lines.push('', `Headings inside nav/header/footer: ${chrome.length} (omitted)`)
  const c = s.collapsed
  const collapsedBits = []
  if (c.details > 0) collapsedBits.push(`${c.details} of ${c.detailsTotal} <details> closed`)
  if (c.buttons > 0) collapsedBits.push(`${c.buttons} aria-expanded="false" buttons`)
  lines.push('', `Collapsed content: ${collapsedBits.length > 0 ? collapsedBits.join('; ') : 'none detected'}`)
  for (const t of c.tablists) lines.push(`  tab group${t.label ? ` "${t.label}"` : ''} → ${t.selector}: ${t.tabs.map((tab, i) => i === t.selected ? `[${tab}]` : tab).join(' | ')}`)
  const tool = value.browser === 'chrome' ? 'chrome_get_page_content' : 'safari_get_page_content'
  lines.push('', `Next: ${tool} with section: "<heading selector>" for one section, selectors: [...] for specific subtrees, expand: true to include collapsed text.`)
  return lines.join('\n')
}
