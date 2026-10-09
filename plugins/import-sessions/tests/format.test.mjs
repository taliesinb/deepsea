import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { toCurrentFormat } from '../host/importer.mjs'
import { listClaudeSubagents, readClaudeSession } from '../host/claude-reader.mjs'
import { readPiSession } from '../host/pi-reader.mjs'
import { claudeStore, piStore } from './fixtures.mjs'

const header = id => ({ version: 3, id, createdAt: 1786010400000, cwd: '/tmp', isSeeded: false, delegationDepth: 0 })
const estimate = m => Math.ceil(JSON.stringify(m ?? '').length / 4)

// The builder writes v3; DSH's own migration must accept every shape it produces, in both modes.
for (const fold of [false, true]) {
  test(`built logs pass DSH's migration to its current format (${fold ? 'working' : 'archive'})`, async () => {
    const claude = claudeStore()
    const { builder } = await readClaudeSession(claude.file, { sessionId: 'claude-x', resultCap: 0 })
    builder.finish('t')
    if (fold) builder.fold({ keepTurns: 1, estimate, sourceLabel: 'x' })
    const child = { id: 'claude-x-agent-abc', createdAt: 1786010401000 }
    const parent = toCurrentFormat(header('claude-x'), builder.events, [child])
    assert.equal(parent.header.version, sessionFormatCatalog.currentVersion)
    if (sessionFormatCatalog.currentVersion > 3) {
      assert.equal(parent.events.filter(e => e.type === 'subagent/catalog').length, 1, 'the imported child is listed in the parent')
      assert.ok(parent.events.some(e => e.type === 'tool/result' && e.data.message.role === 'tool' && e.data.message.isError === true), 'the unanswered call is settled')
    }
    for (const file of await listClaudeSubagents(claude.file)) {
      const read = await readClaudeSession(file, { sessionId: child.id, resultCap: 0, child: true })
      read.builder.finish('Subagent abc')
      const converted = toCurrentFormat({ ...header(child.id), createdAt: child.createdAt, parentSession: 'claude-x', origin: 'subagent', delegationDepth: 1 }, read.builder.events)
      assert.equal(converted.header.version, sessionFormatCatalog.currentVersion)
    }
    const pi = piStore()
    const piRead = await readPiSession(pi.file, { sessionId: 'pi-x', resultCap: 0 })
    piRead.builder.finish('t')
    if (fold) piRead.builder.fold({ keepTurns: 1, estimate, sourceLabel: 'x' })
    assert.equal(toCurrentFormat(header('pi-x'), piRead.builder.events).header.version, sessionFormatCatalog.currentVersion)
  })
}
