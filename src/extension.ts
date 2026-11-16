import * as os from 'node:os'
import * as vscode from 'vscode'
import { baseName, isOpenableUrl, isQuillDocument, isRunnable } from './routing'

export function activate(context: vscode.ExtensionContext): void {
  const provider = new QuillEditorProvider(context)
  context.subscriptions.push(QuillEditorProvider.register(context, provider))

  // "Open with Quill" command: reopens the active markdown file in our editor.
  // The active resource may be a markdown TEXT editor (activeTextEditor) or our
  // own custom editor (activeTab.input). Prefer whichever is present.
  context.subscriptions.push(
    vscode.commands.registerCommand('quill.openWithQuill', async () => {
      const uri = activeResourceUri()
      if (!uri) {
        void vscode.window.showInformationMessage('Open a markdown file first.')
        return
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, QuillEditorProvider.viewType)
    }),
  )

  // "Open as Text" command: reopens the active resource in the built-in text
  // editor. Shown in the editor title bar while a Quill document is focused.
  context.subscriptions.push(
    vscode.commands.registerCommand('quill.openWithTextEditor', async () => {
      const uri = activeResourceUri()
      if (!uri) {
        void vscode.window.showInformationMessage('Open a markdown file first.')
        return
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default')
    }),
  )

  // "Toggle Outline" (also bound to Shift+Cmd/Ctrl+O while a Quill editor is focused).
  context.subscriptions.push(
    vscode.commands.registerCommand('quill.toggleOutline', () => provider.sendToActive({ type: 'command', id: 'toggle-outline' })),
  )

  // Keybinding placeholder. Quill's editor handles shortcuts such as Cmd+B or
  // Shift+Cmd+M itself, but the VS Code webview shell also forwards every
  // keystroke to the workbench, which would run its own command for the same
  // keys (toggle sidebar, Problems panel, Extensions view...). Contributing a
  // keybinding for these keys that points at this empty command, only while a
  // Quill editor is active, makes the workbench do nothing. See package.json.
  context.subscriptions.push(vscode.commands.registerCommand('quill.editorShortcut', () => undefined))

  // Sticky default: when a markdown TEXT editor becomes active and the setting
  // is on, flip the default for *.md / *.markdown back to the text editor. When
  // the Quill custom editor (a webview) is focused, activeTextEditor is
  // undefined, so this never wrongly fires for Quill. Registered here (not only
  // inside resolveCustomTextEditor) so it is live from activation: opening a
  // .md as plain text correctly sets the default to text even before Quill is
  // ever used. resolveCustomTextEditor handles the other direction.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (!editor) return
      if (editor.document.languageId !== 'markdown') return
      if (!rememberLastEditorChoice()) return
      void setMarkdownAssociations('default')
    }),
  )

  // Test-only commands, gated behind QUILL_TEST so they never run in production.
  // They drive a real, resolved webview over its actual message channel, which
  // is how the integration test proves the markdown<->ProseMirror round-trip.
  if (process.env.QUILL_TEST === '1') {
    context.subscriptions.push(
      vscode.commands.registerCommand('quill._test.probe', (uri: string) =>
        provider.testProbe(uri),
      ),
      vscode.commands.registerCommand('quill._test.simulateEdit', (uri: string, text: string) =>
        provider.testSimulateEdit(uri, text),
      ),
      vscode.commands.registerCommand(
        'quill._test.simulatePasteImage',
        (uri: string, bytes: number[], ext: string) =>
          provider.testSimulatePasteImage(uri, bytes, ext),
      ),
      vscode.commands.registerCommand('quill._test.simulate', (uri: string, msg: object) =>
        provider.testSimulate(uri, msg),
      ),
      vscode.commands.registerCommand('quill._test.simulateOpenLink', (uri: string, href: string) =>
        provider.testSimulate(uri, { type: 'simulateOpenLink', href }),
      ),
      vscode.commands.registerCommand('quill._test.simulateKey', (uri: string, key: string, mods: object) =>
        provider.testSimulate(uri, { type: 'simulateKey', key, ...mods }),
      ),
      vscode.commands.registerCommand('quill._test.copy', (uri: string, mode: string) =>
        provider.testCopy(uri, mode),
      ),
      // Feed a message to the host as if the webview had posted it.
      vscode.commands.registerCommand('quill._test.hostMessage', (uri: string, msg: WebviewToHost) =>
        provider.testHostMessage(uri, msg),
      ),
      vscode.commands.registerCommand('quill._test.takeCalls', () => provider.takeCalls()),
      vscode.commands.registerCommand('quill._test.sessionInfo', (uri: string) => provider.testSessionInfo(uri)),
    )
  }
}

export function deactivate(): void {
  /* nothing to clean up */
}

type WebviewToHost =
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

/** What the host did for a webview request. Recorded only under QUILL_TEST. */
export interface HostCall {
  kind: 'openExternal' | 'openMarkdown' | 'openFile' | 'reveal'
  target: string
  anchor?: string | null
}

interface Session {
  webview: vscode.Webview
  document: vscode.TextDocument
  panel: vscode.WebviewPanel
  ready: boolean
}

class QuillEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'quill.markdownEditor'

  // Live sessions by document URI, used only by the test-only probe commands.
  private readonly sessions = new Map<string, Session>()
  private probeId = 0
  private readonly pendingProbes = new Map<number, (r: ProbeResult) => void>()
  private readonly pendingCopies = new Map<number, (r: CopyResult) => void>()
  private readonly pendingAnchors = new Map<string, string>()
  private readonly calls: HostCall[] = []
  private readonly testMode = process.env.QUILL_TEST === '1'
  private activeSession: Session | undefined

  public static register(
    context: vscode.ExtensionContext,
    provider: QuillEditorProvider,
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      QuillEditorProvider.viewType,
      provider,
      {
        webviewOptions: {
          // Keep the editor alive when its tab is in the background so undo
          // history and scroll position survive tab switches.
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      },
    )
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- test-only helpers (registered behind QUILL_TEST) ---

  public testProbe(uri: string): Promise<ProbeResult> {
    const session = this.sessions.get(uri)
    if (!session) return Promise.reject(new Error(`no Quill session for ${uri}`))
    const id = ++this.probeId
    return new Promise<ProbeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingProbes.delete(id)
        reject(new Error('probe timed out'))
      }, 5000)
      this.pendingProbes.set(id, r => {
        clearTimeout(timer)
        resolve(r)
      })
      void session.webview.postMessage({ type: 'probe', id })
    })
  }

  public async testSimulateEdit(uri: string, text: string): Promise<void> {
    const session = this.sessions.get(uri)
    if (!session) throw new Error(`no Quill session for ${uri}`)
    await session.webview.postMessage({ type: 'simulateEdit', text })
  }

  public async testSimulate(uri: string, msg: object): Promise<void> {
    const session = this.sessions.get(uri)
    if (!session) throw new Error(`no Quill session for ${uri}`)
    await session.webview.postMessage(msg)
  }

  public testCopy(uri: string, mode: string): Promise<CopyResult> {
    const session = this.sessions.get(uri)
    if (!session) return Promise.reject(new Error(`no Quill session for ${uri}`))
    const id = ++this.probeId
    return new Promise<CopyResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCopies.delete(id)
        reject(new Error('copy simulation timed out'))
      }, 5000)
      this.pendingCopies.set(id, r => {
        clearTimeout(timer)
        resolve(r)
      })
      void session.webview.postMessage({ type: 'simulateCopy', mode, id })
    })
  }

  public async testHostMessage(uri: string, msg: WebviewToHost): Promise<void> {
    const session = this.sessions.get(uri)
    if (!session) throw new Error(`no Quill session for ${uri}`)
    await this.handleLinkMessage(session.document, msg)
  }

  public takeCalls(): HostCall[] {
    return this.calls.splice(0)
  }

  public testSessionInfo(uri: string): { ready: boolean; active: boolean } | null {
    const s = this.sessions.get(uri)
    return s ? { ready: s.ready, active: this.activeSession === s } : null
  }

  /** Post a message to the Quill editor that currently has focus. */
  public sendToActive(msg: object): void {
    if (this.activeSession) void this.activeSession.webview.postMessage(msg)
  }

  public async testSimulatePasteImage(uri: string, bytes: number[], ext: string): Promise<void> {
    const session = this.sessions.get(uri)
    if (!session) throw new Error(`no Quill session for ${uri}`)
    await session.webview.postMessage({ type: 'simulatePasteImage', bytes, ext })
  }

  // --- image host ---

  /**
   * The folder the document lives in, or null for an untitled/unsaved doc.
   * Relative image srcs resolve against this, and pasted images write into its
   * `assets/` subdir.
   */
  private docDir(document: vscode.TextDocument): vscode.Uri | null {
    if (document.uri.scheme === 'untitled') return null
    if (document.isUntitled) return null
    return vscode.Uri.joinPath(document.uri, '..')
  }

  /**
   * Write pasted/dropped image bytes into `<docDir>/assets/img-<hash>.<ext>`
   * and reply with the relative path to store in the markdown. Uses an FNV-1a
   * content hash (mirroring the app's hashBytes) so re-pasting the same image
   * reuses the file. Replies with an error / null relPath on any failure.
   */
  private async handleSaveImage(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    id: number,
    bytes: number[],
    ext: string,
  ): Promise<void> {
    const docDir = this.docDir(document)
    if (!docDir) {
      void vscode.window.showInformationMessage('Save the document first to add images')
      void webview.postMessage({ type: 'saveImageResult', id })
      return
    }
    try {
      const data = Uint8Array.from(bytes)
      const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
      const name = `img-${fnv1a(data)}.${safeExt}`
      const assetsDir = vscode.Uri.joinPath(docDir, 'assets')
      await vscode.workspace.fs.createDirectory(assetsDir)
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(assetsDir, name), data)
      void webview.postMessage({ type: 'saveImageResult', id, relPath: `assets/${name}` })
    } catch (e) {
      void webview.postMessage({ type: 'saveImageResult', id, error: String(e) })
    }
  }

  /**
   * Slash-menu "Image": run the open dialog, read the chosen file, and hand the
   * bytes back to the webview, which saves them through the same path as paste
   * and inserts the node.
   */
  private async handlePickImage(
    webview: vscode.Webview,
    document: vscode.TextDocument,
  ): Promise<void> {
    if (!this.docDir(document)) {
      void vscode.window.showInformationMessage('Save the document first to add images')
      return
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Insert Image',
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] },
    })
    if (!picked || picked.length === 0) return
    try {
      const data = await vscode.workspace.fs.readFile(picked[0])
      const fsPath = picked[0].fsPath
      const ext = fsPath.slice(fsPath.lastIndexOf('.') + 1).toLowerCase() || 'png'
      void webview.postMessage({ type: 'insertImageData', bytes: Array.from(data), ext })
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't insert image: ${e}`)
    }
  }

  // --- link and file routing (requests from the webview) ---

  /** Where a path from the webview points: same scheme and authority as the document. */
  private uriFor(document: vscode.TextDocument, path: string): vscode.Uri {
    return document.uri.with({ path, query: '', fragment: '' })
  }

  private async handleLinkMessage(document: vscode.TextDocument, msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'openExternal':
        await this.openExternal(msg.url)
        break
      case 'openPath':
        if (msg.kind === 'markdown') await this.openMarkdown(document, msg.path, msg.anchor)
        else await this.openFile(document, msg.path)
        break
      case 'revealPath':
        await this.reveal(document, msg.path)
        break
    }
  }

  private async openExternal(url: string): Promise<void> {
    if (!isOpenableUrl(url)) return
    if (this.testMode) {
      this.calls.push({ kind: 'openExternal', target: url })
      return
    }
    await vscode.env.openExternal(vscode.Uri.parse(url))
  }

  /** `.md` / `.markdown` open in VS Code with the Quill editor; other text-like targets in the normal editor. */
  private async openMarkdown(document: vscode.TextDocument, path: string, anchor: string | null): Promise<void> {
    const uri = this.uriFor(document, path)
    if (!(await exists(uri))) {
      void vscode.window.showErrorMessage(`Quill: ${baseName(path)} was not found.`)
      return
    }
    this.calls.push({ kind: 'openMarkdown', target: uri.toString(), anchor })
    if (!isQuillDocument(path)) {
      await vscode.commands.executeCommand('vscode.open', uri)
      return
    }
    if (anchor) this.pendingAnchors.set(uri.toString(), anchor)
    await vscode.commands.executeCommand('vscode.openWith', uri, QuillEditorProvider.viewType)
    // Already open and ready: scroll now. A freshly created editor picks the
    // anchor up when it reports ready.
    const open = this.sessions.get(uri.toString())
    if (anchor && open?.ready) {
      this.pendingAnchors.delete(uri.toString())
      void open.webview.postMessage({ type: 'scrollToAnchor', anchor })
    }
  }

  /** Other local files: the default app, or the Explorer for folders. */
  private async openFile(document: vscode.TextDocument, path: string): Promise<void> {
    const uri = this.uriFor(document, path)
    const stat = await statOrNull(uri)
    if (!stat) {
      void vscode.window.showErrorMessage(`Quill: ${baseName(path)} was not found.`)
      return
    }
    this.calls.push({ kind: 'openFile', target: uri.toString() })
    if (this.testMode) return
    if (stat.type & vscode.FileType.Directory) {
      await this.revealUri(uri)
      return
    }
    if (isRunnable(path)) {
      const ok = await vscode.window.showWarningMessage(
        `"${baseName(path)}" is a program or script. Opening it may run code on this computer.`,
        { modal: true },
        'Open',
      )
      if (ok !== 'Open') return
    }
    // Only a local file can go to the operating system; for remote workspaces
    // let VS Code open it.
    if (uri.scheme === 'file') await vscode.env.openExternal(uri)
    else await vscode.commands.executeCommand('vscode.open', uri)
  }

  private async reveal(document: vscode.TextDocument, path: string): Promise<void> {
    const uri = this.uriFor(document, path)
    this.calls.push({ kind: 'reveal', target: uri.toString() })
    if (this.testMode) return
    if (!(await exists(uri))) {
      void vscode.window.showErrorMessage(`Quill: ${baseName(path)} was not found.`)
      return
    }
    await this.revealUri(uri)
  }

  private async revealUri(uri: vscode.Uri): Promise<void> {
    // The Explorer shows files inside the workspace; anything else goes to the OS file manager.
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      await vscode.commands.executeCommand('revealInExplorer', uri)
    } else {
      await vscode.commands.executeCommand('revealFileInOS', uri)
    }
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const webview = webviewPanel.webview

    // Sticky default: the user just opened a markdown file with Quill, so make
    // Quill the default for *.md / *.markdown going forward (if the setting is
    // on). The reverse (opening a .md as text) is handled by the
    // onDidChangeActiveTextEditor listener in activate().
    if (rememberLastEditorChoice()) {
      void setMarkdownAssociations(QuillEditorProvider.viewType)
    }

    // For a saved file, the document lives in a folder; local relative images
    // (e.g. assets/x.png) resolve against it. We root that folder (and its
    // assets/ subdir) so the webview can load images from it under the CSP, and
    // hand the webview the folder's base URI so it can build image src URLs.
    const docDir = this.docDir(document)
    const localRoots: vscode.Uri[] = [
      vscode.Uri.joinPath(this.context.extensionUri, 'media'),
    ]
    let imageBase: string | null = null
    if (docDir) {
      localRoots.push(docDir, vscode.Uri.joinPath(docDir, 'assets'))
      imageBase = webview.asWebviewUri(docDir).toString()
    }

    webview.options = {
      enableScripts: true,
      localResourceRoots: localRoots,
    }
    webview.html = this.getHtml(webview)

    const uriKey = document.uri.toString()
    const session: Session = { webview, document, panel: webviewPanel, ready: false }
    this.sessions.set(uriKey, session)
    if (webviewPanel.active) this.activeSession = session
    const viewSub = webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) this.activeSession = session
      else if (this.activeSession === session) this.activeSession = undefined
    })

    // The text the webview last reported to us. Used to suppress the echo: when
    // we apply the webview's edit to the document, onDidChangeTextDocument fires,
    // and we must NOT bounce that identical text back (it would reset the caret).
    let lastTextFromWebview: string | null = null
    let ready = false

    // Home folder for "~/" links; only meaningful for local files.
    const home = document.uri.scheme === 'file' ? vscode.Uri.file(os.homedir()).path : null
    const docPath = docDir ? document.uri.path : null

    const pushDocumentToWebview = (reason: 'init' | 'update') => {
      void webview.postMessage({ type: reason, text: document.getText(), imageBase, docPath, home })
    }

    // Apply the webview's serialized markdown to the document as a single
    // whole-document replacement. VSCode owns dirty state, undo, and save; we
    // never hand-roll incremental ProseMirror<->TextDocument diffing.
    const applyEditToDocument = async (text: string): Promise<void> => {
      // The webview works in LF; keep the document's own line endings.
      if (document.eol === vscode.EndOfLine.CRLF) text = text.replace(/\r?\n/g, '\r\n')
      if (text === document.getText()) return
      lastTextFromWebview = text
      const edit = new vscode.WorkspaceEdit()
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      )
      edit.replace(document.uri, fullRange, text)
      await vscode.workspace.applyEdit(edit)
    }

    const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() !== document.uri.toString()) return
      if (!ready) return
      const text = document.getText()
      // Skip the echo of the webview's own edit.
      if (text === lastTextFromWebview) return
      // An external change (git checkout, find/replace in another view, format
      // on save, undo/redo driven by VSCode). Reload the webview's document.
      pushDocumentToWebview('update')
    })

    const messageSub = webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      switch (msg.type) {
        case 'ready': {
          ready = true
          session.ready = true
          pushDocumentToWebview('init')
          const anchor = this.pendingAnchors.get(uriKey)
          if (anchor) {
            this.pendingAnchors.delete(uriKey)
            // Give the first render a moment so the heading exists.
            setTimeout(() => void webview.postMessage({ type: 'scrollToAnchor', anchor }), 250)
          }
          break
        }
        case 'edit':
          await applyEditToDocument(msg.text)
          break
        case 'openExternal':
        case 'openPath':
        case 'revealPath':
          await this.handleLinkMessage(document, msg)
          break
        case 'saveImage':
          await this.handleSaveImage(webview, document, msg.id, msg.bytes, msg.ext)
          break
        case 'pickImage':
          await this.handlePickImage(webview, document)
          break
        case 'copy-result': {
          const resolve = this.pendingCopies.get(msg.id)
          if (resolve) {
            this.pendingCopies.delete(msg.id)
            resolve({ text: msg.text, html: msg.html, ok: msg.ok })
          }
          break
        }
        case 'probe-result': {
          const resolve = this.pendingProbes.get(msg.id)
          if (resolve) {
            this.pendingProbes.delete(msg.id)
            resolve(msg.result)
          }
          break
        }
      }
    })

    webviewPanel.onDidDispose(() => {
      this.sessions.delete(uriKey)
      if (this.activeSession === session) this.activeSession = undefined
      viewSub.dispose()
      changeSub.dispose()
      messageSub.dispose()
    })
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js'),
    )
    // KaTeX and Mermaid are separate scripts that the webview injects the first
    // time a document needs them (webview-src/lazy.ts). The stylesheet is linked
    // (not inlined) so its relative url(fonts/...) refs resolve against media/.
    const mediaUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file)).toString()
    // The bundled editor + theme CSS that esbuild emits next to the JS.
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css'),
    )
    const nonce = getNonce()
    // Strict CSP: only nonce'd scripts run (the main bundle, and the engine
    // scripts it injects with the same nonce). Styles load as linked
    // stylesheets (webview.css, and katex.min.css on demand) from media/. style-src still
    // needs 'unsafe-inline' because ProseMirror and KaTeX set inline style=""
    // attributes, which CSP Level 2 governs under style-src. KaTeX fonts load
    // as same-origin webview resources via font-src. No remote anything, no eval.
    const csp = [
      `default-src 'none'`,
      // Local images load as same-origin webview resources (cspSource); remote
      // image URLs (https) and inline data: URIs render too.
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ')

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Quill</title>
  </head>
  <body>
    <div id="app">
      <main id="editor-container">
        <div id="editor"></div>
      </main>
      <span id="word-count"></span>
      <div class="titlebar-right"></div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"
      data-katex-js="${mediaUri('katex.js')}"
      data-katex-css="${mediaUri('katex.min.css')}"
      data-mermaid-js="${mediaUri('mermaid.js')}"></script>
  </body>
</html>`
  }
}

// --- sticky default-editor helpers ---

/** Whether the "remember my last editor choice" sticky default is enabled. */
function rememberLastEditorChoice(): boolean {
  return vscode.workspace.getConfiguration('quill').get<boolean>('rememberLastEditorChoice', true)
}

/**
 * The URI of the active resource, whether it is open as a markdown text editor
 * (activeTextEditor) or as our custom editor (the active tab's input). When the
 * Quill webview is focused, activeTextEditor is undefined, so we fall back to
 * the active tab, whose input is a TabInputCustom carrying the uri.
 */
function activeResourceUri(): vscode.Uri | undefined {
  const fromText = vscode.window.activeTextEditor?.document.uri
  if (fromText) return fromText
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as
    | { uri?: vscode.Uri }
    | undefined
  return input?.uri
}

// Patterns we manage in workbench.editorAssociations. We only ever touch these
// two keys; any other associations the user has set are preserved untouched.
const MD_PATTERNS = ['*.md', '*.markdown'] as const

/**
 * Point the *.md / *.markdown editor associations at `target` (either the Quill
 * viewType or "default" for the built-in text editor), merging into whatever
 * the user already has and writing at the Global target. Only writes when the
 * value actually changes, to avoid settings churn and write loops.
 */
async function setMarkdownAssociations(target: string): Promise<void> {
  const config = vscode.workspace.getConfiguration()
  const current =
    config.get<Record<string, string>>('workbench.editorAssociations') ?? {}

  // Already correct? Do nothing (this is what prevents a write loop: the
  // onDidChangeActiveTextEditor / resolve handlers can fire repeatedly).
  const alreadyCorrect = MD_PATTERNS.every(p => current[p] === target)
  if (alreadyCorrect) return

  const next: Record<string, string> = { ...current }
  for (const p of MD_PATTERNS) next[p] = target

  await config.update(
    'workbench.editorAssociations',
    next,
    vscode.ConfigurationTarget.Global,
  )
}

interface CopyResult {
  text: string | null
  html: string | null
  ok: boolean
}

async function statOrNull(uri: vscode.Uri): Promise<vscode.FileStat | null> {
  try {
    return await vscode.workspace.fs.stat(uri)
  } catch {
    return null
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  return (await statOrNull(uri)) !== null
}

// FNV-1a over the bytes, matching the app's hashBytes so the same image
// content always maps to the same assets/img-<hash> filename (re-paste dedupes).
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function getNonce(): string {
  let text = ''
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return text
}
