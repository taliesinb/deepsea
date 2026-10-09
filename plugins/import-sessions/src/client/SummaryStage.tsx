/**
 * Stages 5 and 6 — the running progress bar and the per-session summary.
 */
import type { ImportRowResult, ProgressResult } from './protocol.ts'
import { basename, borderColor, brandColor, dangerColor, hoverBg, intText, plural, small, successColor } from './format.ts'

/** Progress bar + current item while the host job runs. */
export function RunningStage({ progress, total }: { progress: ProgressResult | undefined, total: number }) {
  const done = progress?.done ?? 0
  const all = progress?.total ?? total
  const ratio = all === 0 ? 0 : Math.min(1, done / all)
  const current = progress?.current
  const phaseText = current === undefined ? undefined : current.phase === 'reading' ? 'reading transcript' : current.phase === 'writing' ? 'writing session log' : 'attaching to workspace'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontWeight: 600 }}>Importing {plural(all, 'session')}…</span>
        <span style={small}>{String(done)} / {String(all)}</span>
      </div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={all} aria-valuenow={done} style={{ height: 8, borderRadius: 4, background: hoverBg, border: `1px solid ${borderColor}`, overflow: 'hidden' }}>
        <div style={{ width: `${String(ratio * 100)}%`, height: '100%', background: brandColor, transition: 'width 200ms ease' }} />
      </div>
      <div style={{ ...small, minHeight: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {current !== undefined
          ? <>{current.title !== '' ? current.title : basename(current.file)}{phaseText !== undefined ? <span style={{ opacity: 0.7 }}> — {phaseText}</span> : null}</>
          : progress === undefined ? 'Starting…' : progress.finished ? 'Finishing…' : 'Waiting for the next session…'}
      </div>
    </div>
  )
}

function countsLine(row: ImportRowResult): string | undefined {
  const counts = row.counts
  if (counts === undefined) return undefined
  const parts: string[] = [
    plural(counts.turns, 'turn'),
    `${intText(counts.toolCalls)} tool call${counts.toolCalls === 1 ? '' : 's'}`,
  ]
  if (counts.images > 0) parts.push(counts.imagesImported === counts.images ? plural(counts.images, 'image') : `${String(counts.imagesImported)}/${String(counts.images)} images`)
  if (counts.truncatedResults > 0) parts.push(`${String(counts.truncatedResults)} truncated`)
  if (counts.foldedTurns !== undefined && counts.foldedTurns > 0) parts.push(`${String(counts.foldedTurns)} folded`)
  if (counts.children !== undefined && counts.children > 0) parts.push(plural(counts.children, 'child session'))
  if (counts.droppedRecords > 0) parts.push(`${String(counts.droppedRecords)} dropped`)
  if (counts.orphanResults > 0) parts.push(`${String(counts.orphanResults)} orphan result${counts.orphanResults === 1 ? '' : 's'}`)
  if (counts.surfaceTokens !== undefined) parts.push(`~${intText(counts.surfaceTokens)} tokens`)
  return parts.join(' · ')
}

/** Per-session result rows; never auto-closes. */
export function SummaryStage({ results, total }: { results: ImportRowResult[], total: number }) {
  const okCount = results.filter(row => row.ok).length
  const failed = results.length - okCount
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
        <span style={{ fontWeight: 600 }}>{String(okCount)} of {plural(total, 'session')} imported</span>
        {failed > 0 && <span style={{ color: dangerColor }}>{String(failed)} failed</span>}
      </div>
      <div style={{ maxHeight: '55vh', overflow: 'auto', border: `1px solid ${borderColor}`, borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {results.map(row => {
              const counts = countsLine(row)
              const title = row.title !== undefined && row.title !== '' ? row.title : basename(row.file)
              return (
                <tr key={row.file} style={{ borderBottom: `1px solid ${borderColor}` }}>
                  <td style={{ padding: '6px 8px', verticalAlign: 'top', width: 20, color: row.ok ? successColor : dangerColor, fontWeight: 700 }} aria-label={row.ok ? 'imported' : 'failed'}>
                    {row.ok ? '✓' : '✕'}
                  </td>
                  <td style={{ padding: '6px 8px', verticalAlign: 'top', minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.file}>{title}</span>
                      {row.ok && (
                        <span style={small}>
                          → {row.workspace === null || row.workspace === undefined ? 'Ungrouped' : row.workspace.title}
                        </span>
                      )}
                    </div>
                    {counts !== undefined && <div style={small}>{counts}</div>}
                    {row.error !== undefined && row.error !== '' && <div style={{ color: dangerColor, fontSize: 12, marginTop: 2 }}>{row.error}</div>}
                  </td>
                </tr>
              )
            })}
            {results.length === 0 && (
              <tr><td style={{ padding: 8, ...small }}>No results were reported.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
