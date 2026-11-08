/**
 * panel-page.mjs — the page the macOS app shows in a floating panel when a
 * call has waited `noticeSeconds` without a click (src/client/notice.ts asks
 * for it): the card again, standalone, plus one line naming the session.
 *
 * Served by the package root at GET /api/deepsea-tool-system-permissions/panel
 * (behind DSH's authentication; the panel shares the app's cookies). A small
 * standalone page rather than the GUI at a special address: it loads at once
 * (no client shell to boot, nothing else to hide), and it draws the same rows
 * from the same pure module and stylesheet as the card (src/panel builds
 * lib/panel.js from src/client/model.ts and src/client/styles.ts).
 */

/** HTML text, escaped for an element or a double-quoted attribute. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c])
}

/** A JSON value safe inside a <script> element. */
export function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/**
 * The panel page.
 * @param {{ callId: string, sessionId: string, panelId: string, workspace?: string, title?: string, script: string }} options
 *   `workspace` and `title`: the session's, for its line; `script`: lib/panel.js.
 */
export function panelHtml({ callId, sessionId, panelId, workspace, title, script }) {
  const boot = { callId, sessionId, panelId, workspace: workspace ?? '', title: title ?? '' }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title || 'System permissions')}</title>
</head>
<body>
<div id="deepsea-tool-system-permissions-panel"></div>
<script>window.__DEEPSEA_SYSTEM_PERMISSIONS_PANEL__ = ${scriptJson(boot)};</script>
<script>${script.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>
`
}
