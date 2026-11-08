/**
 * The browser half of the scripted model: a prompt that is a JSONL script
 * shows in its message bubble as JSON, one line per row, in the code font
 * with JSON colours; a row too long for the bubble is cut with an ellipsis
 * instead of wrapping. Elsewhere (the queued-message preview) it stays one
 * line. Only the drawing changes: the message text, its copy action and what
 * the model gets are the text as typed.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports (erased at build time): `ctx.uiConversation`, the slot
// map with `conversation.user.text.node`, and the user-text rule types.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useCodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import { scriptLines } from './script-text.ts'
import { SCRIPT_NODE as NODE, scriptRule } from './script-rule.ts'

export const name = 'deepsea-llm-scripted'
export const inject = ['slots', 'uiConversation']

const STYLE_ID = 'deepsea-llm-scripted-style'

/**
 * Inside a message bubble each line is a row of its own, cut with an ellipsis
 * when too long; anywhere else (one-line previews) the rows run together on
 * one line, so the preview's own ellipsis still applies.
 */
const STYLESHEET = `
.${NODE} { font-family: var(--ds-font-family-code); }
.${NODE}-line + .${NODE}-line::before { content: ' '; }
[data-message-bubble] .${NODE} { display: block; font: var(--dsw-font-markdown-code-block); }
[data-message-bubble] .${NODE}-line { display: block; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
[data-message-bubble] .${NODE}-line + .${NODE}-line::before { content: none; }
`

/** A script prompt, line by line, coloured as JSON once the grammar has loaded. */
function ScriptText({ raw }: UserTextNodeProps<typeof NODE>) {
  const highlight = useCodeHighlighter('json')
  const lines = scriptLines(raw) ?? [raw]
  const coloured = highlight(lines.join('\n'))
  return (
    <span className={NODE} data-deepsea-script="">
      {lines.map((line, i) => (
        <span key={i} className={`${NODE}-line`}>
          {coloured?.[i] === undefined || line === ''
            ? (line === '' ? '\u200b' : line)
            : coloured[i].map((span, j) => <span key={j} style={span.style}>{span.text}</span>)}
        </span>
      ))}
    </span>
  )
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLESHEET
    document.head.append(style)
    return () => { style.remove() }
  }, 'llm-scripted: stylesheet')
  ctx.effect(() => ctx.uiConversation.userText.register(scriptRule), 'llm-scripted: script prompts')
  ctx.slots.inject('conversation.user.text.node', () =>
    ctx.slots.register({ name: 'conversation.user.text.node', key: NODE, priority: 100 }, ScriptText))
}
