# Vendored editor core

Copied from the Quill app (https://github.com/ETM-Code/quill) at commit `72b30e8`
(`origin/main`). To re-sync, copy the same files from the app's `src/` and
re-apply the patches below.

Copied: `editor-setup.ts`, `icons.ts`, `images.ts`, `mermaid.ts`, `math-render.ts`,
`katex-lazy.ts`, `styles.css`, `markdown/`, `extensions/`, and from `ui/`: bubble menu,
find bar, image/link/math/mermaid popovers, link router, outline, popover, slash
menu, table controls, toast, and `views.css`.

Not copied (Tauri-only or replaced by VS Code): `main.ts` and `file-ops.ts` (replaced by
`../index.ts` and the extension host), `ui/source-view.ts` (VS Code has Open as Text),
`ui/print.ts`, `ui/drag-drop.ts`, `startup-files.ts`, and the app's tests.

## Local patches

| File | Change |
|---|---|
| `math-render.ts` | Loads KaTeX through `../lazy.ts` (a separate script, `media/katex.js`) instead of a dynamic `import()`. |
| `mermaid.ts`, `ui/mermaid-popover.ts` | Load Mermaid through `../lazy.ts` (`media/mermaid.js`). |
| `images.ts` | Removed the Tauri `convertFileSrc` fallback; the adapter supplies `resolveLocal`. |
| `ui/link-router.ts` | Removed the Tauri host actions; the extension carries out link targets. |
| `ui/outline.ts` | Removed the source-view hooks. |
| `ui/image-popover.ts` | Host-neutral labels ("Reveal in Explorer", "Open image"). |
| `ui/views.css` | Dropped the source-mode and print rules. |

The build (`scripts/build-webview.ts`) also applies the app's `vite.config.ts` plugins: the
`entities` shim for markdown-it and the `katex` stub for `@tiptap/extension-mathematics`.
