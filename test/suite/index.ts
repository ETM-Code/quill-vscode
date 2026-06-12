import * as path from 'node:path'
import Mocha from 'mocha'

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 })
  const testFile = path.resolve(__dirname, './quill.test.js')
  mocha.addFile(testFile)

  return new Promise((resolve, reject) => {
    try {
      mocha.run(failures => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed.`))
        else resolve()
      })
    } catch (err) {
      reject(err as Error)
    }
  })
}
