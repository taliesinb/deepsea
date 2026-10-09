# @deepsea/preset-per-model

Agent presets bound to model selections. DSH has no coupling between the two:
a session's preset is fixed once it has run a turn, and its model is a
separate choice. This plugin maps models to presets with rules, and when a
blank, top-level session selects a model a rule matches, it switches the
session to that preset through `ctx.agentPresets.select`, the queued,
blank-checked path the preset picker uses.

The point is to give tiny local models tiny compositions. The standard
preset's system prompt and tool schemas come to several thousand tokens, and
pi-ai keeps 4,096 tokens of every model's window in reserve before it sets
the output budget, so a model with a 4k–16k window either cannot fit the
request or is left one output token ("Output token limit reached"). On
`minimal-no-tools` the whole request is one sentence plus the conversation.

## Configuration

```yaml
rules:                       # first match wins, in order
  - provider: apple          # required; '*' matches any provider
    model: foundation        # optional; absent or '*' matches any model
    preset: minimal-no-tools # required preset id
  - provider: lmstudio
    preset: minimal
trace: false                 # true: a decision trace (below)
```

That is the bundle's default. `minimal` ships with the harness's web profile;
`minimal-no-tools` is the chat-only preset of `@deepsea/preset-chat-only`
(a one-line persona, no tools, no runtime context), so install both. A rule
naming a preset that does not exist leaves the session where it is and logs
`Unknown agent preset`. Unknown fields fail the load. A profile override of
the row's `config` replaces the whole value.

## When it acts

- **On `model/selection`** (a committed session event: the model was picked)
  of a top-level session (`delegationDepth` 0). Subagents join their
  parent's composition and are never touched.
- **On `agent/created`** of a fresh top-level session, with the deployment's
  default model (`ctx.agentDefaultModel.currentSelection()`). A session that
  never picks a model runs on the default, and the picker remembers a choice
  by making it the default, so no `model/selection` fires for such sessions.
  A later explicit selection enforces again through the event.
- Only while the session is blank. Once a turn has run, DSH refuses the
  switch (`agent-preset/locked`); the plugin treats that as the intended
  outcome, so a model change mid-session keeps the running composition.
- A model a rule matches overrides a manual preset choice on a blank
  session: this plugin *enforces* its rules.
- A model no rule matches leaves the preset alone, with one exception: it
  undoes a switch this plugin made. A blank session moved to
  `minimal-no-tools` for Apple's model goes back to the preset it had before
  (the person's choice, or the default) when the person picks Claude, as
  long as it is still on `minimal-no-tools`. After several switches it goes
  back to the preset from before the first one. A preset the person chose
  after the plugin's switch is theirs, and stays. The plugin remembers its
  switches in memory only, so after a server restart a blank session keeps
  the preset it is on.
- A catch-all rule (`provider: '*'`) makes every other model enforce one
  preset instead, overriding manual choices too: a new session on a cloud
  model then always lands in that preset, whatever the picker or `dsd drive
  create-session --preset` asked for.

## Trace

Switches and failures are logged through `ctx.logger`. For every decision,
set `trace: true`: one JSON line per decision, through `@deepsea/logs`, to
`plugins/preset-per-model/<ts>-<pid>.jsonl` in the variant's log
directory (`~/Library/Logs/<variant name>/`; `$DSH_HOME/logs/` for a home
outside DeepSea), one file per server process, `latest.jsonl` pointing at the
newest: `start` (plugin, pid, variant, home), then `agent-created`,
`default-selection` and `selection` (with the matching rule), `enforce`
(current and target preset) or `restore` (undoing the plugin's switch: current
and the preset it goes back to), and `selected`, `locked` or `failed` (with
the error).

## Development

```sh
pnpm install && pnpm test
```

The tests drive the plugin through a stand-in context: rule order and
wildcards, switching on selection and at creation, undoing its own switches
(and leaving the person's alone), the lock, subagents, refusals, and the
trace.

In a throwaway, `dsd run release --throwaway-server --scripted --plugins
preset-per-model,preset-chat-only`: no default rule matches the scripted
model, so a session created with `--preset minimal` stays on `minimal`. To
see a switch, add a rule for it with `--patch` (`provider: scripted`).
