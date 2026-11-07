'use strict'

// 启动画面：按 ?last=<上次下标>&seed=<随机数> 选一句填进模板，
// 收到 fadeOut() 后整层黑幕淡出，露出后面的主窗口。
const stage = document.getElementById('stage')
const enEl = document.getElementById('quoteEn')
const cnEl = document.getElementById('quoteCn')

const QUOTES = window.SPLASH_QUOTES || [{ en: 'I am the master of fate', cn: '我是命运的统帅' }]

function pickIndex() {
  const params = new URLSearchParams(location.search)
  const last = Number(params.get('last'))
  const seed = Number(params.get('seed'))

  // 指定了固定下标（截图/调试用）
  const forced = params.get('index')
  if (forced !== null && forced !== '' && !Number.isNaN(Number(forced))) {
    return Math.abs(Number(forced)) % QUOTES.length
  }

  const n = QUOTES.length
  const s = Number.isFinite(seed) ? Math.abs(seed) : Math.floor(Math.random() * 1e6)
  // 没有历史记录：纯随机
  if (!Number.isFinite(last) || last < 0) return s % n
  // 有历史记录：在「除上一句之外」的 n-1 句里挑，保证不重复
  if (n <= 1) return 0
  return (last + 1 + (s % (n - 1))) % n
}

const index = pickIndex()
const quote = QUOTES[index]

if (enEl) {
  enEl.textContent = quote.en
  // 句子越长字号越小，避免在窄窗口里挤出边界
  if (quote.en.length > 30) enEl.classList.add('en--long')
}
if (cnEl) cnEl.textContent = quote.cn

window.splash = {
  setStage() {},
  setVersion() {},
  /** 当前显示的是第几句，主进程拿去记住 */
  getIndex() {
    return index
  },
  /** 整层黑幕淡出 → 露出已被覆盖的主界面 */
  fadeOut() {
    if (stage) stage.classList.add('is-out')
  }
}
