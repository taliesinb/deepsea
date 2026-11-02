/**
 * @deepsea/no-global-tools: an agent-preset row that hides every
 * deployment-global tool from the agents composed under its preset
 * (README.md).
 *
 * Host plugins register their tools globally, so a preset that merely leaves
 * out the in-tree tool groups still carries all of theirs. `ctx.tools.restrict`
 * is the per-agent mask: an empty allow list keeps no global tool, while tools
 * registered inside the preset (scoped registrations) stay visible. Mount it
 * from a preset, where `ctx` is an agent scope; `restrict` refuses a
 * context-global call, so a profile row fails to load.
 */
export const name = 'deepsea-no-global-tools'
export const inject = ['tools']

export function apply(ctx) {
  // An effect of this row: unloading it (or the agent) lifts the restriction.
  ctx.tools.restrict({ allow: [] })
}
