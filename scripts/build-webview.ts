// Builds the webview: media/webview.js (+ webview.css), and the two engines that
// load on demand, media/katex.js and media/mermaid.js. Usage:
//   bun run scripts/build-webview.ts [--watch] [--dev]
// Needs the esbuild API (not the CLI) because three plugins rewrite imports the
// same way the app's vite.config.ts does:
//   - markdown-it's `entities` table (~21 KB gzip) -> the browser's decoder
//   - @tiptap/extension-mathematics' static `katex` import -> a stub that routes
//     rendering through the lazy loader, so KaTeX stays out of webview.js
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')
const dev = watch || process.argv.includes('--dev')

const entitiesShim: esbuild.Plugin = {
  name: 'quill-markdown-it-entities',
  setup(build) {
    build.onResolve({ filter: /^entities$/ }, args =>
      /[\\/]markdown-it[\\/]/.test(args.importer)
        ? { path: join(root, 'webview-src/vendor/markdown/entities-shim.ts') }
        : null,
    )
  },
}

const katexLazy: esbuild.Plugin = {
  name: 'quill-katex-lazy',
  setup(build) {
    build.onResolve({ filter: /^katex$/ }, args =>
      /[\\/]@tiptap[\\/]extension-mathematics[\\/]/.test(args.importer)
        ? { path: join(root, 'webview-src/vendor/katex-lazy.ts') }
        : null,
    )
  },
}

const common: esbuild.BuildOptions = {
  bundle: true,
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  minify: !dev,
  sourcemap: dev,
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
}

const builds: esbuild.BuildOptions[] = [
  {
    ...common,
    entryPoints: [join(root, 'webview-src/index.ts')],
    outfile: join(root, 'media/webview.js'),
    plugins: [entitiesShim, katexLazy],
  },
  { ...common, entryPoints: [join(root, 'webview-src/engines/katex.ts')], outfile: join(root, 'media/katex.js') },
  { ...common, entryPoints: [join(root, 'webview-src/engines/mermaid.ts')], outfile: join(root, 'media/mermaid.js') },
]

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch()
} else {
  await Promise.all(builds.map(b => esbuild.build(b)))
}
