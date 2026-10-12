/**
 * Environment checks for the two browsers, phrased as things the person must
 * do.
 *
 * The model cannot install an app or flip a Safari setting; when a tool fails
 * for one of these reasons the useful error says so and gives the model a
 * precise instruction to relay, instead of a raw WebDriver or CDP message
 * that invites retries.
 *
 * Detection:
 * - Chrome: the app bundle (the usual install locations, then Spotlight by
 *   bundle id for a custom location). chrome-devtools-mcp reports a missing
 *   browser only indirectly ("Target closed" / "Failed to launch").
 * - Safari Technology Preview: the app bundle and its `safaridriver`. "Allow
 *   Remote Automation" cannot be read from a script (Safari keeps it in a
 *   secure per-user store that `defaults` does not see), so it is detected
 *   only from the WebDriver error text (`WebDriverErrorDomain Code=6` /
 *   "Allow remote automation") when a call fails.
 * - No GUI login session: both browsers need the window server. A server
 *   started over ssh or by a daemon has none; `safaridriver --mcp` then exits
 *   silently and Chrome crashes on launch, which reach the plugin only as
 *   "Connection closed" / "Target closed". `launchctl print gui/<uid>` tells
 *   the cases apart.
 */
import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Lead-in of every remedy: explicit, so the model relays rather than retries. */
export const ASK_USER = 'This needs the user to act on this machine (the assistant cannot do it): '

export const CHROME_INSTALL_REMEDY = `${ASK_USER}download and install Google Chrome from https://www.google.com/chrome/ (or \`brew install --cask google-chrome\`), open it once so macOS finishes its first launch, then retry. Until then use the safari_* tools if Safari Technology Preview is available.`

export const STP_INSTALL_REMEDY = `${ASK_USER}download and install Safari Technology Preview (release 247 or newer) from https://developer.apple.com/safari/technology-preview/, then in Safari Technology Preview enable Develop ▸ Developer Settings ▸ "Allow Remote Automation", and retry. Classic Safari cannot be used instead (its safaridriver has no MCP mode). Until then use the chrome_* tools if Google Chrome is available.`

export const STP_REMOTE_AUTOMATION_REMEDY = `${ASK_USER}enable "Allow Remote Automation" for Safari Technology Preview. From a terminal on this machine (admin password asked once, per macOS user): sudo "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver" --enable — or in STP choose Develop ▸ Developer Settings… and tick "Allow Remote Automation" (enable the Develop menu first under Settings ▸ Advanced if it is hidden). Then retry. Until then use the chrome_* tools if Google Chrome is available.`

const CHROME_BUNDLES = [
  '/Applications/Google Chrome.app',
  join(homedir(), 'Applications', 'Google Chrome.app'),
]

/**
 * Is Google Chrome installed? The usual bundle locations, then Spotlight by
 * bundle id (slower, so only as a fallback; the result is cached).
 * @returns {string | undefined} the bundle path when found.
 */
let chromeCache
export function findChrome() {
  if (chromeCache !== undefined) return chromeCache.path
  for (const path of CHROME_BUNDLES) {
    if (existsSync(join(path, 'Contents', 'MacOS', 'Google Chrome'))) { chromeCache = { path }; return path }
  }
  try {
    const found = execFileSync('/usr/bin/mdfind', ['kMDItemCFBundleIdentifier == com.google.Chrome'], { encoding: 'utf8', timeout: 3000 })
      .split('\n').map(line => line.trim()).find(line => line.endsWith('.app'))
    chromeCache = { path: found }
    return found
  } catch {
    chromeCache = { path: undefined }
    return undefined
  }
}

/** Forget the cached Chrome lookup (after the person installs it, the next call should see it). */
export function forgetChrome() { chromeCache = undefined }

/**
 * Is Safari Technology Preview installed with the driver the plugin needs?
 * @param {string} driverPath - configured safaridriver path.
 * @returns {'ok' | 'missing'}
 */
export function checkSafariTechnologyPreview(driverPath) {
  return existsSync(driverPath) ? 'ok' : 'missing'
}

/**
 * Does this process run inside a GUI login session (macOS)? Cached for 30 s:
 * a session appears when the person logs in and vanishes when they log out.
 * Not macOS: true (no window server to be missing).
 */
let guiCache
export function hasGuiSession() {
  if (process.platform !== 'darwin') return true
  if (guiCache !== undefined && Date.now() - guiCache.at < 30_000) return guiCache.value
  let value = true
  try {
    execFileSync('/bin/launchctl', ['print', `gui/${String(userInfo().uid)}`], { stdio: 'ignore', timeout: 3000 })
  } catch {
    value = false
  }
  guiCache = { at: Date.now(), value }
  return value
}

/**
 * Why a browser cannot open a window here, when this server has no GUI session.
 * @param {'chrome' | 'safari'} browser
 */
export function noGuiSessionRemedy(browser) {
  const user = userInfo().username
  const which = browser === 'safari' ? 'Safari Technology Preview (safaridriver --mcp exits at once, silently)' : 'Google Chrome'
  const alt = browser === 'safari'
    ? 'There is no headless Safari; the chrome_* tools work without a session only when the plugin runs chrome-headless-shell (chrome.headless with --executablePath to it in chrome.args).'
    : 'Without a session only chrome-headless-shell can run: chrome.headless with --executablePath to it in chrome.args. The safari_* tools cannot work here at all.'
  return `no GUI login session for the macOS account \`${user}\` on this machine, which ${which} needs to open a window. This DeepSea server was started outside a GUI login session (over ssh, or from a daemon), and a process does not join a session that starts later. ${ASK_USER}log the account \`${user}\` in on this Mac, then start DeepSea from inside that session and retry. ${alt}`
}

/**
 * Classify a failure from either browser server as an environment problem the
 * person must fix, or `undefined` when it is an ordinary tool error.
 * @param {'chrome' | 'safari'} browser
 * @param {string} message - the failure text.
 * @param {{ everOpened?: boolean }} [context] - whether this browser has served a window in this
 *   process (a launch-time "Target closed" on a browser that never worked means it cannot start,
 *   not that a page went away).
 * @returns {string | undefined} the remedy.
 */
export function environmentRemedy(browser, message, context = {}) {
  // A launch-time transport death without a GUI session is the session, whatever the browser says (usually nothing).
  if (/Connection closed|Target closed|Session closed|Failed to launch|could not launch|Bus error|not configured correctly or you need to authenticate/i.test(message) && !hasGuiSession()) {
    return noGuiSessionRemedy(browser)
  }
  if (browser === 'safari') {
    if (/Allow remote automation|Allow Remote Automation|not configured correctly or you need to authenticate/i.test(message)) return STP_REMOTE_AUTOMATION_REMEDY
    // Code=6 is WebDriver's generic "session not created"; only the Remote-Automation wording means that switch.
    if (/WebDriverErrorDomain Code=6/i.test(message) && !/Unable to launch a compatible Safari/i.test(message)) return STP_REMOTE_AUTOMATION_REMEDY
    if (/Unable to launch a compatible Safari/i.test(message)) return `${ASK_USER}Safari Technology Preview could not be launched for automation (WebDriver could not create a session). Open Safari Technology Preview once by hand on this Mac (it may be showing an update or first-launch dialog), quit it, then retry.`
    if (/no safaridriver at|safaridriver.*(ENOENT|not found)/i.test(message)) return STP_INSTALL_REMEDY
    return undefined
  }
  if (/Failed to launch the browser process|Could not find (?:Chrome|browser)|spawn .*Google Chrome.*ENOENT|Browser was not found/i.test(message)) {
    return findChrome() === undefined ? CHROME_INSTALL_REMEDY : `${ASK_USER}Google Chrome is installed but could not be launched for automation. Open Google Chrome once by hand (it may be showing a first-launch, update or permission dialog), quit it, then retry.`
  }
  if (context.everOpened !== true && /Target closed|Session closed|Connection closed/i.test(message)) {
    if (findChrome() === undefined) return CHROME_INSTALL_REMEDY
    return `${ASK_USER}Google Chrome is installed but its automation session closed immediately on first launch. Open Google Chrome once by hand (dismiss any first-launch, default-browser or permission dialog), quit it, then retry.`
  }
  return undefined
}
