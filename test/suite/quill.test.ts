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
  imgCount: number
  imgSrcs: string[]
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
