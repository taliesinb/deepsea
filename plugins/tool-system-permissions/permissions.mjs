/**
 * permissions.mjs — the permission classes `seek_system_permission` knows,
 * how each is named, probed, triggered and shown in System Settings.
 *
 * Pure data and parsing, no I/O: the probes themselves are macos/probe.jxa
 * (run by macos.mjs), the fake ones fake.mjs.
 *
 * A class has:
 *   id        what the model passes (`screen-recording`, `automation:com.apple.systemevents`)
 *   name      English name, as System Settings' list calls the pane
 *   service   the TCC service tccd logs it under (stale-row detection)
 *   anchor    the pane's anchor: x-apple.systempreferences:com.apple.preference.security?<anchor>
 *   grant     what Grant does, the one window the person deals with:
 *               'dialog'  macOS's own Allow / Don't Allow is the grant
 *                         (Microphone, Camera, Automation): the first Grant
 *                         fires the trigger alone; Don't Allow records a
 *                         refusal the probe sees (status denied)
 *               'pane'    the probe itself makes tccd list the app, switched
 *                         off (Accessibility: AXIsProcessTrusted; Full Disk
 *                         Access: the refused read), so Grant opens the pane
 *               'alert'   nothing lists the app silently (Screen Recording,
 *                         Input Monitoring): the first Grant on a never-asked
 *                         row calls the request API alone, whose alert ("…
 *                         would like to …", Open System Settings / Deny) lists
 *                         the app and leads to the pane; its Deny is not
 *                         recorded. A later Grant opens the pane, with the app
 *                         in Finder to drag in if it is still not listed
 *             Accessibility's request alert is never raised: its trust check
 *             lists the app silently, so the pane alone does.
 */

/** Pane URL prefix: System Settings' Privacy & Security extension, by its legacy pref-pane id. */
export const PANE_URL_PREFIX = 'x-apple.systempreferences:com.apple.preference.security?'

/** Statuses a probe reports. */
export const STATUSES = Object.freeze(['granted', 'denied', 'not-determined', 'not-granted', 'stale', 'restricted', 'not-running', 'unavailable', 'unknown'])

/**
 * Statuses no amount of waiting can turn into a grant from this tool:
 * restricted (MDM or parental policy), unavailable (the target app is not
 * installed, or the class does not exist on this system).
 */
export const UNATTAINABLE = Object.freeze(new Set(['restricted', 'unavailable']))

/** The fixed classes, in the order the README and the description list them. */
export const CLASSES = Object.freeze([
  { id: 'screen-recording', name: 'Screen Recording', service: 'kTCCServiceScreenCapture', anchor: 'Privacy_ScreenCapture', grant: 'alert',
    aliases: ['screen', 'screen-capture', 'screencapture', 'screenshot'] },
  { id: 'accessibility', name: 'Accessibility', service: 'kTCCServiceAccessibility', anchor: 'Privacy_Accessibility', grant: 'pane',
    aliases: ['ax', 'ui-automation'] },
  { id: 'microphone', name: 'Microphone', service: 'kTCCServiceMicrophone', anchor: 'Privacy_Microphone', grant: 'dialog',
    aliases: ['mic', 'audio'] },
  { id: 'camera', name: 'Camera', service: 'kTCCServiceCamera', anchor: 'Privacy_Camera', grant: 'dialog',
    aliases: ['video'] },
  { id: 'input-monitoring', name: 'Input Monitoring', service: 'kTCCServiceListenEvent', anchor: 'Privacy_ListenEvent', grant: 'alert',
    aliases: ['listen-event', 'keyboard-monitoring', 'input'] },
  { id: 'full-disk-access', name: 'Full Disk Access', service: 'kTCCServiceSystemPolicyAllFiles', anchor: 'Privacy_AllFiles', grant: 'pane',
    aliases: ['fda', 'all-files', 'disk'] },
])

/** Automation (Apple events) of one target app: `automation:<bundle id>` or one of these names. */
export const AUTOMATION_SERVICE = 'kTCCServiceAppleEvents'
export const AUTOMATION_ANCHOR = 'Privacy_Automation'
export const AUTOMATION_TARGETS = Object.freeze({
  'system-events': { bundleId: 'com.apple.systemevents', name: 'System Events' },
  finder: { bundleId: 'com.apple.finder', name: 'Finder' },
  safari: { bundleId: 'com.apple.Safari', name: 'Safari' },
  'safari-technology-preview': { bundleId: 'com.apple.SafariTechnologyPreview', name: 'Safari Technology Preview' },
  terminal: { bundleId: 'com.apple.Terminal', name: 'Terminal' },
  music: { bundleId: 'com.apple.Music', name: 'Music' },
  mail: { bundleId: 'com.apple.mail', name: 'Mail' },
  messages: { bundleId: 'com.apple.MobileSMS', name: 'Messages' },
  notes: { bundleId: 'com.apple.Notes', name: 'Notes' },
  calendar: { bundleId: 'com.apple.iCal', name: 'Calendar' },
  reminders: { bundleId: 'com.apple.reminders', name: 'Reminders' },
  photos: { bundleId: 'com.apple.Photos', name: 'Photos' },
  xcode: { bundleId: 'com.apple.dt.Xcode', name: 'Xcode' },
  'google-chrome': { bundleId: 'com.google.Chrome', name: 'Google Chrome' },
})

/** Bundle ids are reverse-DNS: letters, digits, dots, hyphens. */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/

/** Model-facing failure of the argument parser. */
export class PermissionNameError extends Error {}

/** Lowercase, spaces and underscores to hyphens: "Screen Recording" → "screen-recording". */
function normalize(name) {
  return String(name).trim().toLowerCase().replace(/[\s_]+/g, '-')
}

/**
 * One permission class from what the model wrote.
 * @param {string} raw
 * @returns {{ id: string, name: string, service: string, anchor: string, grant: 'dialog' | 'pane' | 'alert', target?: { bundleId: string, name: string } }}
 */
export function parsePermission(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new PermissionNameError('each permission must be a non-empty string')
  const text = raw.trim()
  const colon = text.indexOf(':')
  if (colon !== -1 && normalize(text.slice(0, colon)) === 'automation') {
    const target = text.slice(colon + 1).trim()
    const known = AUTOMATION_TARGETS[normalize(target)]
      ?? Object.values(AUTOMATION_TARGETS).find(t => t.bundleId.toLowerCase() === target.toLowerCase())
    if (known !== undefined) return automationClass(known.bundleId, known.name)
    if (BUNDLE_ID.test(target)) return automationClass(target, target)
    throw new PermissionNameError(`"${raw}": automation needs a target app, as automation:<bundle id> (automation:com.apple.systemevents) or one of ${Object.keys(AUTOMATION_TARGETS).map(k => `automation:${k}`).join(', ')}`)
  }
  const key = normalize(text)
  if (key === 'automation') throw new PermissionNameError('"automation" needs a target app: automation:<bundle id>, e.g. automation:com.apple.systemevents')
  const found = CLASSES.find(c => c.id === key || c.aliases.includes(key) || normalize(c.name) === key)
  if (found === undefined) throw new PermissionNameError(`unknown permission "${raw}"; known: ${[...CLASSES.map(c => c.id), 'automation:<bundle id>'].join(', ')}`)
  const { aliases: _aliases, ...rest } = found
  return { ...rest }
}

function automationClass(bundleId, name) {
  return { id: `automation:${bundleId}`, name: `Automation: ${name}`, service: AUTOMATION_SERVICE, anchor: AUTOMATION_ANCHOR, grant: 'dialog', target: { bundleId, name } }
}

/** Longest justification accepted (one sentence). */
export const JUSTIFICATION_MAX = 200

/**
 * One request's justification: the sentence the person reads beside the
 * permission. Required, one line, at most JUSTIFICATION_MAX characters.
 * @param {unknown} raw
 * @param {string} permission - for the error message.
 */
export function parseJustification(raw, permission) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new PermissionNameError(`"${permission}" needs a justification: one sentence saying what you will do with it, e.g. "To take screenshots of the prototype."`)
  const text = raw.trim()
  if (/[\r\n]/.test(text)) throw new PermissionNameError(`the justification for "${permission}" must be one sentence on one line`)
  if (text.length > JUSTIFICATION_MAX) throw new PermissionNameError(`the justification for "${permission}" is ${text.length} characters; keep it to one sentence of at most ${JUSTIFICATION_MAX}`)
  return text
}

/**
 * The classes a call asks for, in its order, duplicates dropped (the first
 * one's justification wins). Each entry is `{ permission, justification }`;
 * with `requireJustification: false` a bare name is accepted too (internal
 * uses: rendering a stored call).
 * @param {unknown} list
 * @param {{ requireJustification?: boolean }} [options]
 */
export function parsePermissions(list, { requireJustification = false } = {}) {
  if (typeof list === 'string' && !requireJustification) list = [list]
  if (!Array.isArray(list) || list.length === 0) throw new PermissionNameError('permissions must be a non-empty list of { permission, justification }')
  const seen = new Set()
  const classes = []
  for (const entry of list) {
    const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    if (!isObject && requireJustification) throw new PermissionNameError(`each permission must be an object { permission, justification }, got ${JSON.stringify(entry)}`)
    const name = isObject ? entry.permission : entry
    const cls = parsePermission(name)
    const justification = isObject && (requireJustification || entry.justification !== undefined) ? parseJustification(entry.justification, String(name)) : undefined
    if (seen.has(cls.id)) continue
    seen.add(cls.id)
    classes.push(justification === undefined ? cls : { ...cls, justification })
  }
  return classes
}

/** The System Settings URL of a class's pane. */
export function paneUrl(cls) {
  return `${PANE_URL_PREFIX}${cls.anchor}`
}

/** The pane's name in System Settings ▸ Privacy & Security, for the model's text. */
export function paneName(cls) {
  switch (cls.anchor) {
    case 'Privacy_ScreenCapture': return 'Screen & System Audio Recording'
    // Renamed in macOS 27 (System Settings' ACCESSIBILITY string); same anchor.
    case 'Privacy_Accessibility': return 'Device Control and Data Access (Accessibility before macOS 27)'
    case 'Privacy_ListenEvent': return 'Input Monitoring'
    case 'Privacy_AllFiles': return 'Full Disk Access'
    case 'Privacy_Automation': return 'Automation'
    default: return cls.name
  }
}

/**
 * What the user has to do in System Settings for a class in a given status,
 * addressed to the model (it relays this to the user). `app` is the name of
 * the row: the app macOS charges the agent's commands to.
 */
export function instructions(cls, status, app) {
  const row = `"${app}"`
  const pane = `System Settings ▸ Privacy & Security ▸ ${paneName(cls)}`
  if (status === 'stale') {
    return `${pane} has a stale ${row} entry (left by an earlier build of that app; it may even look switched on): `
      + `select it, remove it with the − button, then press Grant on the card again and switch the new ${row} entry on.`
  }
  if (status === 'restricted') return `${cls.name} is restricted by a configuration profile or Screen Time on this Mac; the user cannot grant it in System Settings.`
  if (status === 'unavailable') return cls.target ? `${cls.target.name} (${cls.target.bundleId}) is not installed on this Mac.` : `${cls.name} is not available on this Mac.`
  if (cls.target) {
    return status === 'not-running'
      ? `${cls.target.name} was not running, so its permission could not be checked or asked for; it is ${pane} ▸ ${row} ▸ ${cls.target.name}.`
      : `In ${pane}, under ${row}, switch ${cls.target.name} on (macOS adds it there after the user answers its prompt).`
  }
  const where = `it is "${app}.app" in ~/Library/Application Support/io.github.taliesinb.deepsea.<variant>/`
  if (cls.grant === 'alert' && status !== 'denied') return `Answer macOS's alert with Open System Settings and switch ${row} on in ${pane}; if it is not listed there, add it with + (${where}).`
  if (cls.grant === 'pane') return `In ${pane}, switch ${row} on; if it is not listed, add it with + (${where}).`
  if (cls.grant === 'dialog') return status === 'denied' ? `In ${pane}, switch ${row} on.` : `Answer macOS's prompt with Allow, or switch ${row} on in ${pane}.`
  return `In ${pane}, switch ${row} on.`
}
