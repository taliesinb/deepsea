/**
 * The plugin's stylesheet, injected once as a <style> element. The user bubble
 * rules are a port of ui-chat's MessageItem / MessageIconActions modules (its
 * class names are hashed per build, so a replacement renderer cannot reuse
 * them); the hover-reveal rule keys on the unhashed `data-chat-flow-kind`
 * wrapper attribute exactly as the shipped sheet does.
 */
export const STYLE_ID = 'deepsea-message-branches-style'

export const CSS = `
.deepsea-message-branches-userRow { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.deepsea-message-branches-stack { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; min-width: 0;
  max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%); }
.deepsea-message-branches-userRow[data-deepsea-message-branches-editing] .deepsea-message-branches-stack { width: min(calc(var(--dsh-chat-content-width, 748px) * 0.85), 100%); max-width: 100%; }
.deepsea-message-branches-bubble { max-width: 100%; background: var(--dsw-specific-bubble); border-radius: 22px; padding: 10px 16px;
  font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; }
.deepsea-message-branches-referenceSummary { color: var(--dsw-alias-label-tertiary); font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px)); }
.deepsea-message-branches-attachmentRow { display: flex; flex-wrap: wrap; justify-content: flex-end; max-width: 100%; gap: 8px; }
.deepsea-message-branches-fileCard { display: inline-flex; flex: 0 0 240px; align-items: center; gap: 10px; width: 240px; min-height: 64px; padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); border-radius: 16px; background: var(--dsw-specific-input-major, transparent); box-sizing: border-box; }
.deepsea-message-branches-fileIcon { flex: none; width: 28px; height: 28px; }
.deepsea-message-branches-fileContent { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.deepsea-message-branches-fileName { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 500; line-height: 22px; }
.deepsea-message-branches-fileMeta { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); font-size: 12px; line-height: 15px; }

/* IconActions row (clock, copy, edit, version switcher). */
.deepsea-message-branches-actions { display: flex; align-items: center; gap: 8px; height: calc(28px + var(--dsh-content-font-delta, 0px)); }
.deepsea-message-branches-time { padding-right: 12px; font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.deepsea-message-branches-action { display: inline-flex; align-items: center; justify-content: center; width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px)); padding: 6px; border: none; border-radius: 28px; background: transparent;
  color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.deepsea-message-branches-action svg { width: calc(15px + var(--dsh-content-font-delta, 0px)); height: calc(15px + var(--dsh-content-font-delta, 0px)); }
.deepsea-message-branches-action:hover, .deepsea-message-branches-action[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.deepsea-message-branches-action:disabled { opacity: 0.4; cursor: default; }
.deepsea-message-branches-action:disabled:hover { background: transparent; color: var(--dsw-alias-label-tertiary); }
@media (hover: hover) {
  [data-chat-flow-kind='user']:has(~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])) .deepsea-message-branches-actions { opacity: 0; transition: opacity 80ms ease; }
  [data-chat-flow-kind='user']:has(~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])):hover .deepsea-message-branches-actions,
  [data-chat-flow-kind='user']:has(~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])):focus-within .deepsea-message-branches-actions,
  [data-chat-flow-kind='user'] .deepsea-message-branches-actions:has(.deepsea-message-branches-switcher),
  [data-chat-flow-kind='user'] .deepsea-message-branches-actions:has([aria-expanded="true"]) { opacity: 1; }
}

/* ‹ 2/3 › version switcher. */
.deepsea-message-branches-switcher { display: inline-flex; align-items: center; gap: 2px; height: calc(24px + var(--dsh-content-font-delta, 0px)); padding: 0 2px;
  border-radius: 24px; color: var(--dsw-alias-label-tertiary); font-size: var(--dsh-content-font-size-secondary, 13px); }
.deepsea-message-branches-switcher .deepsea-message-branches-action { width: 22px; height: 22px; padding: 4px; }
.deepsea-message-branches-switcherCount { min-width: 28px; padding: 0 2px; border: none; background: transparent; color: inherit; font: inherit;
  font-variant-numeric: tabular-nums; text-align: center; cursor: pointer; border-radius: 12px; line-height: 22px; }
.deepsea-message-branches-switcherCount:hover, .deepsea-message-branches-switcherCount[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }

/* Popovers (versions list, header tree). */
.deepsea-message-branches-popover { position: absolute; z-index: 100; box-sizing: border-box; min-width: 260px; max-width: min(440px, calc(100vw - 24px));
  max-height: min(60vh, 480px); overflow: auto; padding: 6px; border-radius: 14px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-module-platform)); border: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l4));
  box-shadow: 0 8px 28px rgba(0,0,0,0.28); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 18px; text-align: left; cursor: default; }
.deepsea-message-branches-popoverTitle { padding: 6px 10px 4px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.deepsea-message-branches-versionRow, .deepsea-message-branches-treeRow { display: flex; align-items: flex-start; gap: 8px; width: 100%; padding: 6px 10px; border: none; border-radius: 9px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.deepsea-message-branches-versionRow:hover, .deepsea-message-branches-treeRow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.deepsea-message-branches-versionRow[data-current], .deepsea-message-branches-treeRow[data-current] { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover)); }
.deepsea-message-branches-versionIndex { flex: none; min-width: 18px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.deepsea-message-branches-versionText { flex: 1; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.deepsea-message-branches-versionText[data-empty] { color: var(--dsw-alias-label-tertiary); font-style: italic; }
.deepsea-message-branches-currentDot { flex: none; width: 6px; height: 6px; margin-top: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary, currentColor); }
.deepsea-message-branches-currentDot[data-off] { background: transparent; }

/* Tree navigator rows. */
.deepsea-message-branches-tree { display: flex; flex-direction: column; gap: 1px; }
.deepsea-message-branches-treeRow { align-items: flex-start; gap: 6px; padding: 5px 8px; }
.deepsea-message-branches-treeIndent { flex: none; display: inline-block; width: calc(var(--deepsea-message-branches-depth, 0) * 16px); }
.deepsea-message-branches-treeGuide { flex: none; width: 12px; line-height: 18px; color: var(--dsw-alias-label-quaternary, var(--dsw-alias-label-tertiary)); font-size: 12px; }
.deepsea-message-branches-treeMain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.deepsea-message-branches-treeTitle { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; }
.deepsea-message-branches-treeRow[data-current] .deepsea-message-branches-treeTitle { color: var(--dsw-alias-brand-primary, inherit); }
.deepsea-message-branches-treeMeta { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.deepsea-message-branches-treeMeta b { font-weight: 500; color: var(--dsw-alias-label-secondary); }
.deepsea-message-branches-treeEmpty { padding: 10px; color: var(--dsw-alias-label-tertiary); font-size: 12.5px; }
.deepsea-message-branches-treeError { padding: 10px; color: var(--dsw-alias-state-error-primary); font-size: 12.5px; }
.deepsea-message-branches-treePane { padding: 8px; overflow: auto; height: 100%; box-sizing: border-box; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); }

/* Header utility button. */
.deepsea-message-branches-headerRoot { position: relative; display: inline-flex; flex: none; }
.deepsea-message-branches-headerButton { position: relative; display: inline-flex; flex: none; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 6px;
  color: var(--dsw-alias-label-secondary); background: transparent; border: none; border-radius: 28px; cursor: pointer; }
.deepsea-message-branches-headerButton:hover, .deepsea-message-branches-headerButton[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.deepsea-message-branches-headerBadge { position: absolute; top: 1px; right: 0; min-width: 14px; height: 14px; padding: 0 4px; border-radius: 7px; box-sizing: border-box;
  background: var(--dsw-alias-brand-primary, #4d6bfe); color: #fff; font-size: 9.5px; line-height: 14px; font-weight: 600; text-align: center; }
.deepsea-message-branches-headerPopover { top: calc(100% + 6px); right: 0; min-width: 300px; }
.deepsea-message-branches-popoverFooter { display: flex; justify-content: flex-end; gap: 6px; padding: 6px 6px 2px; border-top: 0.5px solid var(--dsw-alias-border-l4, rgba(0,0,0,0.08)); margin-top: 4px; }
.deepsea-message-branches-linkButton { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; padding: 4px 6px; border-radius: 6px; }
.deepsea-message-branches-linkButton:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

/* Inline editor. */
.deepsea-message-branches-editor { display: flex; flex-direction: column; gap: 8px; width: 100%; box-sizing: border-box; padding: 10px 12px 10px;
  border-radius: 22px; background: var(--dsw-specific-bubble); border: 1px solid var(--dsw-alias-brand-primary, transparent); }
.deepsea-message-branches-editorText { width: 100%; min-height: 44px; max-height: 50vh; box-sizing: border-box; resize: none; border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px)); padding: 0 4px; }
.deepsea-message-branches-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.deepsea-message-branches-chip { position: relative; display: inline-flex; align-items: center; gap: 6px; max-width: 220px; height: 30px; padding: 0 8px 0 6px; box-sizing: border-box;
  border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); background: var(--dsw-specific-input-major, transparent);
  color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 16px; }
.deepsea-message-branches-chip[data-pending] { opacity: 0.6; }
.deepsea-message-branches-chip[data-error] { border-color: var(--dsw-alias-state-error-primary); }
.deepsea-message-branches-chipThumb { flex: none; width: 20px; height: 20px; border-radius: 5px; object-fit: cover; background: var(--dsw-alias-bg-base); }
.deepsea-message-branches-chipIcon { flex: none; width: 16px; height: 16px; }
.deepsea-message-branches-chipName { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.deepsea-message-branches-chipRemove { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; margin-left: 2px;
  border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.deepsea-message-branches-chipRemove:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.deepsea-message-branches-chipAdd { display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 10px 0 8px; border-radius: 10px; border: 0.5px dashed var(--dsw-alias-border-l2, rgba(0,0,0,0.2));
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.deepsea-message-branches-chipAdd:hover { background: var(--dsw-alias-interactive-bg-hover); }
.deepsea-message-branches-editorBar { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.deepsea-message-branches-editorError { flex: 1; min-width: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.deepsea-message-branches-button { display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 12px; border-radius: 14px; border: none;
  font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
.deepsea-message-branches-button[data-variant="ghost"] { background: transparent; color: var(--dsw-alias-label-secondary); }
.deepsea-message-branches-button[data-variant="ghost"]:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.deepsea-message-branches-button[data-variant="primary"] { background: var(--dsw-alias-brand-primary, #4d6bfe); color: #fff; }
.deepsea-message-branches-button[data-variant="primary"]:hover { filter: brightness(1.08); }
.deepsea-message-branches-button:disabled { opacity: 0.5; cursor: default; filter: none; }
`
