// Pure helpers for deciding what a link or path from the webview should do.
// No `vscode` import, so bun can unit-test them.

/** Files Quill opens as documents. Other text-like targets open in the normal editor. */
export function isQuillDocument(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

// Opening one of these with the system's default app can run code, so the host
// asks first (the app does the same).
const RUNNABLE = /\.(app|command|sh|bash|zsh|fish|bat|cmd|com|exe|msi|jar|scr|ps1|vbs|pkg|dmg|workflow|terminal|desktop|appimage|run)$/i

export function isRunnable(path: string): boolean {
  return RUNNABLE.test(path)
}

/** External URL schemes the webview may ask the host to open. */
export function isOpenableUrl(url: string): boolean {
  return /^(https?|mailto|tel):/i.test(url.trim())
}

/** Last path segment of a URI path, for messages. */
export function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}
