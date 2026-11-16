// Where a clicked link goes. Pure classification (unit-testable) plus the
// host actions that carry it out:
//   #anchor              -> scroll to the heading in this document
//   http(s)/mailto/tel   -> default browser / mail app
//   www.example.com      -> https://www.example.com
//   ./notes.md[#x]       -> open in VS Code with the Quill editor
//   ./report.pdf, dir/   -> default app / Explorer
// Carrying a target out is the host's job (the extension, over postMessage).
export type LinkTarget =
  | { kind: 'anchor'; anchor: string }
  | { kind: 'external'; url: string }
  | { kind: 'markdown'; path: string; anchor: string | null }
  | { kind: 'file'; path: string }
  | { kind: 'unsupported'; href: string; reason: string }

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdx|txt)$/i
const EXTERNAL_SCHEME = /^(https?|mailto|tel):/i

export function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : '/'
}

export function normalizePath(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length) out.pop()
      continue
    }
    out.push(part)
  }
  return (abs ? '/' : '') + out.join('/')
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Classify `href` relative to the open document at `docPath` (null while
 * untitled). `home` expands a leading "~/".
 */
export function classifyLink(rawHref: string, docPath: string | null, home: string | null = null): LinkTarget {
  const href = rawHref.trim()
  if (!href) return { kind: 'unsupported', href, reason: 'Empty link' }
  if (href.startsWith('#')) return { kind: 'anchor', anchor: safeDecode(href.slice(1)) }
  if (EXTERNAL_SCHEME.test(href)) return { kind: 'external', url: href }
  if (/^www\./i.test(href)) return { kind: 'external', url: `https://${href}` }

  let pathPart = href
  let anchor: string | null = null
  if (/^file:/i.test(href)) {
    try {
      const u = new URL(href)
      pathPart = u.pathname
      anchor = u.hash ? u.hash.slice(1) : null
    } catch {
      return { kind: 'unsupported', href, reason: 'Malformed file link' }
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return { kind: 'unsupported', href, reason: `Quill can't open ${href.split(':')[0]}: links` }
  } else {
    const hash = pathPart.indexOf('#')
    if (hash >= 0) {
      anchor = pathPart.slice(hash + 1) || null
      pathPart = pathPart.slice(0, hash)
    }
    pathPart = pathPart.replace(/\?.*$/, '')
  }
  pathPart = safeDecode(pathPart)
  if (anchor) anchor = safeDecode(anchor)

  if (!pathPart) {
    // "?x" or "#" only
    return anchor ? { kind: 'anchor', anchor } : { kind: 'unsupported', href, reason: 'Empty link' }
  }

  let abs: string
  if (pathPart.startsWith('/')) {
    abs = pathPart
  } else if (pathPart.startsWith('~/') && home) {
    abs = `${home.replace(/\/$/, '')}/${pathPart.slice(2)}`
  } else if (docPath) {
    abs = `${dirname(docPath)}/${pathPart}`
  } else {
    return { kind: 'unsupported', href, reason: 'Save the document to follow relative links' }
  }
  const isDir = abs.endsWith('/')
  abs = normalizePath(abs)
  if (!isDir && MARKDOWN_EXT.test(abs)) return { kind: 'markdown', path: abs, anchor }
  return { kind: 'file', path: abs }
}

export function describeTarget(t: LinkTarget): { label: string; action: string } {
  switch (t.kind) {
    case 'anchor':
      return { label: `#${t.anchor}`, action: 'Jump to heading' }
    case 'external':
      return { label: t.url, action: /^mailto:/i.test(t.url) ? 'Compose email' : 'Open in browser' }
    case 'markdown':
      return { label: t.path.split('/').pop() ?? t.path, action: 'Open in Quill' }
    case 'file':
      return { label: t.path.split('/').pop() || t.path, action: 'Open with default app' }
    case 'unsupported':
      return { label: t.href, action: t.reason }
  }
}
