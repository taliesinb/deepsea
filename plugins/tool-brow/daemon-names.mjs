/**
 * Every name of the brow daemon this plugin uses, in one place:
 * its command, the installed app and its LaunchAgent, its default home, its
 * environment variables. They are
 * the daemon's names, not this plugin's (the plugin's own package, row ids,
 * routes, service and `brow` config key are DeepSea names, defined
 * where they are used), so a renamed daemon is a change of this file alone.
 */

/** `<command> start` starts a daemon (a name on PATH; the default of `brow.command`). */
export const DAEMON_COMMAND = 'brow'

/** The installed app (macOS), as people know it. */
export const APP_NAME = 'Brow.app'

/** Its bundle id (LaunchServices: `open -g -b`), also the name of the default home's directory on macOS. */
export const APP_BUNDLE_ID = 'io.github.taliesinb.brow'

/** The per-user LaunchAgent that runs the installed app's daemon on the default home's socket. */
export const LAUNCH_AGENT_LABEL = 'io.github.taliesinb.brow'

/** The default home's directory name off macOS: `$XDG_STATE_HOME/<it>` (on macOS it is the bundle id, in ~/Library/Application Support). */
export const XDG_NAME = 'brow'

/** The daemon's environment variables: its home, its socket, a JSON configuration merged over `<home>/config.json`. */
export const ENV_HOME = 'BROW_HOME'
export const ENV_SOCKET = 'BROW_SOCKET'
export const ENV_CONFIG = 'BROW_CONFIG'
