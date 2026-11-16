import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

const VIEW_TYPE = 'quill.markdownEditor'

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

interface HostCall {
  kind: 'openExternal' | 'openMarkdown' | 'openFile' | 'reveal'
  target: string
  anchor?: string | null
}

interface CopyResult {
  text: string | null
  html: string | null
  ok: boolean
}

// A minimal valid 1x1 transparent PNG, used as the local image fixture and as
// the bytes for the paste-writes-a-file test.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const SAMPLE = [
  '# Quill Test Document',
  '',
  'This paragraph has **bold text**, *italic text*, and `inline code`.',
  '',
  '## A Table',
  '',
  '| Feature | Status |',
  '| --- | --- |',
  '| Tables | yes |',
  '| Math | yes |',
  '',
  '## A Task List',
  '',
  '- [ ] First task',
  '- [x] Done task',
  '',
  '## Inline Math',
  '',
  "Euler's identity is $e^{i\\pi} + 1 = 0$ in the text.",
  '',
  '## A Code Block',
  '',
  '```python',
  'def greet(name):',
  '    return f"Hello, {name}"',
  '```',
  '',
  '## Images',
  '',
  '![a remote image](https://example.com/y.png)',
  '',
  '![](assets/p.png)',
  '',
  '## A Mermaid Diagram',
  '',
  '```mermaid',
  'graph TD',
  '  A[Start] --> B[End]',
  '```',
  '',
].join('\n')

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function probe(uri: vscode.Uri): Promise<ProbeResult> {
  return vscode.commands.executeCommand<ProbeResult>('quill._test.probe', uri.toString())
}

suite('Quill custom editor', () => {
  let tmpDir: string
  let fileUri: vscode.Uri

  suiteSetup(async function () {
    this.timeout(60000)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-test-'))
    const filePath = path.join(tmpDir, 'sample.md')
    fs.writeFileSync(filePath, SAMPLE, 'utf8')
    // The local image the sample references: assets/p.png next to the doc.
    fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'assets', 'p.png'), PNG_1x1)
    fileUri = vscode.Uri.file(filePath)

    // Ensure the extension is active.
    const ext = vscode.extensions.getExtension('etm-code.quill-vscode')
    assert.ok(ext, 'extension should be discoverable')
    await ext!.activate()

    // Open the file in our custom editor.
    await vscode.commands.executeCommand('vscode.openWith', fileUri, VIEW_TYPE)
    // Give the webview time to load the 2MB bundle, render, and report ready.
    await sleep(4000)
  })

  suiteTeardown(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  test('webview activates and renders the Tiptap document', async function () {
    this.timeout(20000)
    let result: ProbeResult | undefined
    // The webview may still be booting; retry the probe a few times.
    for (let i = 0; i < 10 && !result; i++) {
      try {
        result = await probe(fileUri)
      } catch {
        await sleep(1000)
      }
    }
    assert.ok(result, 'probe should succeed once the webview is ready')

    assert.ok(result!.nodeTypes.includes('heading'), 'should render headings')
    assert.ok(result!.nodeTypes.includes('table'), 'doc should contain a table node')
    assert.ok(result!.nodeTypes.includes('taskList'), 'doc should contain a task list node')
    assert.ok(result!.nodeTypes.includes('codeBlock'), 'doc should contain a code block node')

    assert.ok(result!.hasTable, 'a <table> should be in the DOM')
    assert.ok(result!.hasTaskList, 'a task list should be in the DOM')
    assert.ok(result!.hasCodeBlock, 'a code block should be in the DOM')
    assert.ok(result!.hasKatex, 'inline math should have rendered with KaTeX (.katex element)')
  })

  test('loaded markdown round-trips back to faithful markdown', async function () {
    this.timeout(20000)
    const result = await probe(fileUri)
    const md = result.markdown

    assert.match(md, /^# Quill Test Document/m, 'heading preserved')
    assert.match(md, /\*\*bold text\*\*/, 'bold preserved')
    assert.match(md, /\| Feature \| Status \|/, 'table header preserved')
    assert.match(md, /- \[ \] First task/, 'unchecked task preserved')
    assert.match(md, /- \[x\] Done task/, 'checked task preserved')
    assert.match(md, /\$e\^\{i\\pi\} \+ 1 = 0\$/, 'inline math preserved')
    assert.match(md, /```python[\s\S]*def greet\(name\):/, 'python code block preserved')
  })

  test('both a remote and a local image render as <img> and round-trip', async function () {
    this.timeout(20000)
    const result = await probe(fileUri)

    // The image node type is present in the document.
    assert.ok(result.nodeTypes.includes('image'), 'doc should contain an image node')

    // Both images render as <img class="quill-image"> in the DOM.
    assert.strictEqual(result.imgCount, 2, 'both images should render as <img>')

    // The remote image keeps its https URL; the local one resolves to a
    // vscode webview resource URI (not the raw relative path).
    const srcs = result.imgSrcs.join('\n')
    assert.match(srcs, /https:\/\/example\.com\/y\.png/, 'remote image src preserved')
    assert.ok(
      result.imgSrcs.some(s => /vscode-(resource|webview|cdn)|https:\/\/file/.test(s) && /p\.png/.test(s)),
      `local image should resolve to a webview URI, got: ${JSON.stringify(result.imgSrcs)}`,
    )

    // Markdown round-trips: both image links serialize back faithfully.
    assert.match(result.markdown, /!\[a remote image\]\(https:\/\/example\.com\/y\.png\)/, 'remote image markdown preserved')
    assert.match(result.markdown, /!\[\]\(assets\/p\.png\)/, 'local image markdown preserved')
  })

  test('a mermaid fence renders an SVG and round-trips', async function () {
    this.timeout(40000)
    // Mermaid lazy-renders; retry until the SVG appears (or give up).
    let result = await probe(fileUri)
    // The engine is a separate script (media/mermaid.js) fetched on first use.
    for (let i = 0; i < 30 && !result.hasMermaidSvg; i++) {
      await sleep(800)
      result = await probe(fileUri)
    }
    assert.ok(result.nodeTypes.includes('mermaid'), 'doc should contain a mermaid node')
    assert.ok(result.hasMermaidSvg, 'the mermaid diagram should render an <svg> under the webview CSP')
    // The ```mermaid fence serializes back faithfully (not as a plain code block).
    assert.match(
      result.markdown,
      /```mermaid\ngraph TD\n {2}A\[Start\] --> B\[End\]\n```/,
      'mermaid fence preserved on round-trip',
    )
  })

  test('pasting an image into a saved doc writes assets/ and inserts a link', async function () {
    this.timeout(20000)
    const doc = await vscode.workspace.openTextDocument(fileUri)

    // Drive the real paste path: insertImageBytes -> saver -> host writes file.
    await vscode.commands.executeCommand(
      'quill._test.simulatePasteImage',
      fileUri.toString(),
      Array.from(PNG_1x1),
      'png',
    )

    // The host writes assets/img-<fnv>.png and the webview inserts a link to it.
    // The fnv1a hash of this exact PNG is deterministic; wait for the file and
    // the doc to reflect the inserted link.
    let inserted = false
    let writtenRel = ''
    for (let i = 0; i < 30 && !inserted; i++) {
      await sleep(300)
      const m = /!\[\]\((assets\/img-[0-9a-f]{8}\.png)\)/.exec(doc.getText())
      if (m) {
        inserted = true
        writtenRel = m[1]
      }
    }
    assert.ok(inserted, `the pasted image link should appear in the document, got:\n${doc.getText()}`)

    // The bytes were actually written to disk under assets/.
    const onDisk = path.join(tmpDir, writtenRel)
    assert.ok(fs.existsSync(onDisk), `image file should exist at ${onDisk}`)
    assert.ok(fs.readFileSync(onDisk).length > 0, 'written image file should be non-empty')

    // And the new image renders in the editor (now 3 images: 2 original + pasted).
    const result = await probe(fileUri)
    assert.ok(result.imgCount >= 3, `pasted image should render too, count=${result.imgCount}`)
  })

  test('a webview edit updates the underlying TextDocument', async function () {
    this.timeout(20000)
    const doc = await vscode.workspace.openTextDocument(fileUri)

    const edited = SAMPLE + '\nA new paragraph added from the editor.\n'
    await vscode.commands.executeCommand(
      'quill._test.simulateEdit',
      fileUri.toString(),
      edited,
    )

    // Wait for the debounced edit -> WorkspaceEdit -> document update.
    let updated = false
    for (let i = 0; i < 20 && !updated; i++) {
      await sleep(300)
      updated = doc.getText().includes('A new paragraph added from the editor.')
    }
    assert.ok(updated, 'the TextDocument should reflect the webview edit')

    // And the document should still be valid, re-serializable markdown: probe
    // again and confirm the new content is present in the editor's serialization.
    const result = await probe(fileUri)
    assert.match(
      result.markdown,
      /A new paragraph added from the editor\./,
      're-serialized markdown should contain the new paragraph',
    )
    // Structure must survive the edit too.
    assert.match(result.markdown, /\| Feature \| Status \|/, 'table survived the edit')
    assert.match(result.markdown, /\$e\^\{i\\pi\} \+ 1 = 0\$/, 'math survived the edit')
  })

  test('an external document change reloads the webview', async function () {
    this.timeout(20000)
    // Replace the document via a WorkspaceEdit NOT originating from the webview.
    const doc = await vscode.workspace.openTextDocument(fileUri)
    const newText = '# Replaced Externally\n\nJust one heading now.\n'
    const edit = new vscode.WorkspaceEdit()
    edit.replace(
      fileUri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      newText,
    )
    await vscode.workspace.applyEdit(edit)

    let result: ProbeResult | undefined
    for (let i = 0; i < 20; i++) {
      await sleep(300)
      result = await probe(fileUri)
      if (/# Replaced Externally/.test(result.markdown)) break
    }
    assert.match(
      result!.markdown,
      /# Replaced Externally/,
      'webview should reload to show the externally-changed content',
    )
    assert.ok(!result!.hasTable, 'old table should be gone after external replace')
  })
})

suite('Quill commands and sticky default editor', () => {
  function associations(): Record<string, string> {
    return (
      vscode.workspace
        .getConfiguration()
        .get<Record<string, string>>('workbench.editorAssociations') ?? {}
    )
  }

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('etm-code.quill-vscode')
    assert.ok(ext, 'extension should be discoverable')
    await ext!.activate()
  })

  test('both switch commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true)
    assert.ok(
      commands.includes('quill.openWithQuill'),
      'quill.openWithQuill should be registered',
    )
    assert.ok(
      commands.includes('quill.openWithTextEditor'),
      'quill.openWithTextEditor should be registered',
    )
  })

  test('opening a .md with Quill makes Quill the default for *.md / *.markdown', async function () {
    this.timeout(30000)
    // The setting defaults to true; the first suite already opened a file with
    // Quill, but make this self-contained with its own file.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-assoc-'))
    const filePath = path.join(tmpDir, 'doc.md')
    fs.writeFileSync(filePath, '# Sticky default\n', 'utf8')
    const uri = vscode.Uri.file(filePath)

    try {
      // Start from a known state: clear our two keys.
      await vscode.workspace
        .getConfiguration()
        .update(
          'workbench.editorAssociations',
          {},
          vscode.ConfigurationTarget.Global,
        )

      // Resolving the Quill custom editor should sync the associations to Quill.
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)

      let assoc = associations()
      for (let i = 0; i < 20 && assoc['*.md'] !== VIEW_TYPE; i++) {
        await sleep(200)
        assoc = associations()
      }
      assert.strictEqual(
        assoc['*.md'],
        VIEW_TYPE,
        '*.md should be associated with Quill after opening with Quill',
      )
      assert.strictEqual(
        assoc['*.markdown'],
        VIEW_TYPE,
        '*.markdown should be associated with Quill after opening with Quill',
      )
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('opening a .md as a text editor flips the default back to text', async function () {
    this.timeout(30000)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-assoc-'))
    const filePath = path.join(tmpDir, 'doc2.md')
    fs.writeFileSync(filePath, '# Back to text\n', 'utf8')
    const uri = vscode.Uri.file(filePath)

    try {
      // Pre-seed Quill as the default so we can observe the flip to "default".
      await vscode.workspace
        .getConfiguration()
        .update(
          'workbench.editorAssociations',
          { '*.md': VIEW_TYPE, '*.markdown': VIEW_TYPE },
          vscode.ConfigurationTarget.Global,
        )

      // Open as a plain text editor; this makes a markdown TEXT editor active,
      // which the onDidChangeActiveTextEditor listener turns into "default".
      const doc = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(doc)

      let assoc = associations()
      for (let i = 0; i < 20 && assoc['*.md'] !== 'default'; i++) {
        await sleep(200)
        assoc = associations()
      }
      assert.strictEqual(
        assoc['*.md'],
        'default',
        '*.md should flip back to the built-in editor after opening as text',
      )
      assert.strictEqual(
        assoc['*.markdown'],
        'default',
        '*.markdown should flip back to the built-in editor after opening as text',
      )
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('unrelated editor associations are preserved', async function () {
    this.timeout(30000)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-assoc-'))
    const filePath = path.join(tmpDir, 'doc3.md')
    fs.writeFileSync(filePath, '# Preserve others\n', 'utf8')
    const uri = vscode.Uri.file(filePath)

    try {
      // A key Quill must never touch.
      await vscode.workspace
        .getConfiguration()
        .update(
          'workbench.editorAssociations',
          { '*.svg': 'default', '*.md': 'default', '*.markdown': 'default' },
          vscode.ConfigurationTarget.Global,
        )

      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)

      let assoc = associations()
      for (let i = 0; i < 20 && assoc['*.md'] !== VIEW_TYPE; i++) {
        await sleep(200)
        assoc = associations()
      }
      assert.strictEqual(assoc['*.md'], VIEW_TYPE, 'Quill key updated')
      assert.strictEqual(
        assoc['*.svg'],
        'default',
        'the unrelated *.svg association must be preserved',
      )
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Fidelity, new syntax, links, clipboard and keybindings
// ---------------------------------------------------------------------------

// Front matter, an angle-bracket placeholder, an escaped pipe in a table cell,
// a tilde fence, a nested ordered list and a footnote: the constructs an older
// parser rewrote. Odd spacing is deliberate (the opening and saving must not
// normalise it).
const FIDELITY = [
  '---',
  'title: "Fidelity"',
  'tags: [a,   b]',
  '---',
  '',
  '# Fidelity check',
  '',
  'Set <API_KEY> before running, and keep Vec<T> as written.',
  '',
  '| Name | Pattern |',
  '|:-----|--------:|',
  '| or   | a \\| b   |',
  '',
  '~~~sh',
  'echo "tilde fence"',
  '~~~',
  '',
  '1. first',
  '   1. nested one',
  '   2. nested two',
  '2. second',
  '',
  'A claim with a note.[^1]',
  '',
  '[^1]: The footnote text.',
  '',
  '> [!NOTE]',
  '> A callout.',
  '',
  '> [!WARNING] Custom label',
  '> Another one.',
  '',
  '<details>',
  '<summary>More</summary>',
  '',
  'Hidden text.',
  '',
  '</details>',
  '',
  'Use ==highlight==, H<sub>2</sub>O, x<sup>2</sup> and <kbd>Ctrl</kbd>.',
  '',
  'Last paragraph.',
  '',
].join('\n')

async function openQuill(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)
  for (let i = 0; i < 40; i++) {
    const info = await vscode.commands.executeCommand<{ ready: boolean } | null>(
      'quill._test.sessionInfo',
      uri.toString(),
    )
    if (info?.ready) break
    await sleep(250)
  }
  // First init arrives right after ready; wait until the probe sees content.
  for (let i = 0; i < 40; i++) {
    try {
      if ((await probe(uri)).markdown.length > 0) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
}

async function takeCalls(): Promise<HostCall[]> {
  return vscode.commands.executeCommand<HostCall[]>('quill._test.takeCalls')
}

suite('Quill markdown fidelity and new syntax', () => {
  let tmpDir: string
  let fileUri: vscode.Uri

  suiteSetup(async function () {
    this.timeout(60000)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-fidelity-'))
    const filePath = path.join(tmpDir, 'fidelity.md')
    fs.writeFileSync(filePath, FIDELITY, 'utf8')
    fileUri = vscode.Uri.file(filePath)
    await vscode.extensions.getExtension('etm-code.quill-vscode')!.activate()
    await openQuill(fileUri)
  })

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('opening writes the same text back, byte for byte', async function () {
    this.timeout(20000)
    const result = await probe(fileUri)
    assert.strictEqual(result.markdown, FIDELITY)
    assert.strictEqual((await vscode.workspace.openTextDocument(fileUri)).getText(), FIDELITY)
  })

  test('front matter, footnotes, details, highlight and callouts render', async function () {
    this.timeout(20000)
    const r = await probe(fileUri)
    assert.ok(r.hasFrontMatter, 'front matter block')
    assert.ok(r.hasFootnote, 'footnote reference or definition')
    assert.ok(r.hasDetails, '<details> block')
    assert.ok(r.hasHighlight, '==highlight== renders as <mark>')
    assert.ok(r.hasCallout, 'callout renders')
    assert.deepStrictEqual(r.calloutKinds.map(k => k.toLowerCase()), ['note', 'warning'])
    for (const type of ['subscript', 'superscript', 'kbd']) {
      assert.ok(r.nodeTypes.includes(type) || /<(sub|sup|kbd)>/.test(r.markdown), `${type} survives`)
    }
  })

  test('autocorrect and Typography are off', async function () {
    this.timeout(20000)
    const r = await probe(fileUri)
    assert.strictEqual(r.autocorrect, 'off')
    assert.strictEqual(r.typographyActive, false)
  })

  test('editing one paragraph leaves every other byte alone after save', async function () {
    this.timeout(30000)
    const doc = await vscode.workspace.openTextDocument(fileUri)
    await vscode.commands.executeCommand(
      'quill._test.simulate',
      fileUri.toString(),
      { type: 'simulateAppendText', find: 'Last paragraph', text: ' Edited.' },
    )
    const expected = FIDELITY.replace('Last paragraph.', 'Last paragraph. Edited.')
    for (let i = 0; i < 30 && doc.getText() !== expected; i++) await sleep(300)
    assert.strictEqual(doc.getText(), expected, 'only the edited paragraph changes in the document')
    assert.ok(await doc.save(), 'save succeeds')
    assert.strictEqual(fs.readFileSync(fileUri.fsPath, 'utf8'), expected, 'file on disk matches')
  })
})

suite('Quill CRLF documents', () => {
  test('a CRLF file stays CRLF through open, an edit elsewhere, and save', async function () {
    this.timeout(60000)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-crlf-'))
    const file = path.join(tmp, 'crlf.md')
    const original = '# Title\r\n\r\nFirst line.\r\n\r\n- a\r\n- b\r\n\r\nEnd.\r\n'
    fs.writeFileSync(file, original, 'utf8')
    const uri = vscode.Uri.file(file)
    try {
      await openQuill(uri)
      const doc = await vscode.workspace.openTextDocument(uri)
      assert.strictEqual(doc.eol, vscode.EndOfLine.CRLF)
      await sleep(600)
      assert.strictEqual(doc.isDirty, false, 'opening alone must not dirty the document')
      await vscode.commands.executeCommand('quill._test.simulate', uri.toString(), {
        type: 'simulateAppendText',
        find: 'End.',
        text: ' Done.',
      })
      const expected = original.replace('End.', 'End. Done.')
      for (let i = 0; i < 30 && doc.getText() !== expected; i++) await sleep(300)
      assert.strictEqual(doc.getText(), expected)
      await doc.save()
      assert.strictEqual(fs.readFileSync(file, 'utf8'), expected)
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

suite('Quill links, images and outline', () => {
  let tmpDir: string
  let fileUri: vscode.Uri
  const DOC = [
    '# Links',
    '',
    '## Target heading',
    '',
    'Body text.',
    '',
    '![pic](assets/p.png)',
    '',
  ].join('\n')

  suiteSetup(async function () {
    this.timeout(60000)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-links-'))
    fs.mkdirSync(path.join(tmpDir, 'assets'))
    fs.mkdirSync(path.join(tmpDir, 'sub'))
    fs.writeFileSync(path.join(tmpDir, 'assets', 'p.png'), PNG_1x1)
    fs.writeFileSync(path.join(tmpDir, 'other.md'), '# Other\n\n## Deep section\n\nText.\n', 'utf8')
    fs.writeFileSync(path.join(tmpDir, 'report.pdf'), '%PDF-1.4\n', 'utf8')
    fileUri = vscode.Uri.file(path.join(tmpDir, 'links.md'))
    fs.writeFileSync(fileUri.fsPath, DOC, 'utf8')
    await vscode.extensions.getExtension('etm-code.quill-vscode')!.activate()
    await openQuill(fileUri)
  })

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function click(href: string): Promise<HostCall[]> {
    await takeCalls()
    await vscode.commands.executeCommand('quill._test.simulateOpenLink', fileUri.toString(), href)
    await sleep(700)
    return takeCalls()
  }

  test('web links go to the external-link handler', async function () {
    this.timeout(20000)
    const calls = await click('https://example.com/page')
    assert.deepStrictEqual(calls, [{ kind: 'openExternal', target: 'https://example.com/page' }])
    assert.deepStrictEqual(await click('www.example.com'), [{ kind: 'openExternal', target: 'https://www.example.com' }])
  })

  test('an anchor link scrolls inside the document and calls no host handler', async function () {
    this.timeout(20000)
    assert.deepStrictEqual(await click('#target-heading'), [])
  })

  test('a relative .md link opens in VS Code with the Quill editor, at the anchor', async function () {
    this.timeout(40000)
    const calls = await click('./other.md#deep-section')
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].kind, 'openMarkdown')
    assert.strictEqual(calls[0].target, vscode.Uri.file(path.join(tmpDir, 'other.md')).toString())
    assert.strictEqual(calls[0].anchor, 'deep-section')
    // The new tab is a Quill custom editor for other.md.
    let input: unknown
    for (let i = 0; i < 20; i++) {
      input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
      if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) break
      await sleep(250)
    }
    assert.ok(input instanceof vscode.TabInputCustom, 'active tab is a custom editor')
    assert.strictEqual((input as vscode.TabInputCustom).viewType, VIEW_TYPE)
    assert.strictEqual((input as vscode.TabInputCustom).uri.fsPath, path.join(tmpDir, 'other.md'))
    // Come back to the first document for the remaining tests.
    await vscode.commands.executeCommand('vscode.openWith', fileUri, VIEW_TYPE)
    await sleep(500)
  })

  test('other local files go to the file handler; missing files do not', async function () {
    this.timeout(20000)
    const calls = await click('./report.pdf')
    assert.deepStrictEqual(calls, [{ kind: 'openFile', target: vscode.Uri.file(path.join(tmpDir, 'report.pdf')).toString() }])
    assert.deepStrictEqual(await click('./nope.pdf'), [], 'a missing file is reported, not opened')
  })

  test('image open and reveal messages route to the right handlers', async function () {
    this.timeout(20000)
    await takeCalls()
    const imgPath = path.posix.join(vscode.Uri.file(tmpDir).path, 'assets', 'p.png')
    await vscode.commands.executeCommand('quill._test.hostMessage', fileUri.toString(), {
      type: 'openPath', kind: 'file', path: imgPath, anchor: null,
    })
    await vscode.commands.executeCommand('quill._test.hostMessage', fileUri.toString(), {
      type: 'revealPath', path: imgPath,
    })
    const calls = await takeCalls()
    assert.deepStrictEqual(calls.map(c => c.kind), ['openFile', 'reveal'])
    assert.ok(calls.every(c => c.target.endsWith('/assets/p.png')))
  })

  test('the local image renders from the document folder', async function () {
    this.timeout(20000)
    const r = await probe(fileUri)
    assert.ok(r.imgSrcs.some(s => /p\.png/.test(s) && /^https:/.test(s)), JSON.stringify(r.imgSrcs))
  })

  test('the outline toggles from its command', async function () {
    this.timeout(20000)
    assert.strictEqual((await probe(fileUri)).outlineVisible, false)
    await vscode.commands.executeCommand('quill.toggleOutline')
    let on = false
    for (let i = 0; i < 20 && !on; i++) {
      await sleep(200)
      on = (await probe(fileUri)).outlineVisible
    }
    assert.ok(on, 'outline visible')
    await vscode.commands.executeCommand('quill.toggleOutline')
    await sleep(400)
    assert.strictEqual((await probe(fileUri)).outlineVisible, false)
  })
})

suite('Quill clipboard', () => {
  let tmpDir: string
  let fileUri: vscode.Uri
  const CODE = "git commit -m \"msg\"\nprintf '%s\\n' \"$HOME\"\n  indented line"
  const DOC = ['# Copy', '', 'Some *text* here.', '', '```sh', CODE, '```', ''].join('\n')

  suiteSetup(async function () {
    this.timeout(60000)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-clip-'))
    fileUri = vscode.Uri.file(path.join(tmpDir, 'copy.md'))
    fs.writeFileSync(fileUri.fsPath, DOC, 'utf8')
    await vscode.extensions.getExtension('etm-code.quill-vscode')!.activate()
    await openQuill(fileUri)
  })

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('the copy event on a selected code block carries the raw code and rich HTML', async function () {
    this.timeout(20000)
    const r = await vscode.commands.executeCommand<CopyResult>('quill._test.copy', fileUri.toString(), 'selectAllCode')
    assert.strictEqual(r.text, CODE, 'text/plain is the raw code, no fences')
    assert.ok(r.html && /<pre|<code/.test(r.html), 'text/html carries rich HTML')
  })

  test('the code block copy button puts the raw code on the system clipboard', async function () {
    this.timeout(20000)
    await vscode.env.clipboard.writeText('sentinel')
    const r = await vscode.commands.executeCommand<CopyResult>('quill._test.copy', fileUri.toString(), 'copyButton')
    assert.ok(r.ok, 'the button reports success')
    assert.strictEqual(await vscode.env.clipboard.readText(), CODE)
  })

  test('Copy as Plain Text (Alt+Shift+Cmd/Ctrl+C) writes rendered text without markdown', async function () {
    this.timeout(20000)
    await vscode.env.clipboard.writeText('sentinel')
    await vscode.commands.executeCommand('quill._test.copy', fileUri.toString(), 'plain')
    const text = await vscode.env.clipboard.readText()
    assert.ok(text.includes('Some text here.'), `plain text should drop emphasis marks, got: ${text}`)
    assert.ok(!text.includes('# Copy') && !text.includes('*text*'), 'no markdown syntax')
  })
})

suite('Quill keybindings', () => {
  const WHEN = 'activeCustomEditorId == quill.markdownEditor'
  interface Binding { command: string; key: string; mac?: string; when?: string }

  test('every contributed keybinding is scoped to the Quill editor and targets a registered command', async () => {
    const ext = vscode.extensions.getExtension('etm-code.quill-vscode')!
    const bindings: Binding[] = ext.packageJSON.contributes.keybindings
    assert.ok(bindings.length > 0)
    const commands = await vscode.commands.getCommands(true)
    for (const b of bindings) {
      assert.strictEqual(b.when, WHEN, `${b.command} ${b.key} must be scoped`)
      assert.ok(commands.includes(b.command), `${b.command} must exist`)
    }
  })

  test('the clashing shortcuts are covered', () => {
    const ext = vscode.extensions.getExtension('etm-code.quill-vscode')!
    const bindings: Binding[] = ext.packageJSON.contributes.keybindings
    const macKeys = new Set(bindings.map(b => b.mac))
    for (const key of ['cmd+alt+shift+c', 'cmd+shift+m', 'cmd+shift+o', 'cmd+/', 'cmd+b', 'cmd+shift+x', 'cmd+shift+h']) {
      assert.ok(macKeys.has(key), `${key} should be contributed`)
    }
    const byMac = (k: string) => bindings.find(b => b.mac === k)!.command
    assert.strictEqual(byMac('cmd+shift+o'), 'quill.toggleOutline')
    assert.strictEqual(byMac('cmd+/'), 'quill.openWithTextEditor')
  })
})
