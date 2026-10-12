// The DeepSea app's window reports and commands (app-windows.mjs): the registry and its two Fetch routes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APP_COMMAND_PATH, APP_WINDOW_PATH, createAppWindows, parseReport, registerAppWindowRoutes } from '../app-windows.mjs'

const REPORT = { pid: 4410, bundleId: 'io.github.taliesinb.deepsea.release', frame: { x: 0, y: 34, width: 1200, height: 900 }, screen: { frame: { x: 0, y: 0, width: 1710, height: 1107 }, visible: { x: 0, y: 34, width: 1710, height: 1073 } }, key: true, active: true, fullScreen: false }

function routesOf(appWindows) {
  const routes = new Map()
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    effect(run) { run() },
  }
  assert.deepEqual(registerAppWindowRoutes(ctx, appWindows), [APP_WINDOW_PATH, APP_COMMAND_PATH])
  return routes
}

test('reports: the app\'s published shape is accepted, anything malformed refused', () => {
  assert.deepEqual(parseReport(REPORT), REPORT)
  assert.equal(parseReport({ ...REPORT, pid: '4410' }), undefined)
  assert.equal(parseReport({ ...REPORT, pid: 0 }), undefined)
  assert.equal(parseReport({ ...REPORT, frame: { x: 0, y: 0, width: 'wide', height: 1 } }), undefined)
  assert.equal(parseReport({ ...REPORT, screen: undefined }).screen, undefined)
  assert.equal(APP_WINDOW_PATH, '/api/deepsea-browser/app-window')
  assert.equal(APP_COMMAND_PATH, '/api/deepsea-browser/app-command')
})

test('set-frame reaches the long poll and resolves with the report that matches', async () => {
  const traced = []
  const appWindows = createAppWindows({ trace: (event) => traced.push(event), pollMs: 1000 })
  appWindows.report(REPORT)
  assert.deepEqual(traced.map(e => e.event), ['app-window'])
  const polled = appWindows.poll(4410)
  const wanted = { ...REPORT.frame, width: 1000 }
  const setting = appWindows.setFrame(4410, wanted, 1000)
  assert.deepEqual(await polled, { type: 'set-frame', frame: wanted })
  appWindows.report({ ...REPORT, frame: wanted })
  assert.deepEqual((await setting).frame, wanted)
  // Nobody polling and nobody answering: undefined after the timeout; the command waits in the queue.
  assert.equal(await appWindows.setFrame(4410, REPORT.frame, 30), undefined)
  assert.deepEqual(await appWindows.poll(4410), { type: 'set-frame', frame: REPORT.frame })
  appWindows.dispose()
})

test('routes: POST reports as JSON only; GET long-polls by pid', async () => {
  const appWindows = createAppWindows({ pollMs: 50 })
  const routes = routesOf(appWindows)
  const post = (body, type = 'application/json') => routes.get(APP_WINDOW_PATH).fetch(new Request(`http://x${APP_WINDOW_PATH}`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) }))
  assert.equal((await post(REPORT, 'text/plain')).status, 415)
  assert.equal((await post('{not json')).status, 400)
  assert.equal((await post({ pid: 1 })).status, 400)
  const ok = await post(REPORT)
  assert.deepEqual([ok.status, await ok.json()], [200, { ok: true }])
  assert.equal(appWindows.get(4410).bundleId, REPORT.bundleId)
  const get = (query) => routes.get(APP_COMMAND_PATH).fetch(new Request(`http://x${APP_COMMAND_PATH}?${query}`))
  assert.equal((await get('pid=abc')).status, 400)
  assert.deepEqual(await (await get('pid=4410')).json(), {}, 'nothing to do: an empty answer after the poll time')
  void appWindows.setFrame(4410, REPORT.frame, 50)
  assert.deepEqual(await (await get('pid=4410')).json(), { command: { type: 'set-frame', frame: REPORT.frame } })
  appWindows.dispose()
})
