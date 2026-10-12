/**
 * The model-facing tool set. Each is a plain harness tool whose
 * implementation forwards to the session's private MCP connections
 * (servers.mjs) through the window registry (windows.mjs). Only these tools
 * exist; the servers' raw tools are never registered. Raw parameter names and
 * schemas: docs/server-tools.json.
 *
 * All window-bound tools take an optional `windowId` (windows.mjs: what an
 * omitted id means).
 */

import { environmentRemedy } from './environment.mjs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CHROME_FORMATS, chromeReadCall, unfence } from './chrome-read.mjs'
import { parseWait, runWait, WAIT_PARAM } from './waiting.mjs'
import { describeCollapsed, extractPage, FORMATS, planRead, renderStructure, SCOPES, STRUCTURE_SCRIPT } from './page-read.mjs'
import { describeBlocks, imageOf, parseJsonText, savedFileOf, textOf } from './servers.mjs'
import { cropBox, cropImage, imageSize, measureScript, parseMeasurement, readPng, rectMoved } from './safari-screenshot.mjs'
import { canonicalWatchUrl, EXTRACT_SCRIPT, renderNotes, shapeNotes } from './youtube-notes.mjs'

const WINDOW_ID = (browser) => ({
  type: 'string',
  description: `Window id (${browser === 'safari' ? 's' : 'c'}:<session>:<window>) from ${browser}_open. Omit to use this session's only window (one is opened if none), or its most recently used window when several are open.`,
})

/** Chrome server failures that mean "this page is gone" (server reconnected, page closed underneath us) rather than a bad request. */
const STALE_CHROME_PAGE = /No page found|Page ids have changed|browser was restarted or reconnected|Target closed|Session closed|detached from target|Protocol error.*Target/i

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}
const objectOutput = (render) => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: render(value) }],
})

/** A one-line account of how a window was resolved, when it is worth telling the model. */
function resolutionNote(resolved) {
  if (resolved.reopened) return `Chrome had restarted; reopened ${resolved.id} at ${resolved.reopened.url} (page state was lost). `
  if (resolved.defaulted) return `(${resolved.defaulted.count} windows open; used ${resolved.id}, the most recently used — pass windowId for ${resolved.defaulted.others.join(' / ')}) `
  return ''
}

/**
 * Per-window notes (a window reopened or chosen by default, a parking NOTE),
 * set while a tool resolves its window and put in front of that window's next
 * result. One per plugin instance, shared by every agent's tool set.
 */
export function createNotes() {
  const pending = new Map()
  const take = (id) => {
    const note = pending.get(id) ?? ''
    pending.delete(id)
    return note
  }
  return {
    /** Record (or clear) the resolution note of a resolved window; returns it. */
    resolved(resolved) {
      const note = resolutionNote(resolved)
      if (note) pending.set(resolved.id, note); else pending.delete(resolved.id)
      return resolved
    },
    add(id, note) { pending.set(id, (pending.get(id) ?? '') + note) },
    take,
    /** Prefix a forwarded result with the window it ran in (always, so the model learns ids) and any note. */
    tagged: (id, opened, text) => `${opened ? `Opened ${id}. ` : ''}${take(id)}[${id}]\n${text}`,
  }
}

/**
 * @param {object} deps
 * @param {import('./windows.mjs').BrowserSessions} deps.sessions
 * @param {ReturnType<import('./reader-pool.mjs').createReaderPool> | undefined} deps.readerPool
 * @param {(exec: object, bytes: Uint8Array, name: string) => Promise<{ ref?: object, reason?: string }>} deps.admitImage
 * @param {WeakMap<object, object>} deps.inlineImages
 * @param {(browser: 'safari' | 'chrome') => void} deps.preflight
 * @param {{ maxChars: number, timeoutMs?: number }} deps.limits - page-read clamp and the per-MCP-call timeout (quoted in timeout failures).
 * @param {(conn: object, windowId: string, options: { opened: boolean }) => Promise<{ note: string }>} [deps.ensureRunning]
 *   the safari.hiddenWindows remedy (placement.mjs or foreground.mjs).
 * @param {ReturnType<typeof createNotes>} [deps.notes]
 * @param {string} [deps.scratch] - directory for scratch files (default: the system's temporary directory).
 * @param {object} fallbackAgent - the agent these tools are registered for (used when an execution carries no agent).
 * @returns {object[]} tool definitions
 */
export function createTools(deps, fallbackAgent) {
  const { sessions, readerPool, admitImage, inlineImages, preflight, limits, ensureRunning } = deps
  const notes = deps.notes ?? createNotes()
  const scratch = deps.scratch ?? tmpdir()
  const noteResolution = notes.resolved
  const takeNote = notes.take
  const tagged = notes.tagged
  const describeShot = (value) => describeCapture(value, takeNote(value.windowId))
  const tools = []
  /** Has Chrome served a window in this process? Distinguishes "cannot start" from "page went away". */
  let chromeEverOpened = false

  /** The calling agent: from the execution, else the agent these tools were registered for. */
  const agentOf = (exec) => exec.agent ?? fallbackAgent

  // ---------------------------------------------------------------- Safari

  /**
   * Resolve the Safari window a tool acts on. `raise` (default): apply the safari.hiddenWindows strategy
   * first — park a just-opened window, and un-cover a window whose page is hidden (rAF and animations
   * paused); off for tools that only read buffers or answer dialogs.
   */
  async function safari(exec, windowId, { raise = true } = {}) {
    preflight('safari')
    const resolved = noteResolution(await sessions.resolveSafari(agentOf(exec), windowId))
    if (raise) await raiseIfHidden(resolved.conn, resolved.id, resolved.opened)
    return resolved
  }
  /** safari.hiddenWindows strategy (placement.mjs / foreground.mjs); its failure note is queued for the window's next tagged result. */
  async function raiseIfHidden(conn, id, opened = false) {
    if (ensureRunning === undefined) return
    const { note } = await ensureRunning(conn, id, { opened })
    if (note) notes.add(id, note)
  }
  /** Run a JS function body in a Safari window and return its parsed value. */
  const safariEval = (conn, body) => conn.callText('evaluate_javascript', { expression: body }).then(parseJsonText)
  /**
   * Run an optional `wait` spec against a Safari window; returns the summary line (or '' when no wait).
   * A timeout is reported in the summary, never thrown: the main action still runs.
   */
  async function safariWait(conn, spec) {
    const wait = parseWait(spec)
    if (wait === undefined) return ''
    const outcome = await runWait(body => safariEval(conn, body), wait, { maxSliceMs: sliceMs() })
    return `${outcome.summary}. `
  }
  /** In-page polling slice: well under the MCP call timeout. */
  const sliceMs = () => Math.max(1000, Math.min(5000, Math.floor((limits.timeoutMs ?? 60_000) / 4)))
  /** Resolve a CSS selector to the centre of its element (viewport CSS px), scrolling it into view; for point-based Safari steps. */
  async function safariPointOf(conn, selector, scroll = true) {
    const value = await safariEval(conn, `const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { missing: true, count: document.querySelectorAll(${JSON.stringify(selector)}).length };
${scroll ? 'el.scrollIntoView({ block: "center", inline: "center" }); await new Promise(r => setTimeout(r, 150));' : ''}
const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };`)
    if (!value || value.missing) throw new Error(`no element matches selector ${JSON.stringify(selector)}`)
    if (value.width === 0 || value.height === 0) throw new Error(`selector ${JSON.stringify(selector)} matches an element with no size (hidden?)`)
    return { x: Math.round(value.x), y: Math.round(value.y) }
  }

  tools.push(defineTool({
    name: 'safari_open',
    description: 'Open a NEW Safari (Technology Preview) window private to this chat and return its windowId (s:<session>:<window>). Each window is an independent automation session (own tabs, cookies, JS state) in its own STP window, labeled with this chat in its banner; the user\'s regular Safari is never touched. Call again for additional independent windows. Optionally navigate to url immediately. Other safari_* tools auto-open a window when this session has none, so this is only needed for a second window or to get the id explicitly.',
    parameters: { url: { type: 'string', description: 'Optional URL to load in the new window.' } },
    output: objectOutput(value => `Opened Safari window ${value.windowId}${value.url ? ` at ${value.url}${value.title ? ` — "${value.title}"` : ''}` : ''}.`),
    async execute(args, exec) {
      preflight('safari')
      const window = await sessions.openSafari(agentOf(exec))
      await raiseIfHidden(window.conn, window.id, true)
      if (args.url === undefined || args.url === '') return { windowId: window.id }
      const nav = parseJsonText(await window.conn.callText('navigate_to_url', { url: args.url }))
      return { windowId: window.id, url: nav?.url ?? args.url, title: nav?.title }
    },
  }))

  tools.push(defineTool({
    name: 'safari_close',
    description: 'Close one Safari window of this chat (windowId) or all of them (omit). Frees the STP window and its process.',
    parameters: { windowId: WINDOW_ID('safari') },
    output: textOutput,
    async execute(args, exec) {
      const closed = await sessions.closeSafari(agentOf(exec), args.windowId)
      return closed.length === 0 ? 'No Safari window was open.' : `Closed ${closed.join(', ')}.`
    },
  }))

  tools.push(defineTool({
    name: 'safari_navigate',
    description: 'Load a URL in this chat\'s Safari window and wait for the navigation to finish. Returns the loaded page\'s title and URL; read the page with safari_get_page_content. Optionally `wait` for the page to be ready and run `then` (a JS function body) in the loaded page, all in this one call.',
    parameters: {
      url: { type: 'string', required: true, description: 'URL to load.' },
      wait: WAIT_PARAM,
      then: { type: 'string', description: 'JS function body to run after the navigation (and wait); `return` a value to get it back.' },
      windowId: WINDOW_ID('safari'),
    },
    output: objectOutput(value => `${takeNote(value.windowId)}[${value.windowId}] Loaded ${value.url}${value.title ? ` — "${value.title}"` : ''}.${value.waited ? ` ${value.waited}` : ''}${value.then !== undefined ? `\nthen → ${typeof value.then === 'string' ? value.then : JSON.stringify(value.then)}` : ''}`),
    async execute(args, exec) {
      const { id, conn } = await safari(exec, args.windowId)
      const nav = parseJsonText(await conn.callText('navigate_to_url', { url: args.url }))
      const waited = (await safariWait(conn, args.wait)).trim()
      const out = { windowId: id, url: nav?.url ?? args.url, title: nav?.title, ...(waited ? { waited } : {}) }
      if (args.then) out.then = await safariEval(conn, args.then) ?? null
      return out
    },
  }))

  /** Parameters shared by safari_get_page_content and safari_get_page_structure. */
  const readTarget = {
    url: { type: 'string', description: 'URL to read. Without windowId this uses an isolated reader.' },
    windowId: { type: 'string', description: 'Read this chat\'s Safari window (s:<session>:<window>) instead of an isolated reader. Omit windowId AND url to read this session\'s single open window.' },
    waitMs: { type: 'number', description: 'Extra wait after load before extracting, for lazily rendered pages (default 0).' },
  }

  /** Resolve the read target (isolated reader vs. window) and run one read plan against it. */
  async function readPage(exec, args, request) {
    preflight('safari')
    const isolated = args.windowId === undefined && args.url !== undefined && args.url !== ''
    if (isolated) {
      if (readerPool === undefined) throw new Error('isolated reads are disabled (safari.reader.enabled=false); pass windowId to read a window')
      const result = await readerPool.read({ ...request(true), url: args.url, waitMs: args.waitMs ?? 0 })
      return { ...result, mode: 'isolated' }
    }
    const { id, conn, opened } = await safari(exec, args.windowId)
    if (args.url !== undefined && args.url !== '') await conn.callText('navigate_to_url', { url: args.url })
    if ((args.waitMs ?? 0) > 0) await new Promise(resolve => setTimeout(resolve, args.waitMs))
    const result = await extractPage((name, callArgs) => conn.callText(name, callArgs), request(false), false)
    return { ...result, mode: 'window', windowId: id, opened }
  }

  tools.push(defineTool({
    name: 'safari_get_page_content',
    description: `Read a web page with Safari's engine and return its content. TWO MODES. (1) With url and no windowId: reads in an ISOLATED pooled reader window, never this chat's own window, so a page you are working on is not disturbed — the default for "read this URL" (use instead of web_fetch for JavaScript-rendered pages or when web_fetch returns nothing). (2) With windowId, or with no url: reads the current page of this chat's Safari window (url, if also given, is loaded there first); node UIDs in the result can be used with safari_interact. Formats: ${FORMATS.join(' | ')}, default markdown — the plugin's own DOM serializer (headings, code fences, inline code, tables, nested lists; identical in Safari and Chrome); webkitMarkdown and the rest are WebKit's own extraction. WebKit extracts only RENDERED text: closed <details>, collapsed accordions and unselected tab panels are omitted unless expand is on (default in isolated mode; the header reports what was expanded, or what stayed collapsed). Narrow a read with section (one heading's section, e.g. "#troubleshooting"), selectors (CSS), or scope: "main"; safari_get_page_structure lists the available headings/selectors. prepare runs a JS function body BEFORE extraction (to reveal content); script runs AFTER and returns its value as scriptResult. For YouTube videos use safari_get_youtube_notes.`,
    parameters: {
      ...readTarget,
      format: { type: 'string', enum: FORMATS, description: 'Extraction format (default markdown = the plugin\'s serializer). webkitMarkdown is WebKit\'s markdown (no heading levels, no code fences); plainText is smallest; textTree/json carry roles, labels and node UIDs; html is the rendered DOM.' },
      expand: { type: 'boolean', description: 'Before extracting: open every <details>, click aria-expanded="false" accordions (outside nav/header/footer, never menus), and click through each tab group, appending the other panels\' text under "Hidden tab panels". Default true for isolated reads, false for windows (it changes the page state).' },
      section: { type: 'string', description: 'CSS selector of ONE heading (e.g. "#troubleshooting" or "h2:nth-of-type(3)"); returns that heading through the next heading of the same or a higher level. Get selectors from safari_get_page_structure.' },
      selectors: { type: 'array', items: { type: 'string' }, description: 'CSS selectors; only the matching subtrees are extracted. Isolated pages are edited in place, windows are hidden-and-restored. Not combinable with section.' },
      scope: { type: 'string', enum: SCOPES, description: '"main": extract only the main landmark (main / [role=main] / article / #content); "page": everything; "auto" (isolated default): main when it holds >= 60% of the text, else page. Window default: page. Ignored when section/selectors are given.' },
      markHeadings: { type: 'boolean', description: 'For webkitMarkdown only: prefix headings with "## " so WebKit\'s output carries heading levels. Isolated only; default true for webkitMarkdown. (markdown has native headings.)' },
      clean: { type: 'boolean', description: 'Strip empty images/links and blank runs from markdown output (default true for markdown / webkitMarkdown).' },
      maxWordsPerParagraph: { type: 'number', description: 'Truncate every paragraph — code blocks included — beyond this many words (default 2000 = effectively none). Values below ~50 are for skimming structure only.' },
      includeURLs: { type: 'boolean', description: 'Include link/image URLs (default true).' },
      nodeIds: { type: 'string', enum: ['none', 'editable', 'interactive', 'allContainers'], description: 'Which nodes get UIDs for safari_interact (window mode; default interactive).' },
      prepare: { type: 'string', description: 'JS function body run in the page BEFORE expand/scope/extraction (e.g. dismiss a cookie banner, click "show more"); use `return` to get a value back as prepareResult.' },
      script: { type: 'string', description: 'JS function body run in the page AFTER extraction; use `return`. Returned as scriptResult.' },
    },
    output: objectOutput(renderRead),
    async execute(args, exec) {
      const result = await readPage(exec, args, isolated => planRead(args, isolated))
      return clamp(result, limits.maxChars, scratch)
    },
  }))

  tools.push(defineTool({
    name: 'safari_get_page_structure',
    description: 'Outline of a web page without its text: title, text size, main-content landmark, all landmarks (header/nav/main/aside/footer/forms) and every heading with its level and a CSS selector, plus what is collapsed (closed <details>, aria-expanded="false" buttons, tab groups and their tabs). ~1–2 kB. Use it to pick a section or selectors for safari_get_page_content instead of reading a long page whole. Same two modes as safari_get_page_content (url → isolated reader; windowId → this chat\'s window).',
    parameters: readTarget,
    output: objectOutput(renderStructure),
    async execute(args, exec) {
      const result = await readPage(exec, args, () => ({ ...planRead({ format: 'plainText', expand: false, scope: 'page', markHeadings: false, clean: false }, true), skipContent: true, script: STRUCTURE_SCRIPT }))
      const { scriptResult, content: _c, notes: _n, ...rest } = result
      if (scriptResult === undefined || typeof scriptResult !== 'object') throw new Error('page structure script returned no data')
      return { ...rest, structure: scriptResult }
    },
  }))

  tools.push(defineTool({
    name: 'safari_evaluate_expression',
    description: 'Run JavaScript statements in this chat\'s Safari window. `expression` is a FUNCTION BODY: use an explicit `return` for a value (await is allowed). `$uid(N)` references a node UID from safari_get_page_content. Returns the JSON-encoded result. Use `wait` to wait for text / a selector / a condition (or settle N ms) BEFORE evaluating instead of sleeping inside the expression. (safari_evaluate_function takes a function + args instead.)',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript function body; `return` the value you want.' },
      wait: WAIT_PARAM,
      windowId: WINDOW_ID('safari'),
      frameId: { type: 'string', description: 'Node UID of an iframe (or a node inside one) to run in that subframe.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      const waited = await safariWait(conn, args.wait)
      return tagged(id, opened, waited + await conn.callText('evaluate_javascript', { expression: args.expression, ...(args.frameId ? { frameId: args.frameId } : {}) }))
    },
  }))

  tools.push(defineTool({
    name: 'safari_evaluate_function',
    description: 'Call a JavaScript FUNCTION in this chat\'s Safari window, e.g. `() => document.title` or `(el) => el.innerText` with args naming node UIDs from safari_get_page_content (each resolves to that element). Async functions are awaited. Returns the JSON-encoded result.',
    parameters: {
      function: { type: 'string', required: true, description: 'A function expression (arrow or function), called with args.' },
      args: { type: 'array', description: 'Node UIDs (strings) passed as element arguments, in order.', items: { type: 'string' } },
      windowId: WINDOW_ID('safari'),
      frameId: { type: 'string', description: 'Node UID of an iframe to run in that subframe.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      const refs = (args.args ?? []).map(uid => `$uid(${/^\d+$/.test(uid) ? uid : JSON.stringify(uid)})`)
      const expression = `return await (${args.function})(${refs.join(', ')});`
      return tagged(id, opened, await conn.callText('evaluate_javascript', { expression, ...(args.frameId ? { frameId: args.frameId } : {}) }))
    },
  }))

  tools.push(defineTool({
    name: 'safari_interact',
    description: 'Perform DOM interactions in this chat\'s Safari window, in sequence (400 ms settle between each): click, type, keyPress, scroll, selectText, selectMenuItem, hover, highlightText. Target by node UID (from safari_get_page_content), by find-in-page text, or by viewport point. Batch related steps in ONE call. Returns a diff of the page text (or the full loaded page if a click navigated).',
    parameters: {
      interactions: {
        type: 'array', required: true, description: 'Steps, executed in order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', required: true, enum: ['click', 'type', 'keyPress', 'scroll', 'selectText', 'selectMenuItem', 'hover', 'highlightText'], description: 'Interaction kind.' },
            purpose: { type: 'string', required: true, description: 'Short description of the intended outcome.' },
            node: { type: 'string', description: 'Node UID. Omit to target by `text` (find-in-page).' },
            text: { type: 'string', description: 'Find-in-page query, scroll search term, or menu item label.' },
            value: { type: 'string', description: 'For type: text to type; for keyPress: key name.' },
            pressReturn: { type: 'boolean', description: 'For type: press Return afterwards (default false).' },
            replaceAll: { type: 'boolean', description: 'For type: replace existing field text (default false).' },
            scrollToVisible: { type: 'boolean', description: 'Scroll the target into view first (default false).' },
            point: { type: 'object', additionalProperties: false, description: 'Viewport coordinates, last resort.', properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } } },
            scrollDelta: { type: 'object', additionalProperties: false, description: 'For scroll: pixel delta.', properties: { x: { type: 'number' }, y: { type: 'number' } } },
          },
        },
      },
      fullText: { type: 'boolean', description: 'Return the full page text instead of a diff (default false).' },
      windowId: WINDOW_ID('safari'),
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      return tagged(id, opened, await conn.callText('page_interactions', { interactions: args.interactions, ...(args.fullText ? { fullText: true } : {}) }))
    },
  }))

  /** One page_interactions step from the simple-tool arguments (a `selector` is resolved to a point by the caller). */
  function step(type, purpose, args, extra = {}) {
    if (!args.node && !args.text && !args.point && !args.selector) throw new Error(`${purpose}: give node (UID from safari_get_page_content), selector (CSS), text (find-in-page), or point`)
    return {
      type, purpose,
      ...(args.node ? { node: args.node } : {}),
      ...(args.text ? { text: args.text } : {}),
      ...(args.point ? { point: args.point } : {}),
      ...(args.scrollToVisible !== undefined ? { scrollToVisible: args.scrollToVisible } : { scrollToVisible: true }),
      ...extra,
    }
  }
  const TARGET = {
    node: { type: 'string', description: 'Node UID from safari_get_page_content (preferred).' },
    selector: { type: 'string', description: 'CSS selector of the element (document.querySelector); resolved to its centre point after scrolling it into view.' },
    text: { type: 'string', description: 'Find-in-page text identifying the element when no node is known.' },
    point: { type: 'object', additionalProperties: false, description: 'Viewport coordinates, last resort.', properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } } },
    scrollToVisible: { type: 'boolean', description: 'Scroll the target into view first (default true).' },
  }
  async function interactOnce(exec, args, interaction) {
    const { id, conn, opened } = await safari(exec, args.windowId)
    if (interaction.selector !== undefined) {
      const { selector, ...rest } = interaction
      interaction = { ...rest, point: await safariPointOf(conn, selector, interaction.scrollToVisible !== false) }
    }
    return tagged(id, opened, await conn.callText('page_interactions', { interactions: [interaction] }))
  }

  tools.push(defineTool({
    name: 'safari_click',
    description: 'Click an element in this chat\'s Safari window (by node UID, CSS selector, find-in-page text, or point). Waits for a triggered navigation. Returns the page diff. For several steps use safari_interact.',
    parameters: { ...TARGET, windowId: WINDOW_ID('safari') },
    output: textOutput,
    async execute(args, exec) { return interactOnce(exec, args, step('click', 'click', args, args.selector ? { selector: args.selector } : {})) },
  }))

  tools.push(defineTool({
    name: 'safari_hover',
    description: 'Hover an element in this chat\'s Safari window (by node UID, CSS selector, text, or point). Returns the page diff.',
    parameters: { ...TARGET, windowId: WINDOW_ID('safari') },
    output: textOutput,
    async execute(args, exec) { return interactOnce(exec, args, step('hover', 'hover', args, args.selector ? { selector: args.selector } : {})) },
  }))

  tools.push(defineTool({
    name: 'safari_press_key',
    description: 'Press a key in this chat\'s Safari window (e.g. "Enter", "Escape", "Tab", "ArrowDown"), optionally on a target element. Returns the page diff.',
    parameters: { key: { type: 'string', required: true, description: 'Key name.' }, ...TARGET, windowId: WINDOW_ID('safari') },
    output: textOutput,
    async execute(args, exec) {
      const interaction = { type: 'keyPress', purpose: `press ${args.key}`, value: args.key, ...(args.node ? { node: args.node } : {}), ...(args.text ? { text: args.text } : {}), ...(args.point ? { point: args.point } : {}) }
      return interactOnce(exec, args, interaction)
    },
  }))

  tools.push(defineTool({
    name: 'safari_type_text',
    description: 'Type text into a field in this chat\'s Safari window (target by node UID, CSS selector or find-in-page text), optionally replacing existing text and/or pressing Return to submit. Returns the page diff.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to type.' },
      node: TARGET.node,
      selector: TARGET.selector,
      target: { type: 'string', description: 'Find-in-page text identifying the field when no node is known.' },
      replaceAll: { type: 'boolean', description: 'Replace existing field text (default false).' },
      pressReturn: { type: 'boolean', description: 'Press Return after typing (default false).' },
      windowId: WINDOW_ID('safari'),
    },
    output: textOutput,
    async execute(args, exec) {
      const targetArgs = { node: args.node, text: args.target, selector: args.selector }
      const interaction = step('type', 'type text', targetArgs, { value: args.text, ...(args.replaceAll ? { replaceAll: true } : {}), ...(args.pressReturn ? { pressReturn: true } : {}), ...(args.selector ? { selector: args.selector } : {}) })
      return interactOnce(exec, args, interaction)
    },
  }))

  tools.push(defineTool({
    name: 'safari_wait_for',
    description: 'Wait until a condition holds in this chat\'s Safari page: any of `text` appears, `selector` matches, or `expression` (JS function body) returns truthy — whichever comes first — then optionally settle. Polled from the host, so long waits are safe. Returns what matched (and an expression\'s value) or a timeout notice.',
    parameters: {
      ...WAIT_PARAM.properties,
      windowId: WINDOW_ID('safari'),
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      const wait = parseWait({ text: args.text, selector: args.selector, expression: args.expression, settleMs: args.settleMs, timeout: args.timeout })
      if (wait === undefined) throw new Error('safari_wait_for: give text, selector, expression, or settleMs')
      const outcome = await runWait(body => safariEval(conn, body), wait, { maxSliceMs: sliceMs() })
      return tagged(id, opened, `${outcome.summary}.${outcome.found?.kind === 'expression' ? `\n${JSON.stringify(outcome.found.value)}` : ''}`)
    },
  }))

  tools.push(defineTool({
    name: 'safari_console_messages',
    description: 'Console messages (log/info/warn/error) buffered for this chat\'s Safari window (needs a loaded page). The buffer is kept unless clear is true.',
    parameters: {
      windowId: WINDOW_ID('safari'),
      limit: { type: 'number', description: 'Maximum number of messages (default 100, max 500).' },
      clear: { type: 'boolean', description: 'Clear the buffer after reading (default false).' },
      level_filter: { type: 'array', description: 'Only these levels.', items: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] } },
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId, { raise: false })
      const { windowId: _w, ...rest } = args
      return tagged(id, opened, await conn.callText('browser_console_messages', { clear: false, ...rest }))
    },
  }))

  tools.push(defineTool({
    name: 'safari_network_requests',
    description: 'Network requests recorded in this chat\'s Safari window (method, URL, status, timing, request_id for safari_get_network_request). Recording starts with the FIRST call: call it once, then navigate or reload, then call again. Needs a loaded page.',
    parameters: {
      windowId: WINDOW_ID('safari'),
      clear: { type: 'boolean', description: 'Clear the recorded list after reading.' },
      since: { type: 'string', description: 'Only requests after this ISO timestamp.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId, { raise: false })
      const { windowId: _w, ...rest } = args
      return tagged(id, opened, await conn.callText('list_network_requests', rest))
    },
  }))

  tools.push(defineTool({
    name: 'safari_get_network_request',
    description: 'Full detail of one network request recorded in this chat\'s Safari window (headers, text body within the size cap, timing), by the request id from safari_network_requests.',
    parameters: { request_id: { type: 'string', required: true, description: 'Request id from safari_network_requests.' }, windowId: WINDOW_ID('safari') },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId, { raise: false })
      return tagged(id, opened, await conn.callText('get_network_request', { request_id: args.request_id }))
    },
  }))

  tools.push(defineTool({
    name: 'safari_handle_dialog',
    description: 'List or answer a JavaScript dialog (alert/confirm/prompt) in this chat\'s Safari window. An open dialog blocks every other tool until it is answered.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'accept', 'dismiss'], description: 'list = report open dialogs; accept = OK (with text for prompts); dismiss = Cancel.' },
      text: { type: 'string', description: 'Text to enter for a prompt dialog when accepting.' },
      windowId: WINDOW_ID('safari'),
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId, { raise: false })
      const action = args.action === 'accept' ? 'respond' : args.action
      return tagged(id, opened, await conn.callText('browser_dialogs', { action, ...(args.text !== undefined ? { inputText: args.text } : {}) }))
    },
  }))

  tools.push(defineTool({
    name: 'safari_set_viewport_size',
    description: 'Resize this chat\'s Safari window viewport (CSS pixels).',
    parameters: {
      width: { type: 'number', required: true, description: 'Viewport width in CSS px.' },
      height: { type: 'number', required: true, description: 'Viewport height in CSS px.' },
      windowId: WINDOW_ID('safari'),
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      return tagged(id, opened, await conn.callText('set_viewport_size', { width: args.width, height: args.height }))
    },
  }))

  // Screenshots (element-aware; see safari-screenshot.mjs).
  async function captureSafari(exec, args) {
    const { id, conn, opened } = await safari(exec, args.windowId)
    const waited = (await safariWait(conn, args.wait)).trim()
    const withWait = (value) => waited ? { ...value, notes: [...(value.notes ?? []), waited] } : value
    const viewportPath = join(scratch, `deepsea-browser-safari-shot-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.png`)
    const target = args.querySelector ? `element ${JSON.stringify(args.querySelector)}` : args.fullPage === true ? 'full page' : 'viewport'
    // Apple's `screenshot` answers with text only and writes the PNG to savePath; a success reply with no
    // file (seen when the window is mid-navigation or has no page) would otherwise surface as sharp's
    // opaque "Input file is missing".
    const shot = async () => {
      const reply = await conn.callText('screenshot', { savePath: viewportPath, ...(args.querySelector ? {} : { full_page: args.fullPage === true }) })
      const written = await stat(viewportPath).catch(() => undefined)
      if (written === undefined || written.size === 0) {
        throw new Error(`safari screenshot of ${target} in ${id}: safaridriver reported success but wrote ${written === undefined ? 'no file' : 'an empty file'} at ${viewportPath}. Its reply was: ${reply || '(empty)'}. Is a page loaded in this window (safari_navigate first)?`)
      }
      return written.size
    }
    try {
      if (args.querySelector === undefined || args.querySelector === '') {
        const byteLength = await shot()
        const size = await imageSize(viewportPath)
        return withWait({ windowId: id, opened, bytes: await readPng(viewportPath), width: size.width, height: size.height, fullPage: args.fullPage === true, byteLength })
      }
      const measure = async (scroll) => parseMeasurement(await conn.callText('evaluate_javascript', { expression: measureScript(args.querySelector, scroll) }))
      const before = await measure(args.scrollTo !== false)
      await shot()
      let after = await measure(false)
      let unstable = false
      if (rectMoved(before.rect, after.rect)) {
        await shot()
        const again = await measure(false)
        unstable = rectMoved(after.rect, again.rect)
        after = again
      }
      const size = await imageSize(viewportPath)
      const box = cropBox(after.rect, after.viewport, size)
      const bytes = await cropImage(viewportPath, box)
      return withWait({
        windowId: id, opened, bytes, width: box.width, height: box.height, querySelector: args.querySelector, byteLength: bytes.byteLength,
        rect: { x: Math.round(after.rect.x), y: Math.round(after.rect.y), width: Math.round(after.rect.width), height: Math.round(after.rect.height) },
        viewport: after.viewport, scale: Number(box.scale.toFixed(3)), clipped: box.clipped, settled: before.settled, unstable,
      })
    } finally {
      void rm(viewportPath, { force: true }).catch(() => {})
    }
  }

  const safariShotParams = {
    windowId: WINDOW_ID('safari'),
    wait: WAIT_PARAM,
    querySelector: { type: 'string', description: 'CSS selector of one element to capture (document.querySelector). Omit for the whole viewport.' },
    scrollTo: { type: 'boolean', description: 'With querySelector: scroll the element into view (centered) and wait for scrolling to settle first (default true).' },
    fullPage: { type: 'boolean', description: 'Without querySelector: capture the entire scrollable page instead of the viewport (default false).' },
  }

  tools.push(defineTool({
    name: 'safari_get_screenshot',
    description: 'Screenshot of this chat\'s Safari window, returned INLINE as an image. With querySelector, only that element: scrolled into view (scrollTo), settled, measured, captured, re-measured (re-captured once if it moved) and cropped at device-pixel precision. Without: the viewport, or the whole page with fullPage.',
    parameters: safariShotParams,
    output: objectOutput(describeShot),
    async execute(args, exec) {
      const { bytes, ...meta } = await captureSafari(exec, args)
      return inlineOrFile(exec, bytes, meta, 'safari')
    },
    finalizeContent: inlineFinalizer,
  }))

  tools.push(defineTool({
    name: 'safari_save_screenshot',
    description: 'Screenshot of this chat\'s Safari window written to a PNG file (same element capture options as safari_get_screenshot). Returns path and pixel size.',
    parameters: { path: { type: 'string', required: true, description: 'Destination .png path (absolute, or relative to the session workspace).' }, ...safariShotParams },
    output: objectOutput(value => `Saved ${value.path} (${describeShot(value)})`),
    async execute(args, exec) {
      const { bytes, ...meta } = await captureSafari(exec, args)
      const path = await writeShot(agentOf(exec), args.path, bytes)
      return { ...meta, path }
    },
  }))

  tools.push(defineTool({
    name: 'safari_get_youtube_notes',
    description: 'Show notes of a YouTube video: title, channel, duration, views, publish date, chapters (parsed from timestamps), links and the FULL description (which the rendered page never shows). Reads the watch page in an isolated Safari reader; this chat\'s windows are untouched. Accepts watch / youtu.be / shorts / embed URLs or a bare 11-character id.',
    parameters: { url: { type: 'string', required: true, description: 'YouTube video URL (any form) or video id.' } },
    output: objectOutput(renderNotes),
    async execute(args) {
      preflight('safari')
      if (readerPool === undefined) throw new Error('isolated reads are disabled (safari.reader.enabled=false)')
      const { url } = canonicalWatchUrl(args.url)
      const result = await readerPool.read({ ...planRead({ format: 'plainText', expand: false, scope: 'page', markHeadings: false, clean: false }, true), url, waitMs: 0, skipContent: true, script: EXTRACT_SCRIPT })
      return shapeNotes(result.scriptResult, url)
    },
  }))

  // ---------------------------------------------------------------- Chrome

  async function chrome(exec, windowId) {
    preflight('chrome')
    const resolved = noteResolution(await sessions.resolveChrome(agentOf(exec), windowId))
    chromeEverOpened = true
    return resolved
  }
  /**
   * Resolve a Chrome window and run `fn` on it; when the server says the page is gone (it reconnected,
   * the page was closed underneath us) the window is reopened at its last URL under the same id and
   * `fn` runs once more. The result carries the note via tagged()/describeShot().
   */
  async function withChrome(exec, windowId, fn) {
    const resolved = await chrome(exec, windowId)
    try {
      return await fn(resolved)
    } catch (error) {
      if (!STALE_CHROME_PAGE.test(String(error?.message ?? error))) throw error
      const recovered = await sessions.recoverChrome(agentOf(exec), resolved.id)
      if (recovered === undefined) throw error
      noteResolution(recovered)
      return fn(recovered)
    }
  }
  /** Run a JS function body in a Chrome page and return its parsed value. */
  async function chromeEval(conn, pageId, body) {
    const text = unfence(await conn.callText('evaluate_script', { function: `async () => { ${body}\n }`, pageId }))
    try { return JSON.parse(text) } catch { return text }
  }
  /** Run an optional `wait` spec against a Chrome page; returns the summary line (or '' when no wait). */
  async function chromeWait(conn, pageId, spec) {
    const wait = parseWait(spec)
    if (wait === undefined) return ''
    const outcome = await runWait(body => chromeEval(conn, pageId, body), wait, { maxSliceMs: sliceMs() })
    return `${outcome.summary}. `
  }
  /** Target of chrome_click / chrome_fill / chrome_hover: a snapshot uid, or a CSS selector / visible text found in the page. */
  const CHROME_TARGET = {
    uid: { type: 'string', description: 'Element uid from chrome_snapshot (preferred when you have a snapshot).' },
    selector: { type: 'string', description: 'CSS selector (document.querySelector; the first match is used) — no snapshot needed.' },
    text: { type: 'string', description: 'Visible text of the element (deepest visible element containing it) — no snapshot needed.' },
  }
  /** Forward one page-scoped Chrome tool with pageId injected (stale-page recovery included). */
  async function chromeCall(exec, args, rawName, mapArgs = (rest) => rest) {
    return withChrome(exec, args.windowId, async ({ id, pageId, conn, opened }) => {
      const { windowId: _w, wait: _wait, ...rest } = args
      return { id, opened, text: await conn.callText(rawName, { ...mapArgs(rest), pageId }) }
    })
  }
  const forwardChrome = (rawName, mapArgs) => async function execute(args, exec) {
    const { id, opened, text } = await chromeCall(exec, args, rawName, mapArgs)
    return tagged(id, opened, text)
  }

  tools.push(defineTool({
    name: 'chrome_open',
    description: 'Open a NEW Chrome page (window) private to this chat and return its windowId (c:<session>:<window>). All Chrome windows of this chat share one isolated Chrome instance (fresh temporary profile: no saved logins; cookies shared between this chat\'s windows). Other chrome_* tools auto-open a window when this session has none.',
    parameters: { url: { type: 'string', description: 'URL to load (default about:blank).' } },
    output: objectOutput(value => `Opened Chrome window ${value.windowId}${value.url ? ` at ${value.url}` : ''}.`),
    async execute(args, exec) {
      preflight('chrome')
      const page = await sessions.openChrome(agentOf(exec), args.url)
      return { windowId: page.id, url: args.url }
    },
  }))

  tools.push(defineTool({
    name: 'chrome_close',
    description: 'Close one Chrome window of this chat (windowId) or all of them (omit). Chrome itself quits when the chat\'s last window closes.',
    parameters: { windowId: WINDOW_ID('chrome') },
    output: textOutput,
    async execute(args, exec) {
      const closed = await sessions.closeChrome(agentOf(exec), args.windowId)
      return closed.length === 0 ? 'No Chrome window was open.' : `Closed ${closed.join(', ')}.`
    },
  }))

  tools.push(defineTool({
    name: 'chrome_navigate',
    description: 'Navigate this chat\'s Chrome window: load a url, or go back / forward / reload. Waits for the navigation to complete. Optionally `wait` for the page to be ready (text / selector / condition / settle) and run `then` (a JS function body) in the loaded page — the rebuild → reload → probe loop in one call.',
    parameters: {
      url: { type: 'string', description: 'URL to load (type url).' },
      type: { type: 'string', enum: ['url', 'back', 'forward', 'reload'], description: 'Navigation kind (default url).' },
      ignoreCache: { type: 'boolean', description: 'For reload: bypass the cache.' },
      timeout: { type: 'number', description: 'Milliseconds to wait for the navigation (0 = no timeout).' },
      wait: WAIT_PARAM,
      then: { type: 'string', description: 'JS function body to run after the navigation (and wait); `return` a value to get it back.' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    async execute(args, exec) {
      return withChrome(exec, args.windowId, async ({ id, pageId, conn, opened }) => {
        const { windowId: _w, wait, then, ...rest } = args
        const navArgs = { type: rest.url && !rest.type ? 'url' : rest.type, ...rest }
        let text = await conn.callText('navigate_page', { ...navArgs, pageId })
        if (navArgs.type === 'url' && rest.url) sessions.noteChromeUrl(agentOf(exec), id, rest.url)
        const waited = await chromeWait(conn, pageId, wait)
        if (waited) text += `\n${waited.trim()}`
        if (then) {
          const value = await chromeEval(conn, pageId, then)
          text += `\nthen → ${typeof value === 'string' ? value : JSON.stringify(value)}`
        }
        return tagged(id, opened, text)
      })
    },
  }))

  tools.push(defineTool({
    name: 'chrome_snapshot',
    description: 'Text snapshot of this chat\'s Chrome page from the accessibility tree, listing elements with their uid. Prefer this over screenshots for reading and for finding elements; use the uids with chrome_click / chrome_fill / chrome_hover / chrome_get_screenshot. Always take a fresh snapshot after the page changes.',
    parameters: { verbose: { type: 'boolean', description: 'Include all accessibility properties (default false).' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('take_snapshot'),
  }))

  /** Resolve the Chrome read target (temporary reader page vs. window) and run one read plan against it. */
  async function readChromePage(exec, args, request) {
    preflight('chrome')
    const isolated = args.windowId === undefined && args.url !== undefined && args.url !== ''
    const settle = async () => { if ((args.waitMs ?? 0) > 0) await new Promise(resolve => setTimeout(resolve, args.waitMs)) }
    if (isolated) {
      const result = await sessions.withChromeReaderPage(agentOf(exec), args.url, async ({ conn, pageId }) => {
        await settle()
        return extractPage(chromeReadCall((name, callArgs) => conn.callText(name, { ...callArgs, pageId })), request(true), true)
      })
      return { ...result, mode: 'isolated', browser: 'chrome' }
    }
    const { id, pageId, conn, opened } = await chrome(exec, args.windowId)
    if (args.url !== undefined && args.url !== '') await conn.callText('navigate_page', { type: 'url', url: args.url, pageId })
    await settle()
    const result = await extractPage(chromeReadCall((name, callArgs) => conn.callText(name, { ...callArgs, pageId })), request(false), false)
    return { ...result, mode: 'window', browser: 'chrome', windowId: id, opened }
  }
  /** Chrome has no WebKit extractor: headings are emitted by our own serializer, so the marker step is never needed. */
  const chromePlan = (args, isolated) => ({ ...planRead(args, isolated), markHeadings: false })

  const chromeReadTarget = {
    url: { type: 'string', description: 'URL to read. Without windowId this uses a temporary page of this chat\'s Chrome instance (opened and closed for the read; the chat\'s windows are untouched).' },
    windowId: { type: 'string', description: 'Read this chat\'s Chrome window (c:<session>:<window>) instead. Omit windowId AND url to read this session\'s single open window.' },
    waitMs: { type: 'number', description: 'Extra wait after load before extracting, for lazily rendered pages (default 0).' },
  }

  tools.push(defineTool({
    name: 'chrome_get_page_content',
    description: `Read a web page with Chrome and return its content as ${CHROME_FORMATS.join(' | ')} (default markdown; the plugin's own DOM serializer — chrome-devtools-mcp has no text extractor; chrome_snapshot gives the accessibility tree instead). TWO MODES like safari_get_page_content: url without windowId reads in a temporary page of this chat's Chrome instance; windowId, or no url, reads that window (url, if also given, is loaded there first). Only RENDERED text is extracted: closed <details>, collapsed accordions and unselected tab panels are omitted unless expand is on (default for url reads; the header reports what was expanded or what stayed collapsed). Narrow with section (one heading's section), selectors (CSS) or scope: "main"; chrome_get_page_structure lists headings/selectors. prepare runs BEFORE extraction, script AFTER (its value is scriptResult).`,
    parameters: {
      ...chromeReadTarget,
      format: { type: 'string', enum: CHROME_FORMATS, description: 'markdown (default; headings, lists, code fences, links, tables), plainText (innerText), html (rendered body innerHTML).' },
      expand: { type: 'boolean', description: 'Before extracting: open every <details>, click aria-expanded="false" accordions (outside nav/header/footer, never menus), click through each tab group and append the other panels\' text under "Hidden tab panels". Default true for url reads, false for windows.' },
      section: { type: 'string', description: 'CSS selector of ONE heading (e.g. "#troubleshooting"); returns that heading through the next heading of the same or a higher level. Get selectors from chrome_get_page_structure.' },
      selectors: { type: 'array', items: { type: 'string' }, description: 'CSS selectors; only the matching subtrees are extracted. Temporary pages are edited in place, windows are hidden-and-restored. Not combinable with section.' },
      scope: { type: 'string', enum: SCOPES, description: '"main": only the main landmark; "page": everything; "auto" (url-read default): main when it holds >= 60% of the text. Window default: page. Ignored when section/selectors are given.' },
      clean: { type: 'boolean', description: 'Strip empty images/links and blank runs from markdown (default true for markdown).' },
      maxWordsPerParagraph: { type: 'number', description: 'Truncate every paragraph beyond this many words (default 2000 = effectively none).' },
      includeURLs: { type: 'boolean', description: 'Include link/image URLs (default true).' },
      prepare: { type: 'string', description: 'JS function body run in the page BEFORE expand/scope/extraction; `return` a value to get it back as prepareResult.' },
      script: { type: 'string', description: 'JS function body run in the page AFTER extraction; `return` a value to get it back as scriptResult.' },
    },
    output: objectOutput(renderRead),
    async execute(args, exec) {
      const result = await readChromePage(exec, args, isolated => chromePlan(args, isolated))
      return clamp(result, limits.maxChars, scratch)
    },
  }))

  tools.push(defineTool({
    name: 'chrome_get_page_structure',
    description: 'Outline of a web page in Chrome without its text: title, text size, main-content landmark, all landmarks and every heading with its level and a CSS selector, plus what is collapsed (closed <details>, aria-expanded="false" buttons, tab groups). ~1–3 kB. Use it to pick a section or selectors for chrome_get_page_content. Same two modes as chrome_get_page_content (url → temporary page; windowId → this chat\'s window).',
    parameters: chromeReadTarget,
    output: objectOutput(renderStructure),
    async execute(args, exec) {
      const result = await readChromePage(exec, args, () => ({ ...chromePlan({ format: 'plainText', expand: false, scope: 'page', clean: false }, true), skipContent: true, script: STRUCTURE_SCRIPT }))
      const { scriptResult, content: _c, notes: _n, ...rest } = result
      if (scriptResult === undefined || typeof scriptResult !== 'object') throw new Error('page structure script returned no data')
      return { ...rest, structure: scriptResult }
    },
  }))

  const chromeShotParams = {
    windowId: WINDOW_ID('chrome'),
    wait: WAIT_PARAM,
    uid: { type: 'string', description: 'Element uid from chrome_snapshot to capture just that element.' },
    fullPage: { type: 'boolean', description: 'Capture the whole scrollable page (default false).' },
    format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format (default png).' },
    quality: { type: 'number', description: 'jpeg/webp quality 0–100.' },
  }
  /**
   * One Chrome capture. chrome-devtools-mcp's take_screenshot has two success shapes: an image block, or
   * for captures of 2 MB or more (a retina viewport of a colourful page easily gets there), a text-only
   * reply "Took a screenshot of …\nSaved screenshot to <temporary path>." with the
   * bytes on disk. Both are read here; every other shape is reported with the server's exact reply so
   * the caller can tell a bad request (stale uid, uid+fullPage) from a server-side change.
   */
  async function captureChrome(exec, args) {
    const wanted = args.uid !== undefined ? 'element' : args.fullPage === true ? 'fullPage' : 'viewport'
    const target = wanted === 'element' ? `element uid ${JSON.stringify(args.uid)}` : wanted === 'fullPage' ? 'full page' : 'viewport'
    if (wanted === 'element' && args.fullPage === true) throw new Error(`chrome screenshot: pass either uid (one element) or fullPage (whole page), not both (got uid ${JSON.stringify(args.uid)} and fullPage: true).`)
    return withChrome(exec, args.windowId, async ({ id, pageId, conn, opened }) => {
    const waited = (await chromeWait(conn, pageId, args.wait)).trim()
    const { windowId: _w, path: _p, wait: _wait, ...rest } = args
    const result = await conn.callRaw('take_screenshot', { ...rest, pageId })
    const reply = textOf(result)
    if (result.isError) throw new Error(`chrome screenshot of ${target} in ${id} failed. chrome-devtools-mcp said: ${reply || '(no message)'}`)
    const image = imageOf(result)
    let bytes, mediaType, source
    if (image !== undefined) {
      ({ data: bytes, mediaType } = image)
      source = 'inline'
    } else {
      const saved = savedFileOf(reply)
      if (saved === undefined) {
        throw new Error(`chrome screenshot of ${target} in ${id}: chrome-devtools-mcp returned neither an image block nor a "Saved screenshot to <path>" line, so there is nothing to show. Reply blocks: ${describeBlocks(result)}. Reply text: ${reply || '(empty)'}`)
      }
      try {
        bytes = new Uint8Array(await readFile(saved))
      } catch (error) {
        throw new Error(`chrome screenshot of ${target} in ${id}: chrome-devtools-mcp wrote the capture to ${saved} (it spills captures ≥ 2 MB to disk) but the file could not be read back: ${error.code ?? error.message}. Full reply: ${reply}`, { cause: error })
      }
      mediaType = mediaTypeOfPath(saved, args.format)
      source = 'file'
      void removeServerTempFile(saved)
    }
    if (bytes.byteLength === 0) throw new Error(`chrome screenshot of ${target} in ${id}: the server returned a 0-byte image (source: ${source}). Reply: ${reply || '(empty)'}`)
    const notes = waited ? [waited] : []
    // The server states what it captured; a mismatch with the request is the one thing worth flagging loudly.
    const captured = /screenshot of node with uid/i.test(reply) ? 'element' : /full current page/i.test(reply) ? 'fullPage' : /viewport/i.test(reply) ? 'viewport' : undefined
    if (captured !== undefined && captured !== wanted) notes.push(`requested ${target} but chrome-devtools-mcp reports it captured the ${captured === 'fullPage' ? 'full page' : captured}: "${reply.split('\n')[0]}"`)
    return {
      windowId: id, opened, bytes, mediaType, ...(args.uid !== undefined ? { uid: args.uid } : {}), fullPage: args.fullPage === true,
      byteLength: bytes.byteLength, format: mediaType.replace('image/', ''), source, ...(notes.length > 0 ? { notes } : {}),
    }
    })
  }

  /** Media type of a saved screenshot from its extension (falling back to the requested format). */
  function mediaTypeOfPath(path, format) {
    const ext = extname(path).toLowerCase()
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.webp') return 'image/webp'
    if (ext === '.png') return 'image/png'
    return format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
  }

  /** Best-effort removal of a chrome-devtools-mcp temp capture and its per-call mkdtemp directory. */
  async function removeServerTempFile(path) {
    try {
      await rm(path, { force: true })
      const dir = dirname(path)
      // getTempFilePath() = mkdtemp(<tmp>/chrome-devtools-mcp-XXXXXX)/<file>: one directory per capture.
      if (basename(dir).startsWith('chrome-devtools-mcp-')) await rm(dir, { recursive: true, force: true })
    } catch {
      // The file belongs to the server's temp dir; leaving it behind is harmless.
    }
  }

  tools.push(defineTool({
    name: 'chrome_get_screenshot',
    description: 'Screenshot of this chat\'s Chrome page, returned INLINE as an image: the viewport, the whole page (fullPage), or one element (uid from chrome_snapshot; uids expire when the page changes — re-snapshot first). Large captures are handled transparently; format: "jpeg" or a uid crop keeps them small.',
    parameters: chromeShotParams,
    output: objectOutput(describeShot),
    async execute(args, exec) {
      const { bytes, mediaType, ...meta } = await captureChrome(exec, args)
      return inlineOrFile(exec, bytes, meta, 'chrome', mediaType)
    },
    finalizeContent: inlineFinalizer,
  }))

  tools.push(defineTool({
    name: 'chrome_save_screenshot',
    description: 'Screenshot of this chat\'s Chrome page written to a file (viewport, fullPage, or element uid). Returns the path.',
    parameters: { path: { type: 'string', required: true, description: 'Destination path (absolute, or relative to the session workspace); extension should match format.' }, ...chromeShotParams },
    output: objectOutput(value => `Saved ${value.path} (${describeShot(value)})`),
    async execute(args, exec) {
      const { bytes, mediaType: _m, ...meta } = await captureChrome(exec, args)
      const path = await writeShot(agentOf(exec), args.path, bytes)
      return { ...meta, path }
    },
  }))

  tools.push(defineTool({
    name: 'chrome_evaluate_function',
    description: 'Call a JavaScript FUNCTION in this chat\'s Chrome page, e.g. `() => document.title` or `(el) => el.innerText` with args naming snapshot uids (each resolves to that element). Async functions are awaited. The return value must be JSON-serializable.',
    parameters: {
      function: { type: 'string', required: true, description: 'A function expression (arrow or function), called with args.' },
      args: { type: 'array', description: 'Snapshot uids (strings) passed as element arguments, in order.', items: { type: 'string' } },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    execute: forwardChrome('evaluate_script'),
  }))

  tools.push(defineTool({
    name: 'chrome_evaluate_expression',
    description: 'Run JavaScript statements in this chat\'s Chrome page. `expression` is a FUNCTION BODY: use an explicit `return` for a value (await is allowed). Returns the JSON-encoded result. Use `wait` to wait for text / a selector / a condition (or settle N ms) BEFORE evaluating instead of `await new Promise(r => setTimeout(r, N))` inside the expression (in-page sleeps over ~10 s time out). (chrome_evaluate_function takes a function + uid args instead.)',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript function body; `return` the value you want.' },
      wait: WAIT_PARAM,
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    async execute(args, exec) {
      return withChrome(exec, args.windowId, async ({ id, pageId, conn, opened }) => {
        const waited = await chromeWait(conn, pageId, args.wait)
        return tagged(id, opened, waited + await conn.callText('evaluate_script', { function: `async () => { ${args.expression}\n }`, pageId }))
      })
    },
  }))

  tools.push(defineTool({
    name: 'chrome_click',
    description: 'Click an element in this chat\'s Chrome page: by uid (from chrome_snapshot; a real input event via the devtools protocol), or without a snapshot by CSS `selector` or visible `text` (scrolled into view, then element.click() in the page).',
    parameters: { ...CHROME_TARGET, dblClick: { type: 'boolean', description: 'Double-click (uid targets only).' }, includeSnapshot: { type: 'boolean', description: 'Return a fresh snapshot afterwards.' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    async execute(args, exec) {
      if (args.uid) return forwardChrome('click')(args, exec)
      return chromeDomAction(exec, args, 'click', 'el.scrollIntoView({ block: "center", inline: "center" }); el.click(); return { clicked: describe(el) };')
    },
  }))

  tools.push(defineTool({
    name: 'chrome_fill',
    description: 'Type into an input / textarea / contenteditable or choose a select option: by uid (from chrome_snapshot), or without a snapshot by CSS `selector` or visible `text` (value set in the page with input/change events).',
    parameters: { ...CHROME_TARGET, value: { type: 'string', required: true, description: 'Value to fill.' }, includeSnapshot: { type: 'boolean' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    async execute(args, exec) {
      if (args.uid) return forwardChrome('fill')(args, exec)
      const value = JSON.stringify(args.value)
      return chromeDomAction(exec, args, 'fill', `el.scrollIntoView({ block: "center", inline: "center" }); el.focus && el.focus();
        if (el.tagName === 'SELECT') { const opt = [...el.options].find(o => o.value === ${value} || o.textContent.trim() === ${value}); if (!opt) throw new Error('no option ' + ${value}); el.value = opt.value; }
        else if (el.isContentEditable) { el.textContent = ${value}; }
        else { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; if (setter) setter.call(el, ${value}); else el.value = ${value}; }
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        return { filled: describe(el), value: el.tagName === 'SELECT' ? el.value : (el.isContentEditable ? el.textContent : el.value) };`)
    },
  }))

  tools.push(defineTool({
    name: 'chrome_fill_form',
    description: 'Fill several form fields at once (uids from chrome_snapshot).',
    parameters: {
      elements: { type: 'array', required: true, description: 'Fields to fill.', items: { type: 'object', additionalProperties: false, properties: { uid: { type: 'string', required: true }, value: { type: 'string', required: true, description: '"true"/"false" for checkboxes and toggles.' } } } },
      includeSnapshot: { type: 'boolean' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    execute: forwardChrome('fill_form'),
  }))

  tools.push(defineTool({
    name: 'chrome_hover',
    description: 'Hover an element: by uid (from chrome_snapshot; a real pointer move), or without a snapshot by CSS `selector` or visible `text` (synthetic mouseover/mouseenter events in the page — CSS :hover styles do not react to those).',
    parameters: { ...CHROME_TARGET, includeSnapshot: { type: 'boolean' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    async execute(args, exec) {
      if (args.uid) return forwardChrome('hover')(args, exec)
      return chromeDomAction(exec, args, 'hover', 'el.scrollIntoView({ block: "center", inline: "center" }); el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); el.dispatchEvent(new MouseEvent("mouseenter")); return { hovered: describe(el) };')
    },
  }))

  tools.push(defineTool({
    name: 'chrome_press_key',
    description: 'Press a key or combination in this chat\'s Chrome page, e.g. "Enter", "Escape", "Control+a".',
    parameters: { key: { type: 'string', required: true, description: 'Key or combination.' }, includeSnapshot: { type: 'boolean' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('press_key'),
  }))

  tools.push(defineTool({
    name: 'chrome_type_text',
    description: 'Type text at the current focus in this chat\'s Chrome page (focus an element first with chrome_click), optionally followed by a key such as Enter.',
    parameters: { text: { type: 'string', required: true }, submitKey: { type: 'string', description: 'Key to press after typing, e.g. Enter.' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('type_text'),
  }))

  tools.push(defineTool({
    name: 'chrome_wait_for',
    description: 'Wait until a condition holds in this chat\'s Chrome page: any of `text` appears, `selector` matches, or `expression` (JS function body) returns truthy — whichever comes first — then optionally settle. Polled from the host, so long waits are safe. Returns what matched (and an expression\'s value) or a timeout notice.',
    parameters: {
      ...WAIT_PARAM.properties,
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    async execute(args, exec) {
      const wait = parseWait({ text: args.text, selector: args.selector, expression: args.expression, settleMs: args.settleMs, timeout: args.timeout })
      if (wait === undefined) throw new Error('chrome_wait_for: give text, selector, expression, or settleMs')
      return withChrome(exec, args.windowId, async ({ id, pageId, conn, opened }) => {
        const outcome = await runWait(body => chromeEval(conn, pageId, body), wait, { maxSliceMs: sliceMs() })
        return tagged(id, opened, `${outcome.summary}.${outcome.found?.kind === 'expression' ? `\n${JSON.stringify(outcome.found.value)}` : ''}`)
      })
    },
  }))

  /** JS (inlined text) that returns the deepest visible element whose text contains `needle`. */
  const FIND_BY_TEXT = (needle) => `(() => { const needle = ${JSON.stringify(needle)}; let best = null; const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT); while (walk.nextNode()) { const el = walk.currentNode; if (!(el.innerText || '').includes(needle)) continue; const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue; best = el; } return best; })()`

  /**
   * Perform a DOM action on an element found by CSS selector or visible text (no snapshot needed).
   * `action` is JS that sees `el` and `describe(el)` and returns a JSON-serialisable summary.
   */
  async function chromeDomAction(exec, args, verb, action) {
    if (!args.selector && !args.text) throw new Error(`chrome_${verb}: give uid (from chrome_snapshot), selector (CSS), or text (visible text)`)
    return withChrome(exec, args.windowId, async ({ id, pageId, conn, opened }) => {
      const finder = args.selector
        ? `const els = document.querySelectorAll(${JSON.stringify(args.selector)}); if (els.length === 0) throw new Error('no element matches selector ' + JSON.stringify(${JSON.stringify(args.selector)})); const el = els[0]; const ambiguous = els.length > 1 ? els.length : 0;`
        : `const el = ${FIND_BY_TEXT(args.text)}; if (!el) throw new Error('no visible element with text ' + JSON.stringify(${JSON.stringify(args.text)})); const ambiguous = 0;`
      const body = `${finder}
        const describe = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : '') + (e.innerText ? ' "' + e.innerText.trim().slice(0, 60) + '"' : '');
        const out = (() => { ${action} })();
        return ambiguous ? { ...out, note: 'selector matched ' + ambiguous + ' elements; acted on the first' } : out;`
      const value = await chromeEval(conn, pageId, body)
      let text = typeof value === 'string' ? value : JSON.stringify(value)
      if (args.includeSnapshot) text += `\n\n${await conn.callText('take_snapshot', { pageId })}`
      return tagged(id, opened, text)
    })
  }

  tools.push(defineTool({
    name: 'chrome_interact',
    description: 'Perform DOM interactions in this chat\'s Chrome page in sequence, mirroring safari_interact: click, type, keyPress, scroll, hover, selectMenuItem (selectText/highlightText and point targets are not supported in Chrome and are reported as failed steps). Target by snapshot uid (`node`) or by page text (`text`). Steps continue after a failed step; the result reports each step\'s outcome.',
    parameters: {
      interactions: {
        type: 'array', required: true, description: 'Steps, executed in order.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            type: { type: 'string', required: true, enum: ['click', 'type', 'keyPress', 'scroll', 'selectText', 'selectMenuItem', 'hover', 'highlightText'], description: 'Interaction kind.' },
            purpose: { type: 'string', required: true, description: 'Short description of the intended outcome.' },
            node: { type: 'string', description: 'Snapshot uid of the target.' },
            text: { type: 'string', description: 'Page text identifying the target (for selectMenuItem: the option label).' },
            value: { type: 'string', description: 'For type: text to type; for keyPress: key or combination.' },
            pressReturn: { type: 'boolean', description: 'For type: press Enter afterwards.' },
            replaceAll: { type: 'boolean', description: 'For type: replace the field\'s existing text (default: fill replaces when a uid is given).' },
            scrollToVisible: { type: 'boolean', description: 'Scroll the target into view first.' },
            scrollDelta: { type: 'object', additionalProperties: false, description: 'For scroll: pixel delta.', properties: { x: { type: 'number' }, y: { type: 'number' } } },
          },
        },
      },
      includeSnapshot: { type: 'boolean', description: 'Append a fresh snapshot after the batch (default false).' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, pageId, conn, opened } = await chrome(exec, args.windowId)
      const call = (name, a) => conn.callText(name, { ...a, pageId })
      const js = (fn) => call('evaluate_script', { function: fn })
      const byText = (needle, action) => js(`() => { const el = ${FIND_BY_TEXT(needle)}; if (!el) throw new Error('no element with text ' + ${JSON.stringify(needle)}); ${action} return 'ok'; }`)
      const report = []
      for (const [index, stepArgs] of args.interactions.entries()) {
        const label = `#${index + 1} ${stepArgs.type} (${stepArgs.purpose})`
        try {
          if (stepArgs.scrollToVisible && stepArgs.node) await call('evaluate_script', { function: '(el) => el.scrollIntoView({ block: "center", inline: "center" })', args: [stepArgs.node] })
          switch (stepArgs.type) {
            case 'click':
              if (stepArgs.node) await call('click', { uid: stepArgs.node })
              else if (stepArgs.text) await byText(stepArgs.text, 'el.scrollIntoView({ block: "center" }); el.click();')
              else throw new Error('click needs node or text')
              break
            case 'hover':
              if (stepArgs.node) await call('hover', { uid: stepArgs.node })
              else if (stepArgs.text) await byText(stepArgs.text, 'el.scrollIntoView({ block: "center" }); el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); el.dispatchEvent(new MouseEvent("mouseenter"));')
              else throw new Error('hover needs node or text')
              break
            case 'type':
              if (stepArgs.value === undefined) throw new Error('type needs value')
              if (stepArgs.node) {
                await call('fill', { uid: stepArgs.node, value: stepArgs.value })
                if (stepArgs.pressReturn) await call('press_key', { key: 'Enter' })
              } else {
                if (stepArgs.text) await byText(stepArgs.text, 'el.scrollIntoView({ block: "center" }); el.click(); el.focus && el.focus();')
                if (stepArgs.replaceAll) await call('press_key', { key: 'Meta+a' })
                await call('type_text', { text: stepArgs.value, ...(stepArgs.pressReturn ? { submitKey: 'Enter' } : {}) })
              }
              break
            case 'keyPress':
              if (!stepArgs.value) throw new Error('keyPress needs value (key name)')
              if (stepArgs.node) await call('click', { uid: stepArgs.node })
              await call('press_key', { key: stepArgs.value })
              break
            case 'scroll':
              if (stepArgs.scrollDelta) await js(`() => { window.scrollBy(${Number(stepArgs.scrollDelta.x) || 0}, ${Number(stepArgs.scrollDelta.y) || 0}); return 'ok'; }`)
              else if (stepArgs.node) await call('evaluate_script', { function: '(el) => { el.scrollIntoView({ block: "center", inline: "center" }); return "ok"; }', args: [stepArgs.node] })
              else if (stepArgs.text) await byText(stepArgs.text, 'el.scrollIntoView({ block: "center" });')
              else throw new Error('scroll needs scrollDelta, node, or text')
              break
            case 'selectMenuItem':
              if (stepArgs.node && (stepArgs.text || stepArgs.value)) await call('fill', { uid: stepArgs.node, value: stepArgs.text ?? stepArgs.value })
              else throw new Error('selectMenuItem needs node (the <select>) and text (the option label)')
              break
            default:
              throw new Error(`${stepArgs.type} is not supported in Chrome`)
          }
          report.push(`${label} → ok`)
        } catch (error) {
          // Server-tool prefix ("hover: Error: …") kept for provenance; a matching remedy is appended so a
          // stale-uid failure tells the model to re-snapshot instead of retrying the same uid.
          report.push(`${label} → FAILED: ${withHint(String(error).replace(/^Error: /, '')).replace('\nHint: ', ' — Hint: ')}`)
        }
      }
      let text = report.join('\n')
      if (args.includeSnapshot) text += `\n\n${await call('take_snapshot', {})}`
      return tagged(id, opened, text)
    },
  }))

  tools.push(defineTool({
    name: 'chrome_console_messages',
    description: 'Console messages of this chat\'s Chrome page (paginated).',
    parameters: {
      types: { type: 'array', description: 'Only these message types.', items: { type: 'string', enum: ['log', 'debug', 'info', 'error', 'warn', 'dir', 'dirxml', 'table', 'trace', 'clear', 'startGroup', 'startGroupCollapsed', 'endGroup', 'assert', 'profile', 'profileEnd', 'count', 'timeEnd', 'issue'] } },
      pageSize: { type: 'number' }, pageIdx: { type: 'number' }, includeStackTraces: { type: 'boolean' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    execute: forwardChrome('list_console_messages'),
  }))

  tools.push(defineTool({
    name: 'chrome_network_requests',
    description: 'Network requests of this chat\'s Chrome page (paginated; filter by resource type).',
    parameters: {
      resourceTypes: { type: 'array', description: 'Only these resource types (e.g. document, xhr, fetch, script, image).', items: { type: 'string' } },
      pageSize: { type: 'number' }, pageIdx: { type: 'number' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    execute: forwardChrome('list_network_requests'),
  }))

  tools.push(defineTool({
    name: 'chrome_get_network_request',
    description: 'Full detail of one network request of this chat\'s Chrome page (headers, body, timing), by the reqid from chrome_network_requests.',
    parameters: { reqid: { type: 'number', required: true, description: 'Request id from chrome_network_requests.' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('get_network_request'),
  }))

  tools.push(defineTool({
    name: 'chrome_handle_dialog',
    description: 'Answer a JavaScript dialog (alert/confirm/prompt) open in this chat\'s Chrome page. An open dialog blocks every other tool until it is answered.',
    parameters: {
      action: { type: 'string', required: true, enum: ['accept', 'dismiss'], description: 'accept = OK (with text for prompts); dismiss = Cancel.' },
      text: { type: 'string', description: 'Text to enter for a prompt dialog when accepting.' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    execute: forwardChrome('handle_dialog', (rest) => ({ action: rest.action, ...(rest.text !== undefined ? { promptText: rest.text } : {}) })),
  }))

  tools.push(defineTool({
    name: 'chrome_set_viewport_size',
    description: 'Resize this chat\'s Chrome page to the given CSS pixel size.',
    parameters: { width: { type: 'number', required: true, description: 'Page width in CSS px.' }, height: { type: 'number', required: true, description: 'Page height in CSS px.' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('resize_page'),
  }))

  // The harness rejects tool output that is not lossless JSON ("value is not lossless JSON"), and an object
  // with an `undefined`-valued key is exactly that. Several results carry optional fields taken straight
  // from arguments or server answers (`uid: args.uid`, `title: nav?.title`), so they are stripped here
  // instead of at every site. (Tests call execute() directly, bypassing the harness's check.)
  //
  // The same wrapper turns every failure into a message the model can act on (explainFailure): the tool
  // and the server tool that failed, the browser server's own words, a reading of MCP-SDK timeouts, and a
  // remedy for the known failure shapes.
  for (const tool of tools) {
    const execute = tool.execute
    tool.execute = async (args, exec) => {
      try {
        return stripUndefined(await execute(args, exec))
      } catch (error) {
        const explained = explainFailure(tool.name, args, error, exec, limits.timeoutMs, { chromeEverOpened })
        // An environment failure leaves a browser instance behind whose process
        // read the environment at launch: `safaridriver --mcp` checks "Allow
        // Remote Automation" once, so after the user runs `safaridriver
        // --enable` the same process keeps refusing — for up to idleMinutes.
        // Drop the session's instances so the next call spawns fresh ones.
        if (explained !== error && /automation is unavailable on this machine/.test(explained.message)) {
          const agent = agentOf(exec)
          const browser = tool.name.startsWith('safari_') ? 'safari' : 'chrome'
          try {
            if (browser === 'safari') await sessions.closeSafari(agent, undefined, 'environment-failure')
            else await sessions.closeChrome(agent, undefined, 'environment-failure')
          } catch { /* best effort */ }
        }
        throw explained
      }
    }
  }
  return tools

  // ---------------------------------------------------------------- helpers

  async function inlineOrFile(exec, bytes, meta, browser, mediaType = 'image/png') {
    const admitted = await admitImage(exec, bytes, `${browser}-${Date.now()}.${mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'}`, mediaType)
    if (admitted.ref === undefined) {
      const fallbackPath = join(scratch, `deepsea-browser-${browser}-screenshot-${Date.now()}-${process.pid}.${mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'}`)
      await writeFile(fallbackPath, bytes)
      return { ...meta, fallbackPath, inlineUnavailable: admitted.reason }
    }
    inlineImages.set(exec, admitted.ref)
    return meta
  }

  function inlineFinalizer(exec, result) {
    const ref = inlineImages.get(exec)
    if (ref === undefined) return undefined
    inlineImages.delete(exec)
    if (result.isError) return undefined
    return [{ type: 'image', attachment: ref }, ...result.content]
  }

  async function writeShot(agent, requested, bytes) {
    const path = resolvePath(agent.session?.header?.cwd ?? process.cwd(), requested)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    return path
  }
}

/** Text summary of a capture; `note` is the window's pending note (createNotes). */
function describeCapture(value, note = '') {
  const parts = [`${note}[${value.windowId}]${value.opened ? ' (opened)' : ''}`]
  if (value.width !== undefined) parts.push(`${value.width}×${value.height} px`)
  if (value.querySelector !== undefined) {
    parts.push(`element ${JSON.stringify(value.querySelector)} at CSS rect x=${value.rect.x} y=${value.rect.y} ${value.rect.width}×${value.rect.height} (viewport ${value.viewport.width}×${value.viewport.height}, scale ${value.scale})`)
    if (value.clipped) parts.push('NOTE: element extends beyond the viewport; crop clipped to the visible part')
    if (value.unstable) parts.push('NOTE: element kept moving during capture; crop may be off')
    if (!value.settled) parts.push('NOTE: scrolling had not fully settled before capture')
  } else if (value.uid !== undefined) parts.push(`element uid ${value.uid}`)
  else if (value.fullPage) parts.push('full page')
  else parts.push('viewport')
  if (value.byteLength !== undefined) {
    const size = value.byteLength >= 1_000_000 ? `${(value.byteLength / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(value.byteLength / 1000))} kB`
    parts.push(`${size}${value.format !== undefined ? ` ${value.format}` : ' png'}${value.source === 'file' ? ' (≥ 2 MB: chrome-devtools-mcp wrote it to disk; read back by the plugin — format: "jpeg" or a uid crop gives a smaller capture)' : ''}`)
  }
  for (const note of value.notes ?? []) parts.push(`NOTE: ${note}`)
  if (value.fallbackPath !== undefined) parts.push(`saved to ${value.fallbackPath}; not shown inline: ${value.inlineUnavailable}. View it with read_image`)
  return parts.join('; ')
}

/**
 * Remedies for failure messages the browser servers (and this plugin) produce, matched against the
 * message text. Ordered: the first match wins. Sources: chrome-devtools-mcp's McpPage, McpContext and
 * ToolHandler, Apple's safaridriver --mcp replies, and safari-screenshot.mjs.
 */
const FAILURE_HINTS = [
  [/no longer exists on the page|Element uid .* not found on page|No snapshot found for page/i,
    'uids come from chrome_snapshot and stop resolving once the page re-renders or navigates; take a fresh chrome_snapshot and use a uid from it.'],
  [/Providing both "uid" and "fullPage"/i, 'pass either uid (one element) or fullPage (whole page), not both.'],
  [/A dialog is open/i, 'answer it with chrome_handle_dialog (accept / dismiss); every page tool is blocked until then.'],
  [/selected page has been closed|No page selected|No page found|Page (?:with id )?\S* ?not found|Target closed|Session closed|Connection closed|Protocol error/i,
    'the page or browser is gone; open a new window (chrome_open / safari_open, or omit windowId when this chat has none) and navigate again.'],
  [/did not become interactive within/i, 'the element exists but is not clickable (covered, disabled or off-screen); scroll it into view (chrome_interact scroll with node, or chrome_evaluate_function scrollIntoView), wait, then retry with a fresh uid.'],
  [/Execution context was destroyed|Cannot find context with specified id/i, 'the page navigated while the script ran; wait for the load (chrome_wait_for / safari_wait_for) and retry.'],
  [/Access denied: path/i, 'chrome-devtools-mcp only writes under its workspace roots and the temp dir; use chrome_save_screenshot, which writes the file itself.'],
  [/Could not find option with text/i, 'for <select> elements the value must be an option label exactly as shown; read them with chrome_snapshot (verbose) or evaluate_function.'],
  [/no element matches/i, 'check the selector against the live DOM: safari_get_page_structure lists heading/landmark selectors, or evaluate document.querySelectorAll(...).length with safari_evaluate_expression.'],
  [/element is outside the viewport/i, 'pass scrollTo: true (default) or enlarge the window with safari_set_viewport_size, then retake.'],
  [/does not declare image input/i, 'the current model cannot see images; the screenshot was saved to a file instead — switch to a vision-capable model or inspect it with read_image.'],
  [/Allow Remote Automation|Remote Automation/i, 'enable "Allow Remote Automation" for Safari Technology Preview: sudo "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver" --enable (or Develop ▸ Developer Settings in STP).'],
]

/** Append the first matching remedy from FAILURE_HINTS to a message (unchanged when none matches). */
export function withHint(message) {
  for (const [pattern, hint] of FAILURE_HINTS) if (pattern.test(message)) return `${message}\nHint: ${hint}`
  return message
}

/**
 * Rewrite an execute() failure into an actionable message: which tool failed and, when the
 * text starts with a `<server tool>: ` prefix from callText, which server tool produced it; MCP-SDK
 * timeouts explained in terms of the plugin's toolCallTimeoutMs; then a hint. Aborts (the user stopped
 * the turn) pass through untouched so the harness keeps recognising them.
 */
export function explainFailure(toolName, args, error, exec, timeoutMs, context = {}) {
  if (error?.name === 'AbortError' || exec?.signal?.aborted === true) return error
  let message = error instanceof Error ? error.message : String(error)
  // An environment problem (browser not installed, Safari's Remote Automation
  // switch off, Chrome unable to launch) is not something the model can fix by
  // retrying or opening another window: say so, and say what the user must do.
  const browser = toolName.startsWith('safari_') ? 'safari' : 'chrome'
  const remedy = environmentRemedy(browser, message, { everOpened: browser === 'chrome' ? context.chromeEverOpened === true : true })
  if (remedy !== undefined) {
    const explained = new Error(`${toolName}: ${browser === 'safari' ? 'Safari' : 'Chrome'} automation is unavailable on this machine. ${remedy}\n(underlying error: ${message.slice(0, 300)})`, { cause: error })
    explained.name = error?.name ?? 'Error'
    return explained
  }
  const prefixed = /^([a-z][a-z0-9_]*): /.exec(message)
  if (prefixed !== null && prefixed[1] !== toolName && !prefixed[1].startsWith('safari_') && !prefixed[1].startsWith('chrome_')) {
    message = `${toolName}: server tool ${prefixed[1]} failed: ${message.slice(prefixed[0].length)}`
  } else if (!message.startsWith(toolName)) {
    message = `${toolName}: ${message}`
  }
  if (/-32001|Request timed out|Maximum total timeout exceeded/i.test(message)) {
    const budget = typeof timeoutMs === 'number' ? `${timeoutMs} ms (the browser plugin's toolCallTimeoutMs)` : 'the configured toolCallTimeoutMs'
    const browser = toolName.startsWith('safari_') ? 'safari' : 'chrome'
    message += `\nThe browser server did not answer within ${budget}. Usual causes: a JavaScript dialog is blocking the page (${browser}_handle_dialog), a navigation that never finishes, an in-page script that never returns, or the browser process is hung — close the window (${browser}_close) and open a fresh one if it persists.`
  }
  const argSummary = summarizeArgs(args)
  if (argSummary !== '') message += `\nRequest: ${argSummary}`
  const explained = new Error(withHint(message), { cause: error })
  explained.name = error?.name ?? 'Error'
  return explained
}

/** Compact one-line JSON of the call's arguments (long strings elided) so the failure text shows what was asked. */
function summarizeArgs(args) {
  if (args === null || typeof args !== 'object') return ''
  const entries = Object.entries(args).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return '{} (defaults)'
  const shown = Object.fromEntries(entries.map(([key, value]) => [key, typeof value === 'string' && value.length > 120 ? `${value.slice(0, 117)}…` : value]))
  const json = JSON.stringify(shown)
  return json.length > 400 ? `${json.slice(0, 397)}…` : json
}

/** Truncate a page read to maxChars, the full text written to a scratch file first. */
export async function clamp(result, maxChars, scratch = tmpdir()) {
  if (result.content.length <= maxChars) return result
  const ext = result.format === 'html' ? 'html' : result.format === 'json' ? 'json' : result.format === 'markdown' || result.format === 'webkitMarkdown' ? 'md' : 'txt'
  const file = join(scratch, `deepsea-browser-read-${Date.now()}-${process.pid}.${ext}`)
  await writeFile(file, result.content)
  return { ...result, content: result.content.slice(0, maxChars), truncated: true, totalChars: result.content.length, fullTextPath: file }
}

/** Model-facing text for a page read. */
function renderRead(value) {
  const expanded = value.expanded
  const expandedLine = expanded !== undefined
    ? (expanded.details + expanded.buttons + expanded.tabs > 0
        ? `Expanded: ${describeCollapsed({ details: expanded.details, buttons: expanded.buttons, tabGroups: 0 })}${expanded.tabs > 0 ? `${expanded.details + expanded.buttons > 0 ? '; ' : ''}${expanded.tabs} hidden tab panel${expanded.tabs === 1 ? '' : 's'} appended at the end` : ''}`
        : 'Expanded: nothing was collapsed')
    : undefined
  const head = [
    value.mode === 'window' ? `[${value.windowId}]${value.opened ? ' (opened)' : ''}` : value.browser === 'chrome' ? '[temporary Chrome page]' : '[isolated reader]',
    value.title !== undefined ? `Title: ${value.title}` : undefined,
    `URL: ${value.url ?? ''}`,
    `Format: ${value.format}${value.scope !== undefined ? `; scope: ${value.scope.scope}${value.scope.reason ? ` (${value.scope.reason})` : ''}` : ''}`,
    expandedLine,
    ...(value.notes ?? []).map(note => `NOTE: ${note}`),
    value.truncated ? `NOTE: content truncated to ${value.content.length} of ${value.totalChars} chars; full text saved to ${value.fullTextPath} (use read).` : undefined,
  ].filter(Boolean).join('\n')
  const json = (v) => typeof v === 'string' ? v : JSON.stringify(v, null, 1)
  const prepare = 'prepareResult' in value ? `\n\n--- prepareResult ---\n${json(value.prepareResult)}` : ''
  const script = 'scriptResult' in value ? `\n\n--- scriptResult ---\n${json(value.scriptResult)}` : ''
  return `${head}\n\n${value.content}${prepare}${script}`
}

/** Deep-remove `undefined` values from plain objects/arrays (other values pass through untouched). */
export function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(entry => entry === undefined ? null : stripUndefined(entry))
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {}
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = stripUndefined(entry)
    return out
  }
  return value
}
