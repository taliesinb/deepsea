// Generate docs/tools.md from the registered tool definitions (names,
// descriptions, parameter schemas) so the reference cannot drift from the code.
//   node scripts/gen-tool-docs.mjs          # write
//   node scripts/gen-tool-docs.mjs --check  # exit 1 when docs/tools.md is stale
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTools } from '../tools.mjs'

const out = fileURLToPath(new URL('../docs/tools.md', import.meta.url))
const tools = createTools({ sessions: {}, readerPool: {}, admitImage: async () => ({}), inlineImages: new WeakMap(), preflight: () => {}, limits: { maxChars: 1 } }, {})

const GROUPS = [
  { title: 'Windows', match: /^(safari|chrome)_(open|close)$/ },
  { title: 'Navigation and reading', match: /^(safari|chrome)_(navigate|get_page_content|get_page_structure|snapshot|get_youtube_notes|wait_for)$/ },
  { title: 'JavaScript', match: /_evaluate_/ },
  { title: 'Interaction', match: /^(safari|chrome)_(interact|click|hover|press_key|type_text|fill|fill_form)$/ },
  { title: 'Screenshots', match: /_screenshot$/ },
  { title: 'Diagnostics, dialogs and viewport', match: /_(console_messages|network_requests|get_network_request|handle_dialog|set_viewport_size)$/ },
]

const NOTES = {
  safari_open: 'Each Safari window is a separate `safaridriver --mcp` process: its own automation session, cookies and JS state, in its own STP window whose banner reads `This window is controlled by DeepSea: ‹chat› · s:0:1.` Nothing is shared between windows.',
  chrome_open: 'All Chrome windows of a session are pages of one Chrome instance with a throwaway profile (cookies shared between the session\'s windows; the profile is deleted when the instance ends). Chrome launches with the first page and quits with the last.',
  safari_get_page_content: 'Two modes: `url` without `windowId` reads in an isolated pooled reader (never a chat window); `windowId`, or no `url`, reads the chat\'s window. WebKit extracts only rendered text, so the tool runs in-page steps around the extraction (page-read.mjs): `prepare` → `expand` (details.open, aria-expanded accordions outside nav/header/footer, tab groups clicked through and appended as "Hidden tab panels") → scope (`section` / `selectors` / `scope`; isolated pages are edited in place, windows are hidden-and-restored) → `markHeadings` → extraction → probe of what stayed collapsed (a NOTE in the header) → `script` → `clean`. Isolated defaults: expand on, scope auto (main landmark when ≥ 60% of the text), markdown cleaned (headings marked for `webkitMarkdown`); window defaults: expand off, scope page. The server\'s `maxWordsPerParagraph` default of 15 truncates prose, so the tool defaults it to 2000 and always extracts `region: entire_page`. Output beyond `safari.reader.maxChars` is cut and the full text saved to a scratch file named in the header.',
  chrome_get_page_content: 'chrome-devtools-mcp has no text extractor (its snapshot is the accessibility tree), so the content is the plugin\'s own in-page DOM serializer (chrome-read.mjs): headings, paragraphs, lists (nested), code fences with language, inline code, bold/italic, links, images with alt, pipe tables, blockquotes; visibility via `checkVisibility()` (display/visibility/content-visibility, which is how Chrome hides closed <details>). The surrounding expand / scope / probe / clean pipeline is page-read.mjs, shared with Safari. `url` reads use a temporary page of the session\'s Chrome instance (opened and closed per read; the instance stays warm until the session idle timer).',
  chrome_get_page_structure: 'Same in-page outline script as safari_get_page_structure, run through chrome-devtools-mcp\'s `evaluate_script`.',
  safari_get_page_structure: 'One in-page script (no extraction): landmarks and headings with CSS selectors (`#id` when unique, else an `nth-of-type` path), the main landmark and its share of the text, collapsed `<details>` / aria-expanded buttons / tab groups. Headings inside nav/header/footer are counted but omitted; hidden headings are tagged `[collapsed]`.',
  safari_get_youtube_notes: 'The rendered watch page never contains the full description (collapsed behind "…more"); the tool reads `videoDetails` from the inline `ytInitialPlayerResponse` script in an isolated reader and parses chapters from timestamp lines.',
  safari_wait_for: 'No server counterpart: the plugin\'s wait engine (waiting.mjs) polls the page every 100 ms in in-page slices of at most 5 s from a host loop that owns the deadline, so a long wait never runs into the MCP call timeout. The same engine serves the `wait` parameter of navigate, evaluate_expression and get_screenshot.',
  chrome_wait_for: 'The plugin\'s wait engine (waiting.mjs), as for safari_wait_for, run through `evaluate_script`.',
  safari_evaluate_function: 'Wrapped as `return await (fn)($uid(a), $uid(b))`, so `args` are node UIDs from `safari_get_page_content`.',
  chrome_evaluate_expression: 'Wrapped as `async () => { … }` for the server\'s `evaluate_script`.',
  chrome_evaluate_function: 'Server-native `evaluate_script`; `args` are snapshot uids only (plain values must be inlined into the function source).',
  safari_interact: 'Direct forward of Apple\'s `page_interactions`. Prefer one batched call over several single-step calls.',
  chrome_interact: 'Mirrors `safari_interact`\'s batch format on Chrome: click/hover/keyPress/type/scroll/selectMenuItem map onto `click`/`hover`/`press_key`/`fill`+`press_key`/`type_text`/`evaluate_script`/`fill`. `node` = snapshot uid (native); `text` targets use an in-page finder (deepest visible element containing the text). `selectText`, `highlightText` and `point` targets are reported as failed steps; the batch continues and each step\'s outcome is listed.',
  safari_click: 'Single-step convenience over `safari_interact` (`scrollToVisible` defaults to true). Waits for a navigation the click triggers.',
  safari_hover: 'Single-step convenience over `safari_interact`.',
  safari_press_key: 'Single-step convenience over `safari_interact` (`keyPress`).',
  safari_type_text: 'Single-step convenience over `safari_interact` (`type`, with `replaceAll` / `pressReturn`).',
  safari_get_screenshot: 'With `querySelector`: scroll into view (`scrollTo`), wait until rect and scroll offset are stable for three samples (setTimeout polling — rAF does not fire in occluded windows), capture the viewport, re-measure (retake once if it moved > 2 px), crop with sharp at device-pixel precision. Inline images go through the harness\'s attachment store when the current model declares image input; otherwise the capture is saved to a scratch file and its path returned.',
  safari_save_screenshot: 'Same capture as `safari_get_screenshot`, written to `path` (relative paths resolve against the session workspace; parents are created).',
  chrome_get_screenshot: 'Server-native capture (viewport, `fullPage`, or element `uid`); inline via the attachment store under the same admission rule as `safari_get_screenshot`.',
  chrome_save_screenshot: 'Same capture as `chrome_get_screenshot`, written to `path`.',
  safari_network_requests: 'Inspector recording is enabled by the first call (verified: 0 requests for a page loaded before it, 1 after the next navigation). Diagnostics tools require a loaded page (\"No active browsing context\" otherwise).',
  safari_console_messages: 'Apple\'s server clears the buffer by default; this tool keeps it unless `clear` is true, matching Chrome.',
  safari_handle_dialog: '`accept` maps to Apple\'s `respond`; `list` reports open dialogs.',
  chrome_handle_dialog: '`text` maps to the server\'s `promptText`.',
  chrome_set_viewport_size: 'Forwards to `resize_page`.',
}

const RETURNS = {
  safari_open: '`{ windowId, url?, title? }`', chrome_open: '`{ windowId, url? }`',
  safari_close: 'text: which ids were closed', chrome_close: 'text: which ids were closed',
  safari_navigate: '`{ windowId, url, title? }`', chrome_navigate: 'text from the server, prefixed `[windowId]`',
  safari_get_page_content: '`{ mode, windowId?, url, title?, format, content, notes[], expanded?{details,buttons,tabs}, collapsed?{details,buttons,tabGroups}, scope?{scope,chars,reason?}, prepareResult?, scriptResult?, truncated?, fullTextPath? }` rendered with a header (scope, what was expanded or what stayed collapsed as NOTEs)',
  chrome_get_page_content: 'same shape as safari_get_page_content plus `browser: "chrome"`',
  chrome_get_page_structure: 'same shape as safari_get_page_structure plus `browser: "chrome"`',
  safari_get_page_structure: '`{ mode, windowId?, structure: { title, url, chars, main?, landmarks[], headings[{level,text,selector,hidden?,chrome?}], collapsed{details,detailsTotal,buttons,tablists[]}, forms, iframes, links } }` rendered as an outline',
  safari_get_youtube_notes: '`{ url, videoId, title, author, channelId, publishDate, category, lengthSeconds, viewCount, isLive, keywords[], chapters[{time,title}], links[], description }`',
  safari_get_screenshot: 'inline image + `{ windowId, width, height, rect?, viewport?, scale?, clipped?, settled?, unstable? }`',
  chrome_get_screenshot: 'inline image + `{ windowId, width?, height?, uid?, fullPage }`',
  safari_save_screenshot: '`{ path, width, height, … }`', chrome_save_screenshot: '`{ path, … }`',
  safari_wait_for: 'text: what matched (`waited 1.2s: text "Done" appeared`, an expression\'s value on the next line) or a timeout notice', chrome_wait_for: 'as safari_wait_for', chrome_interact: 'text: one line per step (`ok` / `FAILED: reason`), optional snapshot',
}

const esc = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ')
const typeOf = (schema) => {
  if (schema.enum) return schema.enum.map(v => `\`${v}\``).join(' \\| ')
  if (schema.type === 'array') return `array of ${schema.items?.type === 'object' ? 'objects' : (schema.items?.enum ? schema.items.enum.map(v => `\`${v}\``).join(' \\| ') : (schema.items?.type ?? 'any'))}`
  return schema.type ?? 'any'
}

function paramRows(schema, prefix = '') {
  const required = new Set(schema.required ?? [])
  const rows = []
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    rows.push(`| \`${prefix}${name}\` | ${typeOf(prop)} | ${required.has(name) ? 'yes' : ''} | ${esc(prop.description ?? '')} |`)
    const nested = prop.type === 'array' && prop.items?.type === 'object' ? prop.items : (prop.type === 'object' ? prop : undefined)
    if (nested?.properties) rows.push(...paramRows(nested, `${prefix}${name}${prop.type === 'array' ? '[].' : '.'}`))
  }
  return rows
}

const lines = [
  '# Tool reference',
  '',
  '<!-- GENERATED by scripts/gen-tool-docs.mjs from tools.mjs — do not edit by hand. -->',
  '',
  `${tools.length} tools, registered into every eligible chat and subagent. Window-bound tools take an optional \`windowId\` (\`s:<session>:<window>\` for Safari, \`c:<session>:<window>\` for Chrome); when omitted, no window opens one (the result says \`Opened …\`), one is used, and of several the most recently used one is, the result naming the others. Ids are validated against the caller's session. Nothing is spawned until a tool needs it; a session's windows close after \`idleMinutes\` without a tool call, on agent disposal, and on plugin unload.`,
  '',
  '## Index',
  '',
]
for (const group of GROUPS) {
  const names = tools.filter(t => group.match.test(t.name)).map(t => `[\`${t.name}\`](#${t.name})`)
  lines.push(`- **${group.title}**: ${names.join(', ')}`)
}
const grouped = new Set(GROUPS.flatMap(g => tools.filter(t => g.match.test(t.name)).map(t => t.name)))
const ungrouped = tools.filter(t => !grouped.has(t.name))
if (ungrouped.length > 0) throw new Error(`ungrouped tools: ${ungrouped.map(t => t.name).join(', ')}`)

for (const group of GROUPS) {
  lines.push('', `## ${group.title}`)
  for (const tool of tools.filter(t => group.match.test(t.name))) {
    lines.push('', `### \`${tool.name}\``, '', tool.description, '')
    const rows = paramRows(tool.parameters)
    if (rows.length === 0) lines.push('_No parameters._')
    else lines.push('| Parameter | Type | Required | Description |', '|---|---|---|---|', ...rows)
    lines.push('', `**Returns:** ${RETURNS[tool.name] ?? 'text from the server, prefixed `[windowId]` (and `Opened …` when a window was auto-opened)'}`)
    if (NOTES[tool.name]) lines.push('', `**Notes:** ${NOTES[tool.name]}`)
  }
}
lines.push('')
const content = lines.join('\n')

if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(out, 'utf8') } catch { /* missing → stale */ }
  if (current !== content) {
    console.error('docs/tools.md is stale: run `pnpm run docs`')
    process.exit(1)
  }
  console.log('docs ok: docs/tools.md is current')
} else {
  writeFileSync(out, content)
  console.log(`wrote docs/tools.md (${tools.length} tools)`)
}
