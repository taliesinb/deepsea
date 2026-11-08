# @deepsea/script

The JSONL language a prompt uses to dictate a test model's exact reply, with
no dependencies. The scripted model (`plugins/llm-scripted`) plays scripts
as a DSH model; the provider simulator (`tools/provider-sim`) plays the same
scripts in each provider's wire protocol. The commands, their fields, values
and how a script runs are in `plugins/llm-scripted/README.md`; `help` as a
plain prompt prints the command table.

| Export | Does |
|---|---|
| `isScript(text)` | whether a prompt is a script (starts with `{`) |
| `parseScript(text)` | `{ commands, errors }`: every command with its `line`, `at` and `ref` (nested commands inside `batch` and `loop`), or every problem at once |
| `resume(commands, context, position, record)` | the run, replayed through its first `position` responses (`record` puts each one's tool results into the context), at the start of the next; `undefined` when the script ended |
| `interpret(commands, context)` | the run as a generator of actions: `{ op, command, key, evaluate }` per command, `{ op: 'suspend' }` where a response ends for tool results |
| `checkExpectation(command, context)` | an evaluated `expect` checked; throws `ScriptExpectationError` |
| `formatPrint(value, { prefix, maxChars })` | the Markdown a `print` shows (the interpreter turns a `print` into a `say` of it) |
| `checkCommand(command)`, `evaluateCommand(command, context)` | a command's fields checked against its schema; a command with its values evaluated and checked again |
| `evaluate`, `evaluateValue`, `load`, `applySave`, `recordTool`, `newContext`, `ScriptValueError` | value expressions and the JSON context `{tools, locals, globals, loop}` |
| `chunk(text, n)` | a text cut into `n` streamed pieces |
| `plainReply(text)` | the reply to a plain prompt: `say <text>`, `help`, else the standing reply |
| `helpText()` | the Markdown command table `help` prints |
| `ERROR_KINDS` | the `error` command's kinds: harness code and HTTP status |
| `ORDERS_REPLY`, `FINISHED_REPLY` | the standing reply, and the reply of a response with nothing else to show |

`grammar.mjs` (the commands, parsing, `help`), `values.mjs` (value
expressions, the context) and `run.mjs` (the interpreter); `index.mjs`
re-exports them. Tests: the scripted model's, in `plugins/llm-scripted/tests`,
and the simulator's, in `tools/provider-sim/tests`.
