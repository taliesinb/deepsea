# @deepsea/no-global-tools

An **agent-preset row**, not a profile plugin: mounted from a preset, it runs
in the agent's scope and calls `ctx.tools.restrict({ allow: [] })`, hiding
every deployment-global tool from the agents composed under that preset.
Tools registered inside the preset itself (scoped registrations) stay
visible; that is `restrict`'s contract.

Host plugins register their tools globally (`ctx.tools.register` from a
profile row), so a chat-only preset that merely leaves out the in-tree tool
groups still sends all of theirs: dozens of schemas, tens of kilobytes, into
the window of a small local model, which then answers one token and stops
with `length`.

## The `minimal-no-tools` preset

The bundle inserts a preset built on the row (row
`deepsea-preset-minimal-no-tools`, preset id `minimal-no-tools`, shown as
"Minimal (no tools)"): the one-line persona `You are a helpful, concise
assistant.` as the complete system prompt (`complete: true`, so no harness
identity and no assembled sections; `includeRuntimeContext: false`, so no
runtime-context snapshots), no compaction, and this row. The request carries
that sentence, the conversation and no tool schemas. It is meant for Apple
Foundation on-device and 3–4B LM Studio models; `@deepsea/enforce-model-preset`
can switch new sessions on such a model to it.

## In another preset

```yaml
- id: preset-chat
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: chat
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: You answer in one short paragraph.
          complete: true
      - id: deepsea-no-global-tools
        name: '@deepsea/no-global-tools'
```

As a profile row it fails to load: `restrict` refuses a context-global call,
which would mask every agent.

## Limits

- Plugins that register tools **per agent** (on `agent/created`, through the
  agent's own context) make scoped registrations, which `restrict` does not
  hide. Such a plugin has to skip chat-only presets itself, and follow
  `agent-preset/selected`, since a blank session can be switched to another
  preset after its agent was created (the agent is recomposed, not replaced).
- The restriction lasts as long as the row: unloading it lifts it for the
  agents it was applied to.

## Development

```sh
pnpm install && pnpm test
```

The unit test checks the call and the bundle's preset. The integration test
mounts the row in agent scopes of the harness's real tool registry (global
tools hidden, scoped ones kept, other agents untouched, lifted on unload,
refused outside a scope), from the repository root:

```sh
(cd harness && node --import tsx/esm --test "$OLDPWD/plugins/no-global-tools/tests/integration.mjs")
```

In a throwaway, `dsd run release --throwaway-server --scripted --plugins
no-global-tools`, then `dsd drive create-session --preset minimal-no-tools`:
a scripted turn's `request/header` event lists no tools.
