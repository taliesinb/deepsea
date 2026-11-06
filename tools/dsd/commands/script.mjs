/**
 * dsd script <file.mjs> [-v <ref>] — run a script against a running throwaway.
 * The file's default export is called with one object and its return value is
 * printed as JSON:
 *
 *   export default async ({ id, url, login, server, app, sleep }) => {
 *     const { sessionId } = await server('create-session', { title: 'shot' })
 *     await server('prompt', { sessionId, text: '{"cmd": "say", "text": "hi"}', wait: true })
 *     await app('wait-page', { text: 'hi' })
 *     return app('snapshot', { window: true })
 *   }
 *
 * `server(op, body)` is a test-driver operation (plugins/dev-test-driver/README.md),
 * `app(op, body)` an automation-channel request (apps/macos/Sources/Automation.swift);
 * both resolve the value or throw the error.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appRequest } from '../lib/appsocket.mjs'
import { DsdError, onlyFlags, parseArgs, printJson, sleep, usage } from '../lib/util.mjs'
import { readState, resolveRef } from '../lib/variants.mjs'
import { driverOf, post } from './drive.mjs'

export async function script(argv) {
  const args = parseArgs(argv.map(a => (a === '-v' ? '--variant' : a)), ['variant'])
  onlyFlags(args, ['variant'])
  if (args._.length !== 1) usage('dsd script <file.mjs> [-v <ref>]')
  const variant = resolveRef(args.variant)
  const state = readState(variant.id)
  const mod = await import(pathToFileURL(resolve(args._[0])).href)
  if (typeof mod.default !== 'function') throw new DsdError(`${args._[0]} has no default export function`)
  // Behind a relay the server (and so its driver endpoint) changes on every restart: ask each time.
  let driver
  const server = async () => (state?.relay ? driverOf(variant) : (driver ??= await driverOf(variant)))
  const api = {
    id: variant.id,
    url: state?.url,
    login: state?.url && state?.token ? `${state.url}?token=${state.token}` : undefined,
    server: async (op, body = {}) => post(await server(), op, body),
    app: (op, body = {}, options) => {
      if (!state?.app?.socket) throw new DsdError(`${variant.id} has no app (it was started with --throwaway-server)`)
      return appRequest(state.app.socket, op, body, options)
    },
    sleep: seconds => sleep(seconds * 1000),
  }
  printJson((await mod.default(api)) ?? null)
}
