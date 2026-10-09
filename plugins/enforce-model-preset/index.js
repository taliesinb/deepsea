/**
 * @deepsea/enforce-model-preset: an agent preset per selected model
 * (README.md).
 *
 * DSH fixes a session's preset while the session is blank and lets the model
 * be chosen independently. This plugin maps model selections to presets:
 * when a blank, top-level session selects a model a rule matches (a
 * committed `model/selection` event), or is created on a default model a rule
 * matches (`agent/created`), it switches the session's preset through
 * `ctx.agentPresets.select`, the queued, blank-checked path the GUI's picker
 * uses. A session that has started is locked by DSH itself; that refusal is
 * the intended outcome for a mid-session model change.
 */
import { readFileSync } from 'node:fs'
import { createTrace } from '@deepsea/logs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const name = 'deepsea-enforce-model-preset'
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
export const inject = ['agents', 'agentPresets', 'sessionProjections', 'agentDefaultModel']

const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const RULE_KEYS = new Set(['provider', 'model', 'preset'])

/** Validate and detach `{ rules, trace }`; every problem names the rule. */
export function resolveConfig(input = {}) {
  if (!isMapping(input) || Object.keys(input).some(key => key !== 'rules' && key !== 'trace')) {
    throw new Error('enforce-model-preset: expected only rules and trace')
  }
  if (input.rules !== undefined && !Array.isArray(input.rules)) throw new Error('enforce-model-preset: rules must be a list')
  if (input.trace !== undefined && typeof input.trace !== 'boolean') throw new Error('enforce-model-preset: trace must be true or false')
  const rules = (input.rules ?? []).map((rule, index) => {
    const where = `enforce-model-preset: rules[${index}]`
    if (!isMapping(rule)) throw new Error(`${where} must be a mapping`)
    const unknown = Object.keys(rule).filter(key => !RULE_KEYS.has(key))
    if (unknown.length > 0) throw new Error(`${where} has unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`)
    const { provider, model, preset } = rule
    if (typeof provider !== 'string' || provider.length === 0) throw new Error(`${where}.provider must be a non-empty string ('*' for any)`)
    if (model !== undefined && (typeof model !== 'string' || model.length === 0)) throw new Error(`${where}.model must be a non-empty string ('*' for any)`)
    if (typeof preset !== 'string' || preset.length === 0) throw new Error(`${where}.preset must be a non-empty preset id`)
    return { provider, ...(model === undefined ? {} : { model }), preset }
  })
  return { rules, trace: input.trace ?? false }
}

/** Cordis validates the rules before activating the plugin. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'deepsea-enforce-model-preset',
    validate(input) {
      try { return { value: resolveConfig(input) } }
      catch (error) { return { issues: [{ message: error.message }] } }
    },
  },
}

/** The first rule matching a selection, in order; undefined when none does. */
export function matchRule(rules, selection) {
  return rules.find(rule =>
    (rule.provider === '*' || rule.provider === selection.provider)
    && (rule.model === undefined || rule.model === '*' || rule.model === selection.model))
}

/** Whether a preset switch was refused because the session has started (DSH's own lock). */
export function isLocked(error) {
  return (isMapping(error) && error.code === 'agent-preset/locked') || String(error).includes('agent-preset/locked')
}

export function apply(ctx, input) {
  install(ctx, input)
}

/**
 * Listen for agent creation and model selections. `options.home` and
 * `options.env` replace the home and environment the trace's directory comes
 * from, for tests.
 */
export function install(ctx, input, options = {}) {
  const { rules, trace: tracing } = resolveConfig(input)
  if (rules.length === 0) {
    ctx.logger.warn('no rules configured; nothing to enforce')
    return
  }
  // A JSONL decision trace in the variant's log directory, one file per server process.
  const trace = createTrace({
    enabled: tracing, name: 'enforce-model-preset', plugin: `${pkg.name}@${pkg.version}`,
    home: options.home ?? resolveDshHome(), env: options.env,
  })

  /** Switch one blank session to the rule's preset; DSH's lock is a normal refusal. */
  async function enforce(session, selection, rule, knownAgent) {
    let current
    try {
      current = ctx.sessionProjections.stateOf(session, 'agentPreset')
    } catch {
      return // no preset projection for this kind of session
    }
    trace({ event: 'enforce', session: session.id, current: current ?? null, target: rule.preset })
    if (current === rule.preset) return
    const agent = knownAgent ?? ctx.agents.get(session.id)
    if (agent === undefined) return // no live agent (a cold log replay)
    try {
      await ctx.agentPresets.select(agent, rule.preset)
      trace({ event: 'selected', session: session.id, preset: rule.preset })
      ctx.logger.info(`session "${session.id}" → preset "${rule.preset}" (model ${selection.provider}/${selection.model})`)
    } catch (error) {
      if (isLocked(error)) {
        trace({ event: 'locked', session: session.id, preset: rule.preset })
        return
      }
      trace({ event: 'failed', session: session.id, preset: rule.preset, error: String(error) })
      ctx.logger.warn(`could not switch session "${session.id}" to preset "${rule.preset}": ${String(error)}`)
    }
  }

  // A session that never picks a model runs on the deployment default, which
  // may be a mapped provider (the picker remembers a choice by making it the
  // default), and no `model/selection` ever fires for it. Enforce at agent
  // creation on the effective default; a later explicit selection
  // re-enforces through the event below.
  ctx.on('agent/created', ({ agent }) => {
    const session = agent.session
    const depth = session.header?.delegationDepth ?? 0
    trace({ event: 'agent-created', session: session.id, depth })
    if (depth > 0) return // a subagent joins its parent's composition
    // Blank = no turn has run. The preamble makes a fresh session's seq
    // non-zero, so the turn boundary is the test; `select` re-checks it under
    // its queue and refuses with agent-preset/locked otherwise.
    let boundary
    try { boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary') } catch { boundary = undefined }
    if (boundary !== undefined && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0)) return
    let selection
    try {
      selection = ctx.agentDefaultModel.currentSelection()
    } catch (error) {
      trace({ event: 'default-failed', session: session.id, error: String(error) })
      return
    }
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return
    const rule = matchRule(rules, selection)
    trace({ event: 'default-selection', session: session.id, provider: selection.provider, model: selection.model, rule: rule ?? null })
    if (rule === undefined) return
    void enforce(session, selection, rule, agent).catch((error) => {
      ctx.logger.warn(`enforcement at creation failed: ${String(error)}`)
    })
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'model/selection') return
    if ((session.header?.delegationDepth ?? 0) > 0) return
    const selection = event.data
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return
    const rule = matchRule(rules, selection)
    trace({ event: 'selection', session: session.id, provider: selection.provider, model: selection.model, rule: rule ?? null })
    if (rule === undefined) return
    void enforce(session, selection, rule).catch((error) => {
      ctx.logger.warn(`enforcement failed: ${String(error)}`)
    })
  })
}
