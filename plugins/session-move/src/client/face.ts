/**
 * The contract other plugins use to add destinations to Move to… and Copy
 * to… (service `deepseaSessionMove`). A contribution lists headed groups (a
 * remote host each, say) after this machine's Workspaces; a pick of one of
 * its entries is handed to its `run`, which answers in the Host's own
 * refusal vocabulary (`session/move-live`, `session/copy-live` with
 * `details.blockers`), so a refusal reads the same for every destination.
 *
 * The shapes are structural on purpose: a contributor declares its own copy
 * of these types (cross-plugin runtime imports are forbidden), and plain
 * objects satisfy them.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Service name under which the browser half provides {@link SessionMoveFace}. */
export const SERVICE = 'deepseaSessionMove'

/** One contributed destination: a Workspace somewhere else. */
export interface DestinationEntry {
  /** Stable key within its group. */
  readonly key: string
  /** Display title. */
  readonly title: string
  /** Directory shown beside the title. */
  readonly path?: string
}

/** One heading of contributed destinations (one remote host, say) with its entries. */
export interface DestinationGroup {
  /** Stable id, unique across every contribution. */
  readonly id: string
  /** Heading text. */
  readonly label: string
  /** Destinations under the heading; an empty group is not listed. */
  readonly entries: readonly DestinationEntry[]
}

/** What the dialog asks a contributor to carry out once one of its destinations is chosen. */
export interface DestinationRunRequest {
  /** Move the Session there, or store a copy there. */
  readonly action: 'move' | 'copy'
  readonly sessionId: string
  /** Owning Workspace of the source, absent for an ungrouped Session. */
  readonly sourceWorkspaceId?: string
  /** The source's display title. */
  readonly sourceTitle: string
  /** The chosen group. */
  readonly groupId: string
  /** The chosen entry's key. */
  readonly destinationKey: string
  /** Move: interrupt work in flight (after a `session/move-live` refusal). */
  readonly stopLive?: boolean
  /** Copy: drop the turn in progress (after a `session/copy-live` refusal). */
  readonly truncate?: boolean
  /** Copy: title recorded on the copy; omitted keeps the source's. */
  readonly title?: string
  /** Tell the Agent on its next step. */
  readonly notify: boolean
}

/** A contributor's answer. */
export type DestinationRunResult =
  | {
    readonly ok: true
    /** Shown in the dialog before it is closed; omitted closes the dialog at once. */
    readonly summary?: string
  }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly details?: unknown }

/** One contributor of dialog destinations. */
export interface DestinationContribution {
  /** Stable id, unique among contributions. */
  readonly id: string
  /** Sort key among contributions; this machine's own Workspaces always come first. */
  readonly order?: number
  /** Live groups; an empty list hides the contribution. */
  readonly groups: ObservableSnapshot<readonly DestinationGroup[]>
  /** Carry out the move or copy to one of this contribution's destinations. */
  readonly run: (request: DestinationRunRequest) => Promise<DestinationRunResult>
}

/** The service: destination contributions. */
export interface SessionMoveFace {
  /**
   * Add destinations to Move to… and Copy to….
   * @param contribution - identity, placement, live groups, and the action.
   * @returns disposer withdrawing the contribution.
   * @throws when a contribution with the same id is already registered.
   */
  contributeDestinations(contribution: DestinationContribution): () => void
  /** Live contributions, in `order`. */
  readonly contributions: ObservableSnapshot<readonly DestinationContribution[]>
}
