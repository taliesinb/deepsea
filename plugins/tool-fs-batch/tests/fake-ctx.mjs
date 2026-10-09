/**
 * A fake plugin Context for tests: a real-filesystem `ctx.fs` under a temp
 * root (resolve/stat/listDir/readText/writeText/editText with an in-memory
 * version counter and the FS_SANDBOX_DENIED / FS_STALE_VERSION codes of
 * dsh-fs-sandbox + dsh-fs-local), a mini read-before-edit policy wired to
 * `fs/edit-intent` (waterfall) and `fs/observed` (emit) like
 * dsh-fs-observation-policy, a `sandboxPolicy` resolver and a bare `tools`.
 *
 * The write fence is dsh-fs-sandbox's: `read-only` refuses every write,
 * `workspace-write` allows a target whose canonical path is under
 * `writableRoots(policy)` (the workspace root, /tmp and the platform temp dir),
 * `danger-full-access` allows all; a write without a policy runs under the
 * deployment's. `fs.checkWrite` answers that same decision without writing,
 * as the harness topic `fs-check-write` does; `checkWrite: 'unknown'` is a
 * backend that cannot decide, `checkWrite: false` a harness without the
 * method. `refuseAtWrite` (a set of paths) refuses those writes as well, as if
 * the policy had changed after validation. `confining: false` is a backend
 * that never confines (`sandboxMode` undefined; every write allowed).
 * `checkWriteCalls` records the arguments of each checkWrite.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'

class FsError extends Error {
  constructor(message, code) { super(message); this.code = code }
}

function lstatOrUndefined(path) {
  try { return lstatSync(path) } catch { return undefined }
}

/** The canonical spelling of `p`: its deepest existing ancestor realpath'd, the missing rest appended. */
function canonical(p) {
  if (existsSync(p)) return realpathSync.native(p)
  const parent = dirname(p)
  return parent === p ? p : join(canonical(parent), basename(p))
}

/**
 * A fresh directory outside every writable root of a workspace-write policy
 * (not under the temp dirs): beside the tests. The caller removes it.
 */
export function outsideDir() {
  return mkdtempSync(join(import.meta.dirname, '.outside-'))
}

export function fakeCtx({ workspaceRoot, mode = 'workspace-write', withPolicy = true, withShell = true, workingDirectory, confining = true, checkWrite = true }) {
  /** owner(session id) → Map(targetKey → { kind, version }) — the policy's record */
  const observed = new Map()
  /** abs path → version token; bumped on every mutation (also by `externalWrite`) */
  const versions = new Map()
  const events = []
  const registered = []
  const owner = (exec) => exec?.agent?.session?.id ?? '(none)'
  const versionOf = (abs) => versions.get(abs) ?? `v0:${statSync(abs).size}`
  const bump = (abs) => { versions.set(abs, `v${versions.size + events.length + 1}`); return versions.get(abs) }
  const mk = (abs) => ({ targetKey: abs, path: abs, displayPath: abs })
  const refuseAtWrite = new Set()
  const checkWriteCalls = []
  /** The fence's one decision, shared by the writes and checkWrite: the refusal message, or undefined. */
  const decide = (target, policy = { mode, workspaceRoot }) => {
    const denied = `cannot write "${target.path}": file access denied under ${policy.mode} mode`
    if (!confining) return undefined
    if (policy.mode === 'read-only') return denied
    if (policy.mode === 'workspace-write') {
      const key = canonical(target.path)
      if (!writableRoots(policy).some(r => key === r || key.startsWith(`${r}/`))) return denied
    }
    return undefined
  }
  const fence = (target, policy) => {
    const denied = refuseAtWrite.has(target.path) ? `cannot write "${target.path}": file access denied under ${(policy ?? { mode }).mode} mode` : decide(target, policy)
    if (denied !== undefined) throw new FsError(denied, 'FS_SANDBOX_DENIED')
  }

  const fs = {
    sandboxMode: confining ? mode : undefined,
    ...checkWrite === false ? {} : {
      async checkWrite(target, signal, policy) {
        checkWriteCalls.push({ path: target.path, signal, policy })
        if (checkWrite === 'unknown') return { kind: 'unknown' }
        const denied = decide(target, policy)
        return denied === undefined ? { kind: 'allowed' } : { kind: 'denied', message: denied }
      },
    },
    async resolve(path, opts) {
      return mk(isAbsolute(path) ? path : resolvePath(opts?.cwd ?? workspaceRoot, path))
    },
    async stat(target) {
      try {
        const s = statSync(target.path)
        return { version: versionOf(target.path), type: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other', ...s.isFile() ? { size: s.size } : {} }
      } catch { return undefined }
    },
    async listDir(target) {
      return readdirSync(target.path, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => {
          const abs = resolvePath(target.path, d.name)
          const type = d.isFile() ? 'file' : d.isDirectory() ? 'directory' : 'other'
          return { name: d.name, type, target: mk(abs), ...type === 'file' ? { size: statSync(abs).size } : {} }
        })
    },
    async lstat(path, opts) {
      try {
        const s = lstatSync(isAbsolute(path) ? path : resolvePath(opts?.cwd ?? workspaceRoot, path))
        return { version: 'v', type: s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other' }
      } catch { return undefined }
    },
    async readText(target) { return readFileSync(target.path, 'utf8') },
    async writeText(target, content, expected, _signal, policy) {
      fence(target, policy)
      const existed = lstatOrUndefined(target.path) !== undefined
      // createIfAbsent onto an existing path: refused, with dsh-fs-local's code
      if (expected?.kind === 'createIfAbsent' && existed) throw new FsError(`cannot overwrite existing "${target.path}" without reading it first`, 'FS_NOT_OBSERVED')
      mkdirSync(dirname(target.path), { recursive: true })
      // like dsh-fs-local, a new file is published owner-only (0600)
      writeFileSync(target.path, content, existed ? undefined : { mode: 0o600 })
      if (!existed) chmodSync(target.path, 0o600)
      return { operation: existed ? 'update' : 'create', version: bump(target.path), before: null, after: content }
    },
    // a host-backed backend: process paths are host paths (as dsh-fs-local)
    processPath(target) { return target.path },
    processPathFromHostPath(path) { return isAbsolute(path) ? resolvePath(path) : undefined },
    async editText(target, edit, expected, _signal, policy) {
      fence(target, policy)
      let before
      try { before = readFileSync(target.path, 'utf8') } catch { throw new FsError(`${target.path} not found`, 'FS_NOT_FOUND') }
      if (expected !== undefined && expected.version !== versionOf(target.path)) {
        throw new FsError(`cannot edit "${target.path}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const count = before.split(edit.oldString).length - 1
      if (count === 0) throw new FsError(`old_string was not found in "${target.path}"`, 'FS_EDIT_NO_MATCH')
      if (count > 1 && !edit.replaceAll) throw new FsError(`old_string appears ${count} times in "${target.path}"`, 'FS_EDIT_AMBIGUOUS')
      const after = edit.replaceAll ? before.split(edit.oldString).join(edit.newString) : before.replace(edit.oldString, () => edit.newString)
      writeFileSync(target.path, after)
      return { version: bump(target.path), before, after }
    },
  }

  /** A tiny ctx.shell (the ShellExecutor shape: resolve, then execute → result()): /bin/sh in `workdir`, records specs. */
  const shellRuns = []
  const shell = {
    resolve(request) { return { ...request, timeoutMs: request.timeoutMs ?? 30_000, onExpiry: 'kill' } },
    async execute(spec) {
      shellRuns.push(spec)
      const r = spawnSync('/bin/sh', ['-c', spec.command], { cwd: spec.workdir, encoding: 'utf8', timeout: spec.timeoutMs })
      const result = { exitCode: r.status, signal: r.signal ?? null, timedOut: r.error?.code === 'ETIMEDOUT', aborted: false, timeoutMs: spec.timeoutMs, stdout: { text: r.stdout ?? '', truncated: false }, stderr: { text: r.stderr ?? '', truncated: false } }
      return { result: async () => result }
    },
  }

  const ctx = {
    fs,
    events,
    registered,
    shellRuns,
    refuseAtWrite,
    checkWriteCalls,
    logger: { info() {}, warn() {} },
    tools: { register(t) { registered.push(t) }, get(name) { return registered.find(t => t.name === name) } },
    systemPrompt: { sections: [], section(s) { this.sections.push(s) }, getSectionOrder() { return 1500 } },
    get(name) {
      if (name === 'fs') return fs
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode, workspaceRoot }) }
      if (name === 'shell' && withShell) return shell
      // the harness's WorkingDirectoryService (`working_directory` cd): `workingDirectory.cwd` is the session's current directory
      if (name === 'workingDirectory' && workingDirectory) return { ensure: async () => workingDirectory.cwd }
      return undefined
    },
    emit(name, target, state, exec) {
      events.push({ name, path: target.path, state })
      if (name !== 'fs/observed' || !withPolicy) return
      const map = observed.get(owner(exec)) ?? new Map()
      map.set(target.targetKey, state)
      observed.set(owner(exec), map)
    },
    async waterfall(name, target, exec, fallback) {
      if (name !== 'fs/edit-intent' || !withPolicy) return fallback()
      const state = observed.get(owner(exec))?.get(target.targetKey)
      if (state === undefined) throw new FsError(`edit requires reading "${target.path}" first`, 'FS_NOT_OBSERVED')
      if (state.kind === 'absent') throw new FsError(`"${target.path}" was observed absent`, 'FS_NOT_FOUND')
      return { version: state.version }
    },
    /** Test helper: what the built-in `read` does — record a present observation for this owner. */
    markRead(exec, abs) {
      const map = observed.get(owner(exec)) ?? new Map()
      map.set(abs, { kind: 'present', version: versionOf(abs) })
      observed.set(owner(exec), map)
    },
    /** Test helper: a write by someone else (bash), which moves the version without an observation. */
    externalWrite(abs, content) {
      writeFileSync(abs, content)
      bump(abs)
    },
  }
  return ctx
}

export function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { id: sessionId, header: { id: sessionId, cwd } } }, signal: undefined, callId: 'call-1' }
}

/** Render a canonical value through the tool's own output.render → text. */
export function textOf(tool, args, value) {
  return tool.output.render(args, value).map(b => b.text).join('\n')
}
