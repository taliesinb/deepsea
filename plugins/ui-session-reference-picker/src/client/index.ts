/**
 * @deepsea/ui-session-reference-picker: browser half.
 *
 * `%` in the composer opens a picker of ordinary sessions only, named
 * `workspace/session`, the current one (also `%this`) first, then newest
 * activity first; picking one inserts the same session-reference chip the
 * built-in `@` picker inserts (the current one: a chip of plain text). It is one input
 * trigger source (`ctx.inputTriggers.registerSource`) on `%`, which the
 * harness topic `input-triggers` makes possible (stock triggers are `/` and
 * `@` only); rows dim the `/` through its `labelSegments`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  ClientSessionContext, InputTriggerServiceContract, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  currentSessionPickerItem, filterSessionPickerItems, relativeSessionAge, sessionLabelSegments, sessionPickerItems,
  THIS_SESSION, thisSessionText,
} from './catalog.ts'
import { formatSessionReferenceMention } from './mention.ts'

/** The trigger character. */
export const TRIGGER = '%'
/** The source's name: unique per trigger, and the owner of the chips it inserts. */
export const SOURCE_NAME = 'deepsea-ui-session-reference-picker'

export const name = 'deepsea-ui-session-reference-picker'
export const inject = ['inputTriggers', 'sessions', 'workspaces']

/**
 * Client plugin body.
 * @param ctx - browser-side cordis context.
 */
export function apply(ctx: Context): void {
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  const source: InputTriggerSource = {
    trigger: TRIGGER,
    name: SOURCE_NAME,
    showGroupTitle: false,
    candidates(session: ClientSessionContext, { query, signal }) {
      if (signal.aborted) return Promise.resolve([])
      const sessionList = sessions.list.getSnapshot()
      const workspaceList = workspaces.list.getSnapshot()
      const catalog = sessionPickerItems(sessionList, workspaceList, session.sessionId)
      const current = currentSessionPickerItem(sessionList, workspaceList, session.sessionId, query)
      const now = Date.now()
      // The current session comes first; picking it inserts plain text
      // (thisSessionText), since the server refuses a self-reference.
      const currentRow = current === undefined ? [] : [{
        name: current.qualifiedName,
        labelSegments: sessionLabelSegments(current.workspaceName, current.sessionName),
        description: THIS_SESSION,
        icon: 'session' as const,
        value: JSON.stringify({ sessionId: current.sessionId, label: current.qualifiedName, text: thisSessionText(current) }),
      }]
      return Promise.resolve([...currentRow, ...filterSessionPickerItems(catalog, query).map(item => ({
        name: item.qualifiedName,
        labelSegments: sessionLabelSegments(item.workspaceName, item.sessionName),
        description: relativeSessionAge(item.updatedAt, now),
        icon: 'session' as const,
        value: JSON.stringify({ sessionId: item.sessionId, label: item.qualifiedName }),
      }))])
    },
    onPick({ candidate }) {
      const value = parseValue(candidate.value)
      if (value === undefined) return undefined
      if (value.text !== undefined) {
        return {
          insert: {
            source: SOURCE_NAME,
            ref: value.text,
            label: value.label,
            appearance: 'session',
            clipboardText: value.text,
          },
        }
      }
      // The chip's text is the canonical mention, which is also what is
      // sent: the server's session-reference resolver reads the session id
      // from its URI; the label is only for reading.
      const mention = formatSessionReferenceMention(value.sessionId, value.label)
      return {
        insert: {
          source: SOURCE_NAME,
          ref: mention,
          label: value.label,
          appearance: 'session',
          clipboardText: mention,
        },
      }
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }
  ctx.effect(() => inputTriggers.registerSource(source), 'ui-session-reference-picker: % source')
}

function parseValue(value: string | undefined): { sessionId: string; label: string; text?: string } | undefined {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    return typeof record.sessionId === 'string' && typeof record.label === 'string'
      ? { sessionId: record.sessionId, label: record.label, ...typeof record.text === 'string' ? { text: record.text } : {} }
      : undefined
  } catch {
    return undefined
  }
}
