# @deepsea/chat-title

Lets the agent rename the chat, as a reviewer of the automatic title rather
than a second titler. The harness's LLM titler (`session-title-llm`, mounted
by the `base` bundle) names every chat from the first message with a cheap
side request; this plugin shows the agent that title in the runtime context
and has it rename only when the title is wrong or generic (a greeting-only
first message), when a more accurate name suggests itself in the first few
turns, or when the subject moves. Titles come out in the titler's style.
Host-only (no browser half); everything goes through the session-title
service (`ctx.sessionTitle`), so the sidebar, the `session/title` log event
and the titler all see the same title.

## What the model gets

### `rename_chat` tool

```
rename_chat { title: string }
```

Renames the calling agent's own session. The title is styled first
(`style: slug` → `foo-bar-baz`, capped at `maxWords`; `style: natural` → a
whitespace-collapsed phrase), then applied with `ctx.sessionTitle.rename`,
which logs a `session/title` event with `source.kind: 'user'`, the same event
the sidebar's Rename produces. That pins the title: the automatic titler stops
retitling. In the web chat the call is an ordinary tool row
(`rename_chat · <title>`); clients that use `presentCall` title it "Rename
chat: …".

Outcomes (the value is `{ applied, title, … }`; the model sees a one-line
rendering):

| Situation | Result |
|---|---|
| automatic title (fallback or provider), or a title this tool set earlier | renamed; `previous` carries the old title |
| the same title the tool already set | `applied: false, reason: 'unchanged'` |
| the person named the chat (sidebar Rename, a `slug: ` prefix of the session-title-slug plugin) | `applied: false, reason: 'user-titled'`; the model is told not to call the tool again |
| empty after normalization (`"!!!"`) | error `CHAT_TITLE_EMPTY` |
| called from a subagent session (`header.parentSession` set) | error `CHAT_TITLE_SUBAGENT` |

"Person or agent" is decided from the log, not from memory: the tool writes
the applied title into its `tool/result` `meta.deepseaChatTitle` (through
`presentationMeta`), so after a server restart a `user`-sourced title that
matches any `meta.deepseaChatTitle` in the session is still recognized as the
agent's own and may be replaced; any other `user`-sourced title is the
person's and is never overridden.

### System-prompt section (`promptHint`)

A `tool:deepsea-chat-title` section placed after the tool sections, 80 words:

> Chat title: the chat is titled automatically from the first message; the
> current title appears in the runtime context. Call rename_chat when that
> title is wrong or generic (for example after a greeting-only first
> message), when a more accurate name suggests itself within the first few
> turns, or when the subject of the chat changes. Title: 5 or fewer lowercase
> words joined by hyphens, specific to the task (fix-login-redirect), not
> generic (help-request). Never override a title the user set themselves.

The style sentence follows the resolved style (see Configuration). The
section is emitted only when the assembling agent is top-level (subagents
cannot rename) and its scope can see the tool: a preset without tools
restricts the agent's tool view (`ctx.tools.restrict({ allow: [] })`), so
neither the section nor the line below is sent there.

### Runtime-context line (`nudge`)

While the chat carries an automatic title, the runtime-context snapshot
(`deepsea-chat-title:nudge`) carries the title itself so the agent can judge
it. The two automatic sources read differently:

- fallback (the first words of the first message, written at once):
  *"Chat title: "Please read notes.py and tel" is a placeholder (the first
  words of the first message). Call rename_chat with a real title once you
  know what this chat is about."*
- provider (the LLM titler's result, a few seconds later): *"Automatic chat
  title: "Summarize contents of notes.py file". Keep it if it describes this
  chat; call rename_chat if it is wrong or generic, or if the work so far
  suggests a more accurate name."*

Before any title exists there is nothing to review and the line is empty; it
is empty again once the agent or the person has named the chat. The text
changes at most three times per chat (fallback, provider, gone), each an
appended snapshot message. Same gating as the section.

With the titler on, an agent given a clear task typically keeps the provider
title; with the titler off, it sees the placeholder line and renames.

## Configuration

```yaml
- id: deepsea-chat-title
  config:
    toolName: rename_chat   # model-facing tool name
    style: inherit          # inherit (default) | slug | natural
    # maxWords: 5           # slug word cap / phrase length; unset = the titler row's targetWords, else 5
    promptHint: true        # the system-prompt section
    nudge: true             # the runtime-context line while the title is automatic
```

`style: inherit` reads `style` (and, when `maxWords` is unset, `targetWords`)
from the loader row of the harness's titler (`@deepseek-ai/dsh-session-title-llm`,
`-first-prompt-llm` or `-all-prompts-llm`, whichever the profile mounts), so
agent titles and automatic titles come out in one form: `slug` on a profile
that sets `style: slug` on that row (an option of the harness topic
`title-slug`), `natural` (the harness default) otherwise. The plugin runs on
stock DSH; there it inherits `natural`. The values are read when this row
loads; after changing the titler row's style, reload this row (or restart).

## Interaction with the other title plugins

- `session-title-llm` / `session-title-first-prompt-llm` (harness): does the
  naming; this plugin reviews. In a chat: the fallback title at the first
  prompt, the provider title a few seconds later, and the agent sees each in
  its next request's runtime context. If the agent renames while the titler
  is still running, `sessionTitle.rename` aborts that generation, and the
  `user`-sourced result stops later automatic retitles, so the two never
  overwrite each other. With the `all-prompts` variant the same holds: once
  the agent has renamed, the titler no longer schedules.
- `session-title-slug`: a `some-slug: ` prompt prefix renames with
  `source.kind: 'user'` and no `meta.deepseaChatTitle`, so this plugin treats
  it as the person's title and the model is told to leave it alone, which is
  the intent of typing a slug by hand.

## Limits

- A person's title equal to a title the agent once applied is
  indistinguishable from the agent's own (both `user`-sourced, same string)
  and may be renamed.
- Under the PTC presentation a `rename_chat` sub-dispatch carries no
  `presentationMeta` (nested dispatches have no cards); the in-process
  `WeakMap` still records the applied title, but after a restart it reads as
  the person's. Harmless: the model is merely told not to rename again.

## Development

```sh
pnpm install && pnpm test
```

`pnpm test` covers the styling, the classification, the tool's outcomes and
`apply`'s wiring against fakes. In a server: `dsd run release
--throwaway-app --scripted --plugins chat-title` (tools/dsd/README.md); a
script line `{"cmd":"tool","name":"rename_chat","args":{"title":"Fix the login redirect"}}`
renames the chat.
