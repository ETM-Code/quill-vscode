import * as path from 'node:path'
import { runTests } from '@vscode/test-electron'

async function main(): Promise<void> {
  try {
    // Compiled layout: out-test/test/runTest.js, so __dirname is out-test/test.
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..')
    const extensionTestsPath = path.resolve(__dirname, './suite/index.js')

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Disable other extensions + gpu for a clean, stable headless run.
      launchArgs: ['--disable-extensions', '--disable-gpu'],
      extensionTestsEnv: { QUILL_TEST: '1' },
    })
  } catch (err) {
    console.error('Failed to run tests:', err)
    process.exit(1)
  }
}

void main()
