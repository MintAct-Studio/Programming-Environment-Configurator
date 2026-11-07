'use strict'
/**
 * 可直装软件目录。
 *
 * 收录标准（宁缺毋滥）：
 *  1. 官方在 GitHub Releases 提供 zip 单包，直链可下，不需要登录
 *  2. 免管理员、解压即用
 *  3. 体积可控（几十 MB 量级），不会卡住界面
 * 版本列表**实时**从 Releases 拉取，不写死版本号，避免列表过期。
 */
const fsp = require('node:fs/promises')
const path = require('node:path')

const { download, verifyFile } = require('./net')
const { extract } = require('./archive')
const http = require('./http')
const logger = require('./logger')
const { ensureSpace } = require('./fsutil')

const BUNDLED = require('../data/releases.json')

const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map()

const APPS = [
  {
    id: 'notepadpp',
    name: 'Notepad++',
    desc: '轻量文本编辑器，打开几百 MB 的日志也不卡',
    repo: 'notepad-plus-plus/notepad-plus-plus',
    asset: '^npp\\.(.+)\\.portable\\.x64\\.zip$',
    kind: 'zip',
    stripTop: false,
    verifyFile: 'notepad++.exe',
    sizeHint: '约 5 MB'
  },
  {
    id: 'neovim',
    name: 'Neovim',
    desc: '终端里的现代 Vim，配置可版本化管理',
    repo: 'neovim/neovim',
    asset: '^nvim-win64\\.zip$',
    kind: 'zip',
    stripTop: true,
    verifyFile: 'bin/nvim.exe',
    sizeHint: '约 30 MB'
  },
  {
    id: 'ripgrep',
    name: 'ripgrep',
    desc: '比 grep 快一个量级的全文搜索，VS Code 内部也在用',
    repo: 'BurntSushi/ripgrep',
    asset: '^ripgrep-(.+)-x86_64-pc-windows-msvc\\.zip$',
    kind: 'zip',
    stripTop: true,
    verifyFile: 'rg.exe',
    sizeHint: '约 3 MB'
  },
  {
    id: 'gh',
    name: 'GitHub CLI',
    desc: '在命令行里开 PR、查 Issue、跑 Actions',
    repo: 'cli/cli',
    asset: '^gh_(.+)_windows_amd64\\.zip$',
    kind: 'zip',
    stripTop: true,
    verifyFile: 'bin/gh.exe',
    sizeHint: '约 12 MB'
  },
  {
    id: 'dbeaver',
    name: 'DBeaver Community',
    desc: '一个客户端连 MySQL / PostgreSQL / SQLite / DuckDB',
    repo: 'dbeaver/dbeaver',
    asset: '^dbeaver-ce-(.+)-win32\\.win32\\.x86_64\\.zip$',
    kind: 'zip',
    stripTop: false,
    verifyFile: 'dbeaver.exe',
    sizeHint: '约 130 MB'
  }
]

const BY_ID = new Map(APPS.map((a) => [a.id, a]))

function catalog() {
  return APPS.map((a) => ({
    id: a.id,
    name: a.name,
    desc: a.desc,
    repo: a.repo,
    sizeHint: a.sizeHint,
    installable: true
  }))
}

async function ghJson(url) {
  return http.json(url, { timeoutMs: 15000 })
}

/** API 不可用时的兜底：内置清单里最近 6 个已知版本 */
function bundledVersions(appId) {
  const hit = BUNDLED.apps?.[appId]?.versions
  return Array.isArray(hit) && hit.length ? hit : null
}

/**
 * 列出某软件的可用版本（按发布时间从新到旧）。
 * 返回 [{ version, tag, assetName, url, size, digest }]
 */
async function listVersions(appId, { limit = 8 } = {}) {
  const app = BY_ID.get(appId)
  if (!app) throw new Error('未知的软件')

  const hit = cache.get(appId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.list.slice(0, limit)

  let releases
  try {
    releases = await ghJson(`https://api.github.com/repos/${app.repo}/releases?per_page=20`)
  } catch (err) {
    // API 挂了 / 被限流：用内置清单，保证版本下拉仍然可用
    const fallback = bundledVersions(appId)
    if (fallback) {
      logger.warn('apps', `GitHub API 不可用（${err.message}），使用内置版本清单：${app.id}`)
      cache.set(appId, { at: Date.now(), list: fallback })
      return fallback.slice(0, limit)
    }
    throw err
  }
  if (!Array.isArray(releases)) throw new Error('GitHub 返回的数据格式不对')

  const re = new RegExp(app.asset, 'i')
  const list = []
  const seenVersion = new Set()
  for (const rel of releases) {
    if (rel.draft || rel.prerelease) continue
    const asset = (rel.assets || []).find((a) => re.test(a.name))
    if (!asset) continue
    const m = re.exec(asset.name)
    // 有的资源名不带版本（如 nvim-win64.zip），退回 release 标签并去掉前缀 v
    const version = ((m && m[1]) || String(rel.tag_name || '')).replace(/^v/i, '')
    // 跳过 stable / nightly 这类非数字标签，避免和具体版本重复
    if (!/^\d/.test(version)) continue
    if (seenVersion.has(version)) continue
    seenVersion.add(version)
    list.push({
      version,
      tag: rel.tag_name,
      assetName: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      digest: asset.digest || null,
      publishedAt: rel.published_at
    })
    if (list.length >= 20) break
  }
  if (!list.length) throw new Error(`${app.name} 的最新发布里没有 Windows 压缩包`)

  cache.set(appId, { at: Date.now(), list })
  return list.slice(0, limit)
}

/**
 * 下载并解压指定版本到 installRoot/apps/<id>。
 * onProgress({phase, percent, message})
 */
async function installApp({ appId, version, installRoot, cacheDir, onProgress = () => {} }) {
  const app = BY_ID.get(appId)
  if (!app) throw new Error('未知的软件')

  const versions = await listVersions(appId, { limit: 40 })
  const target = versions.find((v) => v.version === version || v.tag === version)
  if (!target) throw new Error(`找不到版本 ${version}，请刷新列表`)

  const appRoot = path.join(installRoot, 'apps')
  const dest = path.join(appRoot, appId)
  const work = cacheDir || path.join(installRoot, '.autoed', 'cache')
  await fsp.mkdir(dest, { recursive: true })
  await fsp.mkdir(work, { recursive: true })

  const archive = path.join(work, target.assetName)
  const cached = await fsp.stat(archive).then((s) => s.size > 0).catch(() => false)

  if (!cached) {
    const mb = target.size ? `（${(target.size / 1048576).toFixed(1)} MB）` : ''
    // 下载前先看缓存盘够不够
    await ensureSpace(work, (target.size || 0) * 1.15, `下载 ${app.name}`)
    onProgress({ phase: 'download', percent: 0, message: `下载 ${app.name} ${target.version}${mb}` })
    await download(target.url, archive, {
      onProgress: (p) =>
        onProgress({
          phase: 'download',
          percent: p.percent,
          message: `下载 ${target.assetName}`
        })
    })
  }

  // GitHub 现在会给 asset digest（sha256:...），有就校验
  if (target.digest && target.digest.startsWith('sha256:')) {
    onProgress({ phase: 'verify', percent: 100, message: '校验 SHA256' })
    // 注意：verifyFile 返回的是 { ok, actual, expected }，不是布尔
    const check = await verifyFile(archive, target.digest.slice('sha256:'.length))
    if (!check.ok) {
      logger.error('apps', `${app.id} 校验失败：期望 ${check.expected}，实际 ${check.actual}`)
      await fsp.rm(archive, { force: true })
      throw new Error('下载文件校验失败，已删除，请重试')
    }
  }

  onProgress({ phase: 'extract', percent: 100, message: `解压到 ${dest}` })
  await ensureSpace(dest, (target.size || 0) * 2.2, `解压 ${app.name}`)
  await extract(app.kind, archive, dest, { stripTop: Boolean(app.stripTop) })

  // 校验关键文件确实存在
  const probe = path.join(dest, app.verifyFile)
  const exists = await fsp.stat(probe).then(() => true).catch(() => false)
  if (!exists) {
    throw new Error(`解压完成但没找到 ${app.verifyFile}，可能压缩包结构变了`)
  }

  await fsp.rm(archive, { force: true })
  onProgress({ phase: 'done', percent: 100, message: `${app.name} ${target.version} 已就绪` })

  const binDir = path.dirname(probe)
  return {
    ok: true,
    id: app.id,
    name: app.name,
    version: target.version,
    path: dest,
    binDir,
    note: `可把 ${binDir} 加到 PATH 后直接用命令`
  }
}

module.exports = { APPS, catalog, listVersions, installApp }
