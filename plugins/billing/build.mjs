import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const outfile = process.argv.find(arg => arg.startsWith('--outfile='))?.slice(10) ?? 'lib/client.js'
await build({
  absWorkingDir: root,
  entryPoints: ['client.tsx'], outfile,
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic',
  loader: { '.css': 'text' },
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
