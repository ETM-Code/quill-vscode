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
}

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
