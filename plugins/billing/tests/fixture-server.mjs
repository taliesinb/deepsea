// Standalone mock UI only: never starts DSH or loads a DSH home/profile.
// Run node tests/fixture-server.mjs, then use /fixture/ and window.billingFixture.run().
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  absWorkingDir: root, entryPoints: ['tests/fixture.tsx'], bundle: true,
  format: 'iife', platform: 'browser', jsx: 'automatic', write: false,
  loader: { '.css': 'text' },
  alias: {
    react: fileURLToPath(new URL('../node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('../node_modules/react-dom', import.meta.url)),
    '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./fixture-platform.ts', import.meta.url)),
  },
})
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Billing fixture</title></head><body><div id="root"></div><script src="client.js"></script></body></html>'
const server = createServer((request, response) => {
  if (request.url === '/fixture/client.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(result.outputFiles[0].text) }
  else if (request.url === '/fixture/') { response.setHeader('Content-Type', 'text/html'); response.end(html) }
  else { response.statusCode = 404; response.end() }
})
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => console.log(`Billing fixture http://127.0.0.1:${server.address().port}/fixture/`))
