// node --test: brand validation and the generated CSS and payload.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { accentStyle, assetPath, brandStyle, clientPayload, normalizeBrand } from '../brand.mjs'

const dir = mkdtempSync(join(tmpdir(), 'deepsea-brand-kit-test-'))
after(() => { rmSync(dir, { recursive: true, force: true }) })
writeFileSync(join(dir, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
writeFileSync(join(dir, 'Face.woff2'), '')

test('an empty profile is the shipped look', () => {
  const brand = normalizeBrand(undefined)
  assert.equal(brand.name, '')
  assert.equal(brand.mark, '')
  assert.equal(brandStyle(brand, 'Empty'), '')
  assert.deepEqual(clientPayload(brand, 'Empty'), { name: '', headline: '', turnStatus: '', mark: null })
})

test('a full profile: faces, classes, headline, badge, accent, payload', () => {
  const brand = normalizeBrand({
    name: 'Acme', mark: join(dir, 'mark.svg'), headline: 'Hello', turnStatus: 'Working', hidePreviewBadge: true,
    accent: '#7678ed', fontsDir: dir, fonts: [{ file: 'Face.woff2', family: 'Face', weight: 300 }],
    brandFont: { family: '"Face", serif', weight: 300, size: 22, offsetY: -1 }, headlineFont: { family: 'Face', size: 32, lineHeight: 36 },
  })
  const css = brandStyle(brand, 'Acme 1')
  assert.match(css, /@font-face\{font-family:"Face";font-weight:300;font-style:normal;font-display:swap;src:url\(\.\/api\/deepsea-brand-kit\/asset\?s=Acme\+1&k=font&f=Face\.woff2\) format\("woff2"\)\}/)
  assert.match(css, /\.deepsea-brand-kit-name\{font-family:"Face", serif;white-space:nowrap;font-weight:300;font-size:22px;.*translateY\(-1px\)/)
  assert.match(css, /\.deepsea-brand-kit-mark\{.*mask:url\(\.\/api\/deepsea-brand-kit\/asset\?s=Acme\+1&k=mark&f=mark\.svg\)/)
  assert.match(css, /\[class\*="_titleGroup"\]>span:first-child\{font-family:Face;font-weight:500;font-size:32px;line-height:36px/)
  assert.match(css, /_previewBadge"\]\{display:none\}/)
  assert.match(css, /--dsw-static-deepseek-500:#7678ed;--dsw-static-blue-500:#7678ed;/)
  assert.deepEqual(clientPayload(brand, 'Acme 1'), { name: 'Acme', headline: 'Hello', turnStatus: 'Working', mark: { url: './api/deepsea-brand-kit/asset?s=Acme+1&k=mark&f=mark.svg', mode: 'mask' } })
  assert.equal(assetPath(brand, 'mark', 'mark.svg'), join(dir, 'mark.svg'))
  assert.equal(assetPath(brand, 'font', 'Face.woff2'), join(dir, 'Face.woff2'))
  assert.equal(assetPath(brand, 'font', 'Other.woff2'), undefined)
  assert.equal(assetPath(brand, 'mark', '../mark.svg'), undefined)
})

test('an image mark is drawn as it is', () => {
  const css = brandStyle(normalizeBrand({ mark: join(dir, 'mark.svg'), markMode: 'image' }), 'A')
  assert.equal(css, '.deepsea-brand-kit-mark{display:block;flex:none;object-fit:contain}')
})

test('the accent ramp derives its 600 step unless given, and outranks the theme sheet', () => {
  assert.match(accentStyle('#123456', ''), /deepseek-600:color-mix\(in oklab,#123456 85%,black\)/)
  assert.match(accentStyle('#123456', '#0000ff'), /deepseek-600:#0000ff;/)
  assert.match(accentStyle('#123456', ''), /^html>body,html>body\[data-ds-dark-theme\]\{/)
})

test('unsafe or missing values are refused', () => {
  assert.throws(() => normalizeBrand({ name: 'a"b' }), /name must be/)
  assert.throws(() => normalizeBrand({ headline: '<script>' }), /headline must be/)
  assert.throws(() => normalizeBrand({ accent: 'blue' }), /accent must be/)
  assert.throws(() => normalizeBrand({ mark: 'relative.svg' }), /absolute/)
  assert.throws(() => normalizeBrand({ mark: join(dir, 'missing.svg') }), /not found: missing\.svg/)
  assert.throws(() => normalizeBrand({ mark: join(dir, 'Face.woff2') }), /\.svg or \.png/)
  assert.throws(() => normalizeBrand({ fonts: [{ file: 'Face.woff2', family: 'Face' }] }), /without fontsDir/)
  assert.throws(() => normalizeBrand({ fontsDir: dir, fonts: [{ file: '../x.woff2', family: 'Face' }] }), /file must be/)
  assert.throws(() => normalizeBrand({ fontsDir: dir, fonts: [{ file: 'Face.woff2', family: 'A, B' }] }), /one family name/)
  assert.throws(() => normalizeBrand({ markMode: 'svg' }), /markMode/)
  assert.throws(() => normalizeBrand({ brandFont: { size: 500 } }), /size must be/)
  assert.throws(() => normalizeBrand({ brandFont: { family: 'x;}' } }), /font-family list/)
  assert.throws(() => normalizeBrand({ hidePreviewBadge: 'yes' }), /true or false/)
})
