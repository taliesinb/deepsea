/**
 * Ghost rows: keep a typed-into New Session reachable after switching away.
 *
 * WHY: the Workspace browser lists a blank session only while it is the
 * CURRENT one (tree.ts: `session.blank && session.id !== current` is
 * hidden). Select another session and the "New Session" row vanishes,
 * although the blank session still exists on the server (New Session reuses
 * it) and its draft is persisted per session (ui-conversation's store,
 * `localStorage['dsh.conversation.<id>'] = { draft, view, viewRequest }`,
 * `draft` a string or `{ text, references }`). Only a row is missing.
 *
 * WHAT: for every listed session that is blank, not current and has a
 * non-empty persisted draft, a dimmed row right under its Workspace header
 * (where the real blank row sorts), labelled with the draft's slug or the
 * localized "New Session". Click or Enter opens it; the real blank row then
 * takes over and the ghost is removed. A blank session with an empty draft
 * gets no ghost: there is nothing to return to.
 *
 * HOW (DOM, the seam preview.ts uses): the browser fills the `single`
 * `sidebar.workspaces` slot. Each ghost is a clone of a real session row (so
 * it inherits the CSS-module classes for geometry and hover) with the
 * selection, drag, menu and identity artefacts stripped, inside a shallow
 * clone of that row's wrapper, marked `data-deepsea-session-title-slug-ghost="<id>"`
 * and inserted after the Workspace header `data-row-key="workspace:<id>"`.
 * React never touches foreign siblings it did not create; when it remounts
 * the group the ghost goes with it and the MutationObserver re-inserts it.
 * Reconciling is idempotent, so the observer's echo of our own writes
 * settles in one pass. A collapsed Workspace shows no ghost.
 */

import { parseSlug } from '../../slug.mjs'

/** ui-conversation's persistence key prefix (stores.ts `CONVERSATION_STORE_KEY`). */
const CONVERSATION_STORE_KEY = 'dsh.conversation'

const GHOST_ATTR = 'data-deepsea-session-title-slug-ghost'
const GHOST_OPACITY = '0.5'

/** One session the browser knows about (subset of SessionSummary). */
export interface GhostSessionRow {
  id: string
  blank: boolean
  cwd?: string | undefined
}

/** One Workspace (subset of WorkspaceView). */
export interface GhostWorkspace {
  workspaceId: string
  path: string
  sessionIds: readonly string[]
}

/** Inputs the reconciler needs from the data layer. */
export interface GhostInputs {
  sessions: readonly GhostSessionRow[]
  current: string | undefined
  workspaces: readonly GhostWorkspace[]
}

/** One row to render. */
export interface Ghost {
  sessionId: string
  workspaceId: string
  label: string
}

/**
 * The text of a persisted draft (a string, or `{ text, references }` once it
 * holds reference chips).
 * @param stored - the `draft` field of the stored conversation state.
 * @returns the text, or '' when there is none.
 */
export function draftText(stored: unknown): string {
  if (typeof stored === 'string') return stored
  if (typeof stored === 'object' && stored !== null && 'text' in stored && typeof stored.text === 'string') return stored.text
  return ''
}

/**
 * Read the persisted composer draft of any session (current or not).
 * @param sessionId - session whose conversation store to read.
 * @returns the draft text, or '' when nothing usable is stored.
 */
export function readPersistedDraft(sessionId: string): string {
  if (typeof localStorage === 'undefined') return ''
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return ''
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('draft' in stored)) return ''
    return draftText(stored.draft)
  } catch {
    return ''
  }
}

/**
 * Decide which ghosts should exist.
 * @param inputs - list, current selection, Workspaces.
 * @param drafts - draft reader.
 * @param fallbackLabel - the label of a ghost whose draft has no slug.
 * @returns ghosts in list order.
 */
export function deriveGhosts(inputs: GhostInputs, drafts: (sessionId: string) => string, fallbackLabel: string): Ghost[] {
  const out: Ghost[] = []
  for (const session of inputs.sessions) {
    if (!session.blank || session.id === inputs.current) continue
    const draft = drafts(session.id)
    if (draft.trim() === '') continue
    const workspace = inputs.workspaces.find(w => w.sessionIds.includes(session.id))
      ?? (session.cwd === undefined ? undefined : inputs.workspaces.find(w => w.path === session.cwd))
    if (workspace === undefined) continue
    out.push({ sessionId: session.id, workspaceId: workspace.workspaceId, label: parseSlug(draft) ?? fallbackLabel })
  }
  return out
}

/**
 * A row's wrapper: rows (header and session alike) are rendered inside
 * HoverCard's block wrapper div, which is what the group section lays out
 * (the spacing between rows is between wrappers). Detected structurally,
 * as the element holding exactly that one row (plus any ghost parked there),
 * because ui-primitives hashes its classes differently (`_root_<hash>_<n>`).
 */
function wrapperOf(row: HTMLElement): HTMLElement | undefined {
  const parent = row.parentElement
  if (parent === null || parent.getAttribute('role') === 'tree') return undefined
  const ownRows = [...parent.children].filter(child => !child.hasAttribute(GHOST_ATTR))
  return ownRows.length === 1 && ownRows[0] === row ? parent : undefined
}

/** The element a ghost is inserted after: the expanded header's wrapper (or the header). */
function anchorOf(workspaceId: string): HTMLElement | undefined {
  const header = document.querySelector<HTMLElement>(
    `[role="tree"] [role="treeitem"][aria-expanded="true"][data-row-key="workspace:${CSS.escape(workspaceId)}"]`,
  )
  if (header === null) return undefined
  return wrapperOf(header) ?? header
}

/** A real session row to clone for classes and geometry (never a ghost). */
function templateRow(): HTMLElement | undefined {
  for (const row of document.querySelectorAll<HTMLElement>('[role="treeitem"][data-row-key^="session:"]')) {
    if (row.closest(`[${GHOST_ATTR}]`) === null) return row
  }
  return undefined
}

/** Class tokens that encode transient row state and must not survive the clone. */
const STRIP_CLASS_SUFFIXES = ['_selected', '_menuOpen', '_dropBefore', '_dropAfter', '_archived']

function buildGhost(template: HTMLElement, ghost: Ghost, open: (sessionId: string) => void): HTMLElement {
  const el = template.cloneNode(true) as HTMLElement
  for (const token of [...el.classList]) {
    if (STRIP_CLASS_SUFFIXES.some(suffix => token.endsWith(suffix))) el.classList.remove(token)
  }
  // Identity and decoration of the template row (its data-row-key, a
  // preview's marks, other plugins' marks, inline styles) belong to that
  // row, not to the ghost.
  for (const node of [el, ...el.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.startsWith('data-') || attribute.name === 'style' || (node === el && attribute.name.startsWith('aria-'))) {
        node.removeAttribute(attribute.name)
      }
    }
  }
  el.setAttribute('aria-selected', 'false')
  el.removeAttribute('draggable')
  el.removeAttribute('id')
  el.tabIndex = 0
  el.style.opacity = GHOST_OPACITY
  el.title = ghost.label
  // Keep the leading status slot (title alignment) but empty it; keep the
  // title span; drop the time cell, the actions and anything else.
  let keptSlot = false
  for (const child of [...el.children]) {
    const cls = child.className
    if (!keptSlot && typeof cls === 'string' && /_slot(\s|$)/u.test(cls)) {
      child.replaceChildren()
      keptSlot = true
      continue
    }
    if (typeof cls === 'string' && cls.endsWith('_title')) {
      child.textContent = ghost.label
      continue
    }
    child.remove()
  }
  const activate = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    open(ghost.sessionId)
  }
  el.addEventListener('click', activate)
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') activate(event)
  })
  // Real rows sit inside HoverCard's block wrapper, and the group section
  // spaces WRAPPERS; a bare row would lose that spacing and shift the rows
  // below it. A shallow clone of the template's wrapper lays the ghost out
  // exactly like its neighbours.
  const templateWrapper = wrapperOf(template)
  const outer = templateWrapper === undefined ? el : (templateWrapper.cloneNode(false) as HTMLElement)
  if (outer !== el) {
    outer.removeAttribute('id')
    outer.replaceChildren(el)
  }
  outer.setAttribute(GHOST_ATTR, ghost.sessionId)
  return outer
}

/**
 * Install the ghost-row reconciler.
 * @param open - select a session as current.
 * @param newSessionLabel - the localized "New Session" (read at every reconcile).
 * @returns `update(inputs)` to feed fresh data, and `dispose()`.
 */
export function installGhosts(open: (sessionId: string) => void, newSessionLabel: () => string): {
  update: (inputs: GhostInputs) => void
  dispose: () => void
} {
  let inputs: GhostInputs = { sessions: [], current: undefined, workspaces: [] }
  let frame: number | undefined

  const sync = (): void => {
    frame = undefined
    const wanted = deriveGhosts(inputs, readPersistedDraft, newSessionLabel())
    const wantedById = new Map(wanted.map(g => [g.sessionId, g]))

    // Remove ghosts that are no longer wanted, mislabelled or misplaced.
    for (const el of document.querySelectorAll<HTMLElement>(`[${GHOST_ATTR}]`)) {
      const ghost = wantedById.get(el.getAttribute(GHOST_ATTR) ?? '')
      const anchor = ghost === undefined ? undefined : anchorOf(ghost.workspaceId)
      const titleEl = el.querySelector('span[class$="_title"]')
      const placed = anchor !== undefined && el.previousElementSibling === anchor
      if (ghost === undefined || !placed || titleEl?.textContent !== ghost.label) el.remove()
    }
    // Insert the missing ones.
    let template: HTMLElement | undefined
    for (const ghost of wanted) {
      if (document.querySelector(`[${GHOST_ATTR}="${CSS.escape(ghost.sessionId)}"]`) !== null) continue
      const anchor = anchorOf(ghost.workspaceId)
      if (anchor === undefined) continue
      template ??= templateRow()
      if (template === undefined) return
      anchor.insertAdjacentElement('afterend', buildGhost(template, ghost, open))
    }
  }
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = window.requestAnimationFrame(sync)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-expanded', 'aria-selected'],
  })
  // Same-tab localStorage writes fire no `storage` event; drafts are re-read
  // on every reconcile, and the list snapshot changes whenever the selection
  // moves.
  window.addEventListener('storage', schedule)

  return {
    update: (next) => {
      inputs = next
      schedule()
    },
    dispose: () => {
      observer.disconnect()
      window.removeEventListener('storage', schedule)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      for (const el of document.querySelectorAll(`[${GHOST_ATTR}]`)) el.remove()
    },
  }
}
