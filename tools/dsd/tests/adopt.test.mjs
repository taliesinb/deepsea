/**
 * dsd adopt (lib/adopt.mjs) against fake old homes built in $TMPDIR in the
 * old layout (the shapes of an old DSH home, no real data).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsd-adopt-test-'))
process.env.DEEPSEA_ROOT = join(root, 'deepsea')
process.env.DEEPSEA_LOG_ROOT = join(root, 'logs')
test.after(() => rmSync(root, { recursive: true, force: true }))

const { REPO } = await import('../lib/paths.mjs')
const noHarness = !existsSync(join(REPO, 'harness', 'packages', 'credentials', 'credentials-local'))
const { adopt, MANIFEST, oldColor, splitRows, yamlLib } = noHarness ? {} : await import('../lib/adopt.mjs')
const { normalizeMap } = await import('../lib/adopt-map.mjs')
const Y = noHarness ? undefined : yamlLib()
const skip = noHarness ? 'needs the harness build (dsd link)' : false

const WS = '11111111-1111-4111-8111-111111111111'
const S1 = 'session-aaaaaaaa-0000-4000-8000-000000000001'
const S2 = 'session-aaaaaaaa-0000-4000-8000-000000000002'
const SUB = 'bbbbbbbb-0000-4000-8000-000000000003'
const PROJECT = '--Users-USER-projects-demo--'

const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
const older = (path, seconds = 3600) => { const t = new Date(Date.now() - seconds * 1000); utimesSync(path, t, t) }

/** An old DSH home, in the shapes homes from before DeepSea have. */
function oldHome(name) {
  const home = join(root, name)
  const session = (id, text) => {
    put(join(home, 'sessions', PROJECT, id, 'session.v3.jsonl.zstd'), text)
    put(join(home, 'sessions', PROJECT, id, 'session.lock'), '')
    older(join(home, 'sessions', PROJECT, id, 'session.v3.jsonl.zstd'))
  }
  session(S1, 'log one')
  session(S2, 'log two')
  session(SUB, 'a subagent log')
  put(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [WS], archivedSessionIds: [S2] },
    tables: { workspaces: { [WS]: { path: '/Users/USER/projects/demo', title: 'demo', sessionIds: [S2, S1], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' } } }, // dsd-check: allow
  }, null, 2))
  put(join(home, 'storages', 'session_projcache', 'sessions', `${S1}.json`), '{"identity":{"createdAt":1},"rows":{}}')
  put(join(home, 'attachments', 'v1', 'objects', 'ab', 'abcdef'), 'an image')
  put(join(home, 'attachments', 'v1', 'tmp', 'partial'), 'scratch')
  put(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: anthropic-oauth\n  model: claude-opus-5-5\nold-kernel:\n  kernelPath: /Applications/Kernel.app\n')
  put(join(home, '.credentials.yaml'), [
    'version: 1',
    'records:',
    '  {',
    '    client-connection/browser-session: { kind: grant, payload: { version: 1, secret: fake-secret } },',
    '    llm-pi-ai/anthropic-oauth: { kind: grant, payload: { type: oauth, refresh: fake-refresh, access: fake-access, expires: 1 } },',
    '    llm-pi-ai/openrouter: { kind: api-key, key: fake-openrouter-key },',
    '    llm-pi-ai-installation/device-id: { kind: grant, payload: { id: 00000000-0000-4000-8000-000000000001 } }',
    '  }',
    'refs:',
    '  DEEPSEEK_API_KEY: fake-deepseek-key',
    '',
  ].join('\n'))
  put(join(home, '.agent-presets', 'minimal-no-tools', 'preset.yml'), 'name: Minimal (no tools)\n')
  put(join(home, '.agent-presets', 'mine', 'preset.yml'), 'name: Mine\n')
  put(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: old-identity',
    '  config:',
    '    label: DSH Test',
    "    brandColor: '#8E4EC6'",
    '',
    '# Your patch layer (header-like paragraph, belongs to no row).',
    '',
    '- id: old-tailscale',
    '  config:',
    '    instance: test',
    '    listenPort: 3094',
    '    mountPath: /dsh-test',
    "    tailscalePath: ''",
    '    identityOperators: true',
    '',
    '- id: old-browser',
    '  config:',
    '    subagents: true',
    '    chrome:',
    '      headless: false',
    '    traceFile: /tmp/browser-trace.log',
    '',
    '# Notion over mcp-remote',
    '- insert:',
    '    - id: my-notion-mcp',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: notion',
    "        args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp']",
    '        cwd: !!js process.cwd()',
    '',
    '- id: session-title-llm',
    '  config:',
    '    targetWords: 5',
    '    style: slug',
    '',
    '- id: dsh-rewind-plugin',
    '  disabled: true',
    '',
    '- id: old-chat-title',
    '  disabled: true',
    '',
  ].join('\n'))
  put(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'profile', private: true,
    dependencies: { '@deepseek-ai/dsh-base': '^0.1.6', 'dsh-rewind-plugin': '^0.7.5', 'old-billing-pkg': 'link:/Users/USER/github/old-plugins/plugins/billing', 'my-local': 'link:/somewhere' },
  }))
  put(join(home, 'billing', 'sessions', `${S1}.jsonl`), '{"kind":"start"}\n')
  put(join(home, 'billing', 'connections', 'anthropic-oauth-global.json'), '{}')
  put(join(home, 'tailscale-remote-test.json'), JSON.stringify({ version: 1, enabled: true, allowedUsers: ['user@example.com'], token: 'fake-tailscale-token-0123456789' }))
  put(join(home, 'session-owners-test.json'), JSON.stringify({ version: 1, sessions: { [S1]: { logins: { 'user@example.com': 1 } } } }))
  put(join(home, 'remote-workspaces.json'), JSON.stringify({ version: 1, servers: [{ id: 'other', url: 'https://other.example.ts.net/dsh/', label: 'other', token: 'fake-remote-token' }], workspaces: [] }))
  put(join(home, 'brand-profiles', 'state.json'), '{"active":"Acme"}')
  put(join(home, 'brand-profiles', 'Acme', 'profile.json'), '{"name":"Acme"}')
  put(join(home, 'rewind-snapshots', 'snap-1.json'), '{}')
  put(join(home, 'ledger', 'ledger.jsonl'), '{}\n')
  put(join(home, 'cache', 'attachments', 'request-images', 'x'), 'cached')
  put(join(home, 'logs', 'dsh-web.log'), 'log')
  put(join(home, 'mystery.txt'), 'what is this')
  return home
}

/** The old world's table (the shape of the extras' adopt-map.mjs), with made-up old names. */
const MAP = noHarness ? undefined : normalizeMap({
  packages: {
    'old-identity-pkg': { plugin: 'variant-identity', rows: ['old-identity'] },
    'old-tailscale-pkg': { plugin: 'tailscale', rows: ['old-tailscale'] },
    'old-browser-pkg': { plugin: 'browser', rows: ['old-browser'] },
    'old-chat-title-pkg': { plugin: 'chat-title', rows: ['old-chat-title'] },
    'old-billing-pkg': { plugin: 'billing', rows: ['old-billing'] },
  },
  translations: {
    'old-tailscale': { keep: ['identityOperators', 'loopbackForward', 'tailscalePath'], gone: 'the variant gives these', drop: (key, value) => key === 'tailscalePath' && value === '' },
    'old-browser': { keep: ['subagents', 'chrome'], extra: config => (config.traceFile ? { trace: true } : {}) },
    'old-identity': { keep: [], gone: 'the variant gives the colour' },
  },
  settings: { 'old-kernel': { row: 'deepsea-kernel', keys: ['kernelPath'] } },
  color: { row: 'old-identity', key: 'brandColor' },
  entries: [
    { name: 'billing', tree: 'plugins/billing', what: 'billing store' },
    { name: 'brand-profiles', tree: 'plugins/brand-kit/profiles', files: { 'state.json': 'plugins/brand-kit/state.json' }, what: 'brand profiles' },
    { name: 'remote-workspaces.json', file: 'plugins/remote-workspaces/workspaces.json', what: 'remote servers', secret: 'servers' },
    { match: /^tailscale-remote(-[a-z0-9-]+)?\.json$/, file: 'plugins/tailscale/state.json', what: 'tailscale state', secret: 'token' },
    { match: /^session-owners(-[a-z0-9-]+)?\.json$/, file: 'plugins/tailscale/session-owners.json', what: 'session owners' },
    { name: 'rewind-snapshots', tree: 'rewind-snapshots', what: 'a third-party plugin' },
    { name: 'ledger', skip: 'an old ledger nothing reads' },
  ],
})

/** The DeepSea plugins a fake build has. */
const PLUGINS = new Map([
  ['tailscale', { rows: ['deepsea-tailscale'], presets: [] }],
  ['browser', { rows: ['deepsea-browser'], presets: [] }],
  ['billing', { rows: ['deepsea-billing'], presets: [] }],
  ['no-global-tools', { rows: ['deepsea-no-global-tools', 'deepsea-preset-minimal-no-tools'], presets: ['minimal-no-tools'] }],
  ['kernel', { rows: ['deepsea-kernel'], presets: [] }],
])

/** Every file under a directory with a hash of its content and its mtime. */
function snapshot(dir) {
  const out = {}
  const visit = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = join(rel, entry.name)
      if (entry.isDirectory()) visit(path)
      else out[path] = `${createHash('sha256').update(readFileSync(join(dir, path))).digest('hex')} ${statSync(join(dir, path)).mtimeMs}`
    }
  }
  if (existsSync(dir)) visit('')
  return out
}

const read = (...p) => readFileSync(join(...p), 'utf8')
/** The harness bundle rows a test home's carried rows are completed from (a titler with no defaults). */
const BUNDLE_ROWS = new Map([['session-title-llm', { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 4096, timeoutMs: 60000 }]])

const run = (source, target, more = {}) => {
  const installs = []
  const report = adopt({ source, target, plugins: PLUGINS, map: MAP, yaml: Y, bundleRows: BUNDLE_ROWS, installBundle: (spec) => { installs.push(spec); return { ok: true } }, ...more })
  return { report, installs }
}

test('first adopt: sessions, registry, attachments, settings, keys, plugin state, profile rows, bundles', { skip }, () => {
  const source = oldHome('first')
  const target = join(root, 'deepsea', 'first')
  const before = snapshot(source)
  const { report, installs } = run(source, target, { backups: join(root, 'deepsea', '_backups', 'first') })
  assert.deepEqual(snapshot(source), before, 'the old home is untouched')

  // Sessions (subagent ones too), without their lock files; the projection cache comes along.
  for (const id of [S1, S2, SUB]) assert.equal(read(target, 'sessions', PROJECT, id, 'session.v3.jsonl.zstd'), read(source, 'sessions', PROJECT, id, 'session.v3.jsonl.zstd'))
  assert.equal(existsSync(join(target, 'sessions', PROJECT, S1, 'session.lock')), false)
  assert.equal(report.sessions.new, 3)
  assert.ok(existsSync(join(target, 'storages', 'session_projcache', 'sessions', `${S1}.json`)))
  // The registry: the workspace, its sessions in order, the archived one.
  const reg = JSON.parse(read(target, 'storages', 'workspace.json'))
  assert.deepEqual(reg.global.workspaceIds, [WS])
  assert.deepEqual(reg.tables.workspaces[WS].sessionIds, [S2, S1])
  assert.deepEqual(reg.global.archivedSessionIds, [S2])
  assert.deepEqual(reg.global.pinnedSessionIds, [])
  // Attachments without the store's scratch.
  assert.ok(existsSync(join(target, 'attachments', 'v1', 'objects', 'ab', 'abcdef')))
  assert.equal(existsSync(join(target, 'attachments', 'v1', 'tmp')), false)
  // settings.yaml as it is; the old plugin's section reported.
  // As it is, but old-kernel: its keys went into its DeepSea row.
  assert.equal(read(target, 'settings.yaml').trimEnd(), 'agent-default-model:\n  provider: anthropic-oauth\n  model: claude-opus-5-5')
  assert.deepEqual(report.settings.oldSections.map(s => s.section), ['old-kernel'])
  // A settings section a DeepSea row takes: its keys go into that row of the profile patch.
  assert.match(read(target, 'profiles', 'web', 'cordis.patch.yml'), /- id: deepsea-kernel\n\s+config:\n\s+kernelPath: \/Applications\/Kernel\.app/)
  assert.ok(report.rows.translated.some(t => t.from === 'settings.yaml old-kernel' && t.to === 'deepsea-kernel'))
  // API keys, no sign-ins (no --move-sign-ins), never the browser-session secret; 0600.
  const creds = Y.parse(read(target, '.credentials.yaml'))
  assert.deepEqual(creds.refs, { DEEPSEEK_API_KEY: 'fake-deepseek-key' })
  assert.equal(creds.records?.['llm-pi-ai/anthropic-oauth'], undefined)
  assert.equal(creds.records?.['client-connection/browser-session'], undefined)
  // A key a provider's key login stored is a key, not a sign-in; the device id travels only with sign-ins.
  assert.deepEqual(creds.records?.['llm-pi-ai/openrouter'], { kind: 'api-key', key: 'fake-openrouter-key' })
  assert.equal(creds.records?.['llm-pi-ai-installation/device-id'], undefined)
  assert.ok(report.credentials.leftOut.some(l => l.what === 'llm-pi-ai-installation/device-id' && /--move-sign-ins/.test(l.why)))
  assert.equal(statSync(join(target, '.credentials.yaml')).mode & 0o777, 0o600)
  assert.deepEqual(report.credentials.signIns, ['llm-pi-ai/anthropic-oauth'])
  assert.deepEqual(report.credentials.keys, ['DEEPSEEK_API_KEY', 'llm-pi-ai/openrouter'])
  // Old plugins' state in the DeepSea places.
  assert.ok(existsSync(join(target, 'plugins', 'billing', 'sessions', `${S1}.jsonl`)))
  assert.equal(JSON.parse(read(target, 'plugins', 'tailscale', 'state.json')).token, 'fake-tailscale-token-0123456789')
  assert.ok(existsSync(join(target, 'plugins', 'tailscale', 'session-owners.json')))
  assert.equal(JSON.parse(read(target, 'plugins', 'remote-workspaces', 'workspaces.json')).servers[0].token, 'fake-remote-token')
  assert.equal(read(target, 'plugins', 'brand-kit', 'state.json'), '{"active":"Acme"}')
  assert.ok(existsSync(join(target, 'plugins', 'brand-kit', 'profiles', 'Acme', 'profile.json')))
  assert.ok(existsSync(join(target, 'rewind-snapshots', 'snap-1.json')))
  // Presets: a plugin's own preset is not copied; another is.
  assert.equal(existsSync(join(target, '.agent-presets', 'minimal-no-tools')), false)
  assert.ok(existsSync(join(target, '.agent-presets', 'mine', 'preset.yml')))
  // Not carried, and reported.
  for (const what of ['cache', 'logs', 'ledger']) assert.ok(report.skipped.some(s => s.what === what), what)
  assert.ok(report.unknown.some(u => u.what === 'mystery.txt'))
  assert.equal(existsSync(join(target, 'cache')), false)
  assert.deepEqual(report.conflicts, [])
  assert.ok(existsSync(join(target, MANIFEST)))
  // Third-party bundles installed as the harness does; old plugins and local links not.
  assert.deepEqual(installs, ['dsh-rewind-plugin@^0.7.5'])
  assert.equal(report.bundles.oldPlugins['old-billing-pkg'], 'billing')
  assert.ok(report.bundles.thirdParty.some(b => b.name === 'my-local' && /local link/.test(b.result)))
})

test('profile rows: harness and third-party rows carried, old plugins translated or dropped', { skip }, () => {
  const source = oldHome('rows')
  const target = join(root, 'deepsea', 'rows')
  const { report } = run(source, target)
  const text = read(target, 'profiles', 'web', 'cordis.patch.yml')
  const rows = Y.parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: s => ({ js: s }) }] })
  const byId = id => rows.find(r => r.id === id || r.insert?.[0]?.id === id)
  assert.deepEqual(byId('deepsea-tailscale'), { id: 'deepsea-tailscale', config: { identityOperators: true } })
  assert.deepEqual(byId('deepsea-browser'), { id: 'deepsea-browser', config: { subagents: true, chrome: { headless: false }, trace: true } })
  // A row's config replaces its bundle row's: the keys the old row lacked come from the bundle row.
  assert.deepEqual(byId('session-title-llm').config, { targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 4096, timeoutMs: 60000, targetWords: 5, style: 'slug' })
  assert.ok(report.rows.carried.includes('id:session-title-llm (completed: targetCjkCharacters, maxInputBytes, maxOutputTokens, timeoutMs)'))
  assert.deepEqual(byId('dsh-rewind-plugin'), { id: 'dsh-rewind-plugin', disabled: true })
  assert.match(text, /cwd: !!js process\.cwd\(\)/, 'the Notion row is carried as it was')
  assert.match(text, /# Notion over mcp-remote/)
  assert.doesNotMatch(text, /^- id: old-|Your patch layer/m)
  assert.ok(report.rows.dropped.some(d => d.row === 'old-identity'))
  assert.ok(report.rows.dropped.some(d => d.row === 'old-chat-title' && /plugin chat-title is not in this variant/.test(d.why)))
  assert.deepEqual(report.rows.translated.find(t => t.from === 'old-tailscale').notCarried, ['instance', 'listenPort', 'mountPath', 'tailscalePath'])
  // splitRows keeps a row's comment and drops a paragraph that belongs to none.
  const split = splitRows('# h\n\n# a\n- id: a\n\n# loose\n\n- id: b\n')
  assert.deepEqual(split, { header: '# h', rows: ['# a\n- id: a', '- id: b'] })

  // Again: nothing changes. Then the person edits an adopted row in the new home and the old row changes too: a conflict.
  assert.deepEqual(run(source, target).report.rows.unchanged.length, 6) // five rows and the kernel row from settings.yaml
  writeFileSync(join(target, 'profiles', 'web', 'cordis.patch.yml'), text.replace('targetWords: 5', 'targetWords: 7'))
  writeFileSync(join(source, 'profiles', 'web', 'cordis.patch.yml'), read(source, 'profiles', 'web', 'cordis.patch.yml').replace('targetWords: 5', 'targetWords: 6'))
  const again = run(source, target).report
  assert.ok(again.conflicts.some(c => /session-title-llm/.test(c.what)))
  assert.match(read(target, 'profiles', 'web', 'cordis.patch.yml'), /targetWords: 7/)
  // An old row changed while the new one was left alone: brought over.
  writeFileSync(join(source, 'profiles', 'web', 'cordis.patch.yml'), read(source, 'profiles', 'web', 'cordis.patch.yml').replace('headless: false', 'headless: true'))
  assert.equal(run(source, target).report.rows.translated.length, 1)
  assert.match(read(target, 'profiles', 'web', 'cordis.patch.yml'), /headless: true/)
})

test('re-adopt: new and changed sessions come, nothing is duplicated, both-sides changes are conflicts', { skip }, () => {
  const source = oldHome('again')
  const target = join(root, 'deepsea', 'again')
  run(source, target)
  // In the old home: a new session, and S1 continued. In the new home: S2 continued (0.2.1 wrote a new generation).
  const S3 = 'session-aaaaaaaa-0000-4000-8000-000000000004'
  put(join(source, 'sessions', PROJECT, S3, 'session.v3.jsonl.zstd'), 'log three')
  writeFileSync(join(source, 'sessions', PROJECT, S1, 'session.v3.jsonl.zstd'), 'log one, continued')
  const reg = JSON.parse(read(source, 'storages', 'workspace.json'))
  reg.tables.workspaces[WS].sessionIds.unshift(S3)
  writeFileSync(join(source, 'storages', 'workspace.json'), JSON.stringify(reg))
  put(join(target, 'sessions', PROJECT, S2, 'session.v4.jsonl.zstd'), 'migrated and continued in DeepSea')
  writeFileSync(join(source, 'sessions', PROJECT, S2, 'session.v3.jsonl.zstd'), 'log two, continued in the old home')
  // settings.yaml changed on both sides; a billing file only in the old home.
  writeFileSync(join(target, 'settings.yaml'), 'ui-theme:\n  fontSize: 14\n')
  writeFileSync(join(source, 'settings.yaml'), `${read(source, 'settings.yaml')}ui-theme:\n  fontSize: 13\n`)
  writeFileSync(join(source, 'billing', 'sessions', `${S1}.jsonl`), '{"kind":"start"}\n{"kind":"finish"}\n')

  const { report } = run(source, target)
  assert.equal(report.sessions.new, 1)
  assert.equal(report.sessions.updated, 1)
  assert.equal(read(target, 'sessions', PROJECT, S1, 'session.v3.jsonl.zstd'), 'log one, continued')
  assert.ok(report.conflicts.some(c => c.what.includes(S2)), 'S2 changed on both sides')
  assert.equal(read(target, 'sessions', PROJECT, S2, 'session.v3.jsonl.zstd'), 'log two', 'not overwritten')
  assert.ok(report.conflicts.some(c => c.what === 'settings.yaml'))
  assert.equal(read(target, 'settings.yaml'), 'ui-theme:\n  fontSize: 14\n')
  assert.equal(report.categories['billing store'].updated, 1)
  const after = JSON.parse(read(target, 'storages', 'workspace.json'))
  assert.deepEqual(after.tables.workspaces[WS].sessionIds, [S3, S2, S1], 'the new session first, nothing twice')
  assert.deepEqual(after.global.workspaceIds, [WS])
  // A third run with nothing new: no change at all.
  const third = run(source, target).report
  assert.equal(third.sessions.new + third.sessions.updated, 0)
  const runs = JSON.parse(read(target, MANIFEST)).runs
  assert.equal(runs.length, 3)
  assert.equal(runs[0].source, source)
})

test('--move-sign-ins: the old credentials lose the sign-ins, the new ones gain them', { skip }, () => {
  const original = oldHome('signins')
  const source = join(root, 'signins-copy')
  cpSync(original, source, { recursive: true })
  const target = join(root, 'deepsea', 'signins')
  const { report } = run(source, target, { moveSignIns: true })
  assert.deepEqual(report.credentials.movedSignIns, ['llm-pi-ai/anthropic-oauth'])
  const now = Y.parse(read(target, '.credentials.yaml'))
  assert.equal(now.records['llm-pi-ai/anthropic-oauth'].payload.refresh, 'fake-refresh')
  // The installation device id travels with them, and the old home keeps it.
  assert.equal(now.records['llm-pi-ai-installation/device-id'].payload.id, '00000000-0000-4000-8000-000000000001')
  const old = Y.parse(read(source, '.credentials.yaml'))
  assert.equal(old.records['llm-pi-ai/anthropic-oauth'], undefined)
  assert.equal(old.records['llm-pi-ai-installation/device-id'].payload.id, '00000000-0000-4000-8000-000000000001')
  assert.deepEqual(old.records['llm-pi-ai/openrouter'], { kind: 'api-key', key: 'fake-openrouter-key' })
  assert.equal(old.records['client-connection/browser-session'].payload.secret, 'fake-secret', 'the rest of the old document stays')
  assert.equal(old.refs.DEEPSEEK_API_KEY, 'fake-deepseek-key')
  assert.equal(statSync(join(source, '.credentials.yaml')).mode & 0o777, statSync(join(original, '.credentials.yaml')).mode & 0o777)
  // Everything else in the old home is as it was.
  const a = snapshot(original)
  const b = snapshot(source)
  delete a['.credentials.yaml']
  delete b['.credentials.yaml']
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort())
})

test('a throwaway gets no credentials, backups or access tokens', { skip }, () => {
  const source = oldHome('throwaway')
  put(`${source}-backups/h-test--2026-10-01.backup.dsh.zip`, 'zip')
  const target = join(root, 'deepsea', 'release-0a0b0c')
  const { report } = run(source, target, { throwaway: true })
  assert.equal(existsSync(join(target, '.credentials.yaml')), false)
  assert.ok(report.credentials.leftOut.some(l => l.what === 'API keys: DEEPSEEK_API_KEY, llm-pi-ai/openrouter'))
  assert.ok(report.credentials.leftOut.some(l => /sign-ins/.test(l.what)))
  assert.ok(report.credentials.leftOut.some(l => l.what === 'llm-pi-ai-installation/device-id'))
  assert.equal(JSON.parse(read(target, 'plugins', 'tailscale', 'state.json')).token, undefined)
  assert.deepEqual(JSON.parse(read(target, 'plugins', 'tailscale', 'state.json')).allowedUsers, ['user@example.com'])
  assert.equal(JSON.parse(read(target, 'plugins', 'remote-workspaces', 'workspaces.json')).servers[0].token, undefined)
  assert.ok(report.skipped.some(s => s.what === `${source}-backups`))
  assert.equal(existsSync(join(root, 'deepsea', '_backups')), false)
  assert.ok(existsSync(join(target, 'sessions', PROJECT, S1)))
  // An MCP server signs in with this machine's credentials: its row comes disabled.
  const patch = Y.parse(read(target, 'profiles', 'web', 'cordis.patch.yml'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: s => ({ js: s }) }] })
  assert.equal(patch.find(r => r.insert)?.insert[0].disabled, true)
  // A throwaway's own rows stay (dsd turns telemetry off there, picks its default model).
  const own = join(root, 'deepsea', 'release-0d0e0f')
  put(join(own, 'profiles', 'web', 'cordis.patch.yml'), '- id: session-title-llm\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: scripted\n    model: script\n')
  const second = run(source, own, { throwaway: true }).report
  assert.ok(second.rows.dropped.some(d => d.row === 'id:session-title-llm'))
  assert.match(read(own, 'profiles', 'web', 'cordis.patch.yml'), /disabled: true/)
  assert.doesNotMatch(read(own, 'settings.yaml'), /agent-default-model/)
  assert.doesNotMatch(read(own, 'settings.yaml'), /old-kernel/)
  assert.ok(second.skipped.some(s => s.what === 'settings.yaml agent-default-model'))
})

test('settings.yaml: sections the new profile has rows for stay out; after DSH imported it, changes are conflicts', { skip }, () => {
  const source = oldHome('settings')
  const target = join(root, 'deepsea', 'settings')
  put(join(target, 'profiles', 'web', 'cordis.patch.yml'), '- id: agent-default-model\n  config:\n    provider: openai\n    model: gpt-6-sol\n')
  const { report } = run(source, target)
  assert.ok(report.conflicts.some(c => c.what === 'settings.yaml agent-default-model'))
  // old-kernel's keys went into its DeepSea row, so the section stays out of the copy.
  assert.doesNotMatch(read(target, 'settings.yaml'), /old-kernel/)
  // DSH 0.2 at its first start: settings.yaml → settings.yaml.imported. A later change in the old home is a conflict.
  writeFileSync(join(target, 'settings.yaml.imported'), read(target, 'settings.yaml'))
  rmSync(join(target, 'settings.yaml'))
  assert.equal(run(source, target).report.settings.imported, true)
  writeFileSync(join(source, 'settings.yaml'), `${read(source, 'settings.yaml')}ui-theme:\n  fontSize: 13\n`)
  assert.ok(run(source, target).report.conflicts.some(c => c.what === 'settings.yaml' && /imported/.test(c.why)))
})

test('a third-party bundle dsh refuses: reported, and its row stays out', { skip }, () => {
  const source = oldHome('refused')
  const target = join(root, 'deepsea', 'refused')
  const report = adopt({ source, target, plugins: PLUGINS, map: MAP, yaml: Y, installBundle: () => ({ ok: false, message: 'to accept the risk, run: dsh plugin allow-version' }) })
  assert.ok(report.skipped.some(s => s.what === 'bundle dsh-rewind-plugin@^0.7.5'))
  assert.ok(report.rows.dropped.some(d => d.row === 'dsh-rewind-plugin'))
  assert.doesNotMatch(read(target, 'profiles', 'web', 'cordis.patch.yml'), /dsh-rewind-plugin/)
  assert.deepEqual(report.conflicts, [])
})

test('--dry-run touches nothing and reports what it would do', { skip }, () => {
  const source = oldHome('dry')
  const target = join(root, 'deepsea', 'dry')
  mkdirSync(target, { recursive: true })
  put(join(target, 'settings.yaml'), 'mine: true\n')
  const before = [snapshot(source), snapshot(target)]
  const { report, installs } = run(source, target, { dryRun: true, moveSignIns: true })
  assert.deepEqual([snapshot(source), snapshot(target)], before)
  assert.equal(report.sessions.new, 3)
  assert.deepEqual(report.workspaces.added, ['demo'])
  assert.ok(report.conflicts.some(c => c.what === 'settings.yaml'))
  assert.deepEqual(installs, [])
  assert.ok(report.bundles.thirdParty.some(b => b.result === 'would install'))
  assert.deepEqual(report.credentials.movedSignIns, ['llm-pi-ai/anthropic-oauth'])
  assert.equal(oldColor(source, MAP, Y), '#8E4EC6')
  // Without the old world's table: DSH's own state still comes; old plugins' files are unknown, their rows carried as they are.
  const bare = adopt({ source, target, dryRun: true, plugins: PLUGINS, yaml: Y })
  assert.ok(bare.unknown.some(u => u.what === 'billing') && bare.unknown.some(u => u.what === 'ledger'))
  assert.ok(bare.rows.carried.includes('id:old-tailscale'))
  assert.equal(bare.sessions.new, 3)
})

test('dsd adopt: --move-sign-ins refuses --throwaway; a variant or --throwaway, not both', () => {
  const dsd = join(REPO, 'tools', 'dsd', 'bin', 'dsd.mjs')
  const source = join(root, 'cli-home')
  put(join(source, 'settings.yaml'), 'x: 1\n')
  const call = (...args) => spawnSync(process.execPath, [dsd, 'adopt', ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: join(root, 'nowhere') } })
  const refused = call(source, '--throwaway', '--move-sign-ins')
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /--move-sign-ins refuses --throwaway/)
  assert.equal(call(source, 'personal', '--throwaway').status, 2)
  assert.equal(call(source, 'personal', '--simulated').status, 2)
})

test('profile rows after the harness template: its empty `[]` goes, so the patch stays one YAML list', { skip }, () => {
  const source = oldHome('template')
  const target = join(root, 'deepsea', 'template')
  put(join(target, 'profiles', 'web', 'cordis.patch.yml'), '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n[]\n')
  run(source, target)
  const text = read(target, 'profiles', 'web', 'cordis.patch.yml')
  assert.doesNotMatch(text, /^\[\]$/m)
  assert.ok(Array.isArray(Y.parse(text)) && Y.parse(text).length > 0)
})
