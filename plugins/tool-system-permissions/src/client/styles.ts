/**
 * The card's stylesheet, shared with the floating panel's page (src/panel): one look for both.
 * Class prefix and DOM attributes are wire names themes may target.
 */

export const CLS = 'deepsea-tool-system-permissions'
export const STYLE_ID = 'deepsea-tool-system-permissions-style'
export const STYLESHEET = `
.${CLS}-area.${CLS}-area { flex: 1 1 auto; width: auto; min-width: 0; }
.${CLS}-layout.${CLS}-layout { width: 100%; }
.${CLS}-head { margin-left: 8px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--dsh-content-font-size-secondary, 13px); color: var(--dsw-alias-label-secondary); opacity: 0.85; }
.${CLS}-frame { container-type: inline-size; margin: 2px 0 6px 22px; }
.${CLS}-list { display: grid; grid-template-columns: 16px max-content minmax(0, 1fr) auto; column-gap: 10px; row-gap: 2px; font-size: var(--dsh-content-font-size-secondary, 13px); color: var(--dsw-alias-label-secondary); }
.${CLS}-row { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; min-height: 24px; }
.${CLS}-icon { grid-column: 1; grid-row: 1; }
.${CLS}-icon > span, .${CLS}-icon svg { display: block; }
.${CLS}-name { grid-column: 2; grid-row: 1; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.${CLS}-justification { grid-column: 3; grid-row: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
.${CLS}-actions { grid-column: 4; grid-row: 1; margin-left: 6px; }
.${CLS}-actions:empty { margin-left: 0; }
@container (max-width: 520px) {
  .${CLS}-list { grid-template-columns: minmax(0, 1fr); }
  .${CLS}-row { grid-template-columns: 16px minmax(0, 1fr) auto; column-gap: 10px; align-content: start; }
  .${CLS}-name { white-space: normal; }
  .${CLS}-actions { grid-column: 3; }
  .${CLS}-justification { grid-column: 2 / 4; grid-row: 2; white-space: normal; padding-bottom: 4px; }
  .${CLS}-justification:empty { display: none; }
}
[data-deepsea-permission][data-deepsea-permission-icon='granted'] .${CLS}-icon { color: var(--dsw-alias-state-success-primary, #30a46c); }
[data-deepsea-permission][data-deepsea-permission-icon='open'] .${CLS}-icon { color: var(--dsw-alias-state-business-primary, #3b82f6); }
[data-deepsea-permission][data-deepsea-permission-icon='closed'] .${CLS}-icon { color: var(--dsw-alias-state-error-primary, #e5484d); }
[data-deepsea-permission][data-deepsea-permission-icon='checking'] .${CLS}-icon { opacity: 0.4; }
[data-deepsea-permission][data-deepsea-permission-key='state.stale'] .${CLS}-icon, [data-deepsea-permission][data-deepsea-permission-key='state.grantingStale'] .${CLS}-icon { color: var(--dsw-alias-state-warn-primary, #d97706); }
@keyframes ${CLS}-pulse { 50% { opacity: 0.35; } }
[data-deepsea-permission][data-deepsea-permission-state='granting'] .${CLS}-icon > span { animation: ${CLS}-pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { [data-deepsea-permission][data-deepsea-permission-state='granting'] .${CLS}-icon > span { animation: none; } }
.${CLS}-dot { width: 12px; height: 12px; border-radius: 6px; margin: 1px; background: currentColor; }
.${CLS}-buttons { display: inline-flex; gap: 4px; }
.${CLS}-button { appearance: none; height: 20px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 20%, transparent)); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--dsh-content-font-size-secondary, 12px); line-height: 18px; cursor: pointer; }
.${CLS}-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent)); color: var(--dsw-alias-label-primary); }
.${CLS}-button[data-deepsea-permission-action='grant'] { border-color: var(--dsw-alias-state-business-primary, #3b82f6); color: var(--dsw-alias-state-business-primary, #3b82f6); }
.${CLS}-button[data-deepsea-permission-action='deny']:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary, #e5484d); border-color: var(--dsw-alias-state-error-primary, #e5484d); }
.${CLS}-button:disabled { opacity: 0.5; cursor: default; }
.${CLS}-error { margin: 2px 0 6px 22px; color: var(--dsw-alias-state-error-primary, #e5484d); font-size: var(--dsh-content-font-size-secondary, 13px); }
.${CLS}-command-text { margin: 2px 0 6px 22px; padding: 0; background: none; font: 12px/1.5 var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); color: var(--dsw-alias-label-secondary); white-space: pre; overflow-x: auto; }
.${CLS}-command-text[data-error] { color: var(--dsw-alias-state-error-primary, #e5484d); }
`
