/**
 * @deepsea/message-stash, host half: nothing. The plugin lives in the browser
 * (src/client, lib/client.js); this module exists so the loader row resolves
 * and the server serves the `./client` bundle (package.json `dsh.client`).
 * The stash itself is in the browser's localStorage.
 */

export const name = 'deepsea-message-stash'

export function apply() {}
