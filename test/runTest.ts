import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runTests } from '@vscode/test-electron'

async function main(): Promise<void> {
  // The extension writes workbench.editorAssociations, so the run gets its own
  // user-data and extensions folders and never touches a real profile.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-vscode-test-'))
  try {
    // Compiled layout: out-test/test/runTest.js, so __dirname is out-test/test.
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..')
    const extensionTestsPath = path.resolve(__dirname, './suite/index.js')

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Disable other extensions + gpu for a clean, stable headless run.
      launchArgs: [
        '--disable-extensions',
        '--disable-gpu',
        `--user-data-dir=${path.join(scratch, 'user-data')}`,
        `--extensions-dir=${path.join(scratch, 'extensions')}`,
      ],
      extensionTestsEnv: { QUILL_TEST: '1' },
    })
  } catch (err) {
    console.error('Failed to run tests:', err)
    process.exitCode = 1
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

void main()
