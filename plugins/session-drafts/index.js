/**
 * @deepsea/session-drafts, host half: the per-session store of prompt drafts
 * (store.mjs) and the routes the browser half uses. A draft is the composer's
 * semantic document (text, reference chips, command chip, quotes), its
 * attachments' bytes, and when and at which turn it was made; drafts belong
 * to their session but never enter its log or the model's context.
 *
 * Routes (behind DSH's own authentication; `session` names the session):
 *   GET  /api/deepsea-session-drafts/list?session=     { version, drafts }
 *   POST /api/deepsea-session-drafts/create            { sessionId, document, attachments } → { draft }
 *   POST /api/deepsea-session-drafts/update            { sessionId, id, document, attachments } → { draft }
 *   POST /api/deepsea-session-drafts/delete            { sessionId, id } → { deleted }
 *   POST /api/deepsea-session-drafts/blob?session=     the bytes → { blob, size }
 *   GET  /api/deepsea-session-drafts/file?session=&id= the bytes
 *   GET  /api/deepsea-session-drafts/download?session=&id=&name=
 *        the draft as `<name>.draft.md`, or `<name>.draft.zip` with its attachments (download.mjs)
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DraftStore, STATE_NAME, validSessionId } from './store.mjs'
import { parseAttachments, parseDocument } from './document.mjs'
import { attachmentDisposition, draftDownload } from './download.mjs'

export const name = 'deepsea-session-drafts'

export const Config = Schema.object({
  maxDrafts: Schema.natural().min(1).default(200).description('Drafts kept per session.'),
  maxAttachments: Schema.natural().default(32).description('Attachments per draft.'),
  maxAttachmentBytes: Schema.natural().min(1).default(64 * 1024 * 1024).description('Largest attachment, in bytes.'),
  maxChars: Schema.natural().min(1).default(500_000).description('Longest draft text, in characters.'),
})

/** Route prefix below `/api`. */
export const PREFIX = '/api/deepsea-session-drafts'

/**
 * Where the main conversation is: the last turn started and whether it is still running.
 * @param {readonly { type: string, data?: any }[]} events
 * @returns {{ turn: number, running: boolean }}
 */
export function conversationPosition(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/end') return { turn: event.data.turn, running: false }
    if (event.type === 'turn/start') return { turn: event.data.turn, running: true }
  }
  return { turn: 0, running: false }
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})
const fail = (status, message) => json(status, { error: message })

/** Read a streamed body, refusing it once it exceeds `limit` bytes. */
async function readLimited(request, limit) {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > limit) return undefined
  const chunks = []
  let size = 0
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  const store = new DraftStore(join(resolveDshHome(), 'plugins', STATE_NAME, 'sessions'), {
    warn: message => ctx.logger.warn(message),
  })

  /** The session's position, when its agent is live. */
  const positionOf = (sessionId) => {
    const session = ctx.get('agents')?.get(sessionId)?.session
    return session === undefined ? null : conversationPosition(session.snapshotEvents())
  }

  const draftInput = (sessionId, body) => {
    const document = parseDocument(body.document, { maxChars: config.maxChars })
    if ('error' in document) return document
    const attachments = parseAttachments(body.attachments ?? [], {
      maxAttachments: config.maxAttachments,
      exists: blob => store.blobPath(sessionId, blob) !== undefined,
    })
    if ('error' in attachments) return attachments
    return { document: document.document, attachments: attachments.attachments }
  }

  /** Parse a JSON POST naming a session; the handler gets the session id and the body. */
  const post = handler => async (request) => {
    let body
    try {
      body = await request.json()
    } catch {
      // An unreadable body is the caller's error.
      return fail(400, 'body is not JSON')
    }
    if (typeof body !== 'object' || body === null || !validSessionId(body.sessionId)) return fail(400, 'sessionId is required')
    try {
      return await handler(body.sessionId, body)
    } catch (error) {
      ctx.logger.warn('session-drafts: %s', error instanceof Error ? error.stack ?? error.message : String(error))
      return fail(500, error instanceof Error ? error.message : String(error))
    }
  }

  const sessionParam = (request) => {
    const sessionId = new URL(request.url).searchParams.get('session') ?? ''
    return validSessionId(sessionId) ? sessionId : undefined
  }

  const routes = [
    {
      path: `${PREFIX}/list`, methods: ['GET'], requestBody: 'buffered',
      fetch: async (request) => {
        const sessionId = sessionParam(request)
        if (sessionId === undefined) return fail(400, 'session is required')
        return json(200, store.snapshot(sessionId))
      },
    },
    {
      path: `${PREFIX}/create`, methods: ['POST'], requestBody: 'buffered',
      fetch: post((sessionId, body) => {
        if (store.get(sessionId).drafts.length >= config.maxDrafts) return fail(409, `This session already has ${String(config.maxDrafts)} drafts.`)
        const input = draftInput(sessionId, body)
        if ('error' in input) return fail(400, input.error)
        const draft = store.create(sessionId, { ...input, position: positionOf(sessionId) })
        ctx.logger.info('session-drafts: created %s in %s', draft.id, sessionId)
        return json(200, { draft })
      }),
    },
    {
      path: `${PREFIX}/update`, methods: ['POST'], requestBody: 'buffered',
      fetch: post((sessionId, body) => {
        const input = draftInput(sessionId, body)
        if ('error' in input) return fail(400, input.error)
        const draft = store.update(sessionId, String(body.id), input)
        return draft === undefined ? fail(404, 'No such draft.') : json(200, { draft })
      }),
    },
    {
      path: `${PREFIX}/delete`, methods: ['POST'], requestBody: 'buffered',
      fetch: post((sessionId, body) => json(200, { deleted: store.remove(sessionId, String(body.id)) })),
    },
    {
      path: `${PREFIX}/blob`, methods: ['POST'], requestBody: 'streaming',
      fetch: async (request) => {
        const sessionId = sessionParam(request)
        if (sessionId === undefined) return fail(400, 'session is required')
        const bytes = await readLimited(request, config.maxAttachmentBytes)
        if (bytes === undefined) return fail(413, `Attachments are limited to ${String(config.maxAttachmentBytes)} bytes.`)
        return json(200, store.putBlob(sessionId, bytes))
      },
    },
    {
      // Reads have their own buffered route: a streaming route's GET reaches Fetch with a body, which it refuses.
      path: `${PREFIX}/file`, methods: ['GET'], requestBody: 'buffered',
      fetch: async (request) => {
        const sessionId = sessionParam(request)
        if (sessionId === undefined) return fail(400, 'session is required')
        const path = store.blobPath(sessionId, new URL(request.url).searchParams.get('id') ?? '')
        if (path === undefined) return fail(404, 'No such attachment.')
        const type = new URL(request.url).searchParams.get('type') ?? 'application/octet-stream'
        return new Response(await readFile(path), {
          headers: {
            'content-type': /^[\w.+-]+\/[\w.+-]+$/u.test(type) ? type : 'application/octet-stream',
            'cache-control': 'private, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
          },
        })
      },
    },
  ]

  routes.push({
    // A file to save: the response names it, so the browser (and the macOS app) download it rather than show it.
    path: `${PREFIX}/download`, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      const params = new URL(request.url).searchParams
      const sessionId = sessionParam(request)
      if (sessionId === undefined) return fail(400, 'session is required')
      const draft = store.get(sessionId).drafts.find(row => row.id === params.get('id'))
      if (draft === undefined) return fail(404, 'No such draft.')
      const readBlob = (blob) => {
        const path = store.blobPath(sessionId, blob)
        if (path === undefined) throw new Error(`attachment ${blob} is missing`)
        return readFileSync(path)
      }
      try {
        const { filename, type, body } = draftDownload(draft, params.get('name') ?? 'draft', readBlob)
        return new Response(body, {
          headers: { 'content-type': type, 'content-disposition': attachmentDisposition(filename), 'cache-control': 'no-store' },
        })
      } catch (error) {
        return fail(500, error instanceof Error ? error.message : String(error))
      }
    },
  })

  ctx.inject(['connection'], (web) => {
    for (const route of routes) {
      web.effect(() => web.connection.fetch.register(route), `session-drafts: ${route.path}`)
    }
  })
}
