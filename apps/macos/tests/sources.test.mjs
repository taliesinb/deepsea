import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Contracts the Swift sources keep with pages, dsd and the README, checked without compiling.
const source = name => readFileSync(new URL(`../Sources/${name}`, import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

test('every automation operation the header documents is handled, and the README lists them all', () => {
  const automation = source('Automation.swift')
  const header = automation.split('\nimport ')[0]
  const documented = [...header.matchAll(/^\/\/ {3}([a-z][a-z-]*)\b/gm)].map(m => m[1])
  const handled = new Set([...automation.matchAll(/case ((?:"[a-z-]+"(?:, )?)+):/g)].flatMap(m => [...m[1].matchAll(/"([a-z-]+)"/g)].map(n => n[1])))
  for (const op of documented) assert.ok(handled.has(op), `documented op ${op} has no case`)
  for (const op of ['panels', 'panel-eval', 'panel-snapshot', 'panel-close']) {
    assert.ok(documented.includes(op), `${op} documented`)
    assert.match(readme, new RegExp('`' + op + '`'), `${op} in the README`)
  }
})

test('the panel page API: showPanel and closePanel post to the app, which tells every page about panels', () => {
  const panels = source('Panels.swift')
  assert.match(panels, /showPanel: \(options\) => \{[^\n]*type: 'show-panel', id: String\(o\.id \|\| ''\), url: String\(o\.url \|\| ''\)/)
  assert.match(panels, /closePanel: \(id\) => \{[^\n]*type: 'close-panel'/)
  assert.match(panels, /CustomEvent\('deepsea-app-panel'/)
  // The page must be on the app's own server, and the panel never takes focus by appearing.
  assert.match(panels, /scope\.contains\(url\)/)
  assert.match(panels, /\.nonactivatingPanel/)
  assert.match(panels, /\.canJoinAllSpaces/)
  assert.doesNotMatch(panels, /makeKeyAndOrderFront/)
  const main = source('main.swift')
  assert.match(main, /source: Self\.panelScript/)
  assert.match(main, /if handlePanelMessage\(body, message\) \{ return \}/)
  assert.match(readme, /__DEEPSEA_APP__\.showPanel\(\{ id: /)
})
