import { describe, expect, test } from 'bun:test'
import { classifyLink } from '../../webview-src/vendor/ui/link-router'
import { baseName, isOpenableUrl, isQuillDocument, isRunnable } from '../../src/routing'

const DOC = '/home/me/notes/doc.md'

describe('classifyLink (what the webview asks the host to do)', () => {
  test('anchors stay in the document', () => {
    expect(classifyLink('#intro', DOC)).toEqual({ kind: 'anchor', anchor: 'intro' })
  })
  test('web, mail and bare www links are external', () => {
    expect(classifyLink('https://a.dev/x', DOC)).toEqual({ kind: 'external', url: 'https://a.dev/x' })
    expect(classifyLink('mailto:a@b.c', DOC).kind).toBe('external')
    expect(classifyLink('www.a.dev', DOC)).toEqual({ kind: 'external', url: 'https://www.a.dev' })
  })
  test('relative markdown links resolve against the document folder, with their anchor', () => {
    expect(classifyLink('../other.md#deep', DOC)).toEqual({ kind: 'markdown', path: '/home/me/other.md', anchor: 'deep' })
    expect(classifyLink('sub/a%20b.md', DOC)).toEqual({ kind: 'markdown', path: '/home/me/notes/sub/a b.md', anchor: null })
  })
  test('other files and folders are plain file targets', () => {
    expect(classifyLink('./report.pdf', DOC)).toEqual({ kind: 'file', path: '/home/me/notes/report.pdf' })
    expect(classifyLink('assets/', DOC)).toEqual({ kind: 'file', path: '/home/me/notes/assets' })
  })
  test('Windows-style URI paths work because document paths are URI paths', () => {
    expect(classifyLink('b.md', '/c:/Users/me/doc.md')).toEqual({ kind: 'markdown', path: '/c:/Users/me/b.md', anchor: null })
  })
  test('~/ expands only when the host sent a home folder', () => {
    expect(classifyLink('~/x.md', DOC, '/home/me')).toEqual({ kind: 'markdown', path: '/home/me/x.md', anchor: null })
  })
  test('relative links in an untitled document are refused', () => {
    expect(classifyLink('a.md', null).kind).toBe('unsupported')
  })
  test('unknown schemes are refused', () => {
    expect(classifyLink('javascript:alert(1)', DOC).kind).toBe('unsupported')
  })
})

describe('host routing helpers', () => {
  test('only md and markdown open as Quill documents', () => {
    expect(isQuillDocument('/a/b.md')).toBe(true)
    expect(isQuillDocument('/a/b.MARKDOWN')).toBe(true)
    expect(isQuillDocument('/a/b.txt')).toBe(false)
    expect(isQuillDocument('/a/b.mdx')).toBe(false)
  })
  test('programs and scripts need confirmation', () => {
    expect(isRunnable('/a/run.command')).toBe(true)
    expect(isRunnable('/a/Tool.app')).toBe(true)
    expect(isRunnable('/a/report.pdf')).toBe(false)
  })
  test('only web, mail and phone URLs are opened externally', () => {
    expect(isOpenableUrl('https://a.dev')).toBe(true)
    expect(isOpenableUrl('mailto:a@b.c')).toBe(true)
    expect(isOpenableUrl('file:///etc/passwd')).toBe(false)
    expect(isOpenableUrl('vscode://x')).toBe(false)
  })
  test('baseName', () => {
    expect(baseName('/a/b/c.md')).toBe('c.md')
    expect(baseName('/a/b/')).toBe('b')
  })
})
