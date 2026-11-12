/**
 * Duration text of the wait row, compact and localized: `4s`, `2.3s`, `10m37s`,
 * `40m`, `1h5m` in English, `10分37秒`, `40分钟`, `1小时5分` in Chinese (the
 * dictionaries in locale/*.json, `card` section). Pure, so node:test runs it
 * without a browser (tests/format.test.mjs).
 */

/** Dictionary keys of the duration forms; each takes `{h}`, `{m}`, `{s}` as needed. */
export type DurationKey = 'duration.s' | 'duration.m' | 'duration.ms' | 'duration.h' | 'duration.hm' | 'duration.hms'

/** A translate function narrowed to the keys this module uses. */
export type DurationTranslate = (key: DurationKey, params: Record<string, number>) => string

/**
 * A duration from its parts: the zero parts are dropped (`40m`, `1h`, `1h5m`),
 * except that `keepSeconds` keeps the seconds of a running clock (`10m0s`), so
 * the counter does not lose and regain a part as it ticks.
 */
function compose(t: DurationTranslate, h: number, m: number, s: number, keepSeconds: boolean): string {
  if (h > 0) {
    if (keepSeconds || s > 0) return t('duration.hms', { h, m, s })
    return m > 0 ? t('duration.hm', { h, m }) : t('duration.h', { h })
  }
  if (m > 0) return keepSeconds || s > 0 ? t('duration.ms', { m, s }) : t('duration.m', { m })
  return t('duration.s', { s })
}

/**
 * A requested or waited duration: tenths under 10 s (`2.3s`), whole seconds
 * under a minute, then minutes and seconds, then hours and minutes (seconds
 * dropped past the hour, as a total needs no more).
 * @param seconds - the duration; negative or non-finite counts as 0.
 * @param t - translate of the plugin's namespace.
 * @returns the compact text.
 */
export function formatDuration(seconds: number, t: DurationTranslate): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  if (seconds < 10) return t('duration.s', { s: Math.round(seconds * 10) / 10 })
  const whole = Math.round(seconds)
  if (whole < 60) return t('duration.s', { s: whole })
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  return compose(t, h, m, h > 0 ? 0 : whole % 60, false)
}

/**
 * The running clock: whole seconds (no 0.1 s flicker), every part down to the
 * seconds once it has a larger part (`10m0s`, `1h0m5s`).
 * @param seconds - elapsed time; negative or non-finite counts as 0.
 * @param t - translate of the plugin's namespace.
 * @returns the compact text.
 */
export function formatElapsed(seconds: number, t: DurationTranslate): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const whole = Math.floor(seconds)
  return compose(t, Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60, true)
}
