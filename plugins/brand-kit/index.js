/**
 * @deepsea/brand-kit, host half: re-brand the web GUI from brand profiles.
 * No brand is built in and the row has no config: a brand is a profile, a
 * directory in the plugin's state directory (profiles.mjs), managed from the
 * bundle's card in the Plugins panel (src/client/profiles-card.tsx) or from
 * cli.mjs. One profile is active; none active is the shipped look.
 *
 * Every page render reads the active profile (`webserver/index-inject` is
 * emitted per request), so applying one is a page reload, not a restart. An
 * active profile that no longer validates is reported on the card and the
 * shipped look stands in.
 *
 * This half contributes a `<style>` row (font faces, the classes the browser
 * half's components wear, the headline, the badge, the accent) and a
 * `global` row the browser half reads (`__DEEPSEA_BRAND_KIT__`), and owns the
 * Fetch routes below `/api/deepsea-brand-kit`:
 *
 *   GET  /api/deepsea-brand-kit                  the card's state
 *   POST /api/deepsea-brand-kit                  JSON { action, name, to?, profile? }:
 *                                                apply | create | save | duplicate | rename | delete
 *   POST /api/deepsea-brand-kit/upload?name=&kind=mark|font&file=   a file into a profile (octet-stream)
 *   POST /api/deepsea-brand-kit/import?file=     a .brand.zip as a new profile (octet-stream)
 *   GET  /api/deepsea-brand-kit/export?name=     a profile as <name>.brand.zip
 *   GET  /api/deepsea-brand-kit/asset?s=&k=&f=   a file a profile names (nothing else)
 *
 * State-changing requests must carry a JSON or octet-stream body type, which
 * a cross-site form cannot send without a CORS preflight.
 */
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { API_PATH, ASSET_TYPES, assetPath, brandStyle, clientPayload, normalizeBrand } from './brand.mjs'
import { ProfileStore, nameFromFile, stateDirectory } from './profiles.mjs'

export const name = 'deepsea-brand-kit'
export const inject = ['connection']

const SHIPPED_LOOK = normalizeBrand({})
const message = error => (error instanceof Error ? error.message : String(error)).replace(/^brand-kit: /, '')
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const mediaType = request => (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const store = new ProfileStore(stateDirectory())

  /**
   * What the page gets now: the active profile when one is set and valid,
   * else the shipped look.
   * @returns {{ profile: string, brand: import('./brand.mjs').Brand, error?: string }}
   */
  function effective() {
    const active = store.active()
    if (active === '') return { profile: '', brand: SHIPPED_LOOK }
    try {
      return { profile: active, brand: store.read(active).brand }
    } catch (error) {
      return { profile: '', brand: SHIPPED_LOOK, error: `${active}: ${message(error)}` }
    }
  }

  /** The card's view: the active profile, the effective one, and every profile's JSON. */
  function state() {
    const current = effective()
    return {
      active: store.active(),
      effective: current.profile,
      ...(current.error === undefined ? {} : { activeError: current.error }),
      profiles: store.list().map((profile) => {
        try {
          return { name: profile, profile: store.read(profile).json }
        } catch (error) {
          return { name: profile, profile: store.rawJson(profile), error: message(error) }
        }
      }),
    }
  }

  ctx.on('webserver/index-inject', (table) => {
    const { profile, brand } = effective()
    const style = brandStyle(brand, profile)
    if (style !== '') table.push({ kind: 'style', text: `/* deepsea-brand-kit */\n${style}` })
    table.push({ kind: 'global', name: '__DEEPSEA_BRAND_KIT__', value: clientPayload(brand, profile) })
  })

  const route = (path, methods, fetch) => ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })
    return () => { void dispose() }
  }, `brand-kit: ${path}`)

  /** Run one state change; the reply is the new state, or it with the error. */
  const change = async (work) => {
    try {
      const extra = await work()
      return json({ ...state(), ...extra })
    } catch (error) {
      return json({ ...state(), error: message(error) }, 400)
    }
  }
  const refuse = () => json({ ...state(), error: 'unsupported request body type' }, 415)

  route(API_PATH, ['GET', 'POST'], async (request) => {
    if (request.method === 'GET') return json(state())
    if (mediaType(request) !== 'application/json') return refuse()
    return change(async () => {
      const body = await request.json()
      const { action, name: profile, to } = body ?? {}
      switch (action) {
        case 'apply': store.setActive(profile ?? ''); break
        case 'create': store.create(profile); break
        case 'save': store.write(profile, body.profile); break
        case 'duplicate': return { created: store.duplicate(profile, to ?? store.freeName(`${profile} copy`)).name }
        case 'rename': store.rename(profile, to); break
        case 'delete': store.delete(profile); break
        default: throw new Error(`unknown action ${JSON.stringify(action)}`)
      }
      return {}
    })
  })

  route(`${API_PATH}/upload`, ['POST'], async (request) => {
    if (mediaType(request) !== 'application/octet-stream') return refuse()
    const params = new URL(request.url).searchParams
    return change(async () => {
      const kind = params.get('kind') === 'mark' ? 'mark' : 'font'
      return { uploaded: store.putAsset(params.get('name') ?? '', kind, params.get('file') ?? '', new Uint8Array(await request.arrayBuffer())) }
    })
  })

  route(`${API_PATH}/import`, ['POST'], async (request) => {
    if (mediaType(request) !== 'application/octet-stream') return refuse()
    const params = new URL(request.url).searchParams
    return change(async () => {
      const profile = store.freeName(nameFromFile(params.get('file') ?? ''))
      store.importZip(profile, new Uint8Array(await request.arrayBuffer()))
      return { created: profile }
    })
  })

  route(`${API_PATH}/export`, ['GET'], async (request) => {
    const profile = new URL(request.url).searchParams.get('name') ?? ''
    try {
      const zip = store.exportZip(profile)
      // Profile names are letters, digits, spaces, `.`, `_`, `-`: safe in a quoted filename.
      return new Response(zip, { status: 200, headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${profile}.brand.zip"`, 'cache-control': 'no-store' } })
    } catch (error) {
      return new Response(message(error), { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
  })

  route(`${API_PATH}/asset`, ['GET', 'HEAD'], async (request) => {
    const params = new URL(request.url).searchParams
    const kind = params.get('k') ?? ''
    const file = params.get('f') ?? ''
    let brand
    try {
      brand = store.read(params.get('s') ?? '').brand
    } catch {
      return new Response('no such profile', { status: 404 })
    }
    const path = assetPath(brand, kind, file)
    if (path === undefined) return new Response('not a file of this profile', { status: 404 })
    let bytes
    try {
      bytes = await readFile(path)
    } catch {
      return new Response('file missing', { status: 404 })
    }
    const headers = { 'content-type': ASSET_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', 'content-length': String(bytes.byteLength), 'cache-control': 'private, max-age=3600' }
    return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers })
  })

  const current = effective()
  const parts = [
    current.profile === '' ? 'no active profile (shipped look)' : `profile ${JSON.stringify(current.profile)}`,
    current.brand.name === '' ? null : `name ${JSON.stringify(current.brand.name)}`,
    current.brand.mark === '' ? null : `mark ${basename(current.brand.mark)} (${current.brand.markMode})`,
    current.brand.accent === '' ? null : `accent ${current.brand.accent}`,
    current.brand.fonts.length === 0 ? null : `${String(current.brand.fonts.length)} font file(s)`,
    current.error === undefined ? null : `active profile not applied: ${current.error}`,
  ].filter(Boolean)
  ctx.logger.info(`brand-kit: ${parts.join(', ')}; ${String(store.list().length)} profile(s) in ${store.root}`)
}
