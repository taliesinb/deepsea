# @deepsea/prompt-excision

Removes whole paragraphs from the assembled initial system prompt of selected
provider routes when they contain configured literal strings. Host-only. It
does not replace the prompt with a different identity, and it says nothing
about how a request is billed.

## Configuration

The implementation has no built-in rules. The bundle patch
([cordis.patch.yml](cordis.patch.yml)) supplies one mapping, so installing the
bundle opts into it:

```yaml
- insert:
    - id: deepsea-prompt-excision
      name: "@deepsea/prompt-excision"
      config:
        providers:
          anthropic-oauth:
            - DeepSeek Harness
```

`providers` maps exact provider route ids to lists of literal strings. A
paragraph containing **any** of them is removed. Matching is case-sensitive
substring inclusion: no regular expressions, word boundaries, wildcards or
aliases. The route is `anthropic-oauth`, the Anthropic plan route of the
harness topic `pi-ai-oauth-routes` (signed in with `/login anthropic`), not
`anthropic` (the API-key route) or the sign-in flow's name.

An empty mapping or an empty list removes nothing. Unknown keys, invalid
mappings and empty or whitespace-only strings fail activation, without
echoing the configuration. To change the mapping of an installed bundle,
override the row in the profile patch, without another insert; the override
replaces the whole `config`:

```yaml
- id: deepsea-prompt-excision
  config:
    providers:
      anthropic-oauth:
        - DeepSeek Harness
```

## Exact behaviour

- A paragraph is a run of text separated by blank lines. LF and CRLF are
  supported; a blank line may contain spaces or tabs. Wrapped lines belong to
  their paragraph.
- It is a plain-text operation, not a Markdown parser: contiguous list items
  or fenced content can be one paragraph, and a match removes the entire
  paragraph, including instructions that do not contain the string.
- Sections are rendered with DSH's own strict variable interpolator before
  matching. Changed sections become non-interpolating literal text, so
  substituted brace sequences are not interpreted a second time. Invalid
  template references still fail as usual.
- Unmatched text stays byte-identical. Separators next to removed paragraphs
  are dropped; surviving paragraphs keep their original preceding separator.
  Unaffected sections and assemblies with nothing to remove keep their
  original objects.
- Every matching paragraph is removed. A section left empty disappears; an
  entirely removed initial prompt produces no system section.
- User and assistant messages, runtime-context snapshots, tool schemas and
  descriptions, variables and recorded events are not edited. The plugin
  logs no prompt contents.

The bundled rule removes the three paragraphs of the harness's prompt that
contain `DeepSeek Harness`: the identity line, the implementation-checkout
paragraph and the Web GUI paragraph. Their guidance goes with them (the
checkout path, the GUI URL and the instructions about them). This is
deliberate whole-paragraph deletion, not a substitution of the name.

## Timing and scope

The plugin joins the `system-prompt/assemble` waterfall with `prepend: true`,
lets the rest of the waterfall run, then reads the provider from the
returned assembly's `variables.provider`. That is the provider of the session's
current model selection, not the stale one from the agent's creation. Every
assembly uses the current mapping and provider; unloading the plugin restores
normal assembly for later requests.

DSH's prompt admission then records the transformed text in `system/message`
events and sends it to the model: the trajectory shows exactly what was sent.
Excision is not an `llm/stream` or HTTP-body rewrite, and earlier events are
left as they were.

pi-ai adds its OAuth identity block (`You are Claude Code, Anthropic's
official CLI for Claude.`) after this stage, for plan routes. The plugin does
not remove or duplicate it, change tool casing or HTTP attribution, read
credentials or change authentication.

## Limits

- A `complete: true` persona is restored by DSH after the assembly
  waterfall and wins; it is exempt by design. Write such a persona without
  the paragraphs, or use ordinary sections, where excision is wanted.
- A plugin that changes the route only in the later `agent/request`
  waterfall cannot change which rule ran; it would have to expose its
  provider during assembly too, as DSH's model selection does.
- A later outer waterfall transformation can put text back. LLM calls that
  bypass system-prompt assembly (independent auxiliary prompts) are out of
  scope.
- Only initial-system paragraphs are removed; the same text elsewhere in the
  request stays. It is not a request anonymizer.

## Development

```sh
pnpm install && pnpm test
```

The unit tests pin the paragraph algorithm, literal matching, template
handling, configuration validation, and preservation of untouched objects.
The integration tests mount the real Loader, Include and agent loop of the
harness build, run real turns and check the requests against a replay of
their session events: provider switches, disposal, the `complete: true`
persona and the late-route limit, plus pi-ai's real Anthropic serialization
over intercepted HTTP with in-memory credentials (the OAuth identity block
stays, API-key prompts are untouched). No real inference, no live
credentials. From the repository root:

```sh
(cd harness && node --import tsx/esm --test "$OLDPWD/plugins/prompt-excision/tests/integration.mjs")
```

In a throwaway (`dsd run release --throwaway-server --scripted --plugins
prompt-excision`), the bundled rule leaves the scripted route alone; a row
mapping `scripted` to `DeepSeek Harness` removes the three paragraphs from
the session's `system/message` event.
