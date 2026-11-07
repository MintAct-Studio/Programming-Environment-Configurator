'use strict'
const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('node:path')
const fs = require('node:fs/promises')

const { probePermission } = require('../core/permission')
const { probeHardware } = require('../core/hardware')
const { installPlan, importManualComponent } = require('../core/installer')
const { buildPlan, getScenarios, getComponent } = require('../core/recommend')
const { migrateComponent, buildStatusReport } = require('../core/migrate')
const { uninstallComponent, planUninstall } = require('../core/uninstall')
const { validateTarget, probeWritable } = require('../core/validate')
const { catalog: appCatalog, listVersions: listAppVersions, installApp } = require('../core/apps')
const http = require('../core/http')
const logger = require('../core/logger')
const lockfile = require('../core/lockfile')
const { parse: parseLog } = require('../core/logparse')
const { loadState } = require('../core/state')
const { pickInstallRoot } = require('../core/drive')

/** 支持的界面语言（默认英语） */
const DEFAULT_LOCALE = 'en'
const SUPPORTED_LOCALES = ['en', 'zh', 'ja', 'ru', 'ko', 'fr']

/** 最近一次探测结果：主进程缓存，避免每改一次选项就重新查一遍系统 */
let envCache = null
let mainWindow = null

/** 界面完成首次渲染的信号（截图/自动化用），由 preload 的 notifyReady 触发 */
let markUiReady
const uiReady = new Promise((resolve) => { markUiReady = resolve })

/** 同一时间只允许一个安装任务 */
let installRunning = false

/** 跨窗口共享的状态快照（主窗口负责写入，其它窗口只读） */
const syncState = {
  selection: [],
  installRoot: pickInstallRoot(),
  plan: null,
  status: null
}

/** 启动画面窗口（截图模式下不创建） */
let splashWindow = null

function setSplashStage(stage) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.executeJavaScript(`window.splash.setStage(${JSON.stringify(stage)})`).catch(() => {})
  }
}

async function createSplash() {
  // 启动画面要「盖住整个 app 窗口」：与主窗口同尺寸、同位置，
  // 淡出后露出下面已经渲染好的主界面。
  const bounds =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getBounds()
      : null

  // 每句轮换：把上次用过的下标和一个随机种子交给渲染进程，保证不连着重复
  const settings = await readSettings().catch(() => ({}))
  const query = { seed: String(Math.floor(Math.random() * 1e6)) }
  if (Number.isFinite(settings.lastSplashIndex)) query.last = String(settings.lastSplashIndex)

  const forced = process.argv.find((a) => a.startsWith('--splash-quote='))
  if (forced) query.index = forced.slice('--splash-quote='.length)

  splashWindow = new BrowserWindow({
    ...(bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : { width: 1120, height: 800 }),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'AutoED',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })

  splashWindow.loadFile(path.join(__dirname, '../renderer/splash.html'), { query })
  splashWindow.once('ready-to-show', async () => {
    if (!splashWindow || splashWindow.isDestroyed()) return
    splashWindow.show()
    // 记住这一句，下次换别的
    try {
      const idx = await splashWindow.webContents.executeJavaScript('window.splash.getIndex()')
      if (Number.isFinite(idx)) {
        const next = { ...(await readSettings()), lastSplashIndex: idx }
        await writeSettings(next)
      }
    } catch {
      /* 取不到就算了，不影响启动 */
    }
  })
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
  splashWindow = null
}

/* ---------- 自动更新（方案 A：NSIS + electron-updater，手动触发下载） ---------- */

let updateState = { status: 'idle', version: '', percent: 0, error: '', currentVersion: '' }

function broadcastUpdate(patch = {}) {
  updateState = { ...updateState, ...patch }
  mainWindow?.webContents.send('update:state', updateState)
}

function setupUpdater() {
  updateState.currentVersion = app.getVersion()

  // 开发用：--force-update=0.1.1 直接伪造"有更新"状态，用于验证界面
  const forced = process.argv.find((a) => a.startsWith('--force-update='))
  if (forced) {
    broadcastUpdate({ status: 'available', version: forced.slice('--force-update='.length) })
    return
  }

  // 便携版没法替换运行中的自身，electron-updater 不支持这种形态
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    updateState.status = 'unsupported'
    return
  }
  // 开发模式没有 app-update.yml，直接跳过
  if (!app.isPackaged) {
    updateState.status = 'dev'
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => broadcastUpdate({ status: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    broadcastUpdate({ status: 'available', version: info.version, notes: info.releaseNotes || '' })
  )
  autoUpdater.on('update-not-available', () => broadcastUpdate({ status: 'none' }))
  autoUpdater.on('download-progress', (p) => broadcastUpdate({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => broadcastUpdate({ status: 'ready', version: info.version, percent: 100 }))
  autoUpdater.on('error', (err) => broadcastUpdate({ status: 'error', error: String(err?.message || err) }))

  // 每次启动检查一次；延后几秒，避免和硬件探测抢资源
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => broadcastUpdate({ status: 'error', error: String(err?.message || err) }))
  }, 6000)
}

/* ---------- 本地设置（记录"注意事项是否已读"这类状态） ---------- */

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
async function readSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8')
    // 外部工具（记事本、PowerShell 的 UTF8 编码）可能会写入 BOM，
    // 直接 JSON.parse 会抛错并让所有设置退回默认值，这里先去掉
    return JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

async function writeSettings(next) {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true })
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
}

/**
 * 应用代理设置。
 * 两边都要设：session 影响渲染进程与 net.fetch，http 模块让 Node 侧的请求也跟上。
 */
async function applyProxySettings(rules) {
  const proxy = String(rules || '').trim()
  http.setProxy(proxy)
  try {
    if (proxy) {
      await session.defaultSession.setProxy({ proxyRules: proxy })
      logger.info('net', `代理已设置：${proxy}`)
    } else {
      await session.defaultSession.setProxy({ mode: 'system' })
      logger.info('net', '代理：跟随系统')
    }
  } catch (err) {
    logger.error('net', `代理设置失败：${err.message}`)
  }
  return proxy
}

/* ---------- 面板独立窗口 ---------- */

const PANEL_TITLES = {
  hw: '设备信息',
  scenarios: '你要做什么',
  plan: '推荐方案',
  support: '助力发电',
  diag: '诊断'
}

const panelWindows = new Map()

/** 广播给所有窗口（主窗口 + 已拖出的面板窗口） */
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function createPanelWindow(panel, pos) {
  const key = String(panel || '')
  if (!PANEL_TITLES[key]) return null

  const existing = panelWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return existing
  }

  const wide = key === 'diag' || key === 'plan'
  const win = new BrowserWindow({
    width: wide ? 900 : 720,
    height: wide ? 740 : 660,
    minWidth: 480,
    minHeight: 360,
    x: pos?.x,
    y: pos?.y,
    backgroundColor: '#0d1017',
    show: false,
    title: `AutoED · ${PANEL_TITLES[key]}`,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { detached: key } })
  if (process.argv.includes('--debug-renderer')) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${key}] ${message} (${source}:${line})`)
    })
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log(`[renderer:${key}] did-fail-load ${code} ${desc}`)
    })
  }
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => panelWindows.delete(key))
  panelWindows.set(key, win)
  logger.info('ui', `打开独立窗口：${PANEL_TITLES[key]}`)
  return win
}

function createWindow() {
  const shotMode = process.argv.some((a) => a.startsWith('--screenshot='))

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: '#0d1017',
    show: false,
    title: 'AutoED — 环境自动配置',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 安全基线：渲染进程拿不到 Node，所有系统操作只能通过 preload 暴露的白名单接口
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    // 截图模式立刻显示；正常启动时等界面渲染完（期间由启动画面顶着）
    if (shotMode) {      mainWindow.show()
    } else {
      let shown = false
      const reveal = () => {
        if (shown || !mainWindow || mainWindow.isDestroyed()) return
        shown = true
        // 先让主界面在下面亮出来，再让启动画面的黑幕淡出，形成"黑幕化开、露出主页"的效果
        mainWindow.show()
        if (splashWindow && !splashWindow.isDestroyed()) {
          splashWindow.webContents.executeJavaScript('window.splash.fadeOut()').catch(() => {})
          setTimeout(closeSplash, 640) // 略大于 0.55s 的淡出时长
        } else {
          closeSplash()
        }
      }
      uiReady.then(reveal)
      setTimeout(reveal, 25000) // 界面异常时兜底，绝不把用户永久卡在启动画面
    }
  })
  // --demo=ai,cpp 会在界面加载后自动勾选这些方向，方便截图与演示
  const demoArg = process.argv.find((a) => a.startsWith('--demo='))
  const query = {}
  if (demoArg) query.demo = demoArg.slice('--demo='.length)
  if (process.argv.includes('--auto-install')) query.install = '1'
  if (process.argv.includes('--show-locations')) query.locations = '1'
  if (process.argv.includes('--show-diag')) query.diag = '1'
  if (process.argv.includes('--show-software')) query.software = '1'
  if (process.argv.includes('--show-advanced')) query.advanced = '1'
  const lockArg = process.argv.find((a) => a.startsWith('--demo-lock='))
  if (lockArg) query.lock = lockArg.slice('--demo-lock='.length)
  // 开发用：--install-one=ninja 只装一个小组件，用于截取真实安装进度
  const installOneArg = process.argv.find((a) => a.startsWith('--install-one='))
  if (installOneArg) query.installone = installOneArg.slice('--install-one='.length)
  if (process.argv.includes('--show-tutorial')) query.tutorial = '1'
  if (process.argv.includes('--no-tutorial')) query.tutorial = '0'
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), Object.keys(query).length ? { query } : undefined)

  // 开发用：--screenshot=<路径> 会在页面渲染完成后截图并退出，
  // 用于在无人工介入的情况下验证界面。生产构建下不会触发。
  const shotArg = process.argv.find((a) => a.startsWith('--screenshot='))
  if (shotArg) {
    const target = shotArg.slice('--screenshot='.length)
    mainWindow.webContents.once('did-finish-load', async () => {
      // 等界面真正渲染完（硬件探测耗时波动，不能用固定延时）
      // 兜底超时给到 30 分钟：--auto-install 模式下要等整轮安装结束
      await Promise.race([uiReady, new Promise((r) => setTimeout(r, 30 * 60 * 1000))])
      await new Promise((r) => setTimeout(r, 800))

      // 轮询等界面真正渲染出内容（硬件卡片与场景按钮），避免抓到首帧骨架屏
      for (let i = 0; i < 40; i++) {
        const ready = await mainWindow.webContents
          .executeJavaScript("!!document.querySelector('.hw-card__value') && document.querySelectorAll('.scenario').length > 0")
          .catch(() => false)
        if (ready) break
        await new Promise((r) => setTimeout(r, 250))
      }
      // --wait-update：等更新检查有结果再截图（验证更新功能时用）
      if (process.argv.includes('--wait-update')) {
        for (let i = 0; i < 60; i++) {
          if (['available', 'ready', 'none', 'error', 'unsupported', 'dev'].includes(updateState.status)) break
          await new Promise((r) => setTimeout(r, 500))
        }
        await new Promise((r) => setTimeout(r, 600))
      }

      // --scroll=bottom：截图前滚到页面底部，用于展示方案表
      if (process.argv.includes('--scroll=bottom')) {
        await mainWindow.webContents.executeJavaScript(
          "document.querySelector('main').scrollTop = document.querySelector('main').scrollHeight"
        )
        await new Promise((r) => setTimeout(r, 700))
      }
      // 强制重绘后再截图，避免抓到窗口首帧（安装版上尤其明显）
      mainWindow.webContents.invalidate?.()
      // --shot-scroll=<选择器>：把指定元素滚到可视区再截（验证长面板/长列表时用）
      const shotScroll = process.argv.find((a) => a.startsWith('--shot-scroll='))
      if (shotScroll) {
        const sel = shotScroll.slice('--shot-scroll='.length)
        await mainWindow.webContents
          .executeJavaScript(
            `(() => {
              const n = document.querySelector(${JSON.stringify(sel)})
              if (!n) return false
              // 元素本身可能是滚动容器（如弹层 body），先把它滚到底
              if (n.scrollHeight > n.clientHeight) n.scrollTop = n.scrollHeight
              n.scrollIntoView({ block: 'end' })
              return true
            })()`
          )
          .catch(() => {})
        await new Promise((r) => setTimeout(r, 500))
      }
      // --shot-delay=<ms>：截图前额外等待，用来抓"安装进行中"这类过程画面
      const delayArg = process.argv.find((a) => a.startsWith('--shot-delay='))
      const extraDelay = delayArg ? Math.max(0, Number(delayArg.slice('--shot-delay='.length)) || 0) : 0
      await new Promise((r) => setTimeout(r, 1200 + extraDelay))

      // --dump-text=<file>：把页面上仍是中文的可见文本导出来，用来检查翻译覆盖率
      const dumpArg = process.argv.find((a) => a.startsWith('--dump-text='))
      if (dumpArg) {
        try {
          const script = `(() => {
            const seen = new Set()
            const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
            let n
            while ((n = w.nextNode())) {
              const t = (n.nodeValue || '').trim()
              if (!t || !/[\\u4e00-\\u9fff]/.test(t)) continue
              const el = n.parentElement
              if (!el || el.offsetParent === null) continue
              seen.add(t)
            }
            return [...seen]
          })()`
          const left = await mainWindow.webContents.executeJavaScript(script)
          await fs.writeFile(dumpArg.slice('--dump-text='.length), JSON.stringify(left, null, 2), 'utf8')
          console.log(`chinese-left: ${left.length}`)
        } catch (err) {
          console.error('dump-text failed', err)
        }
      }

      try {
        const image = await mainWindow.webContents.capturePage()
        await fs.writeFile(target, image.toPNG())
        console.log(`screenshot saved: ${target}`)
      } catch (err) {
        console.error('screenshot failed', err)
      }
      app.quit()
    })
  }

  // 外链一律交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  ipcMain.on('ui:ready', () => markUiReady())

  // 日志与代理：尽早初始化，这样后面的任何失败都有记录
  logger.init(path.join(pickInstallRoot(), '.autoed', 'logs'))
  logger.info('app', `AutoED ${app.getVersion()} 启动（${process.platform} ${process.arch}）`)
  readSettings()
    .then(async (s) => {
      // 用户可能把环境装到了别的盘，日志跟着走
      if (s.lastInstallRoot) logger.init(path.join(s.lastInstallRoot, '.autoed', 'logs'))
      await applyProxySettings(s.proxy)
    })
    .catch(() => {})

  // 未捕获异常也写进日志，否则用户导出日志时什么都看不到
  process.on('uncaughtException', (err) => logger.error('crash', err.stack || err.message))
  process.on('unhandledRejection', (err) => logger.error('crash', (err && err.stack) || String(err)))

  // ---- 本地设置 ----
  ipcMain.handle('settings:get', async () => ({
    ...(await readSettings()),
    version: app.getVersion(),
    // 首次启动时界面要显示一个合理的默认安装目录（按盘符探测得出，不写死 D:）
    defaultInstallRoot: pickInstallRoot()
  }))
  // 界面语言：默认英语，可切中文/日语/俄语/韩语/法语
  ipcMain.handle('i18n:get', async () => {
    const s = await readSettings()
    const lang = SUPPORTED_LOCALES.includes(s.locale) ? s.locale : DEFAULT_LOCALE
    const load = async (code) => {
      try {
        return JSON.parse(await fs.readFile(path.join(__dirname, '..', 'i18n', `${code}.json`), 'utf8'))
      } catch (err) {
        logger.warn('i18n', `词典读取失败（${code}）：${err.message}`)
        return null
      }
    }

    // 中文就是源码原文，不需要词典
    if (lang === 'zh') return { lang, dict: {} }

    const dict = await load(lang)
    // 某个语言没翻到的条目，退回英语，而不是显示中文
    const fallback = lang === 'en' ? null : await load('en')
    return { lang, dict: dict || {}, fallback }
  })

  ipcMain.handle('settings:set', async (_event, patch = {}) => {
    const next = { ...(await readSettings()), ...patch }
    await writeSettings(next)
    return next
  })

  ipcMain.handle('env:probe', async () => {
    setSplashStage('probe')
    const [permission, hardware] = await Promise.all([probePermission(), probeHardware()])
    envCache = { permission, hardware }
    setSplashStage('plan')
    return { permission, hardware, scenarios: getScenarios() }
  })

  ipcMain.handle('plan:build', async (_event, payload = {}) => {
    if (!envCache) {
      const [permission, hardware] = await Promise.all([probePermission(), probeHardware()])
      envCache = { permission, hardware }
    }
    return buildPlan({
      scenarioIds: payload.scenarioIds || [],
      installRoot: payload.installRoot || undefined,
      overrides: payload.overrides || {},
      versions: payload.versions || {},
      permission: envCache.permission,
      hardware: envCache.hardware
    })
  })

  ipcMain.handle('plan:export', async (_event, plan) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出方案',
      defaultPath: path.join(app.getPath('documents'), 'autoed-plan.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return { saved: false }
    await fs.writeFile(filePath, JSON.stringify(plan, null, 2), 'utf8')
    return { saved: true, filePath }
  })

  // ---- 自动更新 ----

  ipcMain.handle('update:state', () => updateState)

  ipcMain.handle('update:check', async () => {
    if (updateState.status === 'unsupported' || updateState.status === 'dev') return updateState
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      broadcastUpdate({ status: 'error', error: String(err?.message || err) })
    }
    return updateState
  })

  ipcMain.handle('update:download', async () => {
    if (updateState.status !== 'available') return updateState
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      broadcastUpdate({ status: 'error', error: String(err?.message || err) })
    }
    return updateState
  })

  ipcMain.handle('update:install', async () => {
    if (updateState.status !== 'ready') return { ok: false, error: '更新尚未下载完成' }
    // 安装任务进行中不重启，避免把装了一半的环境留在磁盘上
    if (installRunning) return { ok: false, error: '正在安装组件，完成后再重启更新' }
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return { ok: true }
  })

  // ---- 路径校验 / 诊断 / 迁移 ----

  ipcMain.handle('path:validate', async (_event, payload = {}) => {
    const check = validateTarget(payload.path)
    if (!check.ok) return check
    const probe = await probeWritable(payload.path)
    return probe.ok ? check : { ok: false, error: probe.error }
  })

  ipcMain.handle('path:pick', async (_event, payload = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: payload.title || '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return { canceled, path: canceled ? '' : filePaths[0] }
  })

  ipcMain.handle('status:get', async (_event, payload = {}) => {
    const root = String(payload.installRoot || '').trim()
    if (!root) return { installRoot: '', components: [], totalMB: 0 }
    return buildStatusReport({ installRoot: root })
  })

  // ---- 手动安装组件（VS Code）：只提供下载入口与导入 ----

  ipcMain.handle('manual:open', async (_event, payload = {}) => {
    const url = String(payload.url || '')
    if (!/^https:\/\//.test(url)) return { ok: false, error: '只允许打开 https 链接' }
    await shell.openExternal(url)
    return { ok: true }
  })

  // 助力发电等「官方外链」：只放行白名单域名，其余一律拒绝
  const EXTERNAL_ALLOW = ['afdian.com', 'www.afdian.com']

  ipcMain.handle('app:openExternal', async (_event, payload = {}) => {
    let u
    try {
      u = new URL(String(payload.url || ''))
    } catch {
      return { ok: false, error: '链接格式不正确' }
    }
    if (u.protocol !== 'https:') return { ok: false, error: '只允许 https 链接' }
    if (!EXTERNAL_ALLOW.includes(u.hostname)) return { ok: false, error: '该域名不在白名单内' }
    await shell.openExternal(u.toString())
    return { ok: true }
  })

  // ---- 可直装软件：目录 / 版本列表 / 安装 ----
  ipcMain.handle('apps:catalog', async () => appCatalog())
  ipcMain.handle('apps:versions', async (_event, payload = {}) => {
    try {
      const list = await listAppVersions(String(payload.appId || ''), { limit: 8 })
      return { ok: true, versions: list }
    } catch (err) {
      return { ok: false, error: err.message || '获取版本列表失败' }
    }
  })

  ipcMain.handle('apps:install', async (_event, payload = {}) => {
    if (installRunning) return { ok: false, error: '已有安装任务在进行' }
    const installRoot = String(payload.installRoot || '').trim()
    if (!installRoot) return { ok: false, error: '缺少安装目录' }

    installRunning = true
    try {
      // 进度节流：只在整数百分比或阶段变化时推给界面，避免大文件刷出上千条 IPC
      let lastPct = -1
      let lastPhase = ''
      const result = await installApp({
        appId: String(payload.appId || ''),
        version: String(payload.version || ''),
        installRoot,
        onProgress: (p) => {
          const pct = Math.round(Number(p.percent) || 0)
          if (p.phase === lastPhase && pct === lastPct) return
          lastPhase = p.phase
          lastPct = pct
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('apps:progress', { appId: payload.appId, ...p })
          }
        }
      })
      return result
    } catch (err) {
      logger.error('apps', `安装 ${payload.appId} 失败：${err.message}`)
      return { ok: false, error: err.message || '安装失败' }
    } finally {
      installRunning = false
    }
  })

  // ---- 面板独立窗口 ----
  ipcMain.handle('panel:detach', async (_event, payload = {}) => {
    const panel = String(payload.panel || '')
    if (!PANEL_TITLES[panel]) return { ok: false, error: '未知的栏目' }

    // 拖出时：只有松手位置在主窗口之外才开新窗口，避免误触
    if (typeof payload.x === 'number' && typeof payload.y === 'number' && mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getBounds()
      const inside = payload.x >= b.x && payload.x <= b.x + b.width && payload.y >= b.y && payload.y <= b.y + b.height
      if (inside) return { ok: false, ignored: true }
    }

    const win = createPanelWindow(panel, { x: payload.x ? payload.x - 120 : undefined, y: payload.y ? payload.y - 40 : undefined })
    return { ok: Boolean(win) }
  })

  // ---- 跨窗口状态同步（主窗口是唯一的数据所有者，其它窗口只读）----
  ipcMain.handle('sync:get', async () => ({
    selection: syncState.selection,
    installRoot: syncState.installRoot,
    plan: syncState.plan,
    status: syncState.status
  }))

  ipcMain.on('sync:set', (_event, patch = {}) => {
    if (Array.isArray(patch.selection)) syncState.selection = patch.selection
    if (typeof patch.installRoot === 'string') syncState.installRoot = patch.installRoot
    if ('plan' in patch) syncState.plan = patch.plan
    if ('status' in patch) syncState.status = patch.status
    broadcast('sync:changed', {
      selection: syncState.selection,
      installRoot: syncState.installRoot,
      plan: syncState.plan,
      status: syncState.status
    })
  })

  // 独立窗口发起的操作（如改选方向）：统一交给主窗口处理，避免双份状态
  ipcMain.on('sync:action', (_event, action = {}) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sync:action', action)
  })

  // ---- 重装单个组件 ----
  ipcMain.handle('diag:reinstall', async (_event, payload = {}) => {
    if (installRunning) return { ok: false, error: '已有安装任务在进行中' }
    const installRoot = String(payload.installRoot || '').trim()
    const id = String(payload.id || '').trim()
    if (!installRoot || !id) return { ok: false, error: '缺少参数' }

    const state = await loadState(installRoot).catch(() => ({}))
    const rec = state[id]
    if (!rec) return { ok: false, error: '没有找到这个组件的安装记录' }

    const comp = getComponent(id)
    // 用现有记录还原成「一条锁」，复用同一条生成计划与安装链路
    let plan
    try {
      const built = lockfile.planFromLock(
        {
          installRoot,
          components: [
            {
              id,
              name: comp?.name || id,
              version: rec.version,
              relativePath: rec.path ? path.relative(installRoot, rec.path) : null
            }
          ]
        },
        [id],
        installRoot,
        (cid) => getComponent(cid)
      )
      plan = built.plan
    } catch (err) {
      return { ok: false, error: err.message }
    }
    if (!plan.components.length) {
      return { ok: false, error: comp?.manualInstall ? '该组件需要手动下载，无法自动重装' : '无法生成重装计划' }
    }

    installRunning = true
    logger.info('install', `重装 ${id}（${rec.version || '未知版本'}）`)
    try {
      const result = await installPlan({
        plan,
        installRoot,
        cacheDir: path.join(installRoot, '.autoed', 'cache'),
        emit: (event) => broadcast('install:progress', event)
      })
      return { ok: true, result }
    } catch (err) {
      logger.error('install', `重装 ${id} 失败：${err.message}`)
      return { ok: false, error: err.message }
    } finally {
      installRunning = false
    }
  })

  // ---- 命令解析自检：装的东西真的会用上吗 ----
  // 按组件 id 推导它应该提供的命令；兼容旧 id（python-3.12 这类）
  function commandForComponent(id) {
    if (id === 'python' || id.startsWith('python-')) return 'python'
    if (id === 'node-lts' || id.startsWith('node')) return 'node'
    if (id === 'git-min') return 'git'
    if (id === 'w64devkit') return 'gcc'
    if (['cmake', 'ninja', 'uv', 'fnm'].includes(id)) return id
    return null
  }

  ipcMain.handle('diag:resolution', async (_event, payload = {}) => {
    const installRoot = String(payload.installRoot || '').trim()
    if (!installRoot) return { ok: false, error: '缺少安装目录' }
    const state = await loadState(installRoot).catch(() => ({}))
    const { resolveCommand } = require('../core/paths')

    const rows = []
    const seen = new Set()
    for (const [id, rec] of Object.entries(state)) {
      const cmd = commandForComponent(id)
      if (!cmd || !rec?.binDir || seen.has(cmd)) continue
      seen.add(cmd)

      const hit = await resolveCommand(cmd).catch(() => null)
      const actualDir = hit ? path.dirname(hit.file) : null
      rows.push({
        id,
        command: cmd,
        expected: rec.binDir,
        actual: hit ? hit.file : null,
        ok: Boolean(actualDir && actualDir.toLowerCase() === rec.binDir.toLowerCase()),
        fromMachine: Boolean(hit && hit.fromMachine)
      })
    }
    return { ok: true, rows }
  })

  ipcMain.handle('diag:fixResolution', async (_event, payload = {}) => {
    const installRoot = String(payload.installRoot || '').trim()
    const id = String(payload.id || '').trim()
    const state = await loadState(installRoot).catch(() => ({}))
    const rec = state[id]
    if (!rec || !rec.binDir) return { ok: false, error: '没有这个组件的安装记录' }

    const cmd = commandForComponent(id)
    if (!cmd) return { ok: false, error: '该组件没有可自检的命令' }

    try {
      const { ensureCommandFirst } = require('../core/paths')
      const res = await ensureCommandFirst(cmd, rec.binDir)
      logger.info('path', `修正命令解析：${cmd} → ${res.after || res.before || '未知'}（${res.ok ? '成功' : '失败'}）`)
      return { ok: res.ok, ...res }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // ---- 切换 Python 默认版本（把某个版本的 bin 提到 PATH 最前）----
  ipcMain.handle('diag:prioritize', async (_event, payload = {}) => {
    const installRoot = String(payload.installRoot || '').trim()
    const id = String(payload.id || '').trim()
    const version = String(payload.version || '').trim()
    if (!installRoot || !id) return { ok: false, error: '缺少参数' }

    const state = await loadState(installRoot).catch(() => ({}))
    const rec = state[id]
    if (!rec) return { ok: false, error: '没有找到这个组件的安装记录' }

    const variant = version && rec.variants ? rec.variants[version] : null
    const binDir = variant?.binDir || rec.binDir
    if (!binDir) return { ok: false, error: '这个版本没有 PATH 目录' }

    try {
      const { prioritizeUserPath } = require('../core/paths')
      const res = await prioritizeUserPath(binDir)
      logger.info('python', `切换默认版本：${id} ${version || ''} → ${binDir}（${res.changed ? '已调整' : '本来就是第一个'}）`)

      // 状态里把"当前版本"改成选中的那个
      if (variant) {
        const next = { ...state, [id]: { ...rec, path: variant.path, binDir: variant.binDir, version: variant.version } }
        await require('../core/state').saveState(installRoot, next)
      }
      return { ok: true, changed: res.changed, binDir, warning: res.warning || null }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // ---- 高级：网络 / 日志 / 环境锁 ----
  ipcMain.handle('advanced:state', async () => {
    const s = await readSettings()
    return {
      proxy: s.proxy || '',
      logFile: logger.file(),
      version: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
      electron: process.versions.electron
    }
  })

  ipcMain.handle('advanced:setProxy', async (_event, payload = {}) => {
    const rules = String(payload.proxy || '').trim()
    if (rules && !/^[a-z]+:\/\/[^\s]+$/i.test(rules) && !/^[^\s:]+:\d+$/.test(rules)) {
      return { ok: false, error: '代理格式应为 http://127.0.0.1:7890，留空表示不使用' }
    }
    const next = { ...(await readSettings()), proxy: rules }
    await writeSettings(next)
    await applyProxySettings(rules)
    return { ok: true, proxy: rules }
  })

  // 一键导出：环境快照 + 已装组件 + 全部日志，打包成一个 txt 方便发给别人
  ipcMain.handle('advanced:exportLog', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出日志',
      defaultPath: path.join(app.getPath('documents'), `autoed-log-${Date.now()}.txt`),
      filters: [{ name: '文本日志', extensions: ['txt', 'log'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }

    const s = await readSettings()
    const root = s.lastInstallRoot || pickInstallRoot()
    const state = await loadState(root).catch(() => ({}))
    const hw = envCache?.hardware
    const lines = [
      `AutoED ${app.getVersion()}`,
      `导出时间：${new Date().toISOString()}`,
      `平台：${process.platform} ${process.arch}　Electron ${process.versions.electron}　Node ${process.versions.node}`,
      `代理：${s.proxy || '未设置（跟随系统）'}`,
      `安装根目录：${root}`,
      hw
        ? `硬件：${hw.cpu?.name || '?'} / ${hw.ram?.totalGB ?? '?'} GB / ${hw.nvidia?.name || '无独显'}${hw.vramGB ? ` ${hw.vramGB} GB` : ''}`
        : '硬件：未探测',
      '',
      '--- 已安装组件 ---',
      ...Object.entries(state).map(
        ([id, v]) => `${id}\t${v.version || '-'}\t${v.path || '-'}\t${v.installedAt || ''}`
      ),
      '',
      '--- 日志 ---',
      logger.text() || '(无)',
      ''
    ]
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, lines.join('\n'), 'utf8')
    return { ok: true, filePath }
  })

  // 解析一份日志：把报错翻译成「是什么问题、怎么办」
  ipcMain.handle('advanced:parseLog', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择要解析的日志文件',
      properties: ['openFile'],
      filters: [{ name: '日志', extensions: ['log', 'txt', 'json'] }]
    })
    if (canceled || !filePaths?.length) return { ok: false, canceled: true }
    try {
      const text = await fs.readFile(filePaths[0], 'utf8')
      const result = parseLog(text)
      return { ...result, file: filePaths[0] }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 导出环境锁
  ipcMain.handle('advanced:exportLock', async (_event, payload = {}) => {
    const root = String(payload.installRoot || '').trim() || pickInstallRoot()
    const state = await loadState(root).catch(() => ({}))
    const installed = Object.entries(state).map(([id, v]) => ({
      id,
      name: getComponent(id)?.name || id,
      version: v.version,
      channel: getComponent(id)?.channel,
      targetPath: v.path,
      binDir: v.binDir,
      pathAdded: Boolean(v.binDir)
    }))
    if (!installed.length) return { ok: false, error: '还没有安装任何组件，无内容可导出' }

    const lock = lockfile.buildLock({
      components: installed,
      hardware: envCache?.hardware,
      appVersion: app.getVersion(),
      installRoot: root
    })

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出环境锁',
      defaultPath: path.join(app.getPath('documents'), lockfile.LOCK_NAME),
      filters: [{ name: 'AutoED 环境锁', extensions: ['json'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }

    await fs.writeFile(filePath, JSON.stringify(lock, null, 2), 'utf8')
    logger.info('lock', `导出环境锁：${filePath}（${installed.length} 个组件）`)
    return { ok: true, filePath, count: installed.length }
  })

  // 读入环境锁并与当前环境比对
  ipcMain.handle('advanced:readLock', async (_event, payload = {}) => {
    let file = String(payload.path || '').trim()
    if (!file) {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: '选择环境锁文件',
        properties: ['openFile'],
        filters: [{ name: 'AutoED 环境锁', extensions: ['json'] }]
      })
      if (canceled || !filePaths?.length) return { ok: false, canceled: true }
      file = filePaths[0]
    }
    try {
      const lock = await lockfile.readLock(file)
      const root = lock.installRoot || pickInstallRoot()
      const state = await loadState(root).catch(() => ({}))
      const rows = lockfile.diffLock(lock, state)
      logger.info('lock', `读取环境锁：${file}，${rows.length} 项`)
      return { ok: true, file, lock, rows, installRoot: root }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  /**
   * 按锁生成可安装的计划（只包含用户勾选的组件）。
   * 生成后由界面交给既有的 install:start，进度面板、回滚、日志都复用同一条链路。
   */
  ipcMain.handle('advanced:planFromLock', async (_event, payload = {}) => {
    try {
      const { plan } = lockfile.planFromLock(
        payload.lock,
        Array.isArray(payload.ids) ? payload.ids : [],
        payload.installRoot,
        (id) => getComponent(id)
      )
      if (!plan.components.length) {
        const why = plan.skipped.map((s) => `${s.name}：${s.reason}`).join('；')
        return { ok: false, error: why || '没有可重建的组件' }
      }
      return { ok: true, plan }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('manual:import', async (_event, payload = {}) => {
    const component = getComponent(String(payload.id || ''))
    if (!component?.manual) return { ok: false, error: '该组件不支持手动导入' }

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: `选择 ${component.name} 解压后的目录`,
      properties: ['openDirectory']
    })
    if (canceled || !filePaths?.length) return { ok: false, canceled: true }

    try {
      return await importManualComponent({
        component,
        installRoot: String(payload.installRoot || ''),
        dir: filePaths[0]
      })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('uninstall:start', async (_event, payload = {}) => {
    if (installRunning) return { ok: false, error: '安装进行中，稍后再卸载' }

    const installRoot = String(payload.installRoot || '')
    const id = String(payload.id || '')

    let info
    try {
      info = await planUninstall({ installRoot, id })
    } catch (err) {
      return { ok: false, error: err.message }
    }

    const component = getComponent(id)
    const name = component?.name || id
    const sizeText = info.sizeMB >= 1024 ? `${(info.sizeMB / 1024).toFixed(1)} GB` : `${info.sizeMB} MB`

    const detail = [
      `目录：${info.path}`,
      `占用：${sizeText}`,
      info.binDir ? `PATH 条目：${info.binDir}` : '',
      info.dependents.length ? `\n注意：${info.dependents.join('、')} 依赖它，卸载后这些组件可能失效。` : '',
      '\n此操作不可撤销。'
    ]
      .filter(Boolean)
      .join('\n')

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['取消', '确认卸载'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '卸载组件',
      message: `确定卸载「${name}」？`,
      detail
    })
    if (response !== 1) return { ok: false, canceled: true }

    try {
      const result = await uninstallComponent({ installRoot, id })
      return result
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('migrate:start', async (_event, payload = {}) => {    if (installRunning) return { ok: false, error: '安装进行中，稍后再迁移' }
    try {
      return await migrateComponent({
        installRoot: String(payload.installRoot || ''),
        id: String(payload.id || ''),
        toPath: String(payload.toPath || '')
      })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('install:start', async (_event, payload = {}) => {
    if (installRunning) return { ok: false, error: '已有安装任务在进行中' }

    const installRoot = String(payload.installRoot || '')
    // 安装根目录必须是盘符绝对路径，且不能是盘根 / 系统目录
    if (!/^[A-Za-z]:\\/.test(installRoot) || /^[A-Za-z]:\\?$/.test(installRoot)) {
      return { ok: false, error: `安装目录必须是磁盘下的具体文件夹，例如 ${pickInstallRoot()}` }
    }
    if (/^[A-Za-z]:\\(Windows|Program Files|ProgramData)/i.test(installRoot)) {
      return { ok: false, error: '请选择用户可写的目录，不要装到系统目录' }
    }
    if (!Array.isArray(payload.plan?.components) || payload.plan.components.length === 0) {
      return { ok: false, error: '没有可安装的组件' }
    }

    // 逐个校验组件目标路径（界面已校验过，这里再兜一次，防止 IPC 被绕过）
    for (const component of payload.plan.components) {
      const check = validateTarget(component.targetPath)
      if (!check.ok) return { ok: false, error: `${component.name}：${check.error}` }
    }

    installRunning = true
    logger.info('install', `开始安装 ${payload.plan.components.length} 个组件 → ${installRoot}`)
    // 记住安装根目录，导出日志/环境锁时要用
    writeSettings({ ...(await readSettings()), lastInstallRoot: installRoot }).catch(() => {})
    try {
      const result = await installPlan({
        plan: payload.plan,
        installRoot,
        cacheDir: path.join(installRoot, '.autoed', 'cache'),
        emit: (event) => {
          if (event.phase === 'download' || event.phase === 'error') {
            logger.info('install', `${event.id || ''} ${event.phase} ${event.percent ?? ''} ${event.message || ''}`.trim())
          }
          mainWindow?.webContents.send('install:progress', event)
        }
      })
      logger.info('install', `安装结束：成功 ${result?.results?.length ?? 0} 个`)
      return result
    } catch (err) {
      logger.error('install', err.message)
      return { ok: false, error: err.message }
    } finally {
      installRunning = false
    }
  })

  // 开发用：--detached=<栏目> 直接以独立窗口启动（截图与调试用）
  const detachedArg = process.argv.find((a) => a.startsWith('--detached='))
  if (detachedArg) {
    const panel = detachedArg.slice('--detached='.length)
    const win = createPanelWindow(panel)
    const shot = process.argv.find((a) => a.startsWith('--screenshot='))
    if (win && shot) {
      const target = shot.slice('--screenshot='.length)
      win.webContents.once('did-finish-load', async () => {
        await new Promise((r) => setTimeout(r, 3200))
        if (process.argv.includes('--debug-renderer')) {
          const dump = await win.webContents
            .executeJavaScript(
              `JSON.stringify({
                search: location.search,
                panel: document.body.dataset.panel || null,
                stage: window.__stage || null,
                rows: document.querySelectorAll('.diag-row').length,
                rootVal: (document.querySelector('#installRoot') || {}).value || null
              })`
            )
            .catch((e) => 'dump failed: ' + e.message)
          console.log('[dump]', dump)
        }
        try {
          const img = await win.webContents.capturePage()
          await fs.writeFile(target, img.toPNG())
          console.log(`screenshot saved: ${target}`)
        } catch (err) {
          console.error('screenshot failed', err)
        }
        app.quit()
      })
    }
    return
  }

  // 开发用：--splash-shot=<路径> 只截启动画面（等动画收敛后截图）
  const splashShotArg = process.argv.find((a) => a.startsWith('--splash-shot='))
  if (splashShotArg) {
    const target = splashShotArg.slice('--splash-shot='.length)
    createSplash()
    setTimeout(async () => {
      try {
        const image = await splashWindow.webContents.capturePage()
        await fs.writeFile(target, image.toPNG())
        console.log(`splash screenshot saved: ${target}`)
      } catch (err) {
        console.error('splash screenshot failed', err)
      }
      app.quit()
    }, 3200)
    return
  }

  // 先建主窗口（隐藏），再建启动画面——启动画面要按主窗口的尺寸和位置铺上去
  createWindow()
  if (!process.argv.some((a) => a.startsWith('--screenshot='))) createSplash()
  setupUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
