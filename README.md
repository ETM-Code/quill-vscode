# Quill Markdown Editor

Open any markdown file as a real document, right inside VS Code.

Your AI agents write markdown all day, and most of it lands here in VS Code: architecture docs, research, plans, reports. Then you open the file and it is raw source. A table is a wall of pipes and dashes. Math is LaTeX you decode in your head (and sometimes get wrong). An image is a link you have to open somewhere else. Quill renders any `.md` as a clean, editable document, the way ChatGPT renders it but local and inside your editor, and saves it straight back to plain markdown.

![Quill in VS Code](media/screenshot.png)

<!-- MAINTAINER: add a real screenshot or GIF at media/screenshot.png (a rendered .md document with a table, math, and a code block is ideal). Do not ship a fabricated image. -->

## Features

**Safe to open and save**

- **Unedited text is written back byte for byte.** Quill keeps the original source of each block, so opening a file and editing one paragraph never rewrites the rest. That covers blank-line runs, a missing final newline, CRLF line endings, `<API_KEY>` style placeholders, escaped pipes in tables, `~~~` fences, nested lists and link reference definitions.
- **External changes.** VS Code owns the file. Undo, save and hot exit work as in any editor, and the view reloads when the file changes outside Quill.

**Writing**

- **WYSIWYG markdown.** Headings, bold, italic, underline, strikethrough, highlight (`==x==`), `<sub>`, `<sup>`, `<kbd>`, lists, quotes, inline code and links.
- **Beyond CommonMark.** Front matter shows as a collapsed Properties block. Footnotes, GitHub-style callouts (`> [!NOTE]`, with labels), `<details>` with editable content and raw HTML (kept as written, shown sanitised) all round-trip.
- **Tables.** GFM tables render and edit inline. Set column alignment, add rows and columns, and move or delete them.
- **Task lists.** `- [ ]` checkboxes, clickable.
- **LaTeX math (KaTeX).** Inline `$E=mc^2$` and block `$$...$$`. Click an equation to edit it with a live preview. Shift+Cmd+M (Shift+Ctrl+M elsewhere) or the sigma button in the selection menu inserts inline math.
- **Mermaid diagrams.** ` ```mermaid ` fences render as diagrams; click one to edit the source.
- **Images.** Paste, drop or insert an image into a saved document and it is written to `assets/` next to the file. Click an image for a popover (alt text, size, open, reveal in Explorer, copy path) and drag its corner to resize.
- **Code blocks.** Syntax highlighting, a language picker and a copy button. Copying code gives the raw text.
- **Slash menu, selection menu, find and replace.** Type `/` on an empty line for blocks. Select text for a formatting menu. Cmd/Ctrl+F finds, Cmd/Ctrl+Alt+F replaces, Cmd/Ctrl+K links the selection.
- **Outline.** Shift+Cmd+O (Shift+Ctrl+O elsewhere), or the button at the top right, opens a heading outline you can jump from.
- **Links that work.** Click a link for a popover, Cmd/Ctrl-click to open it. Web links open in the browser, `.md` links open in Quill (resolved against the document's folder), `#anchor` links scroll to the heading, and other local files open in their default app. Programs and scripts ask first.
- **Copy and paste.** Copying anything but code puts markdown and rich HTML on the clipboard. "Copy as Plain Text" (Alt+Shift+Cmd/Ctrl+C) copies the rendered text with no markup. Pasting markdown recreates rich blocks, and code and tables pasted from VS Code, spreadsheets (TSV/CSV) and chat apps arrive as code blocks and tables.
- **No autocorrect.** Autocorrect, auto-capitalisation and typographic replacements (arrows, curly quotes, dashes) are off, so commands and flags are not rewritten as you type.
- **Theme-aware.** Follows your active VS Code color theme.

## Switching between Quill and source

A markdown file is still source as often as it is a document, so Quill makes the switch one click either way and never hijacks your files.

**Title-bar buttons.** When a `.md` is open as text, an "Open in Quill" button (book icon) appears in the editor's title bar. When a Quill document is focused, that button becomes "Open as Text" (code icon) to drop back to source.

**Commands** (Command Palette):

- `Quill: Open with Quill (WYSIWYG)` reopens the active file as a Quill document.
- `Quill: Open as Text (View Source)` reopens the active file in the built-in text editor.

`Cmd/Ctrl+/` also opens the text editor while a Quill document is focused. `Quill: Open with Quill` is unbound by default; to bind it, open Keyboard Shortcuts, search for the command, and assign a key. VS Code's own built-in `View: Reopen Editor With...` (`workbench.action.reopenWithEditor`) also lists Quill alongside the text editor.

**Sticky default (`quill.rememberLastEditorChoice`, on by default).** Whichever editor you last used for a markdown file becomes the default for opening `.md` and `.markdown` files. Open one with Quill and the next markdown file opens in Quill; open one as text and the next opens as text, until you switch again.

Under the hood this keeps VS Code's built-in `workbench.editorAssociations` setting in sync, touching only the `*.md` and `*.markdown` entries (any other associations you have set are left alone). To turn it off and manage associations yourself, set:

```jsonc
// settings.json
"quill.rememberLastEditorChoice": false
```

With it off, Quill stays a non-default option: `.md` opens in the text editor unless you explicitly choose Quill (via the title-bar button, a command, or `Open With...`).

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `quill.rememberLastEditorChoice` | boolean | `true` | Make whichever editor you last used for a markdown file the default for `.md` / `.markdown`, by keeping the built-in `workbench.editorAssociations` setting in sync. Turn off to leave associations untouched. |

## Keyboard shortcuts

VS Code receives every keystroke in a webview, so a shortcut the editor handles can also trigger a VS Code command (Cmd+B toggles the sidebar, Shift+Cmd+M opens Problems). Quill contributes keybindings, active only while a Quill editor is focused, that stop VS Code from acting on the keys the editor uses: bold, inline code, strikethrough, highlight, inline math, quote, code block, headings (Cmd/Ctrl+1 to 6), clear formatting and Copy as Plain Text. Open Keyboard Shortcuts and search for "Quill" to see or change them. Cmd/Ctrl+K chords and Cmd/Ctrl+S, Z, F and P are left to VS Code or the editor as before.

## How it works

Quill is a VS Code `CustomTextEditorProvider` that runs the editor core from the standalone [Quill](https://github.com/ETM-Code/quill) app inside a webview: Tiptap and ProseMirror, with a markdown-it parser and a serializer that keeps each block's original source. The core is vendored under `webview-src/vendor/`, and `webview-src/vendor/README.md` names the app commit it came from and the local patches.

Anything that needs the host goes through the webview message channel instead of Tauri: the extension opens links (`vscode.env.openExternal`, or `vscode.openWith` for `.md` files), reveals files in the Explorer, writes pasted images and shows the file picker.

VS Code owns the document. Dirty state, undo/redo, save, and hot-exit all work at the `TextDocument` level. The webview serializes its ProseMirror document back to markdown on edit (debounced, whole-document replacement), and reloads when the document changes outside the editor (git checkout, a find/replace in another view, format on save). There is no incremental diffing. The view follows your VS Code color theme via `--vscode-*` variables, and a strict Content-Security-Policy with a per-load nonce keeps everything same-origin (no remote scripts, no eval). KaTeX and Mermaid are separate scripts (`media/katex.js`, `media/mermaid.js`) that the webview loads, with the same nonce, the first time a document contains math or a diagram. Syntax-highlighting grammars are still part of the main bundle, because a single-file webview bundle cannot split them.

## Limitations

Worth knowing before you rely on it:

- **Saves `.md` only.** No PDF / Word / HTML export. The file on disk stays plain markdown that your tools and your agents can keep reading.
- **Images outside the document folder are sandboxed.** Pasted/dropped images go into `assets/` next to the document and render fine. An image referenced by an absolute path outside the document's folder will not load, because the webview only roots the document folder (and its `assets/`) under the CSP.
- **Untitled / unsaved documents cannot add images.** A pasted image needs a folder on disk to write into, so save the document first.
- **The editor core is vendored.** It is copied from the standalone app, so upstream improvements need a periodic re-sync.
- **Undo and redo are VS Code's.** The webview forwards Cmd/Ctrl+Z to VS Code, which undoes the document and reloads the view.
- **No print or PDF.** Use the text editor or the standalone app for that.

## Install

Install "Quill Markdown Editor" from the VS Code Marketplace, or grab a `.vsix` from [Releases](https://github.com/ETM-Code/quill-vscode/releases) and run `Extensions: Install from VSIX...`.

Then open a markdown file. With the sticky default on (the default), opening any `.md` once with Quill makes it your default opener. Otherwise right-click the file and choose `Open With...` then `Quill (WYSIWYG)`, or use the title-bar button.

## Build from source

Requires [bun](https://bun.sh).

```bash
bun install
bun run build        # bundles the extension + webview, copies KaTeX assets
bun run package      # produces quill-vscode-<version>.vsix
```

The `package` script runs `bunx @vscode/vsce package --no-dependencies` (the extension is esbuild-bundled, so dependencies are not shipped).

## Develop

```bash
bun install
bun run build
```

Press **F5** in VS Code (the "Run Extension" launch config) to open an Extension Development Host, then open a markdown file there with Quill. For an incremental loop, run `bun run watch:ext` and `bun run watch:webview` in two terminals, then F5.

## Test

```bash
bun run test         # builds, then runs the @vscode/test-electron suite in a headless VS Code
bun run test:unit    # codec and link-router unit tests under bun test
```

The integration run uses its own temporary user-data and extensions folders, so it never touches your VS Code settings.

The suite opens real `.md` files with the custom editor in headless VS Code. It checks rendering (headings, table, task list, code, KaTeX, Mermaid, images, callouts, front matter, footnotes), that a document with tricky syntax is unchanged after open, an edit elsewhere and save (also with CRLF), paste to `assets/`, external-change reload, link routing, the raw-code clipboard paths, the contributed keybindings, and the sticky-default associations.

## Related

This is the VS Code companion to the standalone macOS app: [github.com/ETM-Code/quill](https://github.com/ETM-Code/quill). Same editor, two homes, for when the markdown gets written where the agent already lives.

## License

MIT
</content>
</invoke>
