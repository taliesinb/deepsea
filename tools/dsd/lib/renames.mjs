/**
 * Plugins renamed since their first release, old directory → new directory
 * (package `@deepsea/<dir>`, row id `deepsea-<dir>`; plugins/AGENTS.md →
 * Names). A migration table: homes, patches, variant configurations and
 * older builds still carry the old names, so dsd reads them through this
 * table (lib/plugins.mjs). The old names appear nowhere else.
 */
export const PLUGIN_RENAMES = Object.freeze({
  'scripted-model': 'llm-scripted',
  'server-log': 'host-server-log',
  'test-driver': 'dev-test-driver',
  'dash-docsets': 'tool-dash-docsets',
  'fs-tools': 'tool-fs-batch',
  'session-introspect': 'tool-transcripts',
  tools: 'command-tools',
  wait: 'tool-wait',
  ask: 'command-ask',
  billing: 'llm-billing',
  'brand-kit': 'ui-brand-kit',
  'variant-identity': 'ui-variant-identity',
  browser: 'tool-browser',
  'enforce-model-preset': 'preset-per-model',
  'local-model-supervisor': 'llm-local-servers',
  'no-global-tools': 'preset-chat-only',
  'prompt-excision': 'llm-prompt-excision',
  'remote-workspaces': 'workspace-remote',
  'chat-title': 'tool-rename-chat',
  'numbered-switching': 'ui-numbered-switching',
  'session-reference-picker': 'ui-session-reference-picker',
  'backup-restore': 'host-backup',
  'export-sessions': 'session-export',
  'import-api-keys': 'command-import-api-keys',
  'import-sessions': 'session-import',
  reboot: 'command-reboot',
  'phone-ui': 'ui-phone',
  'reload-on-restart': 'ui-reload-on-restart',
  'settings-shortcut': 'ui-settings-entry',
  'transcript-grace-margin': 'ui-transcript-margin',
  login: 'llm-sign-in',
  tailscale: 'host-tailscale',
})

const FORMER = new Map(Object.entries(PLUGIN_RENAMES).map(([old, current]) => [current, old]))

/** A plugin's current directory name: itself, or what an old name became. */
export const currentName = name => PLUGIN_RENAMES[name] ?? name

/** The name a plugin had before it was renamed, if it was. */
export const formerName = name => FORMER.get(name)

/** Whether a plugin directory name (current or old) is the plugin `current`. */
export const isPlugin = (name, current) => currentName(name) === current

/** A row id `deepsea-<old>` as `deepsea-<new>`; any other row id as it is. */
export function currentRowId(id) {
  const m = /^deepsea-(.+)$/.exec(id)
  return m && Object.hasOwn(PLUGIN_RENAMES, m[1]) ? `deepsea-${PLUGIN_RENAMES[m[1]]}` : id
}

/** A package `@deepsea/<old>` as `@deepsea/<new>`; any other package as it is. */
export function currentPackage(name) {
  const m = /^@deepsea\/(.+)$/.exec(name)
  return m && Object.hasOwn(PLUGIN_RENAMES, m[1]) ? `@deepsea/${PLUGIN_RENAMES[m[1]]}` : name
}

/** A home-relative path `plugins/<old>[/…]` as `plugins/<new>[/…]`; any other path as it is. */
export function currentStatePath(path) {
  const m = /^plugins\/([^/]+)(\/.*)?$/.exec(path)
  return m && Object.hasOwn(PLUGIN_RENAMES, m[1]) ? `plugins/${PLUGIN_RENAMES[m[1]]}${m[2] ?? ''}` : path
}
