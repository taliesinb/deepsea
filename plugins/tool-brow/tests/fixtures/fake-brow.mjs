#!/usr/bin/env node
// A stand-in for `brow start`: starts the fake daemon (../fake-daemon.mjs) detached on
// $BROW_SOCKET (or $BROW_HOME/run/daemon.sock) and returns, as the real command does.
// `serve` is the daemon process itself; it exits on daemon.shutdown, or after 20 s in any case.
// FAKE_START_FAIL=1 makes `start` fail the way a broken install would.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeDaemon } from '../fake-daemon.mjs'

const command = process.argv[2]
const socket = process.env.BROW_SOCKET || join(process.env.BROW_HOME ?? '/nonexistent', 'run', 'daemon.sock')

if (command === 'start') {
  if (process.env.FAKE_START_FAIL === '1') {
    process.stderr.write('brow: cannot start: fake failure\n')
    process.exit(3)
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  process.stdout.write(`started: pid ${child.pid}\n`)
} else if (command === 'serve') {
  setTimeout(() => process.exit(0), 20_000).unref()
  const keepAlive = setInterval(() => {}, 1000)
  await startFakeDaemon({ socket, pid: process.pid, onShutdown: () => { clearInterval(keepAlive); process.exit(0) } })
} else {
  process.stderr.write(`usage: fake-brow.mjs start\n`)
  process.exit(2)
}
