// Copies KaTeX CSS + font files into media/ so the webview can load them as
// same-origin resources under the CSP. Run as part of `bun run build`.
import { cpSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const katexDist = join(root, 'node_modules', 'katex', 'dist')
const mediaDir = join(root, 'media')

mkdirSync(join(mediaDir, 'fonts'), { recursive: true })

const cssSrc = join(katexDist, 'katex.min.css')
if (!existsSync(cssSrc)) {
  console.error('katex.min.css not found at', cssSrc, '- did you run bun install?')
  process.exit(1)
}
cpSync(cssSrc, join(mediaDir, 'katex.min.css'))
cpSync(join(katexDist, 'fonts'), join(mediaDir, 'fonts'), { recursive: true })

console.log('Copied KaTeX css + fonts into media/')
