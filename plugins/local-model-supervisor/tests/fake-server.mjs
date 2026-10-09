/**
 * A stand-in for a local model server, for the tests: `node fake-server.mjs
 * <port>` answers `GET /v1/models` with 200 on 127.0.0.1:<port>.
 * FAKE_DELAY_MS delays listening; FAKE_NO_LISTEN=1 never listens;
 * FAKE_IGNORE_TERM=1 survives SIGTERM.
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2])
console.log(`fake model server pid ${process.pid} port ${port}`)
if (process.env.FAKE_IGNORE_TERM === '1') process.on('SIGTERM', () => console.log('ignoring SIGTERM'))
const server = createServer((request, response) => {
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'fake' }] }))
  } else {
    response.writeHead(404)
    response.end()
  }
})
if (process.env.FAKE_NO_LISTEN === '1') setInterval(() => {}, 1_000)
else setTimeout(() => server.listen(port, '127.0.0.1'), Number(process.env.FAKE_DELAY_MS ?? 0))
