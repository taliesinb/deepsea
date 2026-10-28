#!/usr/bin/env node
/**
 * A stand-in for the tailscale CLI, enough of it for the plugin: `status
 * --json`, `serve status --json`, `serve … --set-path=<p> <target>` and
 * `serve … --set-path=<p> off`. Its state is a JSON file beside it
 * (`<this file>.state.json`, or FAKE_TAILSCALE_STATE): the node's status, the
 * Serve handlers, and every call made, so tests can assert what was run.
 * Anything else (reset, funnel, …) is recorded and fails.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = process.env.FAKE_TAILSCALE_STATE || `${fileURLToPath(import.meta.url)}.state.json`
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
state.status ??= {
  BackendState: 'Running',
  Self: { DNSName: 'node.example.ts.net.', UserID: 7, TailscaleIPs: ['100.100.100.1', 'fd7a:115c:a1e0::1'], Tags: [] },
  User: { 7: { LoginName: 'User@Example.com' } },
}
state.web ??= {}
state.calls ??= []
const args = process.argv.slice(2)
state.calls.push(args)
const save = () => writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
const key = `${String(state.status.Self.DNSName).replace(/\.$/, '')}:443`
const handlers = () => (state.web[key] ??= { Handlers: {} }).Handlers

if (state.down) { save(); process.stderr.write('failed to connect to local tailscaled\n'); process.exit(1) }
if (args[0] === 'status' && args[1] === '--json') {
  save()
  process.stdout.write(JSON.stringify(state.status))
  process.exit(0)
}
if (args[0] === 'serve' && args[1] === 'status' && args[2] === '--json') {
  save()
  const any = Object.values(state.web).some(web => Object.keys(web.Handlers ?? {}).length > 0)
  process.stdout.write(any ? JSON.stringify({ Web: state.web }) : '')
  process.exit(0)
}
if (args[0] === 'serve' && args.includes('--https=443') && !args.includes('reset') && !args.some(a => /funnel/i.test(a))) {
  const pathArg = args.find(a => a.startsWith('--set-path='))
  const path = pathArg === undefined ? '/' : pathArg.slice('--set-path='.length)
  const last = args[args.length - 1]
  if (last === 'off') {
    delete handlers()[path]
    save()
    process.exit(0)
  }
  if (args.includes('--bg') && args.includes('--yes') && /^http:\/\/127\.0\.0\.1:\d+$/.test(last)) {
    if (state.failServe) { save(); process.stderr.write('serve failed\n'); process.exit(1) }
    handlers()[path] = { Proxy: last }
    save()
    process.exit(0)
  }
}
save()
process.stderr.write(`fake tailscale: unsupported ${args.join(' ')}\n`)
process.exit(2)
