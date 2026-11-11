import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWorktreeOptions, harnessWorktree } from '../lib/harness-worktree.mjs'
import { run } from '../commands/run.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsd-worktree-test-'))
process.env.DEEPSEA_ROOT = join(root, 'homes')
process.env.DEEPSEA_LOG_ROOT = join(root, 'logs')
test.after(() => rmSync(root, { recursive: true, force: true }))

test('new overrides cannot touch installed variants or server-only display names', async () => {
  await assert.rejects(run(['rewind', '--harness-worktree', '/missing']), /only for throwaways/)
  await assert.rejects(run(['rewind', '--display-name', 'DeepSea Rewind']), /throwaway macOS app/)
  await assert.rejects(run(['rewind', '--throwaway-server', '--display-name', 'DeepSea Rewind']), /throwaway macOS app/)
  await assert.rejects(run(['rewind', '--throwaway-server', '--harness-worktree', '/missing', '--harness', 'HEAD']), /alternatives/)
  assert.equal(existsSync(join(root, 'homes')), false)
  for (const name of ['', ' ../app', '../app', 'a/b', 'a\\b', 'a:b', 'a\nname', '.', '..']) {
    assert.throws(() => checkWorktreeOptions({ 'display-name': name }, { throwaway: true, withApp: true }), /app name/)
  }
  assert.doesNotThrow(() => checkWorktreeOptions({ 'display-name': 'DeepSea Rewind' }, { throwaway: true, withApp: true }))
})

test('local harness resolves dirty files without changing its HEAD, index or sources; shared builds and aliases are refused', () => {
  const dir = join(root, 'harness')
  mkdirSync(join(dir, 'apps', 'cli', 'src'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_EMAIL: 'test@example.com' } }).trim()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
  writeFileSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'), '// source\n')
  git('add', '.'); git('commit', '-qm', 'fixture')
  assert.throws(() => harnessWorktree(dir), /pnpm install/)
  mkdirSync(join(dir, 'node_modules'))
  assert.throws(() => harnessWorktree(dir), /pnpm run build/)
  mkdirSync(join(dir, 'apps', 'web', 'dist'), { recursive: true })
  writeFileSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'), '// dirty source\n')
  const before = git('status', '--porcelain')
  const index = readFileSync(join(dir, '.git', 'index'))
  const info = harnessWorktree(dir)
  assert.equal(info.dir, realpathSync(dir))
  assert.equal(info.commit, git('rev-parse', 'HEAD'))
  assert.equal(info.dirty, true)
  assert.equal(git('status', '--porcelain'), before)
  assert.deepEqual(readFileSync(join(dir, '.git', 'index')), index)
  assert.equal(readFileSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'), 'utf8'), '// dirty source\n')
  assert.throws(() => harnessWorktree(join(dir, 'apps')), /working tree root/)
  assert.throws(() => harnessWorktree(join(root, 'missing')), /no directory/)
  const immutable = join(root, '_builds', 'harness-aaaaaaaaaaaa')
  mkdirSync(immutable, { recursive: true })
  const alias = join(root, 'alias')
  symlinkSync(immutable, alias)
  assert.throws(() => harnessWorktree(immutable), /immutable _builds/)
  assert.throws(() => harnessWorktree(alias), /immutable _builds/)
})

test('a topic name resolves to that topic\'s harness worktree', () => {
  const worktrees = join(root, 'worktrees')
  const previous = process.env.DEEPSEA_WORKTREES
  process.env.DEEPSEA_WORKTREES = worktrees
  try {
    const dir = join(worktrees, 'harness-shorthand')
    mkdirSync(join(dir, 'apps', 'cli', 'src'), { recursive: true })
    mkdirSync(join(dir, 'apps', 'web', 'dist'), { recursive: true })
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
    writeFileSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'), '// source\n')
    const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_EMAIL: 'test@example.com' }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env })
    execFileSync('git', ['add', '.'], { cwd: dir, env })
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir, env })
    assert.equal(harnessWorktree('shorthand').dir, realpathSync(dir))
    assert.throws(() => harnessWorktree('nonexistent-topic'), /no harness worktree for nonexistent-topic/)
  } finally {
    if (previous === undefined) delete process.env.DEEPSEA_WORKTREES
    else process.env.DEEPSEA_WORKTREES = previous
  }
})

test('display override changes app name but preserves random bundle identity and output directory', { skip: process.platform !== 'darwin' }, async () => {
  const { buildThrowawayApp } = await import('../lib/app.mjs')
  const source = join(root, 'app-source')
  const build = join(root, 'glyph-source')
  mkdirSync(source)
  mkdirSync(join(build, 'apps', 'web', 'public'), { recursive: true })
  writeFileSync(join(build, 'apps', 'web', 'public', 'favicon.svg'), '<svg/>')
  writeFileSync(join(source, 'build.mjs'), 'console.log(JSON.stringify({ args: process.argv.slice(2) }))\n')
  const result = buildThrowawayApp('rewind-abc123', { source: { dir: source, describe: 'fixture', build: 'test' }, harnessBuild: build, name: 'DeepSea Rewind' })
  try {
    const value = flag => result.args[result.args.indexOf(flag) + 1]
    assert.equal(value('--name'), 'DeepSea Rewind')
    assert.equal(value('--bundle-id'), 'io.github.taliesinb.deepsea.rewind-abc123')
    assert.match(value('--out'), /deepsea-app-rewind-abc123$/)
  } finally { rmSync(result.dir, { recursive: true, force: true }) }
})
