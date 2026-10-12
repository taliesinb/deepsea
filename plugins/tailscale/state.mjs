/**
 * The plugin's persisted state, `$DSH_HOME/plugins/tailscale/state.json`
 * (0600; the token is a credential: whoever holds it drives an agent that
 * runs commands on this machine):
 *
 *   enabled       whether the operator wants the Serve path published; absent
 *                 until first set, which means "as the variant says"
 *   allowedUsers  tailnet logins admitted without a token
 *   token         the standing access token (the QR code's)
 *
 * tailscaled, not this file, is the truth for whether the Serve path is
 * actually published.
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const VERSION = 1
/** 192-bit token, base64url (32 characters): unguessable, and short enough for a QR code. */
const TOKEN_BYTES = 24

/** `<home>/plugins/tailscale/<file>`. */
export function stateFileOf(home, file = 'state.json') {
  return join(home, 'plugins', 'tailscale', file)
}

export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** Lower-cased, trimmed login for exact comparison. */
export function normalizeLogin(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * A comma, space, semicolon or newline separated login list as unique
 * normalized entries; entries with quotes or angle brackets are dropped.
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseUserList(value) {
  const raw = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\s,;]+/)
  const out = []
  for (const entry of raw) {
    const login = normalizeLogin(entry)
    if (login === '' || login.length > 254 || /["'<>]/.test(login)) continue
    if (!out.includes(login)) out.push(login)
  }
  return out
}

function normalizeState(raw) {
  const record = typeof raw === 'object' && raw !== null ? raw : {}
  const token = typeof record.token === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(record.token) ? record.token : generateToken()
  return {
    version: VERSION,
    ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
    allowedUsers: parseUserList(record.allowedUsers),
    token,
  }
}

/**
 * Load the state, creating it (with a fresh token) when missing or unreadable.
 * @param {string} file
 * @param {(message: string) => void} [warn]
 */
export async function loadState(file, warn = () => {}) {
  let raw
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`tailscale: ${file} unreadable, starting afresh: ${String(error?.message ?? error)}`)
    raw = undefined
  }
  const state = normalizeState(raw)
  // Written at once when new or re-tokened, so the QR code survives a restart.
  if (raw === undefined || raw.token !== state.token) await saveState(file, state)
  return state
}

/** Write the state atomically, owner-only. */
export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}
