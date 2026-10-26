// Mirror of the harness's tool-output rule (harness/packages/util/values, snapshotJsonValue): a result must survive a JSON
// round trip without loss. Tests call tool execute() directly and bypass the harness's check, so they assert it here.
export function losslessReason(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return undefined
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? undefined : `${path}: non-finite or -0 number`
  if (value === undefined) return `${path}: undefined`
  if (typeof value !== 'object') return `${path}: ${typeof value}`
  if (seen.has(value)) return `${path}: cycle`
  seen.add(value)
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) { const reason = losslessReason(entry, `${path}[${index}]`, seen); if (reason) return reason }
    return undefined
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return `${path}: non-plain object (${value.constructor?.name})`
  for (const [key, entry] of Object.entries(value)) { const reason = losslessReason(entry, `${path}.${key}`, seen); if (reason) return reason }
  return undefined
}

export function assertLossless(toolName, value) {
  const reason = losslessReason(value)
  if (reason !== undefined) throw new Error(`${toolName} returned non-lossless JSON — ${reason} (the harness would reject this with "value is not lossless JSON")`)
  return value
}
