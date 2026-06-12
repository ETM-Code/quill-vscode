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
import { BubbleMenu } from './vendor/ui/bubble-menu'
import { LinkPopover } from './vendor/ui/link-popover'
import { MathPopover } from './vendor/ui/math-popover'
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
  | { type: 'init'; text: string }
  | { type: 'update'; text: string }
  // Test-only (sent only when the extension runs under QUILL_TEST):
  | { type: 'probe'; id: number }
  | { type: 'simulateEdit'; text: string }

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'openLink'; url: string }
  | { type: 'probe-result'; id: number; result: ProbeResult }

interface ProbeResult {
  markdown: string
  nodeTypes: string[]
  hasKatex: boolean
  hasTable: boolean
  hasTaskList: boolean
  hasCodeBlock: boolean
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
  onOpenUrl: url => post({ type: 'openLink', url }),
})

linkPopover = new LinkPopover(editor, url => post({ type: 'openLink', url }))
mathPopover = new MathPopover(editor)
const bubbleMenu = new BubbleMenu(editor, () => linkPopover.showEditor())
const slashMenu = new SlashMenu(editor, {
  onMathInserted: (kind, pos) => {
    requestAnimationFrame(() => {
      const node = editor.state.doc.nodeAt(pos)
      const dom = editor.view.nodeDOM(pos) as HTMLElement | null
      if (node && dom) mathPopover.show(kind, node.attrs.latex, pos, elementAnchor(dom))
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
function applyRemoteText(text: string): void {
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
      applyRemoteText(msg.text)
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
  return {
    markdown: getMarkdown(editor),
    nodeTypes: [...nodeTypes],
    // KaTeX renders into .katex elements; presence proves math actually rendered.
    hasKatex: !!dom.querySelector('.katex'),
    hasTable: !!dom.querySelector('table'),
    hasTaskList: !!dom.querySelector('ul[data-type="taskList"]'),
    hasCodeBlock: !!dom.querySelector('.code-block, pre code'),
  }
}

// Flush any pending edit before the webview is torn down.
window.addEventListener('beforeunload', () => flushEditPush())

post({ type: 'ready' })
