/**
 * @deepsea/tools: `/tools [pattern …]` lists the tools the session's
 * agent can call, without a model turn. Two halves:
 *
 *   host (this file)   the command; its result text is a count line followed
 *                      by a JSON listing (listing.mjs `encodeListing`)
 *   browser (lib/client.js, src/client/)
 *                      the `/tools` card on the keyed
 *                      `conversation.chat.commandview` slot: a table of
 *                      name | arguments | description, rows expand to the
 *                      full description and every parameter
 *
 *   /tools                 every visible tool, sorted by name
 *   /tools *session*       glob on the name (case-insensitive; `*`, `?`)
 *   /tools chrome_ safari_ bare words: substring of the name, else of the
 *                          description; several patterns combine with OR
 *   /tools wait            an exact name (or a single match) opens that row
 *
 * The list is `ctx.tools.schemas(agent)`: the agent object is the scope key
 * the registry uses for that agent's dispatch and system prompt
 * (`dsh-agent` dispatch passes `scope: agent`), so restrictions from its
 * preset (`ctx.tools.restrict`) and its own scoped registrations apply
 * exactly as they do for the model. Under the `ptc` presentation the model
 * is sent only `run_code` and reaches the rest through it; the listing still
 * holds every tool and carries `mode: 'ptc'`. The mode is read through the
 * registry's `modeFor(scope)`, which is private in the TypeScript source (no
 * public accessor exists); when it is missing the mode is left out.
 */

import { encodeListing, parsePatterns, selectTools, sortTools, toolEntry, LISTING_VERSION } from './listing.mjs'

export const name = 'deepsea-tools'

export const inject = ['commands', 'tools']

/**
 * Run `/tools` against one tool list. Exported for tests.
 * @param {{ name: string, description?: string, parameters?: any }[]} schemas
 * @param {string} rawInput
 * @param {string} [mode] - the agent's tool presentation (`native` | `ptc` | `both`), when known.
 * @returns {{ kind: 'success' | 'error', text: string }}
 */
export function runTools(schemas, rawInput, mode) {
  const patterns = parsePatterns(rawInput)
  const tools = sortTools(schemas)
  if (tools.length === 0) return { kind: 'success', text: 'No tools visible to this agent.' }
  const { matched, exact } = selectTools(tools, patterns)
  if (exact === undefined && matched.length === 0) {
    return { kind: 'error', text: `No tools match ${patterns.join(' ')} (${String(tools.length)} visible).` }
  }
  const focus = exact ?? (matched.length === 1 && patterns.length > 0 ? matched[0] : undefined)
  const listing = {
    v: LISTING_VERSION,
    total: tools.length,
    patterns,
    ...mode === undefined ? {} : { mode },
    ...focus === undefined ? {} : { focus: focus.name },
    tools: matched.map(toolEntry),
  }
  return { kind: 'success', text: encodeListing(listing) }
}

/**
 * The agent's tool presentation through the registry's private `modeFor`;
 * undefined when unavailable or failing.
 * @param {any} tools - the `tools` service.
 * @param {object} agent
 */
export function presentationOf(tools, agent) {
  try {
    const mode = typeof tools.modeFor === 'function' ? tools.modeFor(agent) : undefined
    return typeof mode === 'string' ? mode : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  // register() is itself an effect of ctx (unregistered on unload). The
  // browser card is keyed by this name, so it is not configurable.
  ctx.commands.register({
    name: 'tools',
    description: 'List the tools this session\'s agent can call: name, arguments, description',
    input: { hint: '[name | glob | word …]' },
    handler: ({ agent, rawInput }) => runTools(ctx.tools.schemas(agent), rawInput, presentationOf(ctx.tools, agent)),
  })
}
