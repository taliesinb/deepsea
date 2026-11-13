/**
 * The floating panel's page (panel-page.mjs serves it; build.mjs bundles
 * this file into lib/panel.js): the card standalone, plus the session line.
 *
 *   [shield] System permissions  DeepSea Server · 1/3
 *   Default workspace / Install the prototype
 *     ✓  Accessibility      To click through the installer.
 *     ?  Screen Recording   To take screenshots …        [Grant] [Deny]
 *
 * It draws the rows with the card's own model (src/client/model.ts) and
 * stylesheet (src/client/styles.ts), asks the status route every second, and
 * POSTs Grant and Deny to the action route, so the inline card follows. When
 * the call ends it shows the final rows for a moment and closes its panel.
 * Plain DOM, no React: the page has no client shell around it.
 */
import enLocale from '../../locale/en.json'
import zhLocale from '../../locale/zh.json'
import { type Row, type Translate, iconOf, isOpen, nameOf, stateKeyOf, stateText } from '../client/model.ts'
import { CLS, STYLESHEET } from '../client/styles.ts'

interface Boot { callId: string, sessionId: string, panelId: string, workspace: string, title: string }
const boot = (globalThis as { __DEEPSEA_SYSTEM_PERMISSIONS_PANEL__?: Boot }).__DEEPSEA_SYSTEM_PERMISSIONS_PANEL__
  ?? { callId: '', sessionId: '', panelId: '', workspace: '', title: '' }

const dictionary: Record<string, string> = /^zh/i.test(navigator.language) ? zhLocale.card : enLocale.card
const t: Translate = (key, params = {}) => (dictionary[key] ?? (enLocale.card as Record<string, string>)[key] ?? key)
  .replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))

/** The default workspace's directory name, which the sidebar shows by its localized name (harness api/workspace-controller DEFAULT_WORKSPACE_DIRECTORY). */
const DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'
const workspace = boot.workspace === DEFAULT_WORKSPACE_DIRECTORY ? t('workspace.default') : boot.workspace
const line = [workspace, boot.title].filter(Boolean).join(' / ')

const STATUS_PATH = './status'
const ACTION_PATH = './action'
const CLOSE_AFTER_MS = 2500

/** Inline marks (the client shell's icon sprite is not on this page). */
const ICONS = {
  shield: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 1.5 2.5 3.5v4c0 3.2 2.3 5.7 5.5 7 3.2-1.3 5.5-3.8 5.5-7v-4z"/></svg>',
  granted: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m4.8 8.2 2.2 2.2 4.2-4.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  open: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6.5"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".7" fill="currentColor" stroke="none"/></svg>',
  closed: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
  checking: '<span class="' + CLS + '-dot"></span>',
}

const PAGE_STYLE = `
:root { color-scheme: light dark; --dsw-alias-label-primary: #1d1d1f; --dsw-alias-label-secondary: #6e6e73; }
@media (prefers-color-scheme: dark) { :root { --dsw-alias-label-primary: #f5f5f7; --dsw-alias-label-secondary: #a1a1a6; } }
html, body { margin: 0; background: Canvas; font: 13px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
#deepsea-tool-system-permissions-panel { padding: 12px 14px; }
.${CLS}-panel-head { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-primary); }
.${CLS}-panel-head > svg { flex: none; color: var(--dsw-alias-label-secondary); }
.${CLS}-panel-session { margin: 2px 0 6px 22px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.${CLS}-panel .${CLS}-frame { margin-top: 6px; }
`

function escape(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] as string)
}

interface View { rows: Row[], subject: { name?: string }, running: boolean }

async function fetchStatus(): Promise<View | undefined> {
  try {
    const query = new URLSearchParams({ callId: boot.callId, sessionId: boot.sessionId })
    const response = await fetch(`${STATUS_PATH}?${query.toString()}`, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return undefined
    const body = await response.json() as { running?: boolean, snapshot?: { rows?: Row[], subject?: { name?: string } } }
    if (!Array.isArray(body.snapshot?.rows)) return undefined
    return { rows: body.snapshot.rows, subject: body.snapshot.subject ?? {}, running: body.running === true }
  } catch {
    return undefined
  }
}

let busy = false
async function act(action: 'grant' | 'deny', permission: string): Promise<void> {
  if (busy) return
  busy = true
  try {
    await fetch(ACTION_PATH, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, permission, callId: boot.callId, sessionId: boot.sessionId }),
    })
  } catch { /* the next status shows what happened */ }
  busy = false
  void refresh()
}

function render(root: HTMLElement, view: View): void {
  const granted = view.rows.filter(r => r.state === 'granted').length
  const head = [view.subject.name, t('summary', { granted, total: view.rows.length })].filter(Boolean).join(' · ')
  const rows = view.rows.map((row) => {
    const name = nameOf(row, t)
    const state = stateText(row, t)
    const buttons = view.running && isOpen(row)
      ? `<span class="${CLS}-buttons">`
        + `<button type="button" class="${CLS}-button" data-deepsea-permission-action="grant" aria-label="${escape(t('grant.aria', { name }))}">${escape(t('grant'))}</button>`
        + `<button type="button" class="${CLS}-button" data-deepsea-permission-action="deny" aria-label="${escape(t('deny.aria', { name }))}">${escape(t('deny'))}</button></span>`
      : ''
    return `<div role="listitem" class="${CLS}-row" title="${escape(state)}" data-deepsea-permission="${escape(row.id)}" data-deepsea-permission-state="${escape(row.state)}"`
      + ` data-deepsea-permission-status="${escape(row.status ?? '')}" data-deepsea-permission-icon="${iconOf(row)}" data-deepsea-permission-key="${stateKeyOf(row)}">`
      + `<span class="${CLS}-icon"><span role="img" aria-label="${escape(state)}">${ICONS[iconOf(row)]}</span></span>`
      + `<span class="${CLS}-name">${escape(name)}</span>`
      + `<span class="${CLS}-justification" title="${escape(row.justification ?? '')}">${escape(row.justification ?? '')}</span>`
      + `<span class="${CLS}-actions">${buttons}</span></div>`
  }).join('')
  root.innerHTML = `<div class="${CLS}-panel" data-tool="seek_system_permission" data-state="${view.running ? 'running' : 'ok'}" data-deepsea-permissions-call="${escape(boot.callId)}">`
    + `<div class="${CLS}-panel-head">${ICONS.shield}<span>${escape(t('title'))}</span><span class="${CLS}-head">${escape(head)}</span></div>`
    + (line ? `<div class="${CLS}-panel-session" title="${escape(line)}">${escape(line)}</div>` : '')
    + `<div class="${CLS}-frame"><div class="${CLS}-list" role="list">${rows}</div></div></div>`
}

const root = document.getElementById('deepsea-tool-system-permissions-panel') as HTMLElement
let closing = false

async function refresh(): Promise<void> {
  const view = await fetchStatus()
  if (view === undefined) return
  render(root, view)
  if (!view.running && !closing) {
    closing = true
    window.setTimeout(() => {
      const app = (globalThis as { __DEEPSEA_APP__?: { closePanel?: (id: string) => void } }).__DEEPSEA_APP__
      app?.closePanel?.(boot.panelId)
    }, CLOSE_AFTER_MS)
  }
}

const style = document.createElement('style')
style.textContent = STYLESHEET + PAGE_STYLE
document.head.append(style)
root.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest?.('button[data-deepsea-permission-action]')
  const row = button?.closest('[data-deepsea-permission]')
  const permission = row?.getAttribute('data-deepsea-permission')
  const action = button?.getAttribute('data-deepsea-permission-action')
  if (permission && (action === 'grant' || action === 'deny')) void act(action, permission)
})
void refresh()
window.setInterval(() => { if (!closing) void refresh() }, 1000)
