/**
 * Sidebar badges: the slot number of each numbered session, drawn on the
 * row's status slot (the column of the Workspace header's folder icon), so
 * neither the row's layout nor its title moves.
 *
 * WHY DOM PATCHING: the Workspace browser fills the `single`
 * `sidebar.workspaces` slot. Its per-row seat `sidebar.session.row.leading`
 * is mounted only while the row is idle (a status dot replaces it), and a
 * numbered session must show its number in every state. So the rendered rows
 * are patched and re-patched after React re-renders (MutationObserver → one
 * reconcile per frame).
 *
 * ROW → SLOT KEY (targets.ts):
 *   - `data-deepsea-remote-session="<ws>:<id>"`: a remote-workspaces row; the
 *     attribute is that plugin's published row identity → `remote:` key.
 *   - `data-row-key="session:<id>"`: a local session row (Rows.tsx) →
 *     `local:` key.
 * A row that is neither gets no badge (exit-animation clones drop their
 * `data-row-key`, so a badge copied onto one is removed).
 *
 * GEOMETRY: a local session row is `padding-inline-start: calc(8px +
 * var(--dsh-workspace-indent))` (`depth * 12px`; 0 under a top-level
 * Workspace), a remote row `padding: 0 8px`; then a 16px status slot, then
 * the title. The Workspace header above has the same 8px padding and a 16px
 * icon slot, so the digit sits ON the status slot: the badge is absolutely
 * positioned, 16px wide, offset by the row's computed `padding-inline-start`
 * (read at reconcile time). Whatever the slot shows (the StateDot of a live
 * status, the ongoing spinner, the idle row's leading seat, a remote running
 * dot) is hidden under the digit, which takes over a status dot's
 * `data-state` color (and pulses for ongoing); it is restored when the badge
 * goes. The row gets `position: relative` inline while it carries a badge
 * (Rows.module.css sets the same value for its drag markers, so nothing else
 * changes).
 *
 * Ghost rows of the session-title-slug plugin
 * (`data-deepsea-session-title-slug-ghost`) are clones and are skipped;
 * search-result rows are `<button role="treeitem">` and are not matched.
 */

import { encodeTarget, remoteKeyOfRow } from './targets.ts'

const BADGE_ATTR = 'data-deepsea-numbered-switching-badge'
const POSITIONED_ATTR = 'data-deepsea-numbered-switching-positioned'
/** Marks a status indicator hidden under the digit (restored on clear). */
const HIDDEN_ATTR = 'data-deepsea-numbered-switching-hidden'
/** Width of the rows' status slot (Rows.module.css `.slot`, the remote rows' slot). */
const SLOT_WIDTH_PX = 16
/** Marks this plugin's stylesheet; one element PER INSTALL (see createStyle). */
const STYLE_ATTR = 'data-deepsea-numbered-switching'
const ROW_SELECTOR = 'div[role="treeitem"][aria-selected]'
/** Ghost rows of the session-title-slug plugin. */
const GHOST_WRAPPER_SELECTOR = '[data-deepsea-session-title-slug-ghost]'
/** Remote-workspaces row identity (`<workspaceId>:<sessionId>`). */
const REMOTE_ROW_ATTR = 'data-deepsea-remote-session'
/** Local row identity (`session:<sessionId>`), set by the Workspace browser. */
const LOCAL_ROW_ATTR = 'data-row-key'
const LOCAL_ROW_PREFIX = 'session:'

const STYLE_TEXT = `
[${BADGE_ATTR}] {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0; /* overwritten per row: the row's leading padding */
  width: ${SLOT_WIDTH_PX}px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
[role="treeitem"][aria-selected="true"] > [${BADGE_ATTR}] {
  color: var(--dsw-alias-label-secondary);
}
/* The digit stands in for the status dot it covers: the state colors of
   ui-primitives StateDot.module.css; the ongoing pixel-chase becomes a pulse. */
[${BADGE_ATTR}][data-state="done"] { color: var(--dsw-alias-state-success-primary); }
[${BADGE_ATTR}][data-state="warning"] { color: var(--dsw-alias-state-warn-primary); }
[${BADGE_ATTR}][data-state="error"] { color: var(--dsw-alias-state-error-primary); }
[${BADGE_ATTR}][data-state="ongoing"] {
  color: var(--dsw-static-deepseek-450, var(--dsw-alias-state-business-primary));
  animation: deepsea-numbered-switching-pulse 1.2s ease-in-out infinite;
}
@keyframes deepsea-numbered-switching-pulse { 50% { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) {
  [${BADGE_ATTR}][data-state="ongoing"] { animation: none; }
}
`

/** What the reconciler needs from the data layer. */
export interface BadgeInputs {
  /** 1-based slot number of a slot key (targets.ts), or undefined for unnumbered ones. */
  numberOf: (key: string) => number | undefined
  /** Tooltip text for slot `n` (e.g. "⌘3"). */
  tooltip: (n: number) => string
}

/**
 * The slot key a row stands for.
 * @param row - the attributes of a session row element.
 * @returns the key, or undefined when the row carries no session identity.
 */
export function rowKey(row: Pick<Element, 'getAttribute'>): string | undefined {
  const remote = row.getAttribute(REMOTE_ROW_ATTR)
  if (remote !== null) return remoteKeyOfRow(remote)
  const local = row.getAttribute(LOCAL_ROW_ATTR)
  if (local === null || !local.startsWith(LOCAL_ROW_PREFIX) || local.length === LOCAL_ROW_PREFIX.length) return undefined
  return encodeTarget({ kind: 'local', sessionId: local.slice(LOCAL_ROW_PREFIX.length) })
}

function sessionRows(): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (row.closest(GHOST_WRAPPER_SELECTOR) !== null) continue
    out.push(row)
  }
  return out
}

/**
 * This install's own stylesheet. Never shared by id: when the plugin is
 * re-applied (a bundle hot-swap, a reconnect) the NEW instance's apply can
 * run before the OLD instance's dispose, and a shared `<style id>` would be
 * adopted by the new one and then removed by the old one's disposer, leaving
 * the badges unstyled. Each instance appends and removes its own element;
 * `sync` re-appends it if anything else took it out.
 */
function createStyle(): HTMLStyleElement {
  const style = document.createElement('style')
  style.setAttribute(STYLE_ATTR, '')
  style.textContent = STYLE_TEXT
  document.head.append(style)
  return style
}

/**
 * Layout-critical declarations, inlined on every badge as well: even with no
 * stylesheet at all the digit stays out of the row's flex flow and small.
 * Only the state colors and the pulse depend on the sheet.
 */
const INLINE_BADGE_STYLE: Readonly<Record<string, string>> = {
  position: 'absolute',
  insetBlock: '0',
  width: `${SLOT_WIDTH_PX}px`,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '11px',
  lineHeight: '1',
  pointerEvents: 'none',
}

function setBadge(row: HTMLElement, n: number, tooltip: string): void {
  let badge = row.querySelector<HTMLElement>(`:scope > [${BADGE_ATTR}]`)
  if (badge === null) {
    badge = document.createElement('span')
    badge.setAttribute(BADGE_ATTR, '')
    badge.setAttribute('aria-hidden', 'true')
    Object.assign(badge.style, INLINE_BADGE_STYLE)
    row.prepend(badge)
  }
  const text = String(n)
  if (badge.textContent !== text) badge.textContent = text
  if (badge.title !== tooltip) badge.title = tooltip
  // The digit sits on the 16px status slot, which follows the row's leading
  // padding (8px under a top-level Workspace and on a remote row; 12px more
  // per nesting level): the column of the Workspace header's icon.
  const gutter = getComputedStyle(row).paddingInlineStart
  if (gutter !== '' && badge.style.insetInlineStart !== gutter) badge.style.insetInlineStart = gutter
  // Whatever the slot shows hides under the digit, which takes over a status
  // dot's state color.
  const indicator = slotIndicator(row)
  const state = indicator?.state ?? ''
  if ((badge.getAttribute('data-state') ?? '') !== state) {
    if (state === '') badge.removeAttribute('data-state')
    else badge.setAttribute('data-state', state)
  }
  if (indicator !== undefined && !indicator.element.hasAttribute(HIDDEN_ATTR)) {
    indicator.element.setAttribute(HIDDEN_ATTR, indicator.element.style.visibility)
    indicator.element.style.visibility = 'hidden'
  }
  if (!row.hasAttribute(POSITIONED_ATTR)) {
    // Remember whether we set it, so the clear path restores only our own write.
    if (row.style.position === '') row.style.position = 'relative'
    row.setAttribute(POSITIONED_ATTR, row.style.position === 'relative' ? 'ours' : 'theirs')
  }
}

/**
 * What the row's status slot shows: the first element child of the slot span
 * (the first non-badge child of the row). For a row with a live status that
 * is the StateDot (`data-state`, then screen-reader-only labels, which stay
 * untouched); for an idle row it is the `sidebar.session.row.leading` seat
 * (`data-slot`, `display: contents`), whose occupants hide under the digit
 * too but lend it no color. A remote row's indicator without `data-state` is
 * its running dot or spinner.
 */
function slotIndicator(row: HTMLElement): { element: HTMLElement; state: string } | undefined {
  const slot = [...row.children].find(child => !child.hasAttribute(BADGE_ATTR))
  if (slot === undefined || slot.tagName !== 'SPAN') return undefined
  const first = slot.firstElementChild
  if (first === null || !(first instanceof HTMLElement || first instanceof SVGElement)) return undefined
  // Visually-hidden status text (Rows.tsx `visuallyHidden`) is not an indicator.
  if (first instanceof HTMLElement && first.className.endsWith('_visuallyHidden')) return undefined
  const element = first as unknown as HTMLElement
  if (element.hasAttribute('data-slot')) return { element, state: '' }
  return { element, state: element.getAttribute('data-state') ?? 'ongoing' }
}

function clearBadge(row: HTMLElement): void {
  row.querySelector(`:scope > [${BADGE_ATTR}]`)?.remove()
  for (const hidden of row.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`)) {
    hidden.style.visibility = hidden.getAttribute(HIDDEN_ATTR) ?? ''
    hidden.removeAttribute(HIDDEN_ATTR)
  }
  if (row.getAttribute(POSITIONED_ATTR) === 'ours') row.style.position = ''
  row.removeAttribute(POSITIONED_ATTR)
}

/**
 * Install the badge reconciler.
 * @param inputs - number lookup, title fallback data, tooltip text.
 * @returns `update()` to re-sync after a slot change, and `dispose()`.
 */
export function installBadges(inputs: BadgeInputs): { update: () => void; dispose: () => void } {
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const style = createStyle()

  const sync = (): void => {
    frame = undefined
    timer = undefined
    // Self-heal: a re-applied sibling instance or a head rewrite may have
    // removed our sheet; the next row mutation brings it back here.
    if (!style.isConnected) document.head.append(style)
    for (const row of sessionRows()) {
      const key = rowKey(row)
      const n = key === undefined ? undefined : inputs.numberOf(key)
      if (n === undefined) clearBadge(row)
      else setBadge(row, n, inputs.tooltip(n))
    }
    // Badges orphaned outside a session row (defensive).
    for (const stray of document.querySelectorAll(`[${BADGE_ATTR}]`)) {
      if (!(stray.parentElement?.matches(ROW_SELECTOR) ?? false)) stray.remove()
    }
  }
  // One reconcile per frame. A hidden document (a background or covered
  // window) gets no frames, so a timer stands in there: the badges must be
  // right the moment the page is seen again.
  const schedule = (): void => {
    if (frame !== undefined || timer !== undefined) return
    if (document.hidden) timer = setTimeout(sync, 0)
    else frame = window.requestAnimationFrame(sync)
  }

  // Our own writes echo through the observer; setBadge/clearBadge are
  // idempotent, so the second pass settles without further mutations.
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'aria-expanded'],
  })
  schedule()

  return {
    update: schedule,
    dispose: () => {
      observer.disconnect()
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      if (timer !== undefined) clearTimeout(timer)
      for (const row of document.querySelectorAll<HTMLElement>(`[${POSITIONED_ATTR}]`)) clearBadge(row)
      for (const badge of document.querySelectorAll(`[${BADGE_ATTR}]`)) badge.remove()
      style.remove()
    },
  }
}
