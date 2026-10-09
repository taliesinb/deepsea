/**
 * @deepsea/tool-transcripts: the package root, row `deepsea-tool-transcripts`
 * ("Transcript sharing", global). It makes THIS instance's transcripts
 * readable by other instances' transcript_* tools (`remote: …`): three GET
 * routes under /api/deepsea-session-introspect/v1 (serve.mjs) behind DSH's
 * normal admission, over `ctx.sessionQuery`.
 *
 * The tools themselves are the subpath row `@deepsea/tool-transcripts/tools`
 * (tools.js, `deepsea-tool-transcripts-tools`), which joins the agent presets.
 * The routes stay here, in a global row: a preset row would register them
 * once per preset, and the second registration of an exact route fails.
 *
 * Config (all optional):
 *
 *   serve: true                # answer /api/deepsea-session-introspect/v1/* for other instances' tools (needs ctx.connection)
 *   trace: false               # JSONL lifecycle trace in the variant's log directory (@deepsea/logs)
 *
 * The tools' settings (scope, limits, remote keys) are the tools row's.
 */

import { readFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { registerTranscriptRoutes } from './serve.mjs'
import { createLocalSource } from './source.mjs'
import { createTrace } from '@deepsea/logs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const name = 'deepsea-tool-transcripts'

export const inject = ['sessionQuery']

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export const Config = Schema.object({
  serve: Schema.boolean().default(true),
  trace: Schema.boolean().default(false),
})

/** The plugin's optional JSONL trace (both rows write one when their `trace` is on). */
export function openTrace(config) {
  return createTrace({ enabled: config.trace, name: 'tool-transcripts', plugin: `${pkg.name}@${pkg.version}`, home: resolveDshHome() })
}

/**
 * @param {any} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  if (!config.serve) return
  const trace = openTrace(config)
  const local = createLocalSource(ctx, { trace })
  // The routes need the Connection service (absent in headless compositions).
  ctx.inject(['connection'], (scoped) => {
    const paths = registerTranscriptRoutes(scoped, local, { trace })
    trace({ event: 'serving', paths })
    scoped.logger.info(`tool-transcripts: serving ${paths.join(', ')} for remote transcript_* tools`)
  })
}
