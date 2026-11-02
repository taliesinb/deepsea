/**
 * The registry of remote DeepSea servers and of the remote workspaces shown
 * in this sidebar: `$DSH_HOME/plugins/remote-workspaces/workspaces.json`
 * (0600 in a 0700 directory; a server entry may carry a standing token, a
 * credential). Remote workspaces are not entries of this server's own
 * workspace registry, which needs a local directory; they live here and the
 * browser half adds them to the sidebar.
 *
 *   servers[]    { id, url, label, token?, lastUsedAt? }
 *   workspaces[] { id, serverId, remoteWorkspaceId, title, remotePath, remoteTitle?,
 *                  remoteCreatedAt?, createdAt, order, sessionOrder,
 *                  cache: { sessions: [{ id, title, updatedAt?, running?, remoteIndex?, permissions? }],
 *                           blankIds?, polledAt?, gone? } }
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const VERSION = 1

/** `<home>/plugins/remote-workspaces/workspaces.json`. */
export function stateFileOf(home) {
  return join(home, 'plugins', 'remote-workspaces', 'workspaces.json')
}

export function generateId(prefix) {
  return `${prefix}-${randomBytes(6).toString('base64url')}`
}

/** A short, URL-safe route segment derived from a server label (`studio-lab`), unique among `taken`. */
export function routeIdFor(label, taken = new Set()) {
  const base = String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'remote'
  let candidate = base
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${String(n)}`
  return candidate
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function normalizeServer(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = String(raw.id ?? '')
  const url = String(raw.url ?? '')
  if (!ID_PATTERN.test(id) || url === '') return undefined
  return {
    id,
    url,
    label: String(raw.label ?? id),
    token: typeof raw.token === 'string' && raw.token !== '' ? raw.token : undefined,
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : undefined,
  }
}

function normalizeWorkspace(raw, serverIds) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = String(raw.id ?? '')
  const serverId = String(raw.serverId ?? '')
  const remoteWorkspaceId = String(raw.remoteWorkspaceId ?? '')
  if (id === '' || !serverIds.has(serverId) || remoteWorkspaceId === '') return undefined
  const cache = typeof raw.cache === 'object' && raw.cache !== null ? raw.cache : {}
  const sessions = Array.isArray(cache.sessions)
    ? cache.sessions.flatMap(entry => (typeof entry === 'object' && entry !== null && typeof entry.id === 'string'
      ? [{
          id: entry.id, title: String(entry.title ?? ''),
          ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}),
          ...(entry.running === true ? { running: true } : {}),
          ...(Number.isInteger(entry.remoteIndex) ? { remoteIndex: entry.remoteIndex } : {}),
          ...(typeof entry.permissions === 'object' && entry.permissions !== null ? { permissions: entry.permissions } : {}),
        }]
      : []))
    : []
  return {
    id,
    serverId,
    remoteWorkspaceId,
    title: String(raw.title ?? remoteWorkspaceId),
    remotePath: String(raw.remotePath ?? ''),
    ...(typeof raw.remoteTitle === 'string' ? { remoteTitle: raw.remoteTitle } : {}),
    ...(typeof raw.remoteCreatedAt === 'string' ? { remoteCreatedAt: raw.remoteCreatedAt } : {}),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    order: Number.isFinite(raw.order) ? Number(raw.order) : 0,
    /** Local manual session order (ids); sessions absent from it keep the remote's order ahead of it. */
    sessionOrder: Array.isArray(raw.sessionOrder) ? raw.sessionOrder.filter(id => typeof id === 'string') : [],
    cache: {
      sessions,
      ...(Array.isArray(cache.blankIds) ? { blankIds: cache.blankIds.filter(id => typeof id === 'string') } : {}),
      ...(typeof cache.polledAt === 'string' ? { polledAt: cache.polledAt } : {}),
      ...(cache.gone === true ? { gone: true } : {}),
    },
  }
}

export function normalizeState(raw) {
  const record = typeof raw === 'object' && raw !== null ? raw : {}
  const servers = (Array.isArray(record.servers) ? record.servers : []).flatMap(entry => {
    const server = normalizeServer(entry)
    return server === undefined ? [] : [server]
  })
  const seen = new Set()
  const uniqueServers = servers.filter(server => !seen.has(server.id) && seen.add(server.id))
  const serverIds = new Set(uniqueServers.map(server => server.id))
  const workspaces = (Array.isArray(record.workspaces) ? record.workspaces : []).flatMap(entry => {
    const workspace = normalizeWorkspace(entry, serverIds)
    return workspace === undefined ? [] : [workspace]
  })
  return { version: VERSION, servers: uniqueServers, workspaces }
}

/** @returns {Promise<ReturnType<typeof normalizeState>>} */
export async function loadState(file) {
  try {
    return normalizeState(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeState({})
    throw new Error(`remote-workspaces: cannot read ${file}: ${String(error?.message ?? error)}`)
  }
}

export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${String(process.pid)}.tmp`
  await writeFile(tmp, `${JSON.stringify(normalizeState(state), null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}
