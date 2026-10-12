/**
 * The shapes of the `session-move` plugin's destination contract (service
 * `deepseaSessionMove`), declared here because plugins do not import each
 * other at runtime. Keep in sync with plugins/session-move/src/client/face.ts.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** One contributed destination: a remote workspace. */
export interface DestinationEntry {
  readonly key: string
  readonly title: string
  readonly path?: string
}

/** One heading of destinations: one remote server. */
export interface DestinationGroup {
  readonly id: string
  readonly label: string
  readonly entries: readonly DestinationEntry[]
}

/** What session-move's dialog asks this plugin to carry out. */
export interface DestinationRunRequest {
  readonly action: 'move' | 'copy'
  readonly sessionId: string
  readonly sourceWorkspaceId?: string
  readonly sourceTitle: string
  readonly groupId: string
  readonly destinationKey: string
  readonly stopLive?: boolean
  readonly truncate?: boolean
  readonly title?: string
  readonly notify: boolean
}

/** The answer, in the Host's refusal vocabulary. */
export type DestinationRunResult =
  | { readonly ok: true; readonly summary?: string }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly details?: unknown }

/** The service session-move provides. */
export interface SessionMoveFace {
  contributeDestinations(contribution: {
    readonly id: string
    readonly order?: number
    readonly groups: ObservableSnapshot<readonly DestinationGroup[]>
    readonly run: (request: DestinationRunRequest) => Promise<DestinationRunResult>
  }): () => void
}
