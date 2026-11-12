/**
 * @deepsea/preset-per-model: an agent preset per selected model
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
 *
 * A model no rule matches leaves the session alone, except that a switch
 * this plugin made is undone: the session goes back to the preset it had
 * before, when it is still on the preset the plugin chose. A preset the
 * person chose is never overridden by an unmatched model.
 */
import { readFileSync } from 'node:fs'
import { createTrace } from '@deepsea/logs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const name = 'deepsea-preset-per-model'
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
export const inject = ['agents', 'agentPresets', 'agentDefaultModel']

const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const RULE_KEYS = new Set(['provider', 'model', 'preset'])

/** Validate and detach `{ rules, trace }`; every problem names the rule. */
export function resolveConfig(input = {}) {
  if (!isMapping(input) || Object.keys(input).some(key => key !== 'rules' && key !== 'trace')) {
    throw new Error('preset-per-model: expected only rules and trace')
  }
  if (input.rules !== undefined && !Array.isArray(input.rules)) throw new Error('preset-per-model: rules must be a list')
  if (input.trace !== undefined && typeof input.trace !== 'boolean') throw new Error('preset-per-model: trace must be true or false')
  const rules = (input.rules ?? []).map((rule, index) => {
    const where = `preset-per-model: rules[${index}]`
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
    vendor: 'deepsea-preset-per-model',
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
    enabled: tracing, name: 'preset-per-model', plugin: `${pkg.name}@${pkg.version}`,
    home: options.home ?? resolveDshHome(), env: options.env,
  })

  /**
   * The switches this plugin made, by session id: the preset the session had
   * before (`from`) and the one the plugin chose (`to`). In memory: a restart
   * forgets them, and the session then keeps the preset it is on.
   */
  const switched = new Map()

  /**
   * Act on one blank session's model: switch it to the rule's preset, or with
   * no rule, undo this plugin's own switch. DSH's lock is a normal refusal.
   */
  async function decide(session, selection, rule, knownAgent) {
    let current
    try {
      current = ctx.agentPresets.presetForSession(session)
    } catch {
      return // no preset for this kind of session
    }
    const own = switched.get(session.id)
    // The person moved the session after our switch: that choice is theirs now.
    if (own !== undefined && own.to !== current) switched.delete(session.id)
    const ours = own !== undefined && own.to === current
    if (rule === undefined && !ours) return
    const target = rule?.preset ?? own.from
    trace({ event: rule === undefined ? 'restore' : 'enforce', session: session.id, current: current ?? null, target })
    if (current === target) return
    const agent = knownAgent ?? ctx.agents.get(session.id)
    if (agent === undefined) return // no live agent (a cold log replay)
    try {
      await ctx.agentPresets.select(agent, target)
      // A chain of switches remembers the preset from before the first one.
      if (rule === undefined) switched.delete(session.id)
      else switched.set(session.id, { from: ours ? own.from : current, to: target })
      trace({ event: 'selected', session: session.id, preset: target })
      ctx.logger.info(`session "${session.id}" → preset "${target}" (model ${selection.provider}/${selection.model}${rule === undefined ? ', back from this plugin\'s switch' : ''})`)
    } catch (error) {
      if (isLocked(error)) {
        switched.delete(session.id)
        trace({ event: 'locked', session: session.id, preset: target })
        return
      }
      trace({ event: 'failed', session: session.id, preset: target, error: String(error) })
      ctx.logger.warn(`could not switch session "${session.id}" to preset "${target}": ${String(error)}`)
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
    try { boundary = ctx.agents.turnBoundaryOf(session) } catch { boundary = undefined }
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
    void decide(session, selection, rule, agent).catch((error) => {
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
    void decide(session, selection, rule).catch((error) => {
      ctx.logger.warn(`enforcement failed: ${String(error)}`)
    })
  })
}
