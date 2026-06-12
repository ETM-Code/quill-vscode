# Quill for VSCode

A VSCode port of [Quill](https://github.com/ETM-Code/quill), the Notion-style WYSIWYG
markdown editor. Open any `.md` or `.markdown` file as a real document: headings, tables,
task lists, LaTeX math (KaTeX), and syntax-highlighted code blocks, edited in rich text
and saved as plain markdown.

This extension reuses Quill's editor frontend (Tiptap / ProseMirror with the Tiptap
Markdown extension) inside a VSCode `CustomTextEditorProvider`. VSCode owns the document:
dirty state, undo/redo, save, and hot-exit all work at the `TextDocument` level. The
webview serializes its ProseMirror document back to markdown on edit, and reloads when the
document changes outside the editor.

## Features

- WYSIWYG markdown editing: headings, bold/italic/underline/strike, lists, blockquotes,
  inline code, links.
- GFM tables, task lists (`- [ ]`), horizontal rules.
- LaTeX math with KaTeX: inline `$...$` and block `$$...$$`, click to edit in a popover.
- Code blocks with a language picker, copy button, and syntax highlighting.
- Bubble (selection) menu, `/` slash menu, find & replace (Cmd/Ctrl+F), link popover (Cmd/Ctrl+K).
- Follows the active VSCode color theme.

## Using it

`.md` files still open in the normal text editor by default (the custom editor is
registered with `priority: "option"` so it never hijacks your files). To open a file as a
Quill document:

- Right-click the file in the Explorer, choose **Open With...**, then **Quill (WYSIWYG)**, or
- With the file focused, run the command **Quill: Open with Quill (WYSIWYG)** from the
  command palette.

## Develop / debug

Requires [bun](https://bun.sh) and VSCode.

```bash
bun install
bun run build        # bundles the extension + webview, copies KaTeX assets
```

Then press **F5** in VSCode (the "Run Extension" launch config) to open an Extension
Development Host. Open a markdown file there with "Open With... -> Quill (WYSIWYG)".

For an incremental loop, run `bun run watch:ext` and `bun run watch:webview` in two
terminals, then F5.

## Test

```bash
bun run pretest      # build + compile the integration tests
bun run test         # downloads a headless VSCode and runs the @vscode/test-electron suite
```

The integration suite opens a real `.md` file with the custom editor in headless VSCode and
asserts: the webview activates and renders the Tiptap document; headings, a table, a task
list, a code block, and KaTeX-rendered inline math are all present; loaded markdown
round-trips faithfully; a webview edit updates the underlying `TextDocument` and
re-serializes to valid markdown; and an external document change reloads the webview.

## Package

```bash
bun run build
bun run package      # produces quill-vscode-<version>.vsix
```

## How the port works

- **Reused verbatim** from the source repo (under `webview-src/vendor/`): `editor-setup.ts`
  (Tiptap extensions, lazy lowlight grammars, chunked markdown parse, clipboard),
  `icons.ts`, `styles.css`, and all of `ui/` (bubble menu, slash menu, link/math popovers,
  find bar, toasts). These have no host coupling, so updates from upstream are a straight copy.
- **Written new**: `webview-src/index.ts` (the VSCode host adapter, replacing the source
  repo's Tauri-coupled `main.ts` + `file-ops.ts`), `webview-src/theme.css` (maps the editor
  palette onto `--vscode-*` theme variables), and `src/extension.ts` (the
  `CustomTextEditorProvider`).
- **Markdown sync**: whole-document `WorkspaceEdit` replacement on edit (debounced), and a
  full webview reload on external change. No hand-rolled incremental ProseMirror<->document
  diffing.
- **CSP**: strict policy with a per-load script nonce. The bundled JS and CSS, KaTeX CSS,
  and KaTeX fonts all load as same-origin webview resources via `asWebviewUri()`. KaTeX CSS
  is linked (not inlined) so its relative `url(fonts/...)` references resolve correctly.
  The lowlight grammars are bundled inline (esbuild IIFE), so they need no runtime fetch
  under the CSP.

## License

MIT
