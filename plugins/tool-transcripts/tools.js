/**
 * @deepsea/tool-transcripts/tools: the subpath row
 * `deepsea-tool-transcripts-tools` ("Transcript tools"), which joins the agent
 * presets that have upstream's `@deepseek-ai/dsh-tool-subagent` (package.json
 * `deepsea.presets`): the seven read-only transcript_* tools (tools.mjs),
 * reading other agents' session transcripts through `ctx.sessionQuery`
 * (never the zstd logs):
 *
 *   transcript_find         sessions by workspace/title/id/age (no log reads)
 *   transcript_outline      per-turn table of contents with seq ranges
 *   transcript_read         compact timeline of a turn / seq range (or raw events)
 *   transcript_tool_stats   per-tool errors, latency, top error messages, what-happened-next
 *   transcript_grep         regex over prompts, assistant text, tool args/results
 *   transcript_event        one full raw event by seq
 *   transcript_export       joined call/result rows (+ text rows) as jsonl for offline analysis
 *
 * Every tool takes `fmt` (text | json | jsonl), `out_file` (write the
 * complete rendering through ctx.fs under the session's sandbox mode) and
 * `remote` (read another instance's sessions over the tailnet: `node`,
 * `node/deepsea-personal`, host:port or a URL; remote.mjs). The package root
 * on that instance (index.js, global) serves the logs, so a remote needs no
 * configuration on either side beyond being on the tailnet. The tools are
 * read-only and keep no per-session state, so they work from a preset's
 * context, shared by its agents, subagents included.
 *
 * Config (all optional):
 *
 *   scope: all                 # all | workspace: which LOCAL sessions are visible (workspace = same cwd as the caller only)
 *   maxChars: 24000            # inline rendering budget before rows are omitted (out_file lifts it)
 *   maxResultChars: 400        # excerpt length per tool result / message in transcript_read
 *   findLimit: 20              # default rows of transcript_find
 *   grepLimit: 50              # default hits of transcript_grep
 *   remoteTimeoutMs: 20000     # per request to a remote instance
 *   remoteConcurrency: 4       # parallel log reads from one remote in corpus tools
 *   tailscaleBinary: ''        # path of the tailscale CLI ('' = PATH, then the macOS app's binary)
 *   trace: false               # JSONL lifecycle trace in the variant's log directory (@deepsea/logs)
 */

import Schema from '@deepseek-ai/schemastery'
import { createTailnet } from './remote.mjs'
import { createResolver } from './resolve.mjs'
import { createLocalSource } from './source.mjs'
import { createTools } from './tools.mjs'
import { openTrace } from './index.js'

export const name = 'deepsea-tool-transcripts-tools'

export const inject = ['tools', 'sessionQuery']

export const Config = Schema.object({
  scope: Schema.union(['all', 'workspace']).default('all'),
  maxChars: Schema.number().min(2000).default(24_000),
  maxResultChars: Schema.number().min(40).default(400),
  findLimit: Schema.number().min(1).max(500).default(20),
  grepLimit: Schema.number().min(1).max(1000).default(50),
  remoteTimeoutMs: Schema.number().min(1000).default(20_000),
  remoteConcurrency: Schema.number().min(1).max(16).default(4),
  tailscaleBinary: Schema.string().default(''),
  trace: Schema.boolean().default(false),
})

/**
 * Build source, resolver + tool definitions for a config (shared by apply and tests).
 * @param {any} ctx
 * @param {any} config
 * @param {{ tailnet?: ReturnType<typeof createTailnet>, fetch?: typeof fetch, trace?: (line: object) => void }} [deps] - test seams
 */
export function build(ctx, config, deps = {}) {
  const trace = deps.trace ?? openTrace(config)
  const local = createLocalSource(ctx, { trace })
  const tailnet = deps.tailnet ?? createTailnet({ binary: config.tailscaleBinary || undefined })
  const resolver = createResolver({ local, tailnet }, {
    scope: config.scope,
    remoteTimeoutMs: config.remoteTimeoutMs,
    remoteConcurrency: config.remoteConcurrency,
    fetch: deps.fetch,
    trace,
  })
  const tools = createTools({
    ctx,
    resolver,
    limits: { maxChars: config.maxChars, maxResultChars: config.maxResultChars, findLimit: config.findLimit, grepLimit: config.grepLimit },
    trace,
  })
  return { local, resolver, tools, trace }
}

export function apply(ctx, config) {
  const { tools, trace } = build(ctx, config)
  for (const tool of tools) ctx.tools.register(tool)
  trace({ event: 'registered', tools: tools.map(tool => tool.name), scope: config.scope })
  ctx.logger.info(`tool-transcripts: registered ${tools.map(tool => tool.name).join(', ')} (scope ${config.scope})`)
}
