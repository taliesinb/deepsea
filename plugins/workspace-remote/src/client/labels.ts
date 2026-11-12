/**
 * Labels shared with the local tree, so remote rows and dialogs read like the
 * shell's own (English, as the rest of this plugin's UI).
 */

/** A blank session's row (the shell's `session.new`). */
export const NEW_SESSION_LABEL = 'New Session'

/** The title the harness gives the first-use workspace (its `DEFAULT_WORKSPACE_DIRECTORY`). */
const DEFAULT_WORKSPACE_TITLE = 'default-workspace'

/**
 * How a workspace title reads: the first-use workspace's automatic title as
 * "Default workspace", as the shell labels it (`workspaceDisplayTitle` in the
 * harness's workspace-controller), every other title verbatim.
 * @param title - a stored workspace title, here or on a remote.
 * @returns the label.
 */
export function workspaceLabel(title: string): string {
  return title === DEFAULT_WORKSPACE_TITLE ? 'Default workspace' : title
}
