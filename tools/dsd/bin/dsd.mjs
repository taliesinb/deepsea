#!/usr/bin/env node
/**
 * dsd — the DeepSea developer CLI. Command reference: tools/dsd/README.md.
 */
import { execFileSync } from 'node:child_process'
import { adoptCommand } from '../commands/adopt.mjs'
import { check } from '../commands/check.mjs'
import { client } from '../commands/client.mjs'
import { drive } from '../commands/drive.mjs'
import { logs } from '../commands/logs.mjs'
import { buildsCommand, gc, link, list, stop } from '../commands/manage.mjs'
import { play, run } from '../commands/run.mjs'
import { script } from '../commands/script.mjs'
import { supervise } from '../commands/supervise.mjs'
import { build, newVariant, remove } from '../commands/variant.mjs'
import { sim } from '../commands/sim.mjs'
import { topics } from '../commands/topics.mjs'
import { worktree } from '../commands/worktree.mjs'
import { REPO } from '../lib/paths.mjs'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DsdError, selectOutput } from '../lib/util.mjs'

const HELP = `dsd — DeepSea developer CLI (tools/dsd/README.md)

  dsd play [--plugins <names|all>] [--accounts <names|standard|none>] [--source <ref>] [--real]
  dsd sim [status] | start | stop | accounts [<provider>] | account <provider> <credential> [--set <json>] | fixtures
  dsd new <v> [--source <ref>] [--color <hex>] [--plugins <names|all>] [--no-serve]
  dsd build <v> [--install [--dock]] [--self]
  dsd run <v> [--no-app]   (an installed named variant; a thin client: its app)
  dsd client <v> [<server>] [--source <ref>] [--color <hex>] [--dock]   (macOS: the app for a server elsewhere)
  dsd remove <v> [--home] [--self]
  dsd adopt <old home> (<variant> | --throwaway [run options…]) [--move-sign-ins] [--dry-run]
  dsd run <variant> --throwaway | --throwaway-app | --throwaway-server [--visible] [--detach] [--scripted] [--plugins <names|all>]
          [--app <checkout|ref>] [--patch <file>,…] [--source <ref, e.g. integration/base>] [--simulated [--accounts <names>]] [--harness <ref>] [--ttl <min>] [--keep]
  dsd stop [<variant>] [--keep]
  dsd list [--builds] [--json]
  dsd logs [<variant>] [app | relay | server | dsd | plugin <name>] [--lines <n>] [--follow] [--export]
  dsd gc [--builds] [--dry-run]
  dsd builds [list | make [<harness ref>]]
  dsd link
  dsd drive [-v <ref>] <op> …   server: health create-session prompt command wait events cancel sessions invoke url
                                app: load reload wait-page eval resize view appearance click type describe snapshot window-info app-log opened quit
  dsd script <file.mjs> [-v <ref>]
  dsd worktree add <topic> [--from <ref>] | list | remove <topic>
  dsd topics [list] | check | integrate [--dry-run]
  dsd check [--staged | <rev range>] [--install-hook]

A <variant> reference is a full id, a unique part of a throwaway's hex, or
nothing when exactly one of your throwaways is running.
`

const COMMANDS = { new: newVariant, client, build, remove, adopt: adoptCommand, sim, play, run, stop, list, logs, gc, builds: buildsCommand, link, drive, script, worktree, topics, check, __supervise: supervise }

/**
 * Warn when this dsd is run inside another checkout of the same repository:
 * plugins, the pin and builds come from the checkout dsd belongs to.
 */
function warnForeignCheckout() {
  const ask = (cwd, args) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return undefined } }
  const here = ask(process.cwd(), ['rev-parse', '--show-toplevel'])
  if (here === undefined || here === REPO) return
  const sameRepo = ask(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir']) === ask(REPO, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (sameRepo) process.stderr.write(`dsd: this is ${REPO}'s dsd, run inside ${here}; plugins and the harness pin come from ${REPO}. Use ${here}/tools/dsd/bin/dsd.mjs (or pnpm dsd there).\n`)
}

/**
 * A command's help: the doc comments in tools/dsd that start with `dsd <command>`
 * (drive's lists every operation), and the command's rows of the README's table.
 */
function commandHelp(name) {
  const dsd = join(REPO, 'tools', 'dsd')
  const parts = []
  for (const file of readdirSync(join(dsd, 'commands')).filter(f => f.endsWith('.mjs')).sort()) {
    const text = readFileSync(join(dsd, 'commands', file), 'utf8')
    for (const m of text.matchAll(/\/\*\*\n((?: \*.*\n)+?) \*\//g)) {
      const lines = m[1].split('\n').map(l => l.replace(/^ \* ?/, ''))
      if (new RegExp(`^dsd ${name}\\b`).test(lines[0])) parts.push(lines.join('\n').trimEnd())
    }
  }
  const readme = readFileSync(join(dsd, 'README.md'), 'utf8')
  const rows = readme.split('\n').filter(l => l.startsWith(`| \`dsd ${name}`)).map(l => l.slice(2, -2).replace(/ \| /, '\n    ').replaceAll('\\|', '|'))
  if (rows.length) parts.push(rows.join('\n\n'))
  return parts.length ? `${parts.join('\n\n')}\n\n(tools/dsd/README.md)\n` : HELP
}

const argv = process.argv.slice(2)
const get = argv.indexOf('--get')
if (get >= 0) { selectOutput(argv[get + 1]); argv.splice(get, 2) }
const [command, ...rest] = argv
if (command === undefined || command === '--help' || command === '-h' || (command === 'help' && rest.length === 0)) {
  process.stdout.write(HELP)
} else if (command === 'help' || (command in COMMANDS && rest.some(a => a === '--help' || a === '-h'))) {
  process.stdout.write(commandHelp(command === 'help' ? rest[0] : command))
} else if (!(command in COMMANDS)) {
  process.stderr.write(`dsd: unknown command "${command}"\n\n${HELP}`)
  process.exitCode = 2
} else {
  warnForeignCheckout()
  try {
    await COMMANDS[command](rest)
  } catch (error) {
    if (!(error instanceof DsdError)) throw error
    process.stderr.write(`dsd: ${error.message}\n`)
    process.exitCode = error.code
  }
}
