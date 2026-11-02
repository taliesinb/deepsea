// Write both MCP servers' tools/list (names, descriptions, input schemas) to docs/server-tools.json, the
// reference for what the plugin's tools forward to.
//
//   node scripts/dump-server-tools.mjs            # both servers (needs Safari Technology Preview)
//   node scripts/dump-server-tools.mjs --chrome   # the chrome-devtools-mcp part only (no browser launched)
//
// Listing tools starts the servers but opens no browser: Chrome and STP launch only for a page.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Config, chromeArgs, chromeEnv, chromeServer } from '../index.js'

const out = new URL('../docs/server-tools.json', import.meta.url)

async function dump(command, args, env) {
  const transport = new StdioClientTransport({ command, args, env, stderr: 'ignore' })
  const client = new Client({ name: 'deepsea-browser-tool-list', version: '0' })
  await client.connect(transport)
  const { tools } = await client.listTools()
  await client.close()
  return Object.fromEntries(tools.map(tool => [tool.name, { description: tool.description, inputSchema: tool.inputSchema }]))
}

const current = JSON.parse(await readFile(out, 'utf8').catch(() => '{}'))
const scratch = await mkdtemp(join(tmpdir(), 'deepsea-browser-dump-'))
try {
  const config = Config({ chrome: { headless: true } })
  const chrome = await dump(chromeServer(config).command, chromeArgs(config, join(scratch, 'profile')), chromeEnv(scratch))
  const safari = process.argv.includes('--chrome') ? current.safari : await dump(config.safari.driver, ['--mcp'])
  await writeFile(out, `${JSON.stringify({ safari, chrome }, null, 2)}\n`)
  console.log(`safari tools: ${Object.keys(safari ?? {}).length} | chrome tools: ${Object.keys(chrome).length}`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
