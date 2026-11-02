# @deepsea/import-api-keys

`/import-api-keys` imports provider API keys from a file on the machine you
are at into the server you are talking to. It is a **browser command** (a
`ui-commands` contribution of kind `action`): picking it in the slash menu or
pressing Enter on the bare line opens the file picker and never produces a
chat message or a session record. Because it is just the page, it works the
same in the DeepSea app, in a framed remote session (@deepsea/remote-workspaces)
and in an app connected to another machine's server: the three places where
keys have to reach a server they were not typed into.

## Flow

1. The file picker (`<input type=file>`): `.json`, `.env`, `.yaml`, text.
2. The browser parses the file (`parse.mjs`, sniffed by content, not by
   name):
   - **pi's `~/.pi/agent/auth.json`**: `{ "<provider>": { "type": "api_key",
     "key" } | { "type": "oauth", … } }`. Provider ids map to credential
     names through pi-ai's own env table (`anthropic → ANTHROPIC_API_KEY`,
     `google → GEMINI_API_KEY`, `zai-coding-cn → ZAI_CODING_CN_API_KEY`), the
     names llm-pi-ai's providers read as `apiKeyEnv`, so nothing else needs
     configuring. Sign-ins (`oauth`) and unknown providers are listed as
     skipped.
   - a flat `{ "OPENAI_API_KEY": "…" }` map (names `[A-Z][A-Z0-9_]*`);
   - dotenv text (`export` allowed, quotes stripped, `#` comments);
   - **another home's `.credentials.yaml`** (`$DSH_HOME/.credentials.yaml`,
     the file this command writes into on the receiving server, so "copy my
     keys to that server" is: pick this file). Its `refs:` block is the key
     map; of its `records:`, `llm-pi-ai/<provider>` `api-key` records import
     through the provider's env name, `grant` records (sign-ins) are skipped
     (there is no wire path for them: sign in on the other server), and the
     browser-session grant is ignored. Read by a purpose-built parser of that
     file's fixed layout, not a YAML library.
3. `POST /deepsea-import-api-keys/plan` (host half): each candidate is
   compared with the credential store and comes back as `new`, `same`,
   `different`, `readonly` (supplied by the process environment: a write
   would not take) or `invalid`. The round trip exists because DSH's wire
   API never returns a stored value (`describe` says configured or not), so
   only the host can say whether an import **would overwrite a different
   value**.
4. The confirm dialog, one table of `tick | name | summary`: new keys
   ticked; keys stored with a different value unticked but tickable ("tick
   to overwrite"); keys stored with the same value without a box; invalid,
   read-only and skipped rows with a disabled box and the reason. **Import
   N** counts the ticks and is disabled with none.
5. **Providers are switched on.** A stored key alone does not put a provider
   in the model picker, which lists providers with a profile in settings
   (what Settings ▸ Models writes when you add one). For every imported key,
   the shipped route whose key name it is (pi-ai's env table, else
   `<PROVIDER>_API_KEY`) and that has no profile yet gets an empty profile
   (`settings.mutate(ns, [{ op: 'set', path, value: {} }])`, the Models
   page's own write). The row says "· enables Anthropic"; a key already
   stored with the same value whose provider is still off gets a ticked
   "tick to enable" row (no rewrite, just the profile); the done dialog lists
   the enabled providers. User-declared gateways are never touched.
6. Writes go through `remote.credentials.set` per key (DSH's sanctioned write
   path), then a done dialog says what was stored, enabled or failed.
   Providers re-resolve credentials per request, so imported keys work at
   once, with no restart.

Enter presses the dialog's primary button (Import, OK) and Escape closes it
(`src/client/dialog-keys.ts`).

**Where the picker opens.** A web page cannot choose the picker's start
directory or pre-select a file. The DeepSea app can: just before opening the
input, the plugin posts a one-shot hint to the app's script message handler
(`deepseaApp` → `{ type: 'open-panel', file: '~/.pi/agent/auth.json',
directory: '~/.pi/agent', showsHiddenFiles: true, message }`), which the app
applies to its next open panel: `auth.json` pre-selected when it exists,
else the directory, hidden files shown. In a browser the hint is a no-op and
the picker opens wherever the browser last was (⇧⌘G and `~/.pi/agent` there).

Values cross the wire twice (plan, then set), over the admitted connection,
and are never written to the attachment store or to disk by the browser. An
unreadable or unrecognised file gives an error dialog with the parser's
reason.

## Composition

Host half: `inject = ['webServer', 'connection', 'credentials']`. The plan
route sits behind DSH's own request gate (`connection.requestRejection`: the
Host/Origin fence and the browser-session cookie) and takes the Connection
JSON envelope, so any admitted connection reaches it. Browser half: `inject =
['slots', 'commandUi', 'connection', 'remote', 'remote.credentials',
'remote.llm', 'remote.settings']`; the dialogs render in the `shell.overlay`
slot with the shipped `Modal`. No config.

| File | Role |
|---|---|
| `index.js` | host half: the plan route (`planImport` exported for tests) |
| `parse.mjs` | the file parser, shared by the browser bundle and the tests |
| `src/client/index.tsx` | the command, the picker hint, the confirm and done dialogs |
| `src/client/dialog-keys.ts` | Enter presses the dialog's default button; identical in every plugin with such a dialog |
| `build.mjs` | esbuild → `lib/client.js` in the shell's module-loader wrapper |
| `cordis.patch.yml` | bundle patch inserting the `deepsea-import-api-keys` row |

## Requirements

Harness topic `modal-width` (the dialogs' widths).

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test   # parser and plan classification
```

`pnpm install` needs the repository's `harness` link (`dsd link`).
