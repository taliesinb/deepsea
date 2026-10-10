/**
 * @deepsea/settings-shortcut, host half: nothing. The plugin lives in the
 * browser (src/client, lib/client.js); this module exists so the loader row
 * resolves and the server serves the `./client` bundle (package.json
 * `dsh.client`).
 */

export const name = 'deepsea-settings-shortcut'

export function apply() {}
