/**
 * What this plugin takes from the variant it runs in (LAYOUT.md §1, §7):
 * `$DSH_HOME/variant.yml`, the flat `key: value` file dsd writes. A named
 * variant records its port block (`ports`: proxy on +4, relay on +3) and,
 * when it may publish on the tailnet, `serve: true` and its `servePath`, and
 * `tailscaleSocket` when a tailscaled of the account's own serves it. A
 * throwaway records neither, and a stock home has no variant.yml at all: no
 * Serve path, and a proxy only when the row's config names a port.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { variantName, variantOf } from '@deepsea/logs'

/** Offsets in a variant's port block (LAYOUT.md §7). */
export const OFFSETS = { dsh: 0, relay: 3, proxy: 4 }

/** Parse variant.yml text: `key: value` lines, `#` comments, JSON-quoted strings, booleans and numbers. */
export function parseVariantYaml(text) {
  const out = {}
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd()
    if (line === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (match === null) continue
    const value = match[2].startsWith('"') ? match[2] : match[2].replace(/\s+#.*$/, '')
    let parsed = value
    if (value.startsWith('"')) {
      try { parsed = JSON.parse(value) } catch { parsed = value }
    } else if (value === 'true' || value === 'false') parsed = value === 'true'
    else if (/^-?\d+(\.\d+)?$/.test(value)) parsed = Number(value)
    out[match[1]] = parsed
  }
  return out
}

/** `$DSH_HOME/variant.yml`, or undefined when the home has none. */
export function readVariantFile(home) {
  let text
  try { text = readFileSync(join(home, 'variant.yml'), 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  return parseVariantYaml(text)
}

/** A Serve path in canonical form: leading slash, no trailing slash (`/deepsea-lab`); `/` for the root. */
export function normalizeServePath(value) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '/') return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** LAYOUT.md §1: `release` → DeepSea, `lab` → DeepSea Lab, `lab-3f9a1c` → DeepSea Lab 3f9a1c. */
export function displayNameOf(id) {
  const throwaway = /^(.+)-([0-9a-f]{6})$/.exec(String(id))
  if (throwaway !== null) return `${displayNameOf(throwaway[1])} ${throwaway[2]}`
  if (id === 'release') return 'DeepSea'
  return `DeepSea ${String(id).split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}`
}

/**
 * The settings this plugin runs with: the variant's, overridden by the row's config.
 * @param {Record<string, unknown> | undefined} variant - parsed variant.yml
 * @param {{ proxyPort?: number, servePath?: string, tailscaleSocket?: string }} config
 * @param {{ home: string, env?: NodeJS.ProcessEnv }} where
 * @returns {{ id?: string, name?: string, display?: string, proxyPort?: number, relayPort?: number,
 *   relayUrl?: string, servePath?: string, tailscaleSocket?: string, cookieName: string, appPath?: string }}
 *   `tailscaleSocket`: a tailscaled of the account's own (variant.yml `tailscaleSocket`, `dsd new
 *   --tailscale-socket`) whose node serves the variant, instead of the machine's.
 */
export function resolveSettings(variant, config, { home, env = process.env }) {
  const id = typeof variant?.id === 'string' && variant.id !== '' ? variant.id : variantOf(home, env)
  const block = typeof variant?.ports === 'number' && Number.isInteger(variant.ports) ? variant.ports : undefined
  const proxyPort = config.proxyPort ?? (block === undefined ? undefined : block + OFFSETS.proxy)
  const relayUrl = typeof env.DEEPSEA_RELAY === 'string' && env.DEEPSEA_RELAY !== '' ? env.DEEPSEA_RELAY : undefined
  let relayPort
  if (relayUrl !== undefined) {
    try { relayPort = Number(new URL(relayUrl).port) || undefined } catch { relayPort = undefined }
  }
  const configuredPath = typeof config.servePath === 'string' && config.servePath !== '' ? config.servePath : undefined
  const variantPath = variant?.serve === true && typeof variant.servePath === 'string' && variant.servePath !== '' ? variant.servePath : undefined
  const servePath = configuredPath ?? variantPath
  const display = typeof variant?.display === 'string' && variant.display !== '' ? variant.display : id === undefined ? undefined : displayNameOf(id)
  const socket = [config.tailscaleSocket, variant?.tailscaleSocket].find(value => typeof value === 'string' && value !== '')
  return {
    ...(socket === undefined ? {} : { tailscaleSocket: socket }),
    id,
    name: id === undefined ? undefined : variantName(id),
    display,
    proxyPort,
    relayPort,
    relayUrl,
    servePath: servePath === undefined ? undefined : normalizeServePath(servePath),
    cookieName: id === undefined ? 'deepsea-tailscale' : `deepsea-tailscale-${id}`,
  }
}
