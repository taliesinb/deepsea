import { test } from 'node:test'
import assert from 'node:assert/strict'
import { infoPlist, parseCommandLine, serverHostPlist, sourceHash } from '../build.mjs'

test('Info.plist: the bundle id, display name and version, XML-escaped', () => {
  const plist = infoPlist({ name: 'DeepSea <Test> & Co', bundleId: 'io.github.taliesinb.deepsea.release-3f9a1c', version: '0.2.1', build: 'ab12cd+' })
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>io\.github\.taliesinb\.deepsea\.release-3f9a1c<\/string>/)
  assert.match(plist, /<key>CFBundleName<\/key><string>DeepSea &lt;Test&gt; &amp; Co<\/string>/)
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>DeepSea<\/string>/)
  assert.match(plist, /<key>CFBundleVersion<\/key><string>ab12cd\+<\/string>/)
})

test('command line: --kebab-case value pairs, nothing else', () => {
  assert.deepEqual(parseCommandLine(['--out', '/x', '--bundle-id', 'a.b', '--glyph-color', '#fff']), { out: '/x', bundleId: 'a.b', glyphColor: '#fff' })
  assert.throws(() => parseCommandLine(['--out']), /unexpected/)
  assert.throws(() => parseCommandLine(['stray']), /unexpected/)
})

test('the compile cache key changes with the sources, the compiler and the target', async () => {
  const { fileURLToPath } = await import('node:url')
  const file = fileURLToPath(new URL('../build.mjs', import.meta.url))
  const a = sourceHash([file], 'swift 6.4', 'arm64-apple-macos13.0')
  assert.equal(a, sourceHash([file], 'swift 6.4', 'arm64-apple-macos13.0'))
  assert.notEqual(a, sourceHash([file], 'swift 6.5', 'arm64-apple-macos13.0'))
  assert.notEqual(a, sourceHash([file], 'swift 6.4', 'x86_64-apple-macos13.0'))
  assert.match(a, /^[0-9a-f]{12}$/)
})

test('server host Info.plist: background only, its own bundle id, the privacy usage keys', () => {
  const plist = serverHostPlist({ name: 'DeepSea Lab Server', bundleId: 'io.github.taliesinb.deepsea.lab.server', icon: false })
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>io\.github\.taliesinb\.deepsea\.lab\.server<\/string>/)
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>deepsea-server-host<\/string>/)
  assert.match(plist, /<key>LSBackgroundOnly<\/key><true\/>/)
  assert.match(plist, /<key>NSDesktopFolderUsageDescription<\/key><string>An agent running in DeepSea is asking for this\.<\/string>/)
  assert.doesNotMatch(plist, /CFBundleIconFile/)
  assert.match(serverHostPlist({ name: 'x', bundleId: 'a.b', icon: true }), /CFBundleIconFile/)
})
