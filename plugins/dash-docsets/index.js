/**
 * @deepsea/dash-docsets: tools over the local HTTP API of Dash 8, the macOS
 * documentation browser.
 *
 *   dash_list_docsets   installed docsets with model-friendly keys
 *   dash_search         fuzzy symbol/section search across (selected) docsets
 *   dash_get_page       a page or page section as Markdown (MathML → LaTeX)
 *
 * The API server inside Dash (Settings ▸ Integration ▸ API Server) publishes
 * its per-launch port in ~/Library/Application Support/Dash/.dash_api_server/
 * status.json. Nothing is contacted until a tool runs; then Dash is launched
 * hidden (`open -g -j -b <bundle id>`) and the server enabled with
 * `defaults write <domain> DHAPIServerEnabled -bool YES` when the config
 * allows it. Tools are registered globally (they carry no per-session state),
 * so every agent, including subagents, sees them.
 *
 * Config (all optional):
 *
 *   autoLaunch: true            # launch Dash in the background when it is not running
 *   autoEnableApi: true         # turn the API server on when it is off
 *   bundleIds: [com.kapeli.dash-setapp, com.kapeli.dashdoc]   # tried in order by `open -b`
 *   defaultsDomains: [com.kapeli.dash-setapp, com.kapeli.dashdoc]
 *   maxChars: 60000             # dash_get_page truncation (full text saved to a scratch file)
 *   defaultMaxResults: 20       # dash_search default
 *   docsetCacheSeconds: 300     # how long the docset list (keys ↔ identifiers) is cached
 *   requestTimeoutMs: 30000
 *   trace: false                # JSONL lifecycle trace in the variant's log directory (@deepsea/logs)
 */

import { readFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { createDashClient } from './dash.mjs'
import { createTools } from './tools.mjs'
import { createTrace } from '@deepsea/logs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const name = 'deepsea-dash-docsets'

export const inject = ['tools']

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export const Config = Schema.object({
  autoLaunch: Schema.boolean().default(true),
  autoEnableApi: Schema.boolean().default(true),
  bundleIds: Schema.array(Schema.string()).default(['com.kapeli.dash-setapp', 'com.kapeli.dashdoc']),
  defaultsDomains: Schema.array(Schema.string()).default(['com.kapeli.dash-setapp', 'com.kapeli.dashdoc']),
  maxChars: Schema.number().min(1000).default(60_000),
  defaultMaxResults: Schema.number().min(1).max(200).default(20),
  docsetCacheSeconds: Schema.number().min(0).default(300),
  requestTimeoutMs: Schema.number().min(1000).default(30_000),
  trace: Schema.boolean().default(false),
})

/**
 * Build the client and tool definitions for a config (shared by apply, the
 * tests and the scripts).
 * @param {ReturnType<typeof Config>} config
 * @param {{ logger?: any, trace?: (line: object) => void }} [deps] - `trace` replaces the configured one (tests)
 */
export function build(config, deps = {}) {
  const trace = deps.trace ?? createTrace({ enabled: config.trace, name: 'dash-docsets', plugin: `${pkg.name}@${pkg.version}`, home: resolveDshHome() })
  const dash = createDashClient({
    autoLaunch: config.autoLaunch,
    autoEnableApi: config.autoEnableApi,
    bundleIds: config.bundleIds,
    defaultsDomains: config.defaultsDomains,
    timeoutMs: config.requestTimeoutMs,
    trace,
  })
  const tools = createTools({
    dash,
    limits: { maxChars: config.maxChars, defaultMaxResults: config.defaultMaxResults, docsetCacheMs: config.docsetCacheSeconds * 1000 },
    trace,
  })
  return { dash, tools, trace, logger: deps.logger }
}

export function apply(ctx, config) {
  const { tools, trace } = build(config, { logger: ctx.logger })
  for (const tool of tools) ctx.tools.register(tool)
  trace({ event: 'registered', tools: tools.map(tool => tool.name) })
  ctx.logger.info(`dash-docsets: registered ${tools.map(tool => tool.name).join(', ')}`)
}
