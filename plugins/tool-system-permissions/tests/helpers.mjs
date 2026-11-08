// A scripted prober for the session tests: `states` is read on every probe
// (mutate it to flip a permission), and every probe, trigger and pane opening
// is recorded in order.
export function scriptedProber(states = {}, subject = { name: 'DeepSea Test Server', bundleId: 'io.example.test.server', app: '/Applications/Test Server.app' }) {
  const log = []
  return {
    kind: 'scripted',
    states,
    log,
    probes: 0,
    async probe(classes, { refine } = {}) {
      this.probes += 1
      log.push(`probe ${classes.map(c => c.id).join(',')}${refine ? ' refine' : ''}`)
      const results = {}
      for (const cls of classes) results[cls.id] = { status: typeof states[cls.id] === 'function' ? states[cls.id]({ refine }) : states[cls.id] ?? 'not-determined' }
      return { subject, results }
    },
    trigger(cls, { status }) {
      log.push(`trigger ${cls.id} ${status}`)
      return { stop: () => log.push(`stop ${cls.id}`) }
    },
    async openPane(cls, { reveal = false } = {}) {
      log.push(`open ${cls.id}`)
      if (reveal) log.push(`reveal ${cls.id}`)
    },
    /** Set to an object { ok, command?, error? } (or a function of the class) to give the prober a resetStale. */
    resetAnswer: undefined,
    get resetStale() {
      if (this.resetAnswer === undefined) return undefined
      return async (cls) => {
        log.push(`reset ${cls.id}`)
        return typeof this.resetAnswer === 'function' ? this.resetAnswer(cls) : this.resetAnswer
      }
    },
  }
}

export const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

/** Resolve once `predicate()` holds (polling every 2 ms, at most `ms`). */
export async function until(predicate, ms = 2000) {
  const end = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition')
    await tick(2)
  }
}
