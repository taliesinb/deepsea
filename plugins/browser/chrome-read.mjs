/**
 * Chrome side of page reads. chrome-devtools-mcp has no text extractor (its
 * `take_snapshot` is the accessibility tree): markdown is the plugin's own
 * serializer (dom-markdown.mjs, shared with Safari), plainText is innerText,
 * html the body's innerHTML; everything else (expand, scope, probe,
 * structure, clean) is the same DOM code page-read.mjs runs in Safari.
 *
 * The bridge is `chromeReadCall`: it makes a Chrome page look like Apple's
 * server to `extractPage` by answering `evaluate_javascript` and
 * `get_page_content` calls with `evaluate_script`.
 */

import { domMarkdownScript } from './dom-markdown.mjs'

export const CHROME_FORMATS = ['markdown', 'plainText', 'html']

/** plainText / html envelope; markdown is dom-markdown.mjs. Function body returning `{ url, title, format, content }`. */
export function chromeExtractScript(params) {
  if (params.format === 'markdown') return domMarkdownScript(params)
  return `
const P = ${JSON.stringify(params)};
return { url: location.href, title: document.title, format: P.format, content: P.format === 'html' ? (document.body.innerHTML ?? '') : (document.body.innerText ?? '') };`
}

/** Strip chrome-devtools-mcp's "Script ran on page and returned:\n```json\n…\n```" envelope. */
export function unfence(text) {
  const match = /```(?:json)?\n([\s\S]*?)\n```\s*$/.exec(text)
  return match !== null ? match[1] : text
}

/**
 * Adapter that lets page-read.mjs `extractPage` drive a Chrome page: it answers the two Apple-server calls
 * extractPage makes (`evaluate_javascript`, `get_page_content`) with chrome-devtools-mcp's `evaluate_script`.
 * @param {(name: string, args: object) => Promise<string>} callChrome - `conn.callText` with pageId already bound
 */
export function chromeReadCall(callChrome) {
  const run = async (body) => unfence(await callChrome('evaluate_script', { function: `async () => { ${body}\n }` }))
  return async (name, args) => {
    if (name === 'evaluate_javascript') return run(args.expression)
    if (name === 'get_page_content') {
      if (!CHROME_FORMATS.includes(args.format)) throw new Error(`chrome_get_page_content: format must be one of ${CHROME_FORMATS.join(', ')}`)
      return run(chromeExtractScript({ format: args.format, maxWordsPerParagraph: args.maxWordsPerParagraph, includeURLs: args.includeURLs }))
    }
    throw new Error(`chromeReadCall: unsupported call ${name}`)
  }
}
