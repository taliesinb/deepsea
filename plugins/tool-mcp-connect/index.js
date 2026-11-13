/**
 * @deepsea/tool-mcp-connect: row `deepsea-tool-mcp-connect` ("MCP servers per
 * session", global). It is the harness's experimental mcp-connect plugin
 * (`@deepseek-ai/dsh-experimental-mcp-connect`, harness topic mcp-connect)
 * under a DeepSea row, so a variant gets it by installing this plugin rather
 * than by a hand-written profile row. Its inject, Config and apply are the
 * harness plugin's; README.md says what the tools do.
 */
import * as McpConnect from '@deepseek-ai/dsh-experimental-mcp-connect'

export const name = 'deepsea-tool-mcp-connect'
export const inject = McpConnect.inject
export const Config = McpConnect.Config
export const apply = McpConnect.apply
