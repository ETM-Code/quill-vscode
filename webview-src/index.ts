// Webview entry: the VSCode host adapter for Quill's editor.
//
// This file REPLACES the source repo's src/main.ts + src/file-ops.ts. Instead of
// Tauri IPC (file dialogs, fs, native window), it talks to the extension host
// over the webview message channel. VSCode owns dirty state, undo, save, and
// hot-exit at the TextDocument level; we only push serialized markdown back on
// edit and reload the doc when the host reports an external change.
//
// Everything under ./vendor is copied verbatim from the source repo and is
// host-agnostic, so it is reused unchanged.
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { createQuillEditor, getMarkdown, setMarkdown } from './vendor/editor-setup'
import { configureImages, insertImageBytes } from './vendor/images'
import { BubbleMenu } from './vendor/ui/bubble-menu'
import { LinkPopover } from './vendor/ui/link-popover'
import { MathPopover } from './vendor/ui/math-popover'
import { MermaidPopover } from './vendor/ui/mermaid-popover'
import { SlashMenu } from './vendor/ui/slash-menu'
import { FindBar } from './vendor/ui/find-bar'
import { elementAnchor } from './vendor/ui/popover'

// NOTE: katex.min.css is NOT imported here. esbuild would inline it as a <style>
// tag, and its relative `url(fonts/...)` references would then resolve against
// the webview document URL (wrong) and be blocked by CSP. Instead the extension
// links katex.min.css via webview.asWebviewUri(), so the font URLs resolve
// relative to the stylesheet's own media/ location. See src/extension.ts.
import './vendor/styles.css'
import './theme.css'

// ---------------------------------------------------------------------------
// VSCode webview API
// ---------------------------------------------------------------------------

interface VsCodeApi {
  postMessage(msg: unknown): void
  getState(): unknown
  setState(state: unknown): void
}
declare function acquireVsCodeApi(): VsCodeApi

const vscode = acquireVsCodeApi()

type HostMessage =
  | { type: 'init'; text: string; imageBase?: string | null }
  | { type: 'update'; text: string; imageBase?: string | null }
  // Image host replies (request/response correlated by id):
  | { type: 'saveImageResult'; id: number; relPath?: string; error?: string }
  | { type: 'insertImageData'; bytes: number[]; ext: string }
  // Test-only (sent only when the extension runs under QUILL_TEST):
  | { type: 'probe'; id: number }
  | { type: 'simulateEdit'; text: string }
  | { type: 'simulatePasteImage'; bytes: number[]; ext: string }

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'openLink'; url: string }
  | { type: 'saveImage'; id: number; bytes: number[]; ext: string }
  | { type: 'pickImage' }
  | { type: 'probe-result'; id: number; result: ProbeResult }

interface ProbeResult {
  markdown: string
  nodeTypes: string[]
  hasKatex: boolean
  hasTable: boolean
  hasTaskList: boolean
  hasCodeBlock: boolean
  hasMermaidSvg: boolean
  imgCount: number
  imgSrcs: string[]
}

function post(msg: WebviewMessage): void {
  vscode.postMessage(msg)
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const editorEl = document.getElementById('editor')!
const wordCountEl = document.getElementById('word-count')

// Tracks the markdown the host currently has, so we can:
//  - debounce edits and skip no-op pushes
//  - ignore `update` echoes of our own edits (they'd reset the caret)
let lastSyncedText = ''
// True while we're applying host content into the editor; suppresses the edit
// push that setMarkdown's transactions would otherwise trigger.
let applyingRemote = false

let editPushTimer: ReturnType<typeof setTimeout> | undefined
const EDIT_DEBOUNCE_MS = 220

let linkPopover: LinkPopover
let mathPopover: MathPopover
let mermaidPopover: MermaidPopover

// ---------------------------------------------------------------------------
// Image host wiring
// ---------------------------------------------------------------------------
//
// The webview cannot call asWebviewUri, read files, or write files. So:
//  - the host sends `imageBase`, the document folder's webview base URI, with
//    every init/update. resolveLocal joins it with a relative src.
//  - saving posts {saveImage, id, bytes, ext} and resolves on saveImageResult.
//  - the slash-menu Image command posts {pickImage}; the host runs the open
//    dialog, reads the file, and sends {insertImageData, bytes, ext} back.

// Webview base URI for the document folder (e.g.
// https://file%2B.vscode-resource.../path/to/docdir). Updated on every load.
let imageBaseUri: string | null = null

function joinUri(base: string, rel: string): string {
  return `${base.replace(/\/+$/, '')}/${rel.replace(/^[/\\]+/, '')}`
}

// saveImage request/response correlation.
let saveImageId = 0
const pendingSaves = new Map<number, (relPath: string | null) => void>()

configureImages({
  // Map a LOCAL markdown src to a webview-loadable URL. External srcs
  // (http/data/blob) never reach here; resolveForDisplay handles those.
  resolveLocal: (src, _baseDir) => {
    if (!imageBaseUri) return null
    // Absolute paths can't be joined onto the doc-folder base URI; the host
    // only roots the doc folder (+ assets) in localResourceRoots, so an
    // absolute path outside that tree wouldn't load anyway. Best effort: build
    // a vscode-resource URI from the absolute path via the base's authority.
    if (src.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(src)) {
      try {
        const u = new URL(imageBaseUri)
        // base path is /<...>/<docdir>; swap it for the absolute file path.
        u.pathname = src.replace(/\\/g, '/').replace(/^\/?/, '/')
        return u.toString()
      } catch {
        return null
      }
    }
    return joinUri(imageBaseUri, src)
  },
  // Persist bytes via the host and return the markdown src to store.
  saver: (bytes, ext) =>
    new Promise<string | null>(resolve => {
      const id = ++saveImageId
      const timer = setTimeout(() => {
        pendingSaves.delete(id)
        resolve(null)
      }, 15000)
      pendingSaves.set(id, relPath => {
        clearTimeout(timer)
        resolve(relPath)
      })
      post({ type: 'saveImage', id, bytes: Array.from(bytes), ext })
    }),
})

const editor: Editor = createQuillEditor(editorEl, {
  onDocChanged: () => {
    scheduleWordCount()
    if (applyingRemote) return
    scheduleEditPush()
  },
  onLinkClick: anchor => linkPopover.showForLink(anchor),
  onInlineMathClick: (node, pos) => {
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null
    if (dom) mathPopover.show('inline', node.attrs.latex, pos, elementAnchor(dom))
  },
  onBlockMathClick: (node, pos) => {
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null
    if (dom) mathPopover.show('block', node.attrs.latex, pos, elementAnchor(dom))
  },
  onMermaidClick: (code, pos) => {
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null
    if (dom) mermaidPopover.show(code, pos, elementAnchor(dom))
  },
  onOpenUrl: url => post({ type: 'openLink', url }),
})

linkPopover = new LinkPopover(editor, url => post({ type: 'openLink', url }))
mathPopover = new MathPopover(editor)
mermaidPopover = new MermaidPopover(editor)
const bubbleMenu = new BubbleMenu(editor, () => linkPopover.showEditor())
const slashMenu = new SlashMenu(editor, {
  onMathInserted: (kind, pos) => {
    requestAnimationFrame(() => {
      const node = editor.state.doc.nodeAt(pos)
      const dom = editor.view.nodeDOM(pos) as HTMLElement | null
      if (node && dom) mathPopover.show(kind, node.attrs.latex, pos, elementAnchor(dom))
    })
  },
  // The host runs showOpenDialog, reads the file, and sends the bytes back as
  // an `insertImageData` message (handled in the host message channel below).
  onInsertImage: () => post({ type: 'pickImage' }),
  onMermaidInserted: pos => {
    requestAnimationFrame(() => {
      const node = editor.state.doc.nodeAt(pos)
      const dom = editor.view.nodeDOM(pos) as HTMLElement | null
      if (node && dom) mermaidPopover.show(node.attrs.code as string, pos, elementAnchor(dom))
    })
  },
})
const findBar = new FindBar(editor)
void bubbleMenu
void slashMenu

// --- word count ---
let wordCountTimer: ReturnType<typeof setTimeout> | undefined
function updateWordCount(): void {
  if (!wordCountEl) return
  const storage = (editor.storage as Record<string, any>).characterCount
  const words: number = storage?.words?.() ?? 0
  wordCountEl.textContent = words === 0 ? '' : `${words.toLocaleString()} word${words === 1 ? '' : 's'}`
}
function scheduleWordCount(): void {
  clearTimeout(wordCountTimer)
  wordCountTimer = setTimeout(updateWordCount, 300)
}

// --- edit push (webview -> host) ---
function scheduleEditPush(): void {
  clearTimeout(editPushTimer)
  editPushTimer = setTimeout(flushEditPush, EDIT_DEBOUNCE_MS)
}
function flushEditPush(): void {
  clearTimeout(editPushTimer)
  const md = getMarkdown(editor)
  if (md === lastSyncedText) return
  lastSyncedText = md
  post({ type: 'edit', text: md })
}

// --- apply host content (host -> webview) ---
function applyRemoteText(text: string, imageBase?: string | null): void {
  // Point the image layer at this document's folder before rendering so local
  // images resolve. A null base means the doc is untitled (no folder URI).
  if (imageBase !== undefined) imageBaseUri = imageBase ?? null
  // Skip echoes of our own change. The host re-broadcasts the document text on
  // every change (including ours); re-setting identical content would blow away
  // the selection for no reason.
  if (text === lastSyncedText) return
  lastSyncedText = text
  applyingRemote = true
  try {
    setMarkdown(editor, text)
    // setMarkdown collapses selection to 0 already, but be explicit so the caret
    // never lands on a whole-document selection after a remote reload.
    if (!(editor.state.selection instanceof TextSelection)) {
      editor.commands.setTextSelection(0)
    }
  } finally {
    // Defer clearing so the transactions dispatched by setMarkdown (which fire
    // onDocChanged synchronously) are all seen as remote, not user, edits.
    requestAnimationFrame(() => { applyingRemote = false })
  }
  updateWordCount()
}

// --- keyboard shortcuts (find/replace + link; the rest are editor keymaps) ---
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  const key = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase()
  if (key === 'k' && !e.shiftKey) {
    if (!editor.state.selection.empty || editor.isActive('link')) {
      e.preventDefault()
      linkPopover.showEditor()
    }
  } else if (key === 'f' && !e.shiftKey) {
    e.preventDefault()
    findBar.show(e.altKey)
  }
  // Cmd+S is intentionally left to VSCode: it owns save of the TextDocument.
})

// --- host message channel ---
window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'init':
    case 'update':
      applyRemoteText(msg.text, msg.imageBase)
      break
    case 'saveImageResult': {
      const resolve = pendingSaves.get(msg.id)
      if (resolve) {
        pendingSaves.delete(msg.id)
        resolve(msg.relPath ?? null)
      }
      break
    }
    case 'insertImageData':
      // The host picked + read an image file; save it through the same path
      // and insert at the caret.
      void insertImageBytes(editor, Uint8Array.from(msg.bytes), msg.ext)
      break
    case 'probe':
      post({ type: 'probe-result', id: msg.id, result: probe() })
      break
    case 'simulateEdit':
      // Apply markdown as a genuine (non-remote) edit, so the resulting
      // transactions flow webview -> host exactly like a user's typing would.
      setMarkdown(editor, msg.text)
      flushEditPush()
      break
    case 'simulatePasteImage':
      // Drive the exact paste/drop code path: insertImageBytes runs the
      // configured saver (which posts saveImage to the host, writes the file,
      // and returns assets/img-<hash>), then inserts the image node + pushes
      // the new markdown back to the host like a real paste would.
      void (async () => {
        await insertImageBytes(editor, Uint8Array.from(msg.bytes), msg.ext)
        flushEditPush()
      })()
      break
  }
})

// Inspect the live Tiptap document + rendered DOM. Test-only.
function probe(): ProbeResult {
  const nodeTypes = new Set<string>()
  editor.state.doc.descendants(node => {
    nodeTypes.add(node.type.name)
    return true
  })
  const dom = editor.view.dom
  // Rendered <img> elements (the node view swaps in a loadable URL via
  // resolveForDisplay, so src here is the resolved URL, not the markdown src).
  const imgs = Array.from(dom.querySelectorAll('img.quill-image')) as HTMLImageElement[]
  return {
    markdown: getMarkdown(editor),
    nodeTypes: [...nodeTypes],
    // KaTeX renders into .katex elements; presence proves math actually rendered.
    hasKatex: !!dom.querySelector('.katex'),
    hasTable: !!dom.querySelector('table'),
    hasTaskList: !!dom.querySelector('ul[data-type="taskList"]'),
    hasCodeBlock: !!dom.querySelector('.code-block, pre code'),
    // A rendered mermaid diagram proves the (inlined) mermaid bundle ran and
    // produced SVG under the webview CSP.
    hasMermaidSvg: !!dom.querySelector('.mermaid-block svg'),
    imgCount: imgs.length,
    imgSrcs: imgs.map(i => i.getAttribute('src') ?? ''),
  }
}

// Flush any pending edit before the webview is torn down.
window.addEventListener('beforeunload', () => flushEditPush())

post({ type: 'ready' })
