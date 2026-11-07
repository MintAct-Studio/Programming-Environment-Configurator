'use strict'
/**
 * 界面本地化（gettext 风格：中文原文就是 key）。
 *
 * 为什么不用 t('key.path') 那种写法：
 *   项目里已有 400+ 处中文文案散在 JS 和 HTML 里，逐个改成 key 容易漏、也难 review。
 *   这里直接把「渲染出来的中文」当 msgid 查表替换，DOM 变了会自动补翻。
 *
 * 覆盖不到的地方（没进词典的长文案）会原样显示中文，不会崩。
 */
;(function () {
  const ATTRS = ['placeholder', 'title', 'aria-label']
  let dict = {}
  let fallback = null   // 英语词典，作为缺失条目的兜底
  let lang = 'en'
  let observer = null
  let enabled = false

  /** 取译文；没有就退回英语，再退回原文 */
  function t(text) {
    if (!text) return text
    const key = String(text).trim()
    if (!key) return text
    if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key]
    if (fallback && Object.prototype.hasOwnProperty.call(fallback, key)) return fallback[key]
    return text
  }

  /**
   * 带占位符的模板翻译。
   *   tf('{n} 条 · {mhz} MHz', { n: 2, mhz: 4800 })
   * 词典里同样存带占位符的模板，语序可以按语言调整。
   */
  function tf(template, vars = {}) {
    const out = String(t(template))
    if (!out.includes('{')) return out
    return out.replace(/\{(\w+)\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(vars, k) && vars[k] !== null && vars[k] !== undefined
        ? String(vars[k])
        : m
    )
  }

  /** 翻译一个文本节点（保留首尾空白） */
  function translateTextNode(node) {
    const raw = node.nodeValue
    if (!raw) return
    const trimmed = raw.trim()
    if (!trimmed) return
    const out = t(trimmed)
    if (out === trimmed) return
    const lead = raw.slice(0, raw.indexOf(trimmed))
    const tail = raw.slice(raw.indexOf(trimmed) + trimmed.length)
    node.nodeValue = lead + out + tail
  }

  function translateAttrs(el) {
    if (!el.getAttribute) return
    for (const a of ATTRS) {
      const v = el.getAttribute(a)
      if (!v) continue
      const out = t(v)
      if (out !== v) el.setAttribute(a, out)
    }
  }

  function walk(root) {
    if (!root) return
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root)
      return
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return

    translateAttrs(root)

    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    let n = tw.currentNode
    while (n) {
      if (n.nodeType === Node.TEXT_NODE) translateTextNode(n)
      else translateAttrs(n)
      n = tw.nextNode()
    }
  }

  /**
   * 源码里的字符串带着转义（`HKCU\\Environment`、`\n`），但渲染出来的 DOM 是真实字符
   * （`HKCU\Environment`、换行）。给含转义序列的键补一份反转义后的别名，否则查不到。
   */
  const ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\' }

  function withAliases(src) {
    if (!src) return null
    const out = Object.create(null)
    for (const [k, v] of Object.entries(src)) {
      out[k] = v
      if (k.includes('\\')) {
        const plain = k.replace(/\\(.)/g, (m, c) => (c in ESCAPES ? ESCAPES[c] : m))
        if (plain !== k && !(plain in out)) out[plain] = v
      }
    }
    return out
  }

  /** 词典加载 */
  async function init(options = {}) {
    try {
      const res = await window.autoed.getI18n()
      lang = (res && res.lang) || 'en'
      dict = withAliases((res && res.dict) || {}) || {}
      fallback = withAliases((res && res.fallback) || null)
    } catch {
      lang = 'en'
      dict = {}
      fallback = null
    }
    document.documentElement.setAttribute('lang', lang)
    enabled = true

    if (lang === 'zh') return lang   // 中文就是原文，不用处理

    walk(document.body)
    observe()
    return lang
  }

  /** DOM 变了自动补翻（重渲染、弹层、toast 都走这里） */
  function observe() {
    if (observer || !enabled) return
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') {
          translateTextNode(m.target)
        } else if (m.type === 'childList') {
          for (const node of m.addedNodes) walk(node)
        }
      }
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    })
  }

  window.i18n = { init, t, tf, walk, get lang() { return lang } }
})()
