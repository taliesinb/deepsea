import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')

test('Drafts hides Chat width handles only under its active conversation content', () => {
  const selector = '[data-conversation-content]:has([data-deepsea-drafts-view]) > [data-width-handle]'
  const rule = css.match(/([^{}]+)\{\s*display:\s*none;\s*\}/)
  assert.ok(rule, 'conditional layout controls hiding rule exists')
  const selectors = rule[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map(value => value.trim())
  assert.ok(selectors.includes(selector), 'full-height transcript hit areas are disabled in Drafts')
  assert.ok(selectors.includes('[data-conversation-content]:has([data-deepsea-drafts-view]) [data-composer-seat]'), 'composer remains hidden in Drafts')
  assert.ok(selectors.every(value => value.startsWith('[data-conversation-content]:has([data-deepsea-drafts-view])')), 'Chat and other conversation views retain their controls')
})
