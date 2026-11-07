'use strict'
/**
 * 选择默认安装目录。
 *
 * 规则（按优先级）：
 *   1. 已经有 <盘符>:\AutoED-env 的盘 —— 直接复用，避免老用户的环境"换地方"
 *   2. 剩余空间最大的非系统盘
 *   3. 兜底：用户目录（%USERPROFILE%\AutoED-env）
 *
 * 之所以不用固定的 D: —— 别人的机器上可能没有 D 盘（或 D 是光驱）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const FOLDER = 'AutoED-env'
/** 低于这个剩余空间就不往那块盘放了（GB） */
const MIN_FREE_GB = 8

let cached = null

function pathExists(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 盘符是否存在（光驱、未挂载的盘会返回 false） */
function driveExists(letter) {
  return pathExists(`${letter}:\\`)
}

/** 剩余空间（GB）；拿不到返回 null */
function freeGBOf(letter) {
  try {
    // statfs 在 Node 18.15+ 可用，Electron 45 自带的 Node 版本没问题
    const st = fs.statfsSync(`${letter}:\\`)
    const bytes = Number(st.bavail) * Number(st.bsize)
    if (!Number.isFinite(bytes) || bytes <= 0) return null
    return bytes / 1024 ** 3
  } catch {
    return null
  }
}

/** 列出所有可用的非系统盘（按剩余空间从大到小） */
function listDrives() {
  if (process.platform !== 'win32') return []
  const systemDrive = String(process.env.SystemDrive || 'C:').slice(0, 1).toUpperCase()
  const out = []
  for (let i = 67; i <= 90; i += 1) {
    const letter = String.fromCharCode(i) // C..Z
    if (letter === systemDrive) continue
    if (!driveExists(letter)) continue
    const freeGB = freeGBOf(letter)
    if (freeGB === null || freeGB < MIN_FREE_GB) continue
    out.push({
      letter,
      path: `${letter}:\\`,
      freeGB: Math.round(freeGB * 10) / 10,
      hasEnv: pathExists(path.join(`${letter}:\\`, FOLDER))
    })
  }
  return out.sort((a, b) => b.freeGB - a.freeGB)
}

/**
 * 挑一个默认安装目录。
 * @param {object} [opts]
 * @param {boolean} [opts.refresh] 忽略缓存重新探测
 */
function pickInstallRoot(opts = {}) {
  if (cached && !opts.refresh) return cached

  // 非 Windows 环境（开发调试）直接用用户目录
  if (process.platform !== 'win32') {
    cached = path.join(os.homedir(), FOLDER)
    return cached
  }

  const drives = listDrives()

  // 1. 已经有现成环境的盘优先
  const existing = drives.filter((d) => d.hasEnv)
  if (existing.length) {
    cached = path.join(`${existing[0].letter}:\\`, FOLDER)
    return cached
  }

  // 2. 剩余空间最大的非系统盘
  if (drives.length) {
    cached = path.join(`${drives[0].letter}:\\`, FOLDER)
    return cached
  }

  // 3. 兜底：用户目录
  cached = path.join(os.homedir(), FOLDER)
  return cached
}

function resetCache() {
  cached = null
}

module.exports = { pickInstallRoot, listDrives, resetCache, FOLDER, MIN_FREE_GB }
