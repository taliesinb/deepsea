/**
 * Client-side transcript filter for device uploads (PROTOCOL.md, upload
 * section). Mirrors the host's `sanitizeRelativePath` so nothing we send is
 * rejected, and so a folder chooser over a whole store does not upload memory
 * notes, backups or unrelated files.
 *
 *   claude: `<uuid>.jsonl` at any depth, plus `<uuid>/subagents/agent-*.jsonl`;
 *           skip anything under `memory/`, `*.backup`, everything else
 *   pi:     `<ISO-ts>_<uuid>.jsonl`; skip everything else
 *
 * Pure: takes relative posix paths, returns the survivors. No DOM types so
 * it can be exercised from a plain Node check.
 */
import type { Source } from './protocol.ts'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CLAUDE_SESSION_FILE = new RegExp(`^${UUID}\\.jsonl$`, 'i')
const CLAUDE_SUBAGENT_FILE = /^agent-[^/]+\.jsonl$/i
const CLAUDE_SUBAGENT_PARENT = new RegExp(`^${UUID}$`, 'i')
const PI_SESSION_FILE = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z_${UUID}\\.jsonl$`, 'i')

/** The host refuses deeper paths; a chooser rooted far above the store would produce them. */
const MAX_SEGMENTS = 8

/** Split a chooser path into clean posix segments (drops `.`, empty and backslash noise). */
export function pathSegments(relative: string): string[] {
  return relative.replace(/\\/g, '/').split('/').filter(segment => segment !== '' && segment !== '.')
}

/**
 * Is this relative path a transcript the host will accept for `source`?
 * @param source - `claude` | `pi`.
 * @param relative - `webkitRelativePath || name` of a chosen file.
 */
export function isTranscriptPath(source: Source, relative: string): boolean {
  const segments = pathSegments(relative)
  if (segments.length === 0 || segments.length > MAX_SEGMENTS || segments.includes('..')) return false
  const name = segments[segments.length - 1] as string
  if (name.endsWith('.backup')) return false
  if (source === 'dsh') return /\.(?:backup|rollback)\.dsh\.zip$/i.test(name) || /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/i.test(name)
  if (source === 'pi') return PI_SESSION_FILE.test(name)
  if (segments.includes('memory')) return false
  if (CLAUDE_SESSION_FILE.test(name)) return true
  return segments.length >= 3
    && segments[segments.length - 2] === 'subagents'
    && CLAUDE_SUBAGENT_PARENT.test(segments[segments.length - 3] as string)
    && CLAUDE_SUBAGENT_FILE.test(name)
}

/** What the filter looks for, for the "nothing matched" error. */
export function expectedTranscriptText(source: Source): string {
  return source === 'dsh'
    ? 'a home or session folder, or a .backup.dsh.zip/.rollback.dsh.zip archive'
    : source === 'pi'
      ? 'pi transcripts named <timestamp>_<uuid>.jsonl'
      : 'Claude Code transcripts named <uuid>.jsonl (plus <uuid>/subagents/agent-*.jsonl)'
}

/**
 * Partition chosen files into uploadable transcripts and the rest.
 * @param source - the import source.
 * @param files - anything with a name and optional `webkitRelativePath`.
 * @returns the survivors with the relative path the host should receive.
 */
export function filterTranscripts<F extends { name: string, webkitRelativePath?: string, size?: number }>(source: Source, files: Iterable<F>): { kept: Array<{ file: F, path: string }>, skipped: number } {
  const kept: Array<{ file: F, path: string }> = []
  let skipped = 0
  for (const file of files) {
    const relative = file.webkitRelativePath !== undefined && file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name
    // An empty file cannot be a transcript and the host would store an empty stub.
    if ((file.size ?? 1) === 0 || !isTranscriptPath(source, relative)) { skipped++; continue }
    kept.push({ file, path: pathSegments(relative).join('/') })
  }
  return { kept, skipped }
}
