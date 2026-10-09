/**
 * Parse an API-key file into `{ ref: value }`; shared by the host (tests) and
 * the browser bundle (esbuild inlines it).
 *
 * Accepted shapes, sniffed by content, not by filename:
 *   1. pi's `~/.pi/agent/auth.json`:  { "<provider>": { "type": "api_key", "key": "…" } | { "type": "oauth", … } }
 *      Provider ids map to credential refs through pi-ai's own env table
 *      (`@earendil-works/pi-ai` env-api-keys), which is what llm-pi-ai's
 *      providers read (`apiKeyEnv`), so imported keys are picked up with no
 *      further config. OAuth entries and unknown providers are reported as skipped.
 *   2. a flat map  { "ANTHROPIC_API_KEY": "sk-…", … }   (ref grammar: [A-Z][A-Z0-9_]*)
 *   3. dotenv text  ANTHROPIC_API_KEY=sk-…  (quotes stripped, `export` allowed, # comments)
 *   4. a home's own `$DSH_HOME/.credentials.yaml` (the store this command writes
 *      INTO on the other end): the `refs:` block is the key map; `records:`
 *      entries are reported: `llm-pi-ai/<provider>` `api-key` records import
 *      through the provider's env name, `grant` records (sign-ins) and the
 *      browser-session grant are skipped. Parsed with a purpose-built reader of
 *      that file's fixed 2-space layout, not a YAML library.
 */

/** pi-ai env-api-keys `getApiKeyEnvVars` table (0.85.1), first env var per provider. */
export const PI_PROVIDER_ENV = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GEMINI_API_KEY',
  'google-vertex': 'GOOGLE_CLOUD_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  radius: 'RADIUS_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  zai: 'ZAI_API_KEY',
  'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  together: 'TOGETHER_API_KEY',
  baseten: 'BASETEN_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
  'cloudflare-workers-ai': 'CLOUDFLARE_API_KEY',
  'cloudflare-ai-gateway': 'CLOUDFLARE_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'xiaomi-token-plan-ams': 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'xiaomi-token-plan-sgp': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'ant-ling': 'ANT_LING_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY',
  'qwen-token-plan-individual': 'QWEN_TOKEN_PLAN_API_KEY',
})

export const REF_PATTERN = /^[A-Z][A-Z0-9_]*$/

/**
 * @param {string} text file contents
 * @returns {{ format: 'pi-auth'|'env-map'|'dotenv', keys: Record<string, string>, skipped: { name: string, reason: string }[] }}
 * @throws {Error} when the content is none of the accepted shapes (message is user-facing)
 */
export function parseKeyFile(text) {
  const trimmed = String(text ?? '').replace(/^\uFEFF/, '').trim()
  if (trimmed === '') throw new Error('The file is empty.')
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json
    try { json = JSON.parse(trimmed) } catch (error) { throw new Error(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('Expected a JSON object at the top level.')
    const entries = Object.entries(json)
    if (entries.length === 0) throw new Error('The JSON object is empty.')
    if (entries.every(([, v]) => typeof v === 'object' && v !== null)) return parsePiAuth(entries)
    if (entries.every(([, v]) => typeof v === 'string')) return parseEnvMap(entries)
    throw new Error('Unrecognised JSON: expected pi\'s auth.json ({ provider: { type, key } }) or a flat { "NAME_API_KEY": "value" } map.')
  }
  if (/^version:\s*1\s*$/m.test(trimmed) && /^(refs|records):\s*$/m.test(trimmed)) return parseDshCredentials(trimmed)
  if (/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(trimmed)) return parseDotenv(trimmed)
  throw new Error('Unrecognised file: expected pi\'s auth.json, a .credentials.yaml, a flat JSON map of API keys, or a .env file.')
}

function parsePiAuth(entries) {
  const keys = {}
  const skipped = []
  for (const [provider, entry] of entries) {
    const ref = PI_PROVIDER_ENV[provider]
    if (entry.type === 'oauth') { skipped.push({ name: provider, reason: 'sign-in, not an API key' }); continue }
    if (entry.type !== 'api_key' || typeof entry.key !== 'string' || entry.key.trim() === '') { skipped.push({ name: provider, reason: `unrecognised entry (type ${JSON.stringify(entry.type ?? null)})` }); continue }
    if (ref === undefined) { skipped.push({ name: provider, reason: 'unknown pi provider: no credential name' }); continue }
    keys[ref] = entry.key.trim()
  }
  if (Object.keys(keys).length === 0 && skipped.length === 0) throw new Error('No provider entries found.')
  return { format: 'pi-auth', keys, skipped }
}

function parseEnvMap(entries) {
  const keys = {}
  const skipped = []
  for (const [name, value] of entries) {
    if (!REF_PATTERN.test(name)) { skipped.push({ name, reason: 'not a credential name (expected UPPER_SNAKE_CASE, e.g. OPENAI_API_KEY)' }); continue }
    if (value.trim() === '') { skipped.push({ name, reason: 'empty value' }); continue }
    keys[name] = value.trim()
  }
  return { format: 'env-map', keys, skipped }
}

function parseDotenv(text) {
  const keys = {}
  const skipped = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (m === null) { skipped.push({ name: line.slice(0, 40), reason: 'not a NAME=value line' }); continue }
    const name = m[1]
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '').trim()
    if (!REF_PATTERN.test(name)) { skipped.push({ name, reason: 'not a credential name (expected UPPER_SNAKE_CASE)' }); continue }
    if (value === '') { skipped.push({ name, reason: 'empty value' }); continue }
    keys[name] = value
  }
  if (Object.keys(keys).length === 0 && skipped.length === 0) throw new Error('No NAME=value lines found.')
  return { format: 'dotenv', keys, skipped }
}

/**
 * `$DSH_HOME/.credentials.yaml`, DSH's credentials-local store:
 *   version: 1
 *   records:
 *     <scope>/<id>:
 *       kind: grant | api-key
 *       payload: {…} | key: …
 *   refs:
 *     NAME_API_KEY: value
 * Only this shape (2-space indent, one scalar per line) — enough for the file
 * DSH writes, without shipping a YAML parser to the browser.
 */
function parseDshCredentials(text) {
  const keys = {}
  const skipped = []
  const lines = text.split(/\r?\n/)
  let section = ''
  let record = null // { name, kind, key }
  const flushRecord = () => {
    if (record === null) return
    const [scope, id] = record.name.includes('/') ? [record.name.slice(0, record.name.indexOf('/')), record.name.slice(record.name.indexOf('/') + 1)] : ['', record.name]
    if (scope === 'llm-pi-ai' && record.kind === 'api-key' && record.key) {
      const ref = PI_PROVIDER_ENV[id]
      if (ref) keys[ref] = record.key
      else skipped.push({ name: record.name, reason: 'unknown pi provider: no credential name' })
    } else if (scope === 'llm-pi-ai' && record.kind === 'grant') {
      skipped.push({ name: record.name, reason: 'sign-in (grant record), not an API key' })
    } else if (record.name !== 'client-connection/browser-session') {
      skipped.push({ name: record.name, reason: `${record.kind || 'record'} record, not an API key` })
    }
    record = null
  }
  for (const raw of lines) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    const top = /^(records|refs|version):\s*(.*)$/.exec(raw)
    if (top) { flushRecord(); section = top[1]; continue }
    if (section === 'refs') {
      const m = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(raw)
      if (!m) continue
      const value = unquote(m[2])
      if (!REF_PATTERN.test(m[1])) { skipped.push({ name: m[1], reason: 'not a credential name (expected UPPER_SNAKE_CASE)' }); continue }
      if (value === '') { skipped.push({ name: m[1], reason: 'empty value' }); continue }
      keys[m[1]] = value
    } else if (section === 'records') {
      const head = /^ {2}([^\s:][^:]*):\s*$/.exec(raw)
      if (head) { flushRecord(); record = { name: unquote(head[1]), kind: '', key: '' }; continue }
      const field = /^ {4}(kind|key):\s*(.*)$/.exec(raw)
      if (field && record) { if (field[1] === 'kind') record.kind = unquote(field[2]); else record.key = unquote(field[2]) }
    }
  }
  flushRecord()
  if (Object.keys(keys).length === 0 && skipped.length === 0) throw new Error('No refs or records found in this credentials file.')
  return { format: 'dsh-credentials', keys, skipped }
}

function unquote(value) {
  const v = String(value).trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  return v
}
