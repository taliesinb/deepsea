/**
 * @deepsea/session-introspect: read other agents' session transcripts from
 * inside a session, through `ctx.sessionQuery` (never the zstd logs):
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
 * `node/deepsea-personal`, host:port or a URL; remote.mjs). The same plugin
 * on that instance serves the logs (serve.mjs, three GET routes under
 * /api/deepsea-session-introspect/v1 behind DSH's normal admission), so a
 * remote needs no configuration on either side beyond being on the tailnet.
 * Tools are registered globally (read-only, no per-session state), so every
 * agent, including subagents, sees them.
 *
 * Config (all optional):
 *
 *   scope: all                 # all | workspace: which LOCAL sessions are visible (workspace = same cwd as the caller only)
 *   maxChars: 24000            # inline rendering budget before rows are omitted (out_file lifts it)
 *   maxResultChars: 400        # excerpt length per tool result / message in transcript_read
 *   findLimit: 20              # default rows of transcript_find
 *   grepLimit: 50              # default hits of transcript_grep
 *   serve: true                # answer /api/deepsea-session-introspect/v1/* for other instances' tools (needs ctx.connection)
 *   remoteTimeoutMs: 20000     # per request to a remote instance
 *   remoteConcurrency: 4       # parallel log reads from one remote in corpus tools
 *   tailscaleBinary: ''        # path of the tailscale CLI ('' = PATH, then the macOS app's binary)
 *   trace: false               # JSONL lifecycle trace in the variant's log directory (@deepsea/logs)
 */

import { readFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { createTailnet } from './remote.mjs'
import { createResolver } from './resolve.mjs'
import { registerTranscriptRoutes } from './serve.mjs'
import { createLocalSource } from './source.mjs'
import { createTools } from './tools.mjs'
import { createTrace } from '@deepsea/logs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const name = 'deepsea-session-introspect'

export const inject = ['tools', 'sessionQuery']

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export const Config = Schema.object({
  scope: Schema.union(['all', 'workspace']).default('all'),
  maxChars: Schema.number().min(2000).default(24_000),
  maxResultChars: Schema.number().min(40).default(400),
  findLimit: Schema.number().min(1).max(500).default(20),
  grepLimit: Schema.number().min(1).max(1000).default(50),
  serve: Schema.boolean().default(true),
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
  const trace = deps.trace ?? createTrace({ enabled: config.trace, name: 'session-introspect', plugin: `${pkg.name}@${pkg.version}`, home: resolveDshHome() })
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
  const { local, tools, trace } = build(ctx, config)
  for (const tool of tools) ctx.tools.register(tool)
  trace({ event: 'registered', tools: tools.map(tool => tool.name), scope: config.scope })
  ctx.logger.info(`session-introspect: registered ${tools.map(tool => tool.name).join(', ')} (scope ${config.scope})`)
  if (config.serve) {
    // The routes need the Connection service (absent in headless compositions);
    // waiting for it here keeps the tools available either way.
    ctx.inject(['connection'], (scoped) => {
      const paths = registerTranscriptRoutes(scoped, local, { trace })
      trace({ event: 'serving', paths })
      scoped.logger.info(`session-introspect: serving ${paths.join(', ')} for remote transcript_* tools`)
    })
  }
}
