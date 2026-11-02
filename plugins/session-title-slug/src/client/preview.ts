/**
 * Live sidebar preview: while a blank New Session's draft starts with a slug,
 * its "New Session" row shows the slug instead.
 *
 * WHY DOM PATCHING: the Workspace browser (ui-workspace Rows.tsx) renders a
 * blank row as `node.blank ? t('session.new') : node.title`, and the server
 * keeps `blank` until the first `turn/start`. So neither renaming the blank
 * session nor any store write can change that label: it is a locale
 * constant while blank. The browser fills `sidebar.workspaces`, a `single`
 * slot (replacing the whole browser for one label is out of proportion), and
 * a locale namespace has exactly one owner. The remaining seam is the row's
 * DOM.
 *
 * WHAT IS PATCHED: the title span (`[class$="_title"]`, CSS-module classes
 * being `[hash]_[local]`) of the row `data-row-key="session:<id>"` of the
 * session being typed into, while that row has no `_time` cell (a blank row
 * has none until the first prompt).
 *
 * SAFETY: the original label is kept in `data-deepsea-session-title-slug-label`,
 * the written slug in `data-deepsea-session-title-slug-preview`. Restoring
 * happens only while the span still shows exactly the slug written and the
 * row is still blank-shaped: once the prompt is accepted the row re-renders
 * with its real title, which a blind restore would clobber. A
 * MutationObserver re-applies after the row remounts (folding a workspace,
 * reopening the sidebar).
 */

const PREVIEW_ATTR = 'data-deepsea-session-title-slug-preview'
const TITLE_SELECTOR = ':scope > span[class$="_title"]'
const TIME_SELECTOR = ':scope > span[class$="_time"]'

/** What to preview: the slug for one session's row. */
export interface Preview {
  sessionId: string
  slug: string
}

function rowOf(span: HTMLElement): HTMLElement | null {
  return span.parentElement
}

function isBlankRow(row: HTMLElement | null): boolean {
  return row !== null && row.querySelector(TIME_SELECTOR) === null
}

function titleSpanOf(sessionId: string): HTMLElement | undefined {
  const row = document.querySelector<HTMLElement>(`[role="treeitem"][data-row-key="session:${CSS.escape(sessionId)}"]`)
  if (row === null || !isBlankRow(row)) return undefined
  return row.querySelector<HTMLElement>(TITLE_SELECTOR) ?? undefined
}

function applyTo(span: HTMLElement, slug: string): void {
  if (span.dataset.deepseaSessionTitleSlugPreview === slug && span.textContent === slug) return
  if (span.dataset.deepseaSessionTitleSlugLabel === undefined) span.dataset.deepseaSessionTitleSlugLabel = span.textContent ?? ''
  span.dataset.deepseaSessionTitleSlugPreview = slug
  span.textContent = slug
}

function restore(span: HTMLElement): void {
  const written = span.dataset.deepseaSessionTitleSlugPreview
  if (written === undefined) return
  if (span.textContent === written && isBlankRow(rowOf(span))) span.textContent = span.dataset.deepseaSessionTitleSlugLabel ?? ''
  delete span.dataset.deepseaSessionTitleSlugPreview
  delete span.dataset.deepseaSessionTitleSlugLabel
}

/**
 * Install the preview patcher.
 * @returns setter and disposer; `set(undefined)` restores every patched label.
 */
export function installPreview(): { set: (preview: Preview | undefined) => void; dispose: () => void } {
  let current: Preview | undefined
  let frame: number | undefined

  const sync = (): void => {
    frame = undefined
    const target = current === undefined ? undefined : titleSpanOf(current.sessionId)
    // Restore everything patched that is not the current target or shows another slug.
    for (const span of document.querySelectorAll<HTMLElement>(`span[${PREVIEW_ATTR}]`)) {
      if (span !== target || span.dataset.deepseaSessionTitleSlugPreview !== current?.slug) restore(span)
    }
    if (current !== undefined && target !== undefined) applyTo(target, current.slug)
  }
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = window.requestAnimationFrame(sync)
  }

  // Re-apply after React remounts the row. Our own writes also fire the
  // observer; `applyTo` is idempotent, so the second pass changes nothing.
  const observer = new MutationObserver(() => {
    if (current !== undefined || document.querySelector(`span[${PREVIEW_ATTR}]`) !== null) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return {
    set: (preview) => {
      if (preview?.sessionId === current?.sessionId && preview?.slug === current?.slug) return
      current = preview
      schedule()
    },
    dispose: () => {
      observer.disconnect()
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      current = undefined
      for (const span of document.querySelectorAll<HTMLElement>(`span[${PREVIEW_ATTR}]`)) restore(span)
    },
  }
}
