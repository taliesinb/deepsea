# @deepsea/script

The JSONL language a prompt uses to dictate a test model's exact reply, with
no dependencies. The scripted model (`plugins/llm-scripted`) plays scripts
as a DSH model; the provider simulator (`tools/provider-sim`) plays the same
scripts in each provider's wire protocol. The commands, their fields and the
placement rules are in `plugins/llm-scripted/README.md`; `help` as a plain
prompt prints them.

| Export | Does |
|---|---|
| `isScript(text)` | whether a prompt is a script (starts with `{`) |
| `parseScript(text)` | `{ commands, errors }`: every command with its line, or every problem at once |
| `segments(commands)` | the script split into responses: a tool call ends a response |
| `chunk(text, n)` | a text cut into `n` streamed pieces |
| `plainReply(text)` | the reply to a plain prompt: `say <text>`, `help`, else the standing reply |
| `helpText()` | the Markdown command table `help` prints |
| `ERROR_KINDS` | the `error` command's kinds: harness code and HTTP status |
| `ORDERS_REPLY`, `FINISHED_REPLY` | the standing reply, and the reply after a script's last tool results |

`node --test tests/*.test.mjs` (the grammar's tests are the scripted model's,
in `plugins/llm-scripted/tests`).
