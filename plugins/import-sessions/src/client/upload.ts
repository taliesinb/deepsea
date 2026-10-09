/**
 * Device → server transcript upload (PROTOCOL.md `upload-*`).
 *
 * Each chosen file is streamed: `file.stream()` → `CompressionStream('gzip')`
 * when the browser has one (else sent as-is with encoding `identity`) → the
 * encoded bytes are cut into chunks of at most `chunkBytes` (the host's
 * limit, from `upload-begin`) → each chunk goes out as base64 with the
 * running encoded offset, strictly in order, one request at a time. Memory
 * stays bounded to about one chunk regardless of transcript size.
 */
import type { Call, Source, UploadBeginResult, UploadChunkArgs, UploadChunkResult, UploadFinishResult } from './protocol.ts'

export interface UploadProgress {
  filesDone: number
  filesTotal: number
  /** Encoded bytes sent so far (what travels the wire before base64). */
  bytesSent: number
  currentFile: string | undefined
}

export interface UploadOutcome { uploadId: string, path: string, files: number, bytes: number }

const B64_SLICE = 0x8000

/** Base64 without `String.fromCharCode(...hugeArray)` (that overflows the call stack past ~100K bytes). */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += B64_SLICE) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + B64_SLICE)))
  }
  return btoa(binary)
}

/**
 * Accumulate stream pieces and hand out slices of at most `size` bytes,
 * emitting everything (including a final short slice) when the stream ends.
 */
export async function* chunked(stream: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  const take = (): Uint8Array => {
    const out = new Uint8Array(Math.min(size, pendingBytes))
    let written = 0
    while (written < out.length) {
      const head = pending[0] as Uint8Array
      const room = out.length - written
      if (head.length <= room) {
        out.set(head, written)
        written += head.length
        pending.shift()
      } else {
        out.set(head.subarray(0, room), written)
        pending[0] = head.subarray(room)
        written += room
      }
    }
    pendingBytes -= out.length
    return out
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.length === 0) continue
      pending.push(value)
      pendingBytes += value.length
      while (pendingBytes >= size) yield take()
    }
    while (pendingBytes > 0) yield take()
  } finally {
    pending = []
    reader.releaseLock()
  }
}

/** The file's bytes as a stream, gzipped when the platform can. */
function encodedStream(file: Blob): { stream: ReadableStream<Uint8Array>, encoding: 'gzip' | 'identity' } {
  const raw: ReadableStream<Uint8Array> = typeof file.stream === 'function' ? file.stream() : (new Response(file).body as ReadableStream<Uint8Array>)
  if (typeof CompressionStream !== 'undefined') {
    // lib.dom types the compressor's writable side as BufferSource; Uint8Array is one.
    const gzip = new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
    return { stream: raw.pipeThrough(gzip), encoding: 'gzip' }
  }
  return { stream: raw, encoding: 'identity' }
}

/**
 * Upload the filtered transcripts and return the server path to `scan`.
 * On any failure the upload is discarded server-side before rethrowing, so
 * the caller only has to show the error.
 * @param call - channel caller.
 * @param source - import source (the host validates paths against it).
 * @param files - survivors of `filterTranscripts`, with their relative paths.
 * @param onProgress - progress callback (files, bytes, current name).
 * @param onBegin - receives the upload id as soon as the host issues it, so
 *   the caller can discard it if the dialog closes mid-upload.
 * @param signal - abort: stops between chunks and discards.
 */
export async function uploadTranscripts(
  call: Call,
  source: Source,
  files: ReadonlyArray<{ file: Blob & { name: string }, path: string }>,
  onProgress: (progress: UploadProgress) => void,
  onBegin: (uploadId: string) => void,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const begun = await call<UploadBeginResult>('upload-begin', { source })
  onBegin(begun.uploadId)
  const chunkBytes = Number.isFinite(begun.chunkBytes) && begun.chunkBytes > 0 ? Math.floor(begun.chunkBytes) : 4 * 1024 * 1024
  const progress: UploadProgress = { filesDone: 0, filesTotal: files.length, bytesSent: 0, currentFile: undefined }
  try {
    for (const { file, path } of files) {
      if (signal?.aborted === true) throw new Error('upload cancelled')
      progress.currentFile = file.name
      onProgress({ ...progress })
      const { stream, encoding } = encodedStream(file)
      let offset = 0
      let sentAny = false
      for await (const chunk of chunked(stream, chunkBytes)) {
        if (signal !== undefined && signal.aborted) throw new Error('upload cancelled')
        const args: UploadChunkArgs = { uploadId: begun.uploadId, path, data: toBase64(chunk), encoding, offset }
        await call<UploadChunkResult>('upload-chunk', args)
        offset += chunk.length
        sentAny = true
        progress.bytesSent += chunk.length
        onProgress({ ...progress })
      }
      // A file whose encoding produced nothing (empty identity stream) still needs to exist server-side.
      if (!sentAny) {
        const args: UploadChunkArgs = { uploadId: begun.uploadId, path, data: '', encoding, offset: 0 }
        await call<UploadChunkResult>('upload-chunk', args)
      }
      progress.filesDone++
      progress.currentFile = undefined
      onProgress({ ...progress })
    }
    const finished = await call<UploadFinishResult>('upload-finish', { uploadId: begun.uploadId })
    return { uploadId: begun.uploadId, path: finished.path, files: finished.files, bytes: finished.bytes }
  } catch (failure) {
    try { await call('upload-discard', { uploadId: begun.uploadId }) } catch { /* the host sweeps stale uploads anyway */ }
    throw failure
  }
}
