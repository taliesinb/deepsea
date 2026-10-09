// The isolated fixture exercises the same platform hook implementation as DSH.
export { useAnchoredPosition } from '../../../harness/packages/client/ui-primitives/src/useAnchoredPosition.ts'
export { useDismissOnOutsidePointer } from '../../../harness/packages/client/ui-primitives/src/useDismissOnOutsidePointer.ts'
export { IconInfoOutlineRegular, IconWarningOutlineRegular } from '../../../harness/packages/client/ui-primitives/src/icons/index.tsx'
// The platform Tooltip needs DSH's CSS-module pipeline; the fixture shows its children only.
export function Tooltip({ children }: { children: import('react').ReactNode }) { return children }
export { IconRefreshOutlineRegular } from '../../../harness/packages/client/ui-primitives/src/icons/index.tsx'
