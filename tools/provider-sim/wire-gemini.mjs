/**
 * Gemini's wire format: the Gemini API's `generateContent` and
 * `streamGenerateContent`, as pi-ai's `google-generative-ai` API calls them
 * through @google/genai (`api/google-generative-ai.js`, `api/google-shared.js`).
 *
 * A request's `contents` (user and model turns of parts: text, thought text,
 * functionCall, functionResponse) are read into the neutral conversation
 * wire.mjs plays scripts from; the prompt is found the same way (tool results
 * arrive as functionResponse parts of a user turn, which never start one). A
 * response is a `GenerateContentResponse`: candidates[0].content.parts (text,
 * thought parts `{ text, thought: true }` when the request asked for
 * `includeThoughts`, functionCall parts), a finishReason and usageMetadata,
 * streamed one part per chunk (server-sent events with `alt=sse`, else a JSON
 * array) or whole.
 *
 * Thought signatures, as Gemini hands them out: opaque base64 on the first
 * functionCall part of a response, or on its last part when it calls nothing
 * (none when thinking is off). Gemini 3 and later require the signature of
 * every function call of the current turn back (400 otherwise), and number
 * their function calls (`functionCall.id`, echoed in `functionResponse.id`);
 * earlier models send no ids, so a result is matched to the script's tool call
 * by name and order.
 */
import { randomBytes } from 'node:crypto'
import { chunk } from '../../packages/script/index.mjs'
import { costMicros } from './common.mjs'
import { respond, tokens, usageOf } from './wire.mjs'

/** A Gemini model id's major version (`gemini-3.1-pro-preview` → 3), as pi-ai reads it; undefined for other names. */
export function geminiMajor(id) {
  const match = /^gemini(?:-live)?-(\d+)/.exec(String(id).toLowerCase())
  return match ? Number(match[1]) : undefined
}

const partsOf = content => Array.isArray(content?.parts) ? content.parts : []

/** The text of a `systemInstruction`: a string, a Content, or its parts. */
export function systemText(instruction) {
  if (typeof instruction === 'string') return instruction
  const parts = Array.isArray(instruction) ? instruction : partsOf(instruction)
  return parts.map(p => typeof p === 'string' ? p : p?.text ?? '').join('\n')
}

/** What a functionResponse says: pi-ai sends `{ output }` or `{ error }` with a string. */
function responseText(response) {
  const value = response?.output ?? response?.error ?? response
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

/** `contents` as wire.mjs's neutral conversation (`{ role, texts, toolCalls, toolResults }`; model turns are `assistant`). */
export function geminiConversation(contents) {
  return (contents ?? []).map((c) => {
    const parts = partsOf(c)
    const texts = parts.filter(p => typeof p?.text === 'string' && p.thought !== true).map(p => p.text)
    if (c?.role === 'model') return { role: 'assistant', texts, toolCalls: parts.filter(p => p?.functionCall).length, toolResults: [] }
    const toolResults = parts.filter(p => p?.functionResponse).map(({ functionResponse: f }) => ({
      id: f.id, name: f.name, text: responseText(f.response), isError: f.response?.error !== undefined && f.response?.output === undefined,
    }))
    return { role: 'user', texts, toolCalls: 0, toolResults }
  })
}

/**
 * Gemini 3's check: in the current turn (from the latest user turn with text,
 * not function responses), the first function call of each model turn must
 * carry its thought signature. The error message, or undefined.
 */
export function missingSignature(contents) {
  let start = -1
  contents.forEach((c, i) => {
    const parts = partsOf(c)
    if (c?.role !== 'model' && parts.some(p => typeof p?.text === 'string') && !parts.some(p => p?.functionResponse)) start = i
  })
  for (let i = start + 1; i < contents.length; i++) {
    if (contents[i]?.role !== 'model') continue
    const call = partsOf(contents[i]).find(p => p?.functionCall)
    if (call && !call.thoughtSignature) {
      return 'Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead'
        + ` to degraded model performance. Additional data, function call \`default_api:${call.functionCall.name}\` , position ${i + 1}.`
        + ' Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.'
    }
  }
  return undefined
}

/** A thought signature: base64 (standard alphabet, padded), as pi-ai requires to send it back. */
export const signature = () => Buffer.from(`sim-gemini:${randomBytes(24).toString('hex')}`).toString('base64')
const callId = () => randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8).toLowerCase()

const sleep = (seconds, signal) => new Promise((resolve) => {
  if (!seconds || signal?.aborted) { resolve(); return }
  const timer = setTimeout(resolve, seconds * 1000)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

/**
 * The pieces of a response, in order: `{ part, block }` per streamed piece of
 * text or thought (thoughts only when shown) and per function call, `{ sleep }`
 * for pauses (a chunk delay or a `sleep` step).
 */
function piecesOf(r) {
  const pieces = []
  let calls = 0
  r.steps.forEach((step, block) => {
    if (step.cmd === 'sleep') pieces.push({ sleep: step.time })
    else if (step.cmd === 'say' || (step.cmd === 'think' && r.showThoughts)) {
      for (const [i, text] of chunk(step.text, step.chunks ?? 1).entries()) {
        if (i > 0 && step.chunkDelay) pieces.push({ sleep: step.chunkDelay })
        pieces.push({ part: step.cmd === 'think' ? { text, thought: true } : { text }, block })
      }
    } else if (step.cmd === 'tool') {
      const part = { functionCall: { ...(r.callIds ? { id: step.id ?? callId() } : {}), name: step.name, args: step.args ?? {} } }
      if (r.signed && calls++ === 0) part.thoughtSignature = signature()
      pieces.push({ part, block })
    }
  })
  return { pieces, calls }
}

const finishOf = steps => steps.find(s => s.cmd === 'end')?.reason === 'max-tokens' ? 'MAX_TOKENS' : 'STOP'

/** usageMetadata: the prompt so far on every chunk, everything on the last. */
function usageMetadata(r, final) {
  const prompt = r.usage.input + r.usage.cacheRead
  const meta = { promptTokenCount: prompt }
  if (final) {
    const thoughts = Math.min(r.thoughts, r.usage.output)
    meta.candidatesTokenCount = r.usage.output - thoughts
    if (r.usage.cacheRead > 0) meta.cachedContentTokenCount = r.usage.cacheRead
    meta.totalTokenCount = prompt + r.usage.output
    meta.promptTokensDetails = [{ modality: 'TEXT', tokenCount: prompt }]
    if (r.usage.cacheRead > 0) meta.cacheTokensDetails = [{ modality: 'TEXT', tokenCount: r.usage.cacheRead }]
    if (thoughts > 0) meta.thoughtsTokenCount = thoughts
  } else {
    meta.totalTokenCount = prompt
    meta.promptTokensDetails = [{ modality: 'TEXT', tokenCount: prompt }]
  }
  return meta
}

/** One GenerateContentResponse: `parts` (may be none) and, on the last, the finish reason and full usage. */
function responseOf(r, parts, finishReason) {
  const candidate = { ...(parts.length > 0 ? { content: { parts, role: 'model' } } : {}), ...(finishReason ? { finishReason } : {}), index: 0 }
  return { candidates: [candidate], usageMetadata: usageMetadata(r, finishReason !== undefined), modelVersion: r.model, responseId: r.id }
}

/** A response that calls nothing carries its signature on its last part (an empty text part when there is none). */
function signLast(r, calls, parts) {
  if (!r.signed || calls > 0) return parts
  if (parts.length === 0) return [{ text: '', thoughtSignature: signature() }]
  return [...parts.slice(0, -1), { ...parts.at(-1), thoughtSignature: signature() }]
}

/**
 * Stream a response: one part per chunk, the finish reason and full usage on
 * the last. `sse`: server-sent events (`alt=sse`), else a JSON array.
 * @param {{ id: string, model: string, steps: object[], usage: object, thoughts: number, showThoughts: boolean, callIds: boolean, signed: boolean, signal?: AbortSignal }} r
 */
export async function geminiStream(res, r, { sse = true } = {}) {
  const { pieces, calls } = piecesOf(r)
  res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json; charset=UTF-8', 'cache-control': 'no-cache' })
  let sent = 0
  const write = (response) => {
    const text = JSON.stringify(response)
    res.write(sse ? `data: ${text}\r\n\r\n` : `${sent === 0 ? '[' : ',\r\n'}${text}`)
    sent++
  }
  let pending
  for (const piece of pieces) {
    if (r.signal?.aborted) break
    if (piece.sleep !== undefined) {
      if (pending) { write(responseOf(r, [pending])); pending = undefined }
      await sleep(piece.sleep, r.signal)
      continue
    }
    if (pending) write(responseOf(r, [pending]))
    pending = piece.part
  }
  if (!r.signal?.aborted) write(responseOf(r, signLast(r, calls, pending ? [pending] : []), finishOf(r.steps)))
  res.end(sse ? undefined : ']')
}

/** A whole (non-streamed) response: each block one part. */
export function geminiMessage(r) {
  const { pieces, calls } = piecesOf(r)
  const parts = []
  let lastBlock
  for (const piece of pieces.filter(p => p.part)) {
    if (piece.block === lastBlock && piece.part.text !== undefined) parts.at(-1).text += piece.part.text
    else parts.push({ ...piece.part })
    lastBlock = piece.block
  }
  return responseOf(r, signLast(r, calls, parts), finishOf(r.steps))
}

/**
 * Play one request: the script's response for this point of the turn, charged
 * to the account (`charge(micros, usage)`, before anything is sent).
 * `fail(status, kind, message, retryAfter)` answers a script's error.
 */
export async function geminiGenerate(ctx, { req, res, body, model, stream, sse, account, provider, catalogProvider, catalog, charge, fail }) {
  const contents = body.contents
  // Results without a usable id (models before Gemini 3 send none) are matched to the script's calls by name (wire.mjs).
  const conversation = geminiConversation(contents)
  const system = systemText(body.systemInstruction ?? body.system_instruction)
  const plan = respond(conversation, system)
  if (plan.invalid) return fail(400, 'invalid-request', plan.invalid)
  if (plan.failure) return fail(plan.failure.status, plan.failure.kind, plan.failure.message, plan.failure.retryAfter)
  const thinking = body.generationConfig?.thinkingConfig ?? {}
  // thinkingBudget 0 turns thinking off; otherwise the model thinks (and is billed for it) whether or not it shows its thoughts.
  const thinkingOff = thinking.thinkingBudget === 0
  const steps = thinkingOff ? plan.steps.filter(s => s.cmd !== 'think') : plan.steps
  const usage = usageOf(steps, JSON.stringify(contents) + system)
  const scripted = steps.find(s => s.cmd === 'usage')
  const thoughts = scripted ? (scripted.reasoning ?? 0) : steps.filter(s => s.cmd === 'think').reduce((sum, s) => sum + tokens(s.text), 0)
  const micros = costMicros(catalog.cost(catalogProvider, model), usage)
  const id = randomBytes(17).toString('base64url')
  ctx.store.recordGeneration({ id, account: account.id, provider, model, ...usage, costMicros: micros, streamed: stream })
  charge(micros, usage)
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  const major = geminiMajor(model)
  const r = { id, model, steps, usage, thoughts, signal: controller.signal, showThoughts: thinking.includeThoughts === true && !thinkingOff,
    callIds: major !== undefined && major >= 3, signed: !thinkingOff }
  if (stream) return geminiStream(res, r, { sse })
  return ctx.json(res, 200, geminiMessage(r), { 'content-type': 'application/json; charset=UTF-8' })
}
