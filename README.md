# Quill Markdown Editor

Open any markdown file as a real document, right inside VS Code.

Your AI agents write markdown all day, and most of it lands here in VS Code: architecture docs, research, plans, reports. Then you open the file and it is raw source. A table is a wall of pipes and dashes. Math is LaTeX you decode in your head (and sometimes get wrong). An image is a link you have to open somewhere else. Quill renders any `.md` as a clean, editable document, the way ChatGPT renders it but local and inside your editor, and saves it straight back to plain markdown.

![Quill in VS Code](media/screenshot.png)

<!-- MAINTAINER: add a real screenshot or GIF at media/screenshot.png (a rendered .md document with a table, math, and a code block is ideal). Do not ship a fabricated image. -->

## Features

- **WYSIWYG markdown.** Write in rich text, save as plain `.md`. Headings, bold, italic, underline, strikethrough, lists, blockquotes, inline code, links.
- **GFM tables.** Render and edit inline instead of counting pipes.
- **Task lists.** `- [ ]` checkboxes, clickable, round-trip faithfully.
- **LaTeX math (KaTeX).** Inline `$E=mc^2$` and block `$$...$$`. Click any equation to edit it in a popover.
- **Images.** Local relative images render inline. Paste or drop an image into a saved document and it is written next to the file under `assets/` and linked as `![](assets/img-<hash>.png)`. The slash menu's Image command opens a file picker.
- **Syntax-highlighted code.** Code blocks with a language picker and one-click copy. Grammars load lazily per language, so they cost nothing until used.
- **Slash menu.** Type `/` on an empty line to insert any block: headings, lists, tables, math, dividers, code.
- **Bubble menu.** Select text for a Notion-style formatting menu: turn-into dropdown, marks, link.
- **Find and replace.** `Cmd/Ctrl+F` to find, `Cmd/Ctrl+Alt+F` to replace, with live match highlighting. `Cmd/Ctrl+K` adds a link to the selection.
- **Theme-aware.** Follows your active VS Code color theme.

## Switching between Quill and source

A markdown file is still source as often as it is a document, so Quill makes the switch one click either way and never hijacks your files.

**Title-bar buttons.** When a `.md` is open as text, an "Open in Quill" button (book icon) appears in the editor's title bar. When a Quill document is focused, that button becomes "Open as Text" (code icon) to drop back to source.

**Commands** (Command Palette):

- `Quill: Open with Quill (WYSIWYG)` reopens the active file as a Quill document.
- `Quill: Open as Text (View Source)` reopens the active file in the built-in text editor.

Both are unbound by default to avoid clobbering an existing shortcut. To bind one, open Keyboard Shortcuts, search for the command, and assign a key. VS Code's own built-in `View: Reopen Editor With...` (`workbench.action.reopenWithEditor`) also lists Quill alongside the text editor.

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

## How it works

Quill is a VS Code `CustomTextEditorProvider` that reuses the editor core from the standalone [Quill](https://github.com/ETM-Code/quill) app (Tiptap / ProseMirror with the Tiptap Markdown extension) inside a webview. The editor core is host-agnostic, so the app and this extension share it.

VS Code owns the document. Dirty state, undo/redo, save, and hot-exit all work at the `TextDocument` level. The webview serializes its ProseMirror document back to markdown on edit (debounced, whole-document replacement), and reloads when the document changes outside the editor (git checkout, a find/replace in another view, format on save). There is no hand-rolled incremental diffing. The view follows your VS Code color theme via `--vscode-*` variables, and a strict Content-Security-Policy with a per-load nonce keeps everything same-origin (no remote scripts, no eval).

## Limitations

Worth knowing before you rely on it:

- **Saves `.md` only.** No PDF / Word / HTML export. The file on disk stays plain markdown that your tools and your agents can keep reading.
- **Images outside the document folder are sandboxed.** Pasted/dropped images go into `assets/` next to the document and render fine. An image referenced by an absolute path outside the document's folder will not load, because the webview only roots the document folder (and its `assets/`) under the CSP.
- **Untitled / unsaved documents cannot add images.** A pasted image needs a folder on disk to write into, so save the document first.
- **The editor core is vendored.** It is copied from the standalone app under `webview-src/vendor/`, so upstream improvements need a periodic re-sync.

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
bun run pretest      # build + compile the integration tests
bun run test         # downloads a headless VS Code and runs the @vscode/test-electron suite
```

The suite opens a real `.md` with the custom editor in headless VS Code and asserts the round-trip and rendering (headings, table, task list, code block, KaTeX math, remote and local images, paste-to-`assets/`, webview edit to `TextDocument`, external change reload), plus that both switch commands register and the sticky-default associations flip correctly in both directions while preserving unrelated keys.

## Related

This is the VS Code companion to the standalone macOS app: [github.com/ETM-Code/quill](https://github.com/ETM-Code/quill). Same editor, two homes, for when the markdown gets written where the agent already lives.

## License

MIT
</content>
</invoke>
