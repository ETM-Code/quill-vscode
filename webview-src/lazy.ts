// On-demand loading of the two heavy engines, KaTeX and Mermaid.
//
// The webview is one IIFE bundle (media/webview.js), and esbuild cannot split an
// IIFE, so a dynamic import() would just be inlined. Instead each engine is its
// own small IIFE bundle (media/katex.js, media/mermaid.js; sources in
// webview-src/engines/) that is injected as a <script> the first time a document
// needs it. A document without math or diagrams never downloads either one.
//
// The extension host tells us where the files are through data-* attributes on
// the main <script> tag (see getHtml in src/extension.ts), and the tag's nonce
// is reused so the strict CSP (script-src 'nonce-...') still allows them.
import type { KatexOptions } from 'katex'

interface Assets {
  katexJs?: string
  katexCss?: string
  mermaidJs?: string
  nonce?: string
}

declare global {
  interface Window {
    __quillAssets?: Assets
    __quillKatex?: { render: (latex: string, el: HTMLElement, options?: KatexOptions) => void }
    __quillMermaid?: typeof import('mermaid').default
  }
}

// document.currentScript is only set while the main bundle first runs, so read
// it here at module load. window.__quillAssets is the fallback for test pages.
const assets: Assets = (() => {
  const s = document.currentScript as HTMLScriptElement | null
  if (s?.dataset.katexJs || s?.dataset.mermaidJs) {
    return {
      katexJs: s.dataset.katexJs,
      katexCss: s.dataset.katexCss,
      mermaidJs: s.dataset.mermaidJs,
      nonce: s.nonce || s.getAttribute('nonce') || undefined,
    }
  }
  return window.__quillAssets ?? {}
})()

const scripts = new Map<string, Promise<void>>()

function loadScript(url: string): Promise<void> {
  let p = scripts.get(url)
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script')
      if (assets.nonce) el.nonce = assets.nonce
      el.src = url
      el.onload = () => resolve()
      el.onerror = () => {
        scripts.delete(url)
        reject(new Error(`Could not load ${url}`))
      }
      document.head.appendChild(el)
    })
    scripts.set(url, p)
  }
  return p
}

function loadStyle(url: string): void {
  if (document.querySelector(`link[data-quill-lazy="${CSS.escape(url)}"]`)) return
  const el = document.createElement('link')
  el.rel = 'stylesheet'
  el.href = url
  el.dataset.quillLazy = url
  document.head.appendChild(el)
}

export async function loadKatexEngine(): Promise<NonNullable<Window['__quillKatex']>> {
  if (!window.__quillKatex) {
    if (!assets.katexJs) throw new Error('KaTeX bundle URL missing')
    if (assets.katexCss) loadStyle(assets.katexCss)
    await loadScript(assets.katexJs)
  }
  if (!window.__quillKatex) throw new Error('KaTeX bundle did not register')
  return window.__quillKatex
}

export async function loadMermaidEngine(): Promise<{ default: NonNullable<Window['__quillMermaid']> }> {
  if (!window.__quillMermaid) {
    if (!assets.mermaidJs) throw new Error('Mermaid bundle URL missing')
    await loadScript(assets.mermaidJs)
  }
  if (!window.__quillMermaid) throw new Error('Mermaid bundle did not register')
  return { default: window.__quillMermaid }
}
