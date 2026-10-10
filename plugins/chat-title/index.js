/**
 * @deepsea/chat-title: lets the agent rename the chat, as a reviewer of the
 * automatic title rather than a second titler.
 *
 * Division of labour with the harness's session-title service and its LLM
 * titler (`session-title-llm`, mounted by the `base` bundle): the titler
 * names every chat from the first message with a cheap side request; this
 * plugin shows the agent that title and lets it rename only when the title
 * is wrong or generic (a greeting-only first message), when a more accurate
 * name suggests itself, or when the subject moves. The two never race:
 * `sessionTitle.rename` aborts in-flight automatic generation and, being
 * `user`-sourced, stops later automatic retitles.
 *
 * Three pieces, all host-side (no browser half):
 *
 *   rename_chat            tool: `ctx.sessionTitle.rename(session, title)` on
 *                          the calling agent's own top-level session, after
 *                          applying the configured style (slug / natural).
 *                          Refuses in subagent sessions and never overrides a
 *                          title the person chose (sidebar Rename, a `slug: `
 *                          prefix).
 *   system-prompt section  the rule: review the automatic title, rename only
 *                          when it is wrong, generic or stale.
 *   runtime-context line   while the title is automatic (fallback / provider),
 *                          the runtime context carries the current title so
 *                          the agent can judge it. Empty before the titler has
 *                          written anything and once the agent or the person
 *                          has named the chat. Changes at most three times per
 *                          chat (fallback, provider, gone); each change is one
 *                          appended snapshot message.
 *
 * Config (all optional):
 *
 *   toolName: rename_chat   # model-facing tool name
 *   style: inherit          # inherit (the titler row's style) | slug | natural
 *   maxWords: 5             # word cap for slugs / guidance for phrases
 *   promptHint: true        # the system-prompt section
 *   nudge: true             # the runtime-context line while the title is automatic
 */

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ChatTitleError, META_KEY, agentTitlesOf, classifyTitle, styleGuidance, styleTitle } from './title.mjs'

export const name = 'deepsea-chat-title'

export const inject = ['tools', 'sessionTitle', 'systemPrompt']

export const Config = Schema.object({
  toolName: Schema.string().default('rename_chat'),
  /** `inherit` reads `style` from the session-title-llm row so agent titles match automatic ones. */
  style: Schema.union(['inherit', 'slug', 'natural']).default('inherit'),
  /** Word cap for slugs / phrase length guidance; unset = the titler row's `targetWords`, else 5. */
  maxWords: Schema.number().min(1).max(12),
  promptHint: Schema.boolean().default(true),
  nudge: Schema.boolean().default(true),
})

/** Name of the system-prompt section. */
export const PROMPT_SECTION = 'tool:deepsea-chat-title'
/** Name of the runtime-context contribution. */
export const NUDGE_CONTEXT = 'deepsea-chat-title:nudge'

/** Package names of the harness's LLM titlers (`base` mounts the first-prompt one as row `session-title-llm`). */
const TITLER_ROW = /(^|\/)dsh-session-title(-first-prompt|-all-prompts)?-llm$/

/**
 * Read the automatic titler's `style` and `targetWords` from its loader row,
 * so the agent's titles come out in the same form as the automatic ones.
 * @param {any} ctx
 * @returns {{ style?: 'slug' | 'natural', targetWords?: number, found: boolean }}
 */
export function titlerSettings(ctx) {
  const loader = ctx.get('loader')
  if (loader === undefined || typeof loader.entries !== 'function') return { found: false }
  for (const entry of loader.entries()) {
    const options = entry?.options
    if (typeof options?.name !== 'string' || !TITLER_ROW.test(options.name)) continue
    const raw = options.config
    const config = raw !== null && typeof raw === 'object' ? raw : {}
    return {
      found: true,
      ...(config.style === 'slug' || config.style === 'natural' ? { style: config.style } : {}),
      ...(Number.isInteger(config.targetWords) && config.targetWords > 0 ? { targetWords: config.targetWords } : {}),
    }
  }
  return { found: false }
}

/**
 * Resolve the effective title style: the row's own settings, else the
 * titler's, else the harness default (`natural`, 5 words).
 * @param {any} ctx
 * @param {{ toolName: string, style: 'inherit' | 'slug' | 'natural', maxWords?: number }} config
 * @returns {{ toolName: string, style: 'slug' | 'natural', maxWords: number, inherited: boolean }}
 */
export function resolveStyle(ctx, config) {
  const titler = titlerSettings(ctx)
  const style = config.style === 'inherit' ? (titler.style ?? 'natural') : config.style
  const maxWords = config.maxWords ?? titler.targetWords ?? 5
  return { toolName: config.toolName, style, maxWords: Math.max(1, Math.min(12, maxWords)), inherited: config.style === 'inherit' && titler.found }
}

/**
 * The system-prompt section: the standing rule the model works under.
 * @param {{ toolName: string, style: 'slug' | 'natural', maxWords: number }} config - resolved style
 */
export function promptSection(config) {
  return `Chat title: the chat is titled automatically from the first message; the current title appears in the runtime context. `
    + `Call ${config.toolName} when that title is wrong or generic (for example after a greeting-only first message), `
    + 'when a more accurate name suggests itself within the first few turns, or when the subject of the chat changes. '
    + `Title: ${styleGuidance(config)} Never override a title the user set themselves.`
}

/**
 * The runtime-context line shown while the chat carries an automatic title:
 * the title itself, so the agent can judge it. Empty before the automatic
 * titler has written anything (no title to review yet) and once the agent or
 * the person has named the chat. The two automatic sources read differently:
 * the service's `fallback` (the first words of the first message) is a
 * placeholder to replace; a `provider` title (the LLM titler) is a real
 * attempt to keep unless it is wrong.
 * @param {{ toolName: string }} config
 * @param {'none' | 'automatic' | 'agent' | 'user'} kind - from classifyTitle
 * @param {{ title: string, source: { kind: string } } | undefined} current - the standing title snapshot
 */
export function nudgeText(config, kind, current) {
  if (kind !== 'automatic' || current === undefined) return ''
  if (current.source.kind === 'fallback') {
    return `Chat title: "${current.title}" is a placeholder (the first words of the first message). Call ${config.toolName} with a real title once you know what this chat is about.`
  }
  return `Automatic chat title: "${current.title}". Keep it if it describes this chat; call ${config.toolName} if it is wrong or generic, or if the work so far suggests a more accurate name.`
}

/**
 * Build the rename tool.
 * @param {any} ctx
 * @param {{ toolName: string, style: 'slug' | 'natural', maxWords: number }} config
 * @param {WeakMap<object, string>} applied - session → last title this process applied
 */
export function createRenameTool(ctx, config, applied) {
  return defineTool({
    name: config.toolName,
    description: `Rename this chat (the title shown in the sidebar). Use it when the automatic title is wrong or generic, when the work so far suggests a more accurate name, or when the subject of the chat changes. Title: ${styleGuidance(config)} Refuses if the user renamed the chat themselves or when called from a subagent.`,
    parameters: {
      title: { type: 'string', required: true, description: 'The new chat title: what this chat is about.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderResult(value, config) }],
      presentationMeta: (_args, value) => ({ [META_KEY]: value.applied ? value.title : null }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) throw new ChatTitleError('no live session is attached to this call.', 'CHAT_TITLE_NO_SESSION')
      if (session.header?.parentSession !== undefined) {
        throw new ChatTitleError('this is a subagent session; only the top-level agent names the chat. Do not retry.', 'CHAT_TITLE_SUBAGENT')
      }
      const raw = typeof args.title === 'string' ? args.title : ''
      const title = styleTitle(raw, config)
      if (title.length === 0) throw new ChatTitleError(`title "${raw}" is empty after normalization; use a few descriptive words.`, 'CHAT_TITLE_EMPTY')

      const current = ctx.sessionTitle.get(session)
      const kind = classifyTitle(current, agentTitlesOf(session.snapshotEvents()), applied.get(session))
      if (kind === 'user') {
        return { applied: false, reason: 'user-titled', title: current.title, requested: title }
      }
      if (current !== undefined && current.title === title && kind === 'agent') {
        return { applied: false, reason: 'unchanged', title, requested: title }
      }
      const snapshot = ctx.sessionTitle.rename(session, title)
      applied.set(session, snapshot.title)
      return { applied: true, title: snapshot.title, requested: title, previous: current?.title ?? null, previousKind: kind }
    },
    presentCall: (args) => ({ card: 'generic', title: `Rename chat: ${String(args?.title ?? '')}`, kind: 'write' }),
  })
}

/**
 * @param {any} value
 * @param {{ toolName: string }} config
 */
function renderResult(value, config) {
  if (value.applied) {
    const was = value.previous === null ? '' : ` (was "${value.previous}")`
    return `Chat renamed to "${value.title}"${was}. Rename again only if the subject changes.`
  }
  if (value.reason === 'user-titled') {
    return `Not renamed: the user named this chat "${value.title}" themselves. Do not call ${config.toolName} again in this chat.`
  }
  return `Chat is already named "${value.title}".`
}

export function apply(ctx, rawConfig) {
  // The style is read once, when this row loads; a later change to the
  // titler row's `style` takes effect on the next reload of this row.
  const config = resolveStyle(ctx, rawConfig)
  /** session → the title this process last applied there (supplements the durable tool/result meta). */
  const applied = new WeakMap()
  const tool = createRenameTool(ctx, config, applied)
  ctx.tools.register(tool)

  /**
   * Whether this assembly should carry the title text at all: a top-level
   * agent (subagents cannot rename) whose scope can see the tool. A preset
   * without tools (`ctx.tools.restrict({ allow: [] })`) hides it, and with it
   * the section and the line; an instruction to call a tool the model cannot
   * call would only confuse it.
   */
  const applies = (context) => {
    const session = context?.agent?.session
    return session !== undefined
      && session.header?.parentSession === undefined
      && ctx.tools.get(config.toolName, context.scope) !== undefined
  }

  if (rawConfig.promptHint) {
    ctx.systemPrompt.section({
      name: PROMPT_SECTION,
      order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY') + 50,
      text: (context) => (applies(context) ? promptSection(config) : ''),
    })
  }

  if (rawConfig.nudge) {
    ctx.systemPrompt.context({
      name: NUDGE_CONTEXT,
      order: ctx.systemPrompt.getContextOrder('APPROVAL_POLICY') + 20,
      text: (context) => {
        if (!applies(context)) return ''
        const session = context.agent.session
        const current = ctx.sessionTitle.get(session)
        const kind = classifyTitle(current, agentTitlesOf(session.snapshotEvents()), applied.get(session))
        return nudgeText(config, kind, current)
      },
    })
  }

  ctx.logger.info(`chat-title: registered ${config.toolName} (style ${config.style}${config.inherited ? ' from the session-title-llm row' : ''}, maxWords ${config.maxWords}, promptHint ${rawConfig.promptHint}, nudge ${rawConfig.nudge})`)
}
