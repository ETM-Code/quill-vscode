// Copies the KaTeX stylesheet and fonts into media/ so the webview can load them
// as same-origin resources under the CSP. Run as part of `bun run build`.
//
// The webview is Chromium (Electron or a browser), which always loads woff2, so
// the stylesheet is trimmed to the woff2 source of each face and only the woff2
// font files are copied. That drops about 650 KB from the package.
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const katexDist = join(root, 'node_modules', 'katex', 'dist')
const mediaDir = join(root, 'media')

const cssSrc = join(katexDist, 'katex.min.css')
if (!existsSync(cssSrc)) {
  console.error('katex.min.css not found at', cssSrc, '- did you run bun install?')
  process.exit(1)
}

rmSync(join(mediaDir, 'fonts'), { recursive: true, force: true })
mkdirSync(join(mediaDir, 'fonts'), { recursive: true })

const css = readFileSync(cssSrc, 'utf8').replace(/,url\([^)]*\.(?:woff|ttf)\) format\("[^"]*"\)/g, '')
writeFileSync(join(mediaDir, 'katex.min.css'), css)

for (const f of readdirSync(join(katexDist, 'fonts'))) {
  if (f.endsWith('.woff2')) cpSync(join(katexDist, 'fonts', f), join(mediaDir, 'fonts', f))
}

console.log('Copied KaTeX css + woff2 fonts into media/')
