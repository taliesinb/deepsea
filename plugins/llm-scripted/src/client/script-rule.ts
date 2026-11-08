/** The user-text rule that claims a whole prompt when it is a JSONL script. */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { scriptLines } from './script-text.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** A whole prompt that is a JSONL script; the original text is the node's own range. */
    'deepsea-script': { readonly lines: number }
  }
}

/** The node id, also the class prefix of the stylesheet the browser half installs. */
export const SCRIPT_NODE = 'deepsea-script'

/**
 * Claims the whole prompt when it is a script. Its order is below the
 * whitespace rules, which can also match at the start of the text.
 */
export const scriptRule: UserTextRule<typeof SCRIPT_NODE> = {
  id: SCRIPT_NODE,
  order: 5,
  match(text, from) {
    if (from !== 0) return undefined
    const lines = scriptLines(text)
    return lines === undefined ? undefined : { id: SCRIPT_NODE, start: 0, end: text.length, data: { lines: lines.length } }
  },
}
