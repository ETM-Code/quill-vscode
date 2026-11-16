# Changelog

## 0.3.0

The editor is the one from the Quill app at commit 72b30e8.

- Markdown is parsed with markdown-it and written back by a serializer that keeps each block's original text, so unedited parts of a file are saved byte for byte (including CRLF files).
- New syntax: front matter, footnotes, callouts with labels, `<details>`, `==highlight==`, `<sub>`, `<sup>`, `<kbd>` and raw HTML.
- Code copies as raw text, from the copy button and from Cmd/Ctrl+C. Other copies carry markdown and rich HTML. New "Copy as Plain Text" (Alt+Shift+Cmd/Ctrl+C). Pasting handles VS Code, spreadsheet and chat content.
- Links: `#anchor` scrolls, Cmd/Ctrl-click opens. `.md` links open in Quill, other files in their default app.
- Images: click for a popover (alt text, size, open, reveal in Explorer), drag to resize.
- Tables: column alignment, add, move and delete rows and columns.
- Inline math with Shift+Cmd/Ctrl+M or the sigma button. Heading outline with Shift+Cmd/Ctrl+O.
- Autocorrect and typographic replacements are off.
- KaTeX and Mermaid load only when a document uses them.
- Keybindings, active only in a Quill editor, stop VS Code running its own commands for editor shortcuts (for example Cmd+B toggling the sidebar). Cmd/Ctrl+/ opens the text editor.
- Link clicks in the editor no longer reach VS Code's own link opener.

## 0.2.0

Image refactor and Mermaid support.
