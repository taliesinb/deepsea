# tool-mcp-connect

Lets the agent connect an MCP server to the session it is working in, after
you approve it. It enables the harness's experimental `mcp-connect` plugin
(harness topic `mcp-connect`, package `@deepseek-ai/dsh-experimental-mcp-connect`),
which a DeepSea variant would otherwise only get from a hand-written profile
row.

## What the agent gets

- `mcp_connect({ name })` connects a server a project `.mcp.json` declares
  (searched from the session's working directory up to its repository
  root), in the `mcpServers` format of Claude Code and Cursor.
  `mcp_connect({ name, command, args?, env?, cwd? })` or
  `mcp_connect({ name, url, headers? })` defines one inline. Strings may
  reference the server's environment as `${NAME}` or `${NAME:-default}`.
- Every connection asks you, whatever the access mode: the panel shows the
  command line or URL, the directory, the `.mcp.json` it came from and the
  names of environment variables and headers (literal values hidden).
- The server's tools, `mcp__<name>__<tool>`, reach only that session, from
  the agent's next step. Resuming the session reconnects them without
  asking again; a fork starts without them.
- `mcp_list` shows the servers connected in this session, the profile's own,
  and those `.mcp.json` declares. `mcp_disconnect` stops one.

The harness package README (`packages/experimental/mcp-connect/README.md` in
the harness) has the details and limits.

## Configuration

The row is `deepsea-tool-mcp-connect`; its config is the harness plugin's:

| Field | Default | Meaning |
|---|---|---|
| `startupTimeoutMs` | `120000` | longest wait for a server to start and list its tools |
| `projectFiles` | `true` | offer servers that a project `.mcp.json` declares |

## How it works

`index.js` re-exports the harness plugin's `inject`, `Config` and `apply`
under the DeepSea row name. The harness package comes through a `link:`
dependency into `harness/`, so the plugin needs a harness build that
carries the `mcp-connect` topic (`"deepsea": { "requires": ["mcp-connect"] }`):
an integration that includes it, pinned. Against a harness without it the
row fails to load.

## Limits

A connected server runs as you, outside the sandbox; the approval is the
only control. Each connection changes the system prompt (the MCP resource
section lists every connected server), which costs one prompt-cache miss on
routes that cannot append a system-prompt update.
