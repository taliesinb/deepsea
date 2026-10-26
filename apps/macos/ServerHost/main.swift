// The DeepSea server host: the main executable of a small background-only app
// bundle (`DeepSea[ <V>] Server.app`, bundle id `<variant name>.server`) that
// a variant's LaunchAgent starts in place of the bare Node binary
// (LAYOUT.md §6).
//
//   DeepSea Server.app/Contents/MacOS/deepsea-server-host <program> [args…]
//
// It spawns <program> (the relay) as a child and stays its parent until the
// child exits, forwarding signals. macOS attributes a process's privacy (TCC)
// requests to its *responsible* process — for a launchd job, the job's own
// executable — and children inherit it through posix_spawn. With this binary
// as the job, every agent subprocess (bash, python, osascript…) is attributed
// to the bundle, so macOS shows its normal consent prompts ("DeepSea Personal
// Server would like to access…") naming the bundle, and Full Disk Access can
// be granted to it in System Settings. Exec'ing instead of spawning would hand
// the identity back to Node.

import Darwin
import Dispatch

let arguments = Array(CommandLine.arguments.dropFirst())
guard let program = arguments.first else {
  fputs("usage: deepsea-server-host <program> [args…]\n", stderr)
  exit(64)
}

let forwarded: [Int32] = [SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2]

// The child starts with default dispositions and an empty mask whatever ours are.
var attributes: posix_spawnattr_t? = nil
posix_spawnattr_init(&attributes)
var defaults = sigset_t()
sigemptyset(&defaults)
for signal in forwarded + [SIGPIPE, SIGCHLD] { sigaddset(&defaults, signal) }
var emptyMask = sigset_t()
sigemptyset(&emptyMask)
posix_spawnattr_setsigdefault(&attributes, &defaults)
posix_spawnattr_setsigmask(&attributes, &emptyMask)
posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))

var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) } + [nil]
var child: pid_t = 0
let spawned = posix_spawnp(&child, program, nil, &attributes, &argv, environ)
posix_spawnattr_destroy(&attributes)
if spawned != 0 {
  fputs("deepsea-server-host: cannot start \(program): \(String(cString: strerror(spawned)))\n", stderr)
  exit(127)
}

let target = child
var sources: [DispatchSourceSignal] = []
for signal in forwarded {
  Darwin.signal(signal, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signal, queue: .main)
  source.setEventHandler { kill(target, signal) }
  source.resume()
  sources.append(source)
}

DispatchQueue.global().async {
  var status: Int32 = 0
  while waitpid(target, &status, 0) == -1 && errno == EINTR {}
  let terminatingSignal = status & 0x7f
  exit(terminatingSignal == 0 ? (status >> 8) & 0xff : 128 + terminatingSignal)
}

dispatchMain()
