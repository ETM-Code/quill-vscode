// Webview entry: the VS Code host adapter for Quill's editor.
//
// This file replaces the app's src/main.ts and src/file-ops.ts. Instead of Tauri
// IPC (dialogs, fs, native menus, window management) it talks to the extension
// host over the webview message channel. VS Code owns dirty state, undo, save
// and hot-exit at the TextDocument level; the webview only pushes serialized
// markdown back on edit and reloads when the host reports an external change.
//
// Everything under ./vendor is copied from the Quill app (see vendor/README.md)
// apart from the small patches listed there.
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { createQuillEditor, ensureGrammarsForDoc, getMarkdown, setMarkdown } from './vendor/editor-setup'
import { configureImages, insertImageBytes, localImagePath, isExternalSrc } from './vendor/images'
import { BubbleMenu } from './vendor/ui/bubble-menu'
import { LinkPopover } from './vendor/ui/link-popover'
import { MathPopover } from './vendor/ui/math-popover'
import { MermaidPopover } from './vendor/ui/mermaid-popover'
import { SlashMenu } from './vendor/ui/slash-menu'
import { FindBar } from './vendor/ui/find-bar'
import { ImagePopover } from './vendor/ui/image-popover'
import { Outline } from './vendor/ui/outline'
import { elementAnchor } from './vendor/ui/popover'
import { showToast } from './vendor/ui/toast'
import { classifyLink, describeTarget, dirname, type LinkTarget } from './vendor/ui/link-router'
import {
  findHeadingBySlug,
  installUxPlugins,
  setImageHandlers,
  setInlineMathHandler,
} from './vendor/extensions'

// katex.min.css is not imported here. It is linked on demand by lazy.ts so its
// relative url(fonts/...) references resolve against media/ and load under the CSP.
import './vendor/styles.css'
import './theme.css'

// ---------------------------------------------------------------------------
// VS Code webview API and message types
// ---------------------------------------------------------------------------

interface VsCodeApi {
  postMessage(msg: unknown): void
  getState(): unknown
  setState(state: unknown): void
}
declare function acquireVsCodeApi(): VsCodeApi

const vscode = acquireVsCodeApi()

interface DocContext {
  text: string
  /** Webview URI of the document folder, null while untitled. */
  imageBase?: string | null
  /** URI path of the document (always forward slashes), null while untitled. */
  docPath?: string | null
  /** Home folder as a URI path, for "~/" links; null on remote hosts. */
  home?: string | null
}

type HostMessage =
  | ({ type: 'init' } & DocContext)
  | ({ type: 'update' } & DocContext)
  | { type: 'saveImageResult'; id: number; relPath?: string; error?: string }
  | { type: 'insertImageData'; bytes: number[]; ext: string }
  | { type: 'command'; id: 'toggle-outline' }
  | { type: 'scrollToAnchor'; anchor: string }
  // Test-only (sent only when the extension runs under QUILL_TEST):
  | { type: 'probe'; id: number }
  | { type: 'simulateEdit'; text: string }
  | { type: 'simulatePasteImage'; bytes: number[]; ext: string }
  | { type: 'simulateOpenLink'; href: string }
  | { type: 'simulateCopy'; mode: 'selectAllCode' | 'copyButton' | 'plain' | 'hasFocus'; id: number }
  | { type: 'simulateAppendText'; find: string; text: string }
  | { type: 'simulateKey'; id: number; key: string; mod?: boolean; shift?: boolean; alt?: boolean }

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'openExternal'; url: string }
  | { type: 'openPath'; kind: 'markdown' | 'file'; path: string; anchor: string | null }
  | { type: 'revealPath'; path: string }
  | { type: 'saveImage'; id: number; bytes: number[]; ext: string }
  | { type: 'pickImage' }
  | { type: 'probe-result'; id: number; result: ProbeResult }
  | { type: 'copy-result'; id: number; text: string | null; html: string | null; ok: boolean }

interface ProbeResult {
  markdown: string
  nodeTypes: string[]
  hasKatex: boolean
  hasTable: boolean
  hasTaskList: boolean
  hasCodeBlock: boolean
  hasMermaidSvg: boolean
  hasCallout: boolean
  calloutKinds: string[]
  hasFrontMatter: boolean
  hasFootnote: boolean
  hasDetails: boolean
  hasHighlight: boolean
  imgCount: number
  imgSrcs: string[]
  outlineVisible: boolean
  autocorrect: string | null
  typographyActive: boolean
}

function post(msg: WebviewMessage): void {
  vscode.postMessage(msg)
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const editorEl = document.getElementById('editor')!
const containerEl = document.getElementById('editor-container')!
const wordCountEl = document.getElementById('word-count')

// The markdown the host currently has (LF-normalised; the host converts to the
// document's line endings). Used to skip no-op pushes and to ignore `update`
// echoes of our own edits, which would otherwise reset the caret.
let lastSyncedText = ''
// True while host content is being applied; suppresses the edit push that the
// replacing transaction would trigger.
let applyingRemote = false

let editPushTimer: ReturnType<typeof setTimeout> | undefined
const EDIT_DEBOUNCE_MS = 220

// Document location, refreshed with every init/update.
let docPath: string | null = null
let home: string | null = null
let imageBaseUri: string | null = null

const normalizeEol = (s: string): string => s.replace(/\r\n?/g, '\n')

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
//
// The webview cannot read or write files or call asWebviewUri, so:
//  - the host sends `imageBase` (the document folder as a webview URI);
//    resolveLocal joins it with a relative src.
//  - saving posts {saveImage, id, bytes, ext} and resolves on saveImageResult.
//  - the slash menu's Image command posts {pickImage}; the host shows the open
//    dialog and sends {insertImageData} back.

function joinUri(base: string, rel: string): string {
  return `${base.replace(/\/+$/, '')}/${rel.replace(/^[/\\]+/, '')}`
}

let saveImageId = 0
const pendingSaves = new Map<number, (relPath: string | null) => void>()

configureImages({
  resolveLocal: src => {
    if (!imageBaseUri) return null
    // Absolute paths can't be joined onto the document-folder URI. Best effort:
    // swap the base URI's path for the absolute one (loads only if the host
    // rooted that folder, which it does for the document folder alone).
    if (src.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(src)) {
      try {
        const u = new URL(imageBaseUri)
        u.pathname = src.replace(/\\/g, '/').replace(/^\/?/, '/')
        return u.toString()
      } catch {
        return null
      }
    }
    return joinUri(imageBaseUri, src)
  },
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

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

let linkPopover: LinkPopover
let mathPopoverInst: MathPopover | undefined
let mermaidPopoverInst: MermaidPopover | undefined
// Math and diagram editors are built on first use; most documents never open them.
const mathPopover = {
  show: (...args: Parameters<MathPopover['show']>) =>
    (mathPopoverInst ??= new MathPopover(editor)).show(...args),
}
const mermaidPopover = {
  show: (...args: Parameters<MermaidPopover['show']>) =>
    (mermaidPopoverInst ??= new MermaidPopover(editor)).show(...args),
}

const editor: Editor = createQuillEditor(editorEl, {
  onDocChanged: () => {
    scheduleWordCount()
    scheduleGrammarCheck()
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
  onOpenUrl: href => openLink(href),
})
installUxPlugins(editor)

// VS Code's webview shell opens any clicked <a href> itself (with its own
// confirmation dialog) from a window-level click listener. The editor decides
// what a link click means (popover, or open on Cmd/Ctrl-click), so stop the
// click here, in the capture phase, before it reaches that listener.
editorEl.addEventListener(
  'click',
  e => {
    if ((e.target as HTMLElement | null)?.closest('a[href]')) {
      e.preventDefault()
      e.stopPropagation()
    }
  },
  true,
)

// --- links ---

const targetOf = (href: string): LinkTarget => classifyLink(href, docPath, home)

let flashEl: HTMLDivElement | null = null
function flash(el: HTMLElement): void {
  if (!flashEl) {
    flashEl = document.createElement('div')
    flashEl.className = 'anchor-flash'
    document.body.appendChild(flashEl)
  }
  const r = el.getBoundingClientRect()
  Object.assign(flashEl.style, {
    left: `${r.left - 6}px`,
    top: `${r.top - 2}px`,
    width: `${r.width + 12}px`,
    height: `${r.height + 4}px`,
  })
  flashEl.classList.remove('on')
  void flashEl.offsetWidth
  flashEl.classList.add('on')
  // Fixed overlay: drop it as soon as the page moves under it.
  const stop = () => flashEl?.classList.remove('on')
  setTimeout(() => containerEl.addEventListener('scroll', stop, { once: true, passive: true }), 50)
}

function scrollToAnchor(anchor: string): boolean {
  const pos = findHeadingBySlug(editor.state.doc, anchor)
  if (pos == null) {
    showToast(`No heading “${anchor}” in this document`, { kind: 'info' })
    return false
  }
  editor.chain().setTextSelection(pos + 1).focus(undefined, { scrollIntoView: false }).run()
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null
  if (dom) {
    dom.scrollIntoView({ block: 'start' })
    requestAnimationFrame(() => flash(dom))
  }
  return true
}

function openLink(href: string): void {
  const target = targetOf(href)
  switch (target.kind) {
    case 'anchor':
      scrollToAnchor(target.anchor)
      break
    case 'external':
      post({ type: 'openExternal', url: target.url })
      break
    case 'markdown':
      post({ type: 'openPath', kind: 'markdown', path: target.path, anchor: target.anchor })
      break
    case 'file':
      post({ type: 'openPath', kind: 'file', path: target.path, anchor: null })
      break
    case 'unsupported':
      showToast(target.reason, {
        kind: 'info',
        action: { label: 'Copy link', onClick: () => void navigator.clipboard.writeText(target.href) },
      })
      break
  }
}

// --- image open / reveal ---

function openImage(src: string): void {
  const local = localImagePath(src)
  if (local) post({ type: 'openPath', kind: 'file', path: local, anchor: null })
  else if (/^https?:/i.test(src)) post({ type: 'openExternal', url: src })
  else if (!isExternalSrc(src)) showToast('Save the document to open its images', { kind: 'info' })
}

const imagePopover = new ImagePopover(editor, {
  open: openImage,
  reveal: path => post({ type: 'revealPath', path }),
  localPath: localImagePath,
})
setImageHandlers({
  onSelect: (pos, dom) => imagePopover.show(pos, dom),
  onOpen: pos => {
    imagePopover.hide()
    const src = editor.state.doc.nodeAt(pos)?.attrs.src as string | undefined
    if (src) openImage(src)
  },
})

// --- chrome ---

linkPopover = new LinkPopover(editor, url => openLink(url), href => describeTarget(targetOf(href)))
const bubbleMenu = new BubbleMenu(editor, () => linkPopover.showEditor())
const slashMenu = new SlashMenu(editor, {
  onMathInserted: (kind, pos) => {
    requestAnimationFrame(() => {
      const node = editor.state.doc.nodeAt(pos)
      const dom = editor.view.nodeDOM(pos) as HTMLElement | null
      if (node && dom) mathPopover.show(kind, node.attrs.latex, pos, elementAnchor(dom))
    })
  },
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
setInlineMathHandler(pos => {
  const node = editor.state.doc.nodeAt(pos)
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null
  if (node && dom) mathPopover.show('inline', node.attrs.latex as string, pos, elementAnchor(dom))
})
const outline = new Outline(editor)

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

// New code blocks (typed ```lang fences) may need their grammar fetched.
let grammarTimer: ReturnType<typeof setTimeout> | undefined
function scheduleGrammarCheck(): void {
  clearTimeout(grammarTimer)
  grammarTimer = setTimeout(() => ensureGrammarsForDoc(editor), 400)
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
function firstTextblockPos(): number {
  let first = -1
  editor.state.doc.descendants((node, pos) => {
    if (first < 0 && node.isTextblock) first = pos + 1
    return first < 0
  })
  return first
}

let initialised = false

function applyRemote(ctx: DocContext): void {
  if (ctx.docPath !== undefined) docPath = ctx.docPath
  if (ctx.home !== undefined) home = ctx.home
  if (ctx.imageBase !== undefined) imageBaseUri = ctx.imageBase ?? null
  configureImages({ baseDir: docPath ? dirname(docPath) : null })

  const text = normalizeEol(ctx.text)
  // Skip echoes of our own change: re-setting identical content would blow away
  // the selection for no reason.
  if (initialised && text === lastSyncedText) return
  const keepScroll = initialised ? containerEl.scrollTop : 0
  lastSyncedText = text
  applyingRemote = true
  try {
    setMarkdown(editor, text)
    // A leading atom (front matter) would take a node selection: start from a
    // caret in the first text block.
    const first = firstTextblockPos()
    if (first > 0) {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, first)))
    } else if (!(editor.state.selection instanceof TextSelection)) {
      editor.commands.setTextSelection(0)
    }
  } finally {
    // Defer clearing so every transaction setMarkdown dispatched counts as remote.
    requestAnimationFrame(() => {
      applyingRemote = false
    })
  }
  requestAnimationFrame(() => containerEl.scrollTo(0, keepScroll))
  initialised = true
  updateWordCount()
}

// --- keyboard shortcuts ---
// Only shortcuts the editor's own keymaps do not cover. Cmd/Ctrl+S is left to
// VS Code (it owns save), and ⇧⌘O (outline) and ⌘/ (source) are VS Code
// keybindings that call back into the host; see package.json.
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  // e.code, not e.key: with Alt held, macOS gives composed characters.
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
})

// --- host message channel ---
window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'init':
    case 'update':
      applyRemote(msg)
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
      void insertImageBytes(editor, Uint8Array.from(msg.bytes), msg.ext)
      break
    case 'command':
      if (msg.id === 'toggle-outline') outline.toggle()
      break
    case 'scrollToAnchor':
      scrollToAnchor(msg.anchor)
      break
    case 'probe':
      post({ type: 'probe-result', id: msg.id, result: probe() })
      break
    case 'simulateEdit':
      // Apply markdown as a genuine (non-remote) edit, so the transactions flow
      // webview -> host exactly like typing would.
      setMarkdown(editor, msg.text)
      flushEditPush()
      break
    case 'simulatePasteImage':
      void (async () => {
        await insertImageBytes(editor, Uint8Array.from(msg.bytes), msg.ext)
        flushEditPush()
      })()
      break
    case 'simulateOpenLink':
      openLink(msg.href)
      break
    case 'simulateCopy':
      void simulateCopy(msg)
      break
    case 'simulateKey':
      simulateKey(msg)
      break
    case 'simulateAppendText':
      simulateAppendText(msg)
      break
  }
})

// ---------------------------------------------------------------------------
// Test-only helpers (only reachable through messages the host sends under QUILL_TEST)
// ---------------------------------------------------------------------------

function probe(): ProbeResult {
  const nodeTypes = new Set<string>()
  editor.state.doc.descendants(node => {
    nodeTypes.add(node.type.name)
    return true
  })
  const dom = editor.view.dom
  const imgs = Array.from(dom.querySelectorAll('img.quill-image')) as HTMLImageElement[]
  return {
    markdown: getMarkdown(editor),
    nodeTypes: [...nodeTypes],
    hasKatex: !!dom.querySelector('.katex'),
    hasTable: !!dom.querySelector('table'),
    hasTaskList: !!dom.querySelector('ul[data-type="taskList"]'),
    hasCodeBlock: !!dom.querySelector('.code-block, pre code'),
    hasMermaidSvg: !!dom.querySelector('.mermaid-block svg'),
    hasCallout: !!dom.querySelector('.md-callout'),
    calloutKinds: Array.from(dom.querySelectorAll('.md-callout')).map(n => n.getAttribute('data-callout') ?? ''),
    hasFrontMatter: !!dom.querySelector('.md-front-matter'),
    hasFootnote: !!dom.querySelector('.md-fnref, .md-fndef'),
    hasDetails: !!dom.querySelector('.md-details'),
    hasHighlight: !!dom.querySelector('mark'),
    imgCount: imgs.length,
    imgSrcs: imgs.map(i => i.getAttribute('src') ?? ''),
    outlineVisible: outline.visible,
    autocorrect: dom.getAttribute('autocorrect'),
    typographyActive: editor.extensionManager.extensions.some(x => x.name === 'typography'),
  }
}

// Runs the real copy paths and reports what landed on the clipboard.
async function simulateCopy(msg: Extract<HostMessage, { type: 'simulateCopy' }>): Promise<void> {
  const reply = (text: string | null, html: string | null, ok: boolean) =>
    post({ type: 'copy-result', id: msg.id, text, html, ok })
  if (msg.mode === 'hasFocus') return reply(null, null, document.hasFocus())
  if (msg.mode === 'copyButton') {
    // Same code path as a user click on the code block's copy button.
    const btn = editor.view.dom.querySelector<HTMLButtonElement>('.code-block-copy')
    if (!btn) return reply(null, null, false)
    editor.view.focus()
    btn.click()
    await new Promise(r => setTimeout(r, 150))
    reply(null, null, btn.getAttribute('data-copy-state') === 'copied')
    return
  }
  if (msg.mode === 'selectAllCode') {
    // Select the first code block's contents, then fire a real copy event. The
    // event carries a DataTransfer we can read back (the same one ProseMirror's
    // copy handler fills for Cmd+C).
    let from = -1
    let to = -1
    editor.state.doc.descendants((node, pos) => {
      if (from < 0 && node.type.name === 'codeBlock') {
        from = pos + 1
        to = pos + node.nodeSize - 1
      }
      return from < 0
    })
    if (from < 0) return reply(null, null, false)
    editor.chain().focus().setTextSelection({ from, to }).run()
    const dt = new DataTransfer()
    const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true })
    editor.view.dom.dispatchEvent(ev)
    return reply(dt.getData('text/plain'), dt.getData('text/html'), ev.defaultPrevented)
  }
  // 'plain': Copy as Plain Text via the editor's own shortcut.
  editor.chain().focus().selectAll().run()
  simulateKey({ type: 'simulateKey', id: msg.id, key: 'c', mod: true, shift: true, alt: true })
  await new Promise(r => setTimeout(r, 150))
  reply(null, null, true)
}

// A real single-block edit: append `text` to the end of the first textblock
// containing `find`, then push to the host like typing would.
function simulateAppendText(msg: Extract<HostMessage, { type: 'simulateAppendText' }>): void {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent.includes(msg.find)) at = pos + node.nodeSize - 1
    return at < 0
  })
  if (at < 0) return
  editor.view.dispatch(editor.state.tr.insertText(msg.text, at))
  flushEditPush()
}

function simulateKey(msg: Extract<HostMessage, { type: 'simulateKey' }>): void {
  const ev = new KeyboardEvent('keydown', {
    key: msg.key,
    code: /^[a-z]$/i.test(msg.key) ? `Key${msg.key.toUpperCase()}` : msg.key,
    metaKey: !!msg.mod && /Mac/.test(navigator.platform),
    ctrlKey: !!msg.mod && !/Mac/.test(navigator.platform),
    shiftKey: !!msg.shift,
    altKey: !!msg.alt,
    bubbles: true,
    cancelable: true,
  })
  editor.view.dom.dispatchEvent(ev)
}

// Flush any pending edit before the webview is torn down.
window.addEventListener('beforeunload', () => flushEditPush())

post({ type: 'ready' })
