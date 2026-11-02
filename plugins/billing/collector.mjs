import { randomUUID } from 'node:crypto'
import { acquireBroker } from './collector-transport.mjs'
import { anthropicEvidence, codexEvidence, tokenUsage, unobservedEvidence } from './providers.mjs'

/**
 * installCollector(ctx, onObservation[, { target, now }]) -> idempotent teardown.
 * Requires only DSH's llm service. No command/OAuth/audit plugin dependency.
 *
 * Observation: {sessionId?, requestId, callId, provider, model, purpose?, phase,
 * at: ISO string, usage?, evidence?, finishReason?}.
 * - One callId per lazy middleware invocation; one requestId per attempt. Native
 *   matching HTTP retries get separate ids. Unobserved transports use a call attempt.
 * - usage is DSH's DISJOINT cumulative TokenUsage snapshot: replace, never add samples.
 * - evidence.reportedCost is exact decimal USD, openrouter-account scope. upstreamCost
 *   is independent information, NOT an extra amount to add. Account quotas aren't money.
 * - No accountKey: snapshots are session/request scoped, never reused across sessions.
 * - start/finish bracket attempts; 'superseded' means another native HTTP attempt
 *   began, not zero cost. Missing usage remains missing (especially failed attempts).
 * - Callback must enqueue work quickly. Return promises aren't awaited; rejected
 *   promises and sync exceptions never fail inference. Host owns persistence/limits.
 *
 * target/now exist for offline transport fixtures; production uses global fetch/clock.
 */
export function installCollector(ctx, onObservation, { target = globalThis, now = () => new Date().toISOString() } = {}) {
  let active = true, broker, removeListener, disposed = false
  const notify = observation => {
    if (!active) return
    try { const pending = onObservation(observation); if (pending?.then) Promise.resolve(pending).catch(() => {}) } catch { /* telemetry only */ }
  }
  const dispose = () => {
    if (disposed) return
    disposed = true; active = false
    try { removeListener?.() } finally { broker?.release() }
  }
  ctx.effect(() => {
    broker = acquireBroker(target)
    try {
      removeListener = ctx.on('llm/stream', (options, next) => (async function* () {
        const callId = randomUUID()
        const base = { callId, provider: options.provider, model: options.model,
          ...(typeof options.sessionId === 'string' ? { sessionId: options.sessionId } : {}),
          ...(['compaction', 'session-title'].includes(options.purpose) ? { purpose: options.purpose } : {}) }
        let ordinal = 0, current, done = false, iterator
        const emit = (attempt, fields) => notify({ ...base, requestId: attempt.id, at: now(), ...fields })
        const start = () => {
          const attempt = { id: `${callId}:${++ordinal}`, http: false, finished: false, observed: false }
          emit(attempt, { phase: 'start' })
          return attempt
        }
        const evidence = (attempt, report) => {
          attempt.observed = true
          emit(attempt, { phase: 'evidence', evidence: report })
        }
        const finish = (attempt, finishReason) => {
          if (attempt.finished) return
          if (!attempt.observed) evidence(attempt, unobservedEvidence(base.provider))
          // pi-ai emits synthetic all-zero usage even on pre-dispatch/auth errors.
          // Hold zero snapshots until a successful terminal outcome establishes them.
          if (attempt.pendingZero && !['error', 'aborted', 'superseded', 'returned'].includes(finishReason)) {
            emit(attempt, { phase: 'usage', usage: attempt.pendingZero })
          }
          emit(attempt, { phase: 'finish', finishReason })
          attempt.finished = true
        }
        current = start()
        const state = {
          active: () => active,
          beginHTTP() {
            if (current.http) { finish(current, 'superseded'); current = start() }
            current.http = true
            return current
          },
          headers(attempt, endpoint, { status, headers }) {
            evidence(attempt, endpoint.kind === 'anthropic-oauth' ? anthropicEvidence(status, headers)
              : endpoint.kind === 'openai-codex' ? codexEvidence(status, headers)
                : { kind: 'openrouter', outcome: status >= 200 && status < 300 ? 'unknown' : 'rejected', status })
          },
          evidence,
        }
        try {
          iterator = broker.run(state, () => next()[Symbol.asyncIterator]())
          while (true) {
            const result = await broker.run(state, () => iterator.next())
            done = result.done
            if (done) { finish(current, 'complete'); return }
            if (result.value?.type === 'usage') {
              let usage
              try { usage = tokenUsage(result.value.usage) } catch { /* Invalid custom-adapter telemetry is ignored. */ }
              if (usage && Object.values(usage).every(value => value === 0)) current.pendingZero = usage
              else if (usage) { current.pendingZero = undefined; emit(current, { phase: 'usage', usage }) }
            }
            if (result.value?.type === 'finish') {
              const kind = result.value.reason?.kind
              finish(current, ['stop', 'tool-use', 'tool-calls', 'length', 'max-tokens', 'content-filter', 'error', 'aborted'].includes(kind) ? kind : 'complete')
            }
            yield result.value
          }
        } catch (error) {
          finish(current, options.signal?.aborted ? 'aborted' : 'error')
          throw error
        } finally {
          // Downstream return/cancel happens under the same scope as lazy iteration.
          try { if (!done && iterator) await broker.run(state, () => iterator.return?.()) }
          finally { finish(current, options.signal?.aborted ? 'aborted' : 'returned') }
        }
      })(), { global: true })
    } catch (error) { dispose(); throw error }
    return dispose
  }, 'billing: passive provider telemetry')
  return dispose
}
