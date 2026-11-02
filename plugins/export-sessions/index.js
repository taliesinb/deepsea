/**
 * @deepsea/export-sessions, host half: `/export-workspace [workspace]` and
 * `/export-session [session]` write the current workspace or session (or the
 * named one), with every subagent session and the attachments they
 * reference, to a `.workspace.deepsea.zip` / `.session.deepsea.zip` in the
 * export directory (archive.mjs), for @deepsea/import-sessions'
 * `/import-workspace` and `/import-session` on another machine.
 *
 * The browser half decorates both bare commands with a dialog that shows the
 * written ZIP's path and offers it as a download; it reaches the host through
 * `POST /deepsea-export-sessions/export` (Connection JSON envelope) and
 * downloads from `GET /deepsea-export-sessions/download/<name>`, both behind
 * DSH's own request gate.
 */
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { EXPORT_NAME, makeExport } from './archive.mjs'

export const name = 'deepsea-export-sessions'
export const inject = ['commands', 'webServer', 'connection', 'sessionPersistence', 'workspaceRegistry']

/** The control and download routes' prefix (document-relative in the browser). */
export const CHANNEL = '/deepsea-export-sessions'
const DEFAULT_DIRECTORY = '~/Downloads'

/** `{ directory? }`: where exports are written; default ~/Downloads. */
export function resolveConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'directory')) throw new TypeError('Invalid export-sessions configuration: the only key is `directory`')
  const directory = input.directory
  if (directory !== undefined && (typeof directory !== 'string' || directory.trim() === '' || directory.includes('\0') || !(directory.startsWith('/') || directory.startsWith('~')))) throw new TypeError('Invalid export directory: an absolute path or one starting with ~')
  return directory === undefined ? {} : { directory }
}
export const Config = { '~standard': { version: 1, vendor: 'deepsea-export-sessions', validate(input) {
  try { return { value: resolveConfig(input ?? {}) } }
  catch (error) { return { issues: [{ message: error.message }] } }
} } }

const megabytes = bytes => `${(bytes / 1_000_000).toFixed(1)} megabytes`
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`
const tildify = (path, home = process.env.HOME) => home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path

/**
 * The workspace `query` names: its id, its path (`~` expanded), or its title
 * (case-insensitive; a title several workspaces share is refused with their paths).
 * @param {readonly { id: string, title: string, path: string }[]} workspaces
 * @param {string} query
 */
export function findWorkspace(workspaces, query) {
  const byId = workspaces.find(workspace => String(workspace.id) === query)
  if (byId !== undefined) return byId
  const path = query.startsWith('/') || query.startsWith('~') ? resolve(expandHomePath(query)) : undefined
  const byPath = path === undefined ? undefined : workspaces.find(workspace => workspace.path === path)
  if (byPath !== undefined) return byPath
  const byTitle = workspaces.filter(workspace => workspace.title.toLowerCase() === query.toLowerCase())
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) throw new Error(`${byTitle.length} workspaces are called ${query}; name one by its path: ${byTitle.map(workspace => workspace.path).join(', ')}`)
  throw new Error(`no workspace ${query}${workspaces.length === 0 ? '' : `; workspaces: ${workspaces.map(workspace => workspace.title).join(', ')}`}`)
}

/**
 * The session `query` names: its id or its title (case-insensitive; a title
 * several sessions share is refused with their ids).
 * @param {readonly { id: string, title: string }[]} sessions
 * @param {string} query
 */
export function findSession(sessions, query) {
  const byId = sessions.find(session => session.id === query)
  if (byId !== undefined) return byId
  const byTitle = sessions.filter(session => session.title.toLowerCase() === query.toLowerCase())
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) throw new Error(`${byTitle.length} sessions are called ${query}; name one by its id: ${byTitle.map(session => session.id).join(', ')}`)
  throw new Error(`no session ${query}`)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ directory?: string }} config
 */
export function apply(ctx, config = {}) {
  const home = resolveDshHome()
  const directory = resolve(expandHomePath(config?.directory ?? DEFAULT_DIRECTORY))
  const shownDirectory = tildify(directory)

  /** Every session the server lists, with its title and cwd. */
  const sessionRows = async signal => {
    const controller = ctx.get('sessionController')
    if (controller === undefined) return []
    const { items } = await controller.list({}, signal ?? new AbortController().signal)
    return items.map(item => ({ id: String(item.sessionId), cwd: item.cwd, title: typeof item.projections?.values?.title === 'string' && item.projections.values.title !== '' ? item.projections.values.title : `Session ${String(item.sessionId).slice(-8)}` }))
  }
  const workspaceOf = async (sessionId, cwd) => {
    const registry = ctx.workspaceRegistry
    const holding = registry.list().find(workspace => workspace.sessionIds.map(String).includes(sessionId))
    if (holding !== undefined) return holding
    const byPath = typeof cwd === 'string' ? await registry.resolveByPath(cwd).catch(() => undefined) : undefined
    if (byPath === undefined) throw new Error('this session belongs to no workspace')
    return byPath
  }

  /**
   * Export a workspace (named, or the one holding `sessionId`) or a session
   * (named, or `sessionId` itself).
   * @param {'workspace' | 'session'} kind
   * @param {{ sessionId: string, cwd?: string, query?: string, signal?: AbortSignal }} target
   */
  const exportOne = async (kind, { sessionId, cwd, query, signal }) => {
    const persistence = ctx.sessionPersistence
    if (kind === 'workspace') {
      const workspace = query ? findWorkspace(ctx.workspaceRegistry.list(), query) : await workspaceOf(sessionId, cwd)
      const saved = await makeExport({ kind, home, directory, title: workspace.title, roots: workspace.sessionIds.map(String), describe: { title: workspace.title, path: workspace.path }, persistence, signal })
      return { ...saved, title: workspace.title }
    }
    const rows = await sessionRows(signal)
    const session = query ? findSession(rows, query) : rows.find(row => row.id === sessionId) ?? { id: sessionId, cwd, title: `Session ${sessionId.slice(-8)}` }
    const workspace = await workspaceOf(session.id, session.cwd).catch(() => undefined)
    const saved = await makeExport({ kind, home, directory, title: session.title, roots: [session.id], describe: { id: session.id, title: session.title, cwd: session.cwd, ...(workspace === undefined ? {} : { workspace: { title: workspace.title, path: workspace.path } }) }, persistence, signal })
    return { ...saved, title: session.title }
  }
  const finished = saved => {
    if (saved.missingAttachments > 0) ctx.logger.warn(`export-sessions: ${saved.name}: ${plural(saved.missingAttachments, 'referenced attachment')} not in this home's store`)
    return { name: saved.name, title: saved.title, counts: saved.counts, bytes: saved.bytes, displayPath: `${shownDirectory}/${saved.name}` }
  }

  for (const kind of /** @type {const} */ (['workspace', 'session'])) {
    ctx.effect(() => ctx.commands.register({
      name: `export-${kind}`,
      description: `Export this ${kind}, or a named one, to ${shownDirectory}`,
      input: { hint: kind },
      handler: async ({ agent, rawInput, signal }) => {
        try {
          const saved = finished(await exportOne(kind, { sessionId: String(agent.session.id), cwd: agent.session.header?.cwd, query: rawInput.trim() || undefined, signal }))
          return { kind: 'success', text: `Exported ${saved.title}: ${plural(saved.counts.sessions, 'session')} and ${plural(saved.counts.attachments, 'attachment')} to:\n\`${saved.displayPath}\` (${megabytes(saved.bytes)}).` }
        } catch (error) { return { kind: 'error', text: `Export failed: ${String(error?.message ?? error)}` } }
      },
    }), `export-sessions: /export-${kind}`)
  }

  const fail = message => ({ ok: false, error: { code: 'deepsea-export-sessions/error', message, details: {} } })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = new URL(req.url ?? '/', 'http://x').pathname.slice(CHANNEL.length + 1)
      if (req.method === 'GET' && endpoint.startsWith('download/')) {
        const file = decodeURIComponent(endpoint.slice('download/'.length))
        const path = join(directory, file)
        const info = file === basename(file) && EXPORT_NAME.test(file) ? await lstat(path).catch(() => undefined) : undefined
        if (info === undefined || !info.isFile()) { res.writeHead(404); res.end('not found'); return }
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(info.size), 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store' })
        createReadStream(path).pipe(res)
        return
      }
      if (req.method !== 'POST' || endpoint !== 'export') { res.writeHead(404); res.end('not found'); return }
      try {
        const chunks = []
        let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024) throw new Error('request too large'); chunks.push(chunk) }
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) throw new Error('invalid client-request envelope')
        const args = message.payload?.args ?? {}
        let result
        try {
          if (args.kind !== 'workspace' && args.kind !== 'session') throw new Error('kind must be "workspace" or "session"')
          if (typeof args.sessionId !== 'string' || args.sessionId === '') throw new Error('sessionId is required')
          const header = (await ctx.sessionPersistence.stat(args.sessionId))?.header
          result = { ok: true, value: finished(await exportOne(args.kind, { sessionId: args.sessionId, cwd: header?.cwd })) }
        } catch (error) { result = fail(String(error?.message ?? error)) }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
      } catch (error) { if (!res.headersSent) { res.writeHead(400); res.end(String(error?.message ?? error)) } }
    },
  }), 'export-sessions: control and download routes')
}
