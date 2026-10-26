/**
 * The plugin's own DOM → markdown serializer, run in the page (Safari and
 * Chrome alike) as an evaluate script. It replaces WebKit's markdown for
 * `format: markdown` (WebKit's stays available as `webkitMarkdown`) because
 * measured on real pages it keeps what WebKit's drops: heading levels, code
 * fences (with language), inline code, bold/italic, real tables, list nesting,
 * and link text that happens to appear in the href — and it is identical in
 * both browsers.
 *
 * Rules:
 * - Only RENDERED text: display:none / visibility:hidden / content-visibility
 *   (checkVisibility) or no rendered box → skipped. Children of a closed
 *   <details> and unselected tab panels are therefore absent unless expanded.
 * - Shadow DOM is traversed (open roots; <slot> → assigned nodes); MDN's code
 *   examples live there. Same-origin iframes are not (matches WebKit's default).
 * - A <table> becomes a pipe table only when it looks like a data table (no
 *   nested tables, ≥ 2 rows, a majority of rows sharing a 2–8 column width,
 *   not role=presentation; narrower rows are padded); layout tables (Hacker
 *   News) become plain block flow.
 * - <pre> → fenced block using innerText; the language comes from a
 *   `language-*` class on a nested <code>.
 * - A line holding only an ordinal ("1.", "12") is merged into the next line
 *   as "1. …": ranks and step numbers that sit in their own cell or box.
 *
 * Function body; returns `{ url, title, format: 'markdown', content }`.
 */

/**
 * @param {{ maxWordsPerParagraph: number, includeURLs: boolean }} params
 * @returns {string} function body for evaluate
 */
export function domMarkdownScript(params) {
  return `
const P = ${JSON.stringify({ maxWordsPerParagraph: params.maxWordsPerParagraph, includeURLs: params.includeURLs })};
const SKIP = 'script, style, noscript, template, svg, canvas, iframe, object, embed, [hidden], [aria-hidden="true"]';
const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-row-group|table-header-group|table-footer-group|table-caption|flow-root|-webkit-box)$/;
const visible = (el) => {
  if (el === document.body) return true;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  if (cs.display === 'contents') return true;
  return el.getClientRects().length > 0;
};
// Light children, or the shadow tree when the element hosts one, or a slot's assigned nodes.
const childrenOf = (el) => el.shadowRoot ? [...el.shadowRoot.childNodes] : el.tagName === 'SLOT' ? el.assignedNodes({ flatten: true }) : [...el.childNodes];
const absolute = (value) => { try { return new URL(value, location.href).href; } catch { return value; } };
const collapse = (text) => text.replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\s+/g, ' ');
const truncate = (text) => {
  if (!(P.maxWordsPerParagraph > 0)) return text;
  const words = text.split(' ');
  return words.length > P.maxWordsPerParagraph ? words.slice(0, P.maxWordsPerParagraph).join(' ') + '…' : text;
};

const out = [];
let line = '';
const flush = () => { const text = collapse(line).trim(); if (text) out.push(truncate(text)); line = ''; };
const blank = () => { flush(); if (out.length > 0 && out[out.length - 1] !== '') out.push(''); };
// One run of inline text for an element; lines that block children flushed into out are folded back in.
const inline = (el, ctx) => {
  const saved = line; line = '';
  const start = out.length;
  for (const child of childrenOf(el)) walk(child, ctx);
  const nested = out.splice(start).filter((entry) => entry !== '');
  const text = collapse([...nested, line].join(' ')).trim();
  line = saved;
  return text;
};
const headingLevel = (el) => { const m = /^H([1-6])$/.exec(el.tagName); if (m) return Number(m[1]); if (el.getAttribute('role') === 'heading') { const a = Number(el.getAttribute('aria-level')); return a >= 1 && a <= 6 ? a : 2; } return 0; };
const isDataTable = (table) => {
  if (table.getAttribute('role') === 'presentation' || table.querySelector('table')) return false;
  const rows = [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table && visible(tr));
  if (rows.length < 2) return false;
  // Column count of the majority of rows; rows spanning fewer cells (infobox titles, section rows) are padded.
  const counts = rows.map((tr) => [...tr.children].filter((cell) => /^T[HD]$/.test(cell.tagName) && visible(cell)).length);
  const width = Math.max(...counts);
  return width >= 2 && width <= 8 && counts.filter((count) => count === width).length * 2 >= rows.length;
};
const tableWidth = (rows) => Math.max(...rows.map((tr) => [...tr.children].filter((cell) => /^T[HD]$/.test(cell.tagName) && visible(cell)).length));

function walk(node, ctx) {
  if (node.nodeType === Node.TEXT_NODE) { line += node.data; return; }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node;
  if (el.matches(SKIP) || !visible(el)) return;
  const tag = el.tagName;
  const level = headingLevel(el);
  if (level > 0) {
    blank();
    const text = inline(el, ctx);
    if (text) out.push('#'.repeat(level) + ' ' + text);
    blank();
    return;
  }
  switch (tag) {
    case 'BR': flush(); return;
    case 'HR': blank(); out.push('---'); blank(); return;
    case 'PRE': {
      blank();
      const lang = (el.querySelector('code[class*="language-"]')?.className.match(/language-([\\w-]+)/) ?? [])[1] ?? '';
      out.push('\`\`\`' + lang);
      for (const codeLine of (el.innerText ?? el.textContent ?? '').replace(/\\n$/, '').split('\\n')) out.push(codeLine);
      out.push('\`\`\`');
      blank();
      return;
    }
    case 'CODE': case 'KBD': case 'SAMP': {
      const text = collapse(el.textContent ?? '').trim();
      if (text) line += '\`' + text + '\`';
      return;
    }
    case 'A': {
      const text = inline(el, ctx);
      const href = el.getAttribute('href');
      if (!text) return;
      line += P.includeURLs && href && !/^(javascript:|#$)/.test(href) ? '[' + text + '](' + absolute(href) + ')' : text;
      return;
    }
    case 'IMG': {
      const alt = collapse(el.getAttribute('alt') ?? '').trim();
      if (!alt) return;
      line += P.includeURLs && el.currentSrc ? '![' + alt + '](' + el.currentSrc + ')' : alt;
      return;
    }
    case 'STRONG': case 'B': { const text = inline(el, ctx); if (text) line += '**' + text + '**'; return; }
    case 'EM': case 'I': { const text = inline(el, ctx); if (text) line += '*' + text + '*'; return; }
    case 'INPUT': case 'TEXTAREA': case 'SELECT': return;
    case 'UL': case 'OL': {
      blank();
      let index = tag === 'OL' ? Number(el.getAttribute('start') ?? 1) : 0;
      for (const child of el.children) {
        if (child.tagName !== 'LI' || !visible(child)) continue;
        flush();
        const start = out.length;
        walk(child, { ...ctx, depth: (ctx.depth ?? 0) + 1 });
        flush();
        if (out.length === start) continue;
        const indent = '  '.repeat(ctx.depth ?? 0);
        const marker = tag === 'OL' ? String(index++) + '. ' : '- ';
        out[start] = indent + marker + out[start];
        for (let i = start + 1; i < out.length; i++) if (out[i] !== '' && !/^\\s*(?:-|\\d+\\.) /.test(out[i])) out[i] = indent + '  ' + out[i];
      }
      blank();
      return;
    }
    case 'LI': { for (const child of childrenOf(el)) walk(child, ctx); return; }
    case 'BLOCKQUOTE': {
      blank();
      const start = out.length;
      for (const child of childrenOf(el)) walk(child, ctx);
      flush();
      for (let i = start; i < out.length; i++) out[i] = out[i] === '' ? '>' : '> ' + out[i];
      blank();
      return;
    }
    case 'TABLE': {
      if (!isDataTable(el)) { flush(); for (const child of childrenOf(el)) walk(child, ctx); flush(); return; }
      blank();
      const rows = [...el.querySelectorAll('tr')].filter((tr) => tr.closest('table') === el && visible(tr));
      const width = tableWidth(rows);
      let first = true;
      for (const tr of rows) {
        const cells = [...tr.children].filter((cell) => /^T[HD]$/.test(cell.tagName) && visible(cell)).map((cell) => inline(cell, ctx).replace(/\\|/g, '\\\\|'));
        while (cells.length < width) cells.push('');
        out.push('| ' + cells.join(' | ') + ' |');
        if (first) { out.push('|' + cells.map(() => ' --- |').join('')); first = false; }
      }
      blank();
      return;
    }
    case 'TR': { flush(); for (const child of childrenOf(el)) { walk(child, ctx); line += ' '; } flush(); return; }
    case 'P': case 'FIGCAPTION': case 'DD': case 'DT': case 'ADDRESS': case 'SUMMARY': {
      blank();
      for (const child of childrenOf(el)) walk(child, ctx);
      blank();
      return;
    }
    default: {
      const block = BLOCK.test(getComputedStyle(el).display);
      if (block) flush();
      for (const child of childrenOf(el)) walk(child, ctx);
      if (block) flush();
    }
  }
}
walk(document.body, { depth: 0 });
flush();
// A line that is only an ordinal ("1." / "12" / "3)") is a rank or step number rendered in its own cell or
// box (Hacker News ranks, docs "steps"); merge it into the following line as a list-style prefix.
const merged = [];
for (let i = 0; i < out.length; i++) {
  const ordinal = /^(\\d{1,4})[.)]?$/.exec(out[i]);
  if (ordinal) {
    let next = i + 1;
    while (next < out.length && out[next] === '') next++;
    if (next < out.length && !/^(#{1,6} |\`\`\`|\\||\\s*(?:-|\\d+\\.) )/.test(out[next])) { merged.push(ordinal[1] + '. ' + out[next]); i = next; continue; }
  }
  merged.push(out[i]);
}
return { url: location.href, title: document.title, format: 'markdown', content: merged.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim() };`
}
