/**
 * @deepsea/variant-identity: tell DeepSea variants apart in any browser. The
 * sidebar wordmark reads the variant's display name, the whale (sidebar and
 * favicon) takes its colour, the window title carries the name, and the
 * build-version chip under the wordmark is quietened.
 *
 * The identity comes from the variant itself, `$DSH_HOME/variant.yml`
 * (`display`, `color`), read when the server starts; the row's config
 * overrides it key by key (identity.mjs). A home without variant.yml shows
 * only what is configured, so on a stock home the plugin changes nothing.
 *
 * Host-only: a `<style>` row and a body `<script>` row on the web server's
 * `webserver/index-inject` table, and, with a colour, exact routes for
 * `/favicon.svg` and `/favicon-dark.svg` (named routes answer before the
 * static frontend's fallback).
 */
import { readFileSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { faviconSvg, identityStyle, readVariant, resolveConfig, resolveIdentity, titleScript } from './identity.mjs'

export const name = 'deepsea-variant-identity'
export const inject = ['webServer']

export const Config = { '~standard': { version: 1, vendor: 'deepsea-variant-identity', validate(input) {
  try { return { value: resolveConfig(input ?? undefined) } }
  catch (error) { return { issues: [{ message: error.message }] } }
} } }

const FAVICON_TEMPLATE = new URL('./favicon.svg', import.meta.url)
const FAVICON_PATHS = ['/favicon.svg', '/favicon-dark.svg']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ display?: string, color?: string, versionBadge?: 'subtle' | 'stock' }} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const home = resolveDshHome()
  let variant
  try {
    variant = readVariant(home)
  } catch (error) {
    ctx.logger.warn(`variant-identity: cannot read ${home}/variant.yml: ${error?.message ?? error}`)
  }
  const identity = resolveIdentity(config, variant, home)
  for (const note of identity.notes) ctx.logger.warn(`variant-identity: ${note}`)

  const style = identityStyle(identity)
  const script = identity.display === '' ? '' : titleScript(identity.display)
  if (style !== '' || script !== '') {
    ctx.on('webserver/index-inject', (table) => {
      if (style !== '') table.push({ kind: 'style', text: `/* deepsea-variant-identity */\n${style}` })
      if (script !== '') table.push({ kind: 'script', placement: 'body', text: script })
    })
  }

  if (identity.color !== '') {
    const body = faviconSvg(readFileSync(FAVICON_TEMPLATE, 'utf8'), identity.color)
    for (const path of FAVICON_PATHS) {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store, max-age=0' })
          res.end(req.method === 'HEAD' ? undefined : body)
        },
      }), `variant-identity: ${path}`)
    }
  }

  const source = variant === undefined ? 'no variant.yml' : 'variant.yml'
  const configured = Object.keys(config).length === 0 ? '' : ', config'
  if (style === '' && script === '' && identity.color === '') {
    ctx.logger.info(`variant-identity: nothing to show (${source}${configured})`)
  } else {
    ctx.logger.info(`variant-identity: ${identity.display === '' ? 'stock name' : JSON.stringify(identity.display)}, `
      + `whale ${identity.color === '' ? 'stock' : identity.color}, version chip ${identity.versionBadge} (${source}${configured})`)
  }
}
