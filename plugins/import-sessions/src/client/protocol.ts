/**
 * @deepsea/import-sessions: host ⇄ browser protocol types.
 *
 * Mirrors ../../PROTOCOL.md exactly; the host is written against the same
 * document. Keep the two in step.
 */
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

export const CHANNEL = '/deepsea-import-sessions'

export type Source = 'claude' | 'pi' | 'dsh'

/** `sources` — `{}` */
export interface SourcesResult {
  platform: string
  pickerAvailable: boolean
  sources: Record<Source, { label: string, root: string, defaultRoot: string, exists: boolean }>
  workspaces: Array<{ id: string, title: string, path: string }>
  pickerKind: 'file-or-directory' | 'directory' | 'none'
  defaults: { keepTurns: number, resultCap: number }
  /** Short host name of the server machine, when known. */
  server: { host?: string }
  /** Whether this page runs on the server machine itself; the tailnet peer's host name otherwise, when known. */
  client: { sameMachine: boolean, host?: string }
}

/** `pick` — `{ source }` */
export interface PickResult { path: string | null }

/** `upload-begin` — `{ source }`; `chunkBytes` is the largest encoded (pre-base64) chunk the host accepts. */
export interface UploadBeginResult { uploadId: string, chunkBytes: number }

/** `upload-chunk` — `{ uploadId, path, data, encoding, offset }` */
export interface UploadChunkArgs {
  uploadId: string
  path: string
  data: string
  encoding: 'gzip' | 'identity'
  offset: number
}
export interface UploadChunkResult { bytes: number }

/** `upload-finish` — `{ uploadId }`; `path` is a server directory to hand to `scan` as-is. */
export interface UploadFinishResult { path: string, files: number, bytes: number }

/** `upload-discard` — `{ uploadId }` */
export interface UploadDiscardResult { discarded: boolean }

export type ScanDestination =
  | { kind: 'existing', workspaceId: string, title: string }
  | { kind: 'new', title: string }
  | { kind: 'ungrouped', reason: string }

export interface ScanSession {
  id: string
  sourceId: string
  file: string
  title: string
  startedAt: number
  endedAt: number
  bytes: number
  prompts?: number
  turns: number
  toolCalls: number
  estimatedTokens: number
  large: boolean
  imported: boolean
  duplicateOf?: string
  subagents?: number
}

export interface ScanWorkspace {
  key: string
  dir: string
  dirExists: boolean
  destination: ScanDestination
  sessions: ScanSession[]
}

/** `scan` — `{ source, path }` */
export interface ScanResult {
  source: Source
  path: string
  kind: 'root' | 'workspace' | 'session'
  uploaded: boolean
  largeTokens: number
  workspaces: ScanWorkspace[]
  scanToken?: string
}

export type ImportMode =
  | { kind: 'archive' }
  | { kind: 'working', keepTurns: number, resultCap: number }

export type ImportDestination =
  | { kind: 'existing', workspaceId: string }
  | { kind: 'new', dir: string }
  | { kind: 'ungrouped' }

export interface ImportSelection { file: string, destination: ImportDestination, mode: ImportMode }

/** `import` — `{ source, selections, uploadId? }` */
export interface ImportArgs { source: Source, selections: ImportSelection[], uploadId?: string, scanToken?: string }
export interface ImportResult { jobId: string, total: number }

export interface ImportCounts {
  turns: number
  steps: number
  toolCalls: number
  toolResults: number
  images: number
  imagesImported: number
  truncatedResults: number
  droppedRecords: number
  orphanResults: number
  foldedTurns?: number
  children?: number
  surfaceTokens?: number
}

export interface ImportRowResult {
  file: string
  ok: boolean
  sessionId?: string
  title?: string
  workspace?: { id: string, title: string } | null
  counts?: ImportCounts
  error?: string
}

/** `progress` — `{ jobId }` */
export interface ProgressResult {
  jobId: string
  total: number
  done: number
  current?: { file: string, title: string, phase: 'reading' | 'writing' | 'attaching' }
  finished: boolean
  results: ImportRowResult[]
}

/** A failed endpoint result, keeping the host's error code for branching (`picker-unavailable`). */
export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RpcError'
  }
}

export const PICKER_UNAVAILABLE = 'deepsea-import-sessions/picker-unavailable'

/** The shape every stage uses to reach the host: endpoint + args → typed value. */
export type Call = <T>(endpoint: string, args: object) => Promise<T>

/**
 * Call one endpoint on the plugin channel and unwrap the envelope.
 * @param rpc - the connection's generic caller.
 * @param endpoint - `sources` | `pick` | `upload-*` | `scan` | `import` | `progress`.
 * @param args - endpoint arguments (sent as `payload.args`).
 * @param signal - optional cancellation.
 * @returns the endpoint's value, typed by the caller.
 * @throws RpcError with the host's code on `{ ok: false }`.
 */
export async function callChannel<T>(rpc: ClientConnectionRpc, endpoint: string, args: object, signal?: AbortSignal): Promise<T> {
  const result = await rpc.call(CHANNEL, endpoint, { args }, signal)
  if (!result.ok) throw new RpcError(result.error.code, result.error.message)
  return result.value as T
}

/** Failure text for display; keeps the host's message verbatim. */
export function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
