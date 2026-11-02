/**
 * @deepsea/brand-kit: brand profiles on disk, in the plugin's state directory
 * (LAYOUT.md §4):
 *
 *   $DSH_HOME/plugins/brand-kit/
 *     state.json              { "active": "<profile>" }   ('' or absent: the shipped look)
 *     profiles/<name>/
 *       profile.json          the brand in portable form: `mark` and `fonts[].file`
 *                             are file names in this directory
 *       mark.svg, *.woff2 …   the files it names
 *
 * A profile can be zipped, moved to another machine and imported unchanged;
 * {@link resolveProfile} turns it into the resolved form (absolute paths)
 * that brand.mjs validates. Export and import are zip archives (fflate) of
 * the directory: profile.json and flat asset files. Imports are checked in a
 * hidden staging directory beside the profiles, then renamed into place, so
 * a bad archive leaves nothing behind.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { unzipSync, zipSync } from 'fflate'
import { FONT_EXTENSIONS, MARK_EXTENSIONS, normalizeBrand } from './brand.mjs'

/** Profile names: what a directory can be called and the card can show. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$/
/** File names inside a profile (no paths, no hidden files). */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/
/** Import and upload caps: an archive as a whole and any single file. */
export const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024
export const MAX_FILE_BYTES = 8 * 1024 * 1024

const ASSET_EXTENSIONS = [...MARK_EXTENSIONS, ...FONT_EXTENSIONS]

/** The plugin's state directory: `$DSH_HOME/plugins/brand-kit`. */
export function stateDirectory(env = process.env) {
  return join(resolveDshHome(undefined, env), 'plugins', 'brand-kit')
}

function fail(message) { throw new Error(`brand-kit: ${message}`) }

/**
 * @param {string} name - candidate profile name.
 * @returns {string} the name, when valid.
 */
export function assertProfileName(name) {
  if (typeof name !== 'string' || !PROFILE_NAME.test(name)) fail(`a profile name is 1-41 letters, digits, spaces, '.', '_', '-', starting with a letter or digit; got ${JSON.stringify(name)}`)
  return name
}

/** A profile name from a file name: `Acme.brand.zip` → `Acme`, unusable characters dropped. */
export function nameFromFile(file) {
  const stem = basename(String(file)).replace(/\.brand\.zip$|\.zip$/i, '').replace(/[^A-Za-z0-9 ._-]/g, '').replace(/^[^A-Za-z0-9]+/, '').slice(0, 41).trim()
  return stem === '' ? 'Imported' : stem
}

/**
 * Portable profile JSON → resolved form (still to be validated by normalizeBrand).
 * @param {string} dir - the profile directory.
 * @param {Record<string, unknown>} json - parsed profile.json.
 */
export function resolveProfile(dir, json) {
  const input = { ...json }
  const mark = typeof input.mark === 'string' ? input.mark : ''
  if (mark !== '' && !FILE_NAME.test(mark)) fail(`mark must be a file name in the profile, got ${JSON.stringify(mark)}`)
  input.mark = mark === '' ? '' : join(dir, mark)
  delete input.fontsDir
  input.fontsDir = Array.isArray(input.fonts) && input.fonts.length > 0 ? dir : ''
  return input
}

/** The profiles in a plugin state directory, and which one is active. */
export class ProfileStore {
  /** @param {string} root - the plugin's state directory (created on first write). */
  constructor(root) {
    this.root = root
    this.profiles = join(root, 'profiles')
  }

  dirOf(name) { return join(this.profiles, assertProfileName(name)) }

  /** @returns {string[]} profile names, sorted. */
  list() {
    if (!existsSync(this.profiles)) return []
    return readdirSync(this.profiles, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && PROFILE_NAME.test(entry.name) && existsSync(join(this.profiles, entry.name, 'profile.json')))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
  }

  /** Whether a profile has exactly this name. */
  has(name) { return typeof name === 'string' && PROFILE_NAME.test(name) && this.list().includes(name) }

  /**
   * Whether a directory already answers to this name. File systems that
   * ignore case (macOS by default) make `Acme` and `acme` one directory.
   */
  taken(name) {
    if (!existsSync(this.profiles)) return false
    const key = name.toLowerCase()
    return readdirSync(this.profiles).some(entry => entry.toLowerCase() === key)
  }

  /** `base` if free, else the next free number: `Acme` → `Acme 2`, `Acme 2` → `Acme 3`. */
  freeName(base) {
    assertProfileName(base)
    if (!this.taken(base)) return base
    const numbered = /^(.*\S) (\d+)$/.exec(base)
    const stem = numbered ? numbered[1] : base
    for (let n = numbered ? Number(numbered[2]) + 1 : 2; ; n++) {
      const suffix = ` ${String(n)}`
      const candidate = `${stem.slice(0, 41 - suffix.length).trimEnd()}${suffix}`
      if (!this.taken(candidate)) return candidate
    }
  }

  /**
   * Read and validate one profile.
   * @param {string} name
   * @returns {{ name: string, dir: string, json: Record<string, unknown>, brand: import('./brand.mjs').Brand }}
   */
  read(name) {
    const dir = this.dirOf(name)
    if (!this.has(name)) fail(`no profile named ${JSON.stringify(name)}`)
    let json
    try {
      json = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'))
    } catch (error) {
      fail(`${name}: profile.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) fail(`${name}: profile.json must be an object`)
    return { name, dir, json, brand: normalizeBrand(resolveProfile(dir, json)) }
  }

  /** A profile's profile.json as it is, valid or not; null when unreadable. */
  rawJson(name) {
    try {
      const json = JSON.parse(readFileSync(join(this.dirOf(name), 'profile.json'), 'utf8'))
      return json !== null && typeof json === 'object' && !Array.isArray(json) ? json : null
    } catch {
      return null
    }
  }

  /**
   * Validate and write a profile's JSON (its files must already be in place).
   * @param {string} name - profile name (its directory is created when absent).
   * @param {Record<string, unknown>} json - portable profile JSON.
   */
  write(name, json) {
    const dir = this.dirOf(name)
    if (json === null || typeof json !== 'object' || Array.isArray(json)) fail('a profile is an object')
    normalizeBrand(resolveProfile(dir, json)) // throws before anything is written
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'profile.json'), `${JSON.stringify(json, null, 2)}\n`)
    return this.read(name)
  }

  /** A new, empty profile: the shipped look. */
  create(name) {
    if (this.taken(assertProfileName(name))) fail(`a profile named ${JSON.stringify(name)} already exists`)
    return this.write(name, {})
  }

  /** A copy of a profile, its files included. */
  duplicate(from, to) {
    const { dir, json } = this.read(from)
    const target = this.dirOf(to)
    if (this.taken(to)) fail(`a profile named ${JSON.stringify(to)} already exists`)
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(dir)) {
      if (FILE_NAME.test(entry) && statSync(join(dir, entry)).isFile()) copyFileSync(join(dir, entry), join(target, entry))
    }
    return this.write(to, json)
  }

  rename(from, to) {
    if (!this.has(from)) fail(`no profile named ${JSON.stringify(from)}`)
    const target = this.dirOf(to)
    if (this.taken(to) && to.toLowerCase() !== from.toLowerCase()) fail(`a profile named ${JSON.stringify(to)} already exists`)
    renameSync(this.dirOf(from), target)
    if (this.active() === '' && this.storedActive() === from) this.setActive(to)
    return this.read(to)
  }

  delete(name) {
    if (!this.has(name)) fail(`no profile named ${JSON.stringify(name)}`)
    if (this.active() === name) this.setActive('')
    rmSync(this.dirOf(name), { recursive: true, force: true })
  }

  /**
   * Store an uploaded file in a profile directory.
   * @param {string} name - an existing profile.
   * @param {'mark' | 'font'} kind - decides the accepted extensions.
   * @param {string} file - file name in the profile.
   * @param {Uint8Array} bytes
   * @returns {string} the stored file name.
   */
  putAsset(name, kind, file, bytes) {
    if (!this.has(name)) fail(`no profile named ${JSON.stringify(name)}`)
    const allowed = kind === 'mark' ? MARK_EXTENSIONS : FONT_EXTENSIONS
    if (typeof file !== 'string' || !FILE_NAME.test(file) || !allowed.includes(extname(file).toLowerCase())) fail(`a ${kind} file is named like name${allowed[0]} (${allowed.join(', ')}), got ${JSON.stringify(file)}`)
    if (bytes.byteLength === 0) fail('empty file')
    if (bytes.byteLength > MAX_FILE_BYTES) fail(`file too large (${String(bytes.byteLength)} bytes; limit ${String(MAX_FILE_BYTES)})`)
    writeFileSync(join(this.dirOf(name), file), bytes)
    return file
  }

  /**
   * A zip of the profile: profile.json and the files it names, flat.
   * @param {string} name
   * @returns {Uint8Array}
   */
  exportZip(name) {
    const { dir, json, brand } = this.read(name)
    /** @type {Record<string, Uint8Array>} */
    const files = { 'profile.json': new TextEncoder().encode(`${JSON.stringify(json, null, 2)}\n`) }
    const named = [...(brand.mark === '' ? [] : [basename(brand.mark)]), ...brand.fonts.map(font => font.file)]
    for (const file of named) files[file] = new Uint8Array(readFileSync(join(dir, file)))
    return zipSync(files, { level: 6 })
  }

  /**
   * Install a profile from files already read into memory: validated in a
   * hidden staging directory, then renamed into place.
   * @param {string} name - new profile name.
   * @param {Record<string, unknown>} json - its profile.json.
   * @param {Record<string, Uint8Array>} files - its assets by file name.
   * @param {{ replace?: boolean }} [options]
   */
  install(name, json, files, { replace = false } = {}) {
    const target = this.dirOf(name)
    if (this.taken(name) && !replace) fail(`a profile named ${JSON.stringify(name)} already exists`)
    if (json === null || typeof json !== 'object' || Array.isArray(json)) fail('profile.json must be an object')
    mkdirSync(this.profiles, { recursive: true })
    const staging = join(this.profiles, `.import-${String(process.pid)}-${randomBytes(3).toString('hex')}`)
    mkdirSync(staging)
    try {
      for (const [file, data] of Object.entries(files)) writeFileSync(join(staging, file), data)
      writeFileSync(join(staging, 'profile.json'), `${JSON.stringify(json, null, 2)}\n`)
      normalizeBrand(resolveProfile(staging, json))
      if (replace) rmSync(target, { recursive: true, force: true })
      renameSync(staging, target)
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
    return this.read(name)
  }

  /**
   * A profile from an archive made by {@link exportZip}, or by hand
   * (profile.json and its files at the root; one wrapping folder is accepted).
   * @param {string} name - new profile name.
   * @param {Uint8Array} bytes - the archive.
   * @param {{ replace?: boolean }} [options]
   */
  importZip(name, bytes, options) {
    assertProfileName(name)
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) fail(`archive too large (${String(bytes.byteLength)} bytes; limit ${String(MAX_ARCHIVE_BYTES)})`)
    let entries
    try {
      entries = unzipSync(bytes)
    } catch (error) {
      fail(`not a zip archive (${error instanceof Error ? error.message : String(error)})`)
    }
    const keys = Object.keys(entries).filter(key => !key.endsWith('/') && !key.split('/').some(part => part.startsWith('.') || part === '__MACOSX'))
    const prefix = keys.includes('profile.json') ? '' : (keys.find(key => /^[^/]+\/profile\.json$/.test(key)) ?? '').replace(/profile\.json$/, '')
    if (!keys.includes(`${prefix}profile.json`)) fail('the archive has no profile.json')
    /** @type {Record<string, Uint8Array>} */
    const files = {}
    let json
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue
      const file = key.slice(prefix.length)
      if (file.includes('/')) fail(`unexpected folder in the archive: ${JSON.stringify(key)}`)
      if (entries[key].byteLength > MAX_FILE_BYTES) fail(`${file} is too large`)
      if (file === 'profile.json') {
        try { json = JSON.parse(new TextDecoder().decode(entries[key])) } catch (error) { fail(`profile.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`) }
        continue
      }
      if (!FILE_NAME.test(file) || !ASSET_EXTENSIONS.includes(extname(file).toLowerCase())) fail(`unexpected file in the archive: ${JSON.stringify(file)}`)
      files[file] = entries[key]
    }
    return this.install(name, json, files, options)
  }

  /**
   * A profile from a directory laid out like an export (profile.json and
   * its files); other files beside them stay behind.
   * @param {string} name
   * @param {string} dir
   * @param {{ replace?: boolean }} [options]
   */
  importDirectory(name, dir, options) {
    assertProfileName(name)
    if (!existsSync(join(dir, 'profile.json'))) fail(`${basename(dir)} has no profile.json`)
    let json
    try { json = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')) } catch (error) { fail(`profile.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`) }
    /** @type {Record<string, Uint8Array>} */
    const files = {}
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (entry === 'profile.json' || !FILE_NAME.test(entry) || !ASSET_EXTENSIONS.includes(extname(entry).toLowerCase()) || !statSync(path).isFile()) continue
      if (statSync(path).size > MAX_FILE_BYTES) fail(`${entry} is too large`)
      files[entry] = new Uint8Array(readFileSync(path))
    }
    return this.install(name, json, files, options)
  }

  // ---- the active profile

  get stateFile() { return join(this.root, 'state.json') }

  /** The name state.json records, whether or not that profile exists. */
  storedActive() {
    try {
      const state = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      return typeof state?.active === 'string' ? state.active : ''
    } catch {
      return ''
    }
  }

  /** @returns {string} the active profile, '' for the shipped look. */
  active() {
    const name = this.storedActive()
    return this.has(name) ? name : ''
  }

  /** @param {string} name - a profile, or '' for the shipped look. */
  setActive(name) {
    if (name !== '' && !this.has(assertProfileName(name))) fail(`no profile named ${JSON.stringify(name)}`)
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.stateFile, `${JSON.stringify({ active: name }, null, 2)}\n`)
  }
}
