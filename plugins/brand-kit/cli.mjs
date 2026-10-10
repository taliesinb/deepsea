#!/usr/bin/env node
/**
 * @deepsea/brand-kit: profiles from the command line, for provisioning a
 * variant without its GUI open. The same store and validation as the card,
 * in `$DSH_HOME/plugins/brand-kit/`; a change shows on the next page load.
 *
 *   node cli.mjs list
 *   node cli.mjs active
 *   node cli.mjs apply <name | none>
 *   node cli.mjs import <file.brand.zip | directory> [--name <name>] [--apply] [--replace]
 *   node cli.mjs export <name> <out.brand.zip>
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ProfileStore, assertProfileName, nameFromFile, stateDirectory } from './profiles.mjs'

const USAGE = 'usage: cli.mjs list | active | apply <name|none> | export <name> <out.brand.zip> | import <zip|dir> [--name <name>] [--apply] [--replace]'

const args = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (!arg.startsWith('--')) positional.push(arg)
  else if (arg === '--apply' || arg === '--replace') flags[arg.slice(2)] = true
  else if (arg === '--name') flags.name = args[++i]
  else { console.error(`unknown option ${arg}\n${USAGE}`); process.exit(2) }
}
const [command, ...rest] = positional
const store = new ProfileStore(stateDirectory())

try {
  switch (command) {
    case 'list': {
      const active = store.active()
      const names = store.list()
      for (const name of names) console.log(`${name === active ? '* ' : '  '}${name}`)
      if (names.length === 0) console.log(`(no profiles in ${store.profiles})`)
      break
    }
    case 'active':
      console.log(store.active() || '(none: the shipped look)')
      break
    case 'apply': {
      const name = rest[0] === undefined || rest[0] === 'none' ? '' : rest[0]
      store.setActive(name)
      console.log(name === '' ? 'active: none (the shipped look)' : `active: ${name}`)
      break
    }
    case 'export': {
      const [name, out] = rest
      if (name === undefined || out === undefined) throw new Error(USAGE)
      writeFileSync(out, store.exportZip(name))
      console.log(`wrote ${out}`)
      break
    }
    case 'import': {
      const source = rest[0]
      if (source === undefined) throw new Error(USAGE)
      const name = assertProfileName(flags.name ?? nameFromFile(source))
      const options = { replace: flags.replace === true }
      if (store.taken(name) && !options.replace) throw new Error(`brand-kit: a profile named ${JSON.stringify(name)} already exists (--replace to overwrite)`)
      if (statSync(source).isDirectory()) store.importDirectory(name, resolve(source), options)
      else store.importZip(name, new Uint8Array(readFileSync(source)), options)
      console.log(`imported ${name} into ${store.dirOf(name)}`)
      if (flags.apply) { store.setActive(name); console.log(`active: ${name}`) }
      break
    }
    default:
      console.error(USAGE)
      process.exit(2)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
