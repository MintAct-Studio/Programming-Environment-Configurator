'use strict'
/**
 * 环境锁（autoed.lock.json）。
 *
 * 作用只有一个：把一个装好的环境**变成可复现的凭据**。
 * 里面记录精确版本、下载来源、安装位置，以及 PATH 的登记顺序——
 * 环境坏掉八成不是版本问题，而是 PATH 顺序被别人插队了。
 */
const fsp = require('node:fs/promises')
const path = require('node:path')

const { pickInstallRoot } = require('./drive')

const LOCK_NAME = 'autoed.lock.json'
const LOCK_VERSION = 1

function lockPath(installRoot) {
  return path.join(installRoot, LOCK_NAME)
}

/**
 * 生成锁对象。
 * @param {object} opts
 * @param {Array}  opts.components  [{ id, name, version, channel, targetPath, pathAdded }]
 * @param {object} opts.hardware    硬件摘要（可选）
 * @param {string} opts.appVersion  AutoED 版本
 * @param {string} opts.installRoot 安装根目录
 */
function buildLock({ components = [], hardware = null, appVersion = '', installRoot = '' }) {
  return {
    lockVersion: LOCK_VERSION,
    tool: 'AutoED',
    toolVersion: appVersion,
    createdAt: new Date().toISOString(),
    installRoot,
    platform: {
      os: hardware?.os?.name ? `${hardware.os.name} ${hardware.os.version || ''}`.trim() : process.platform,
      arch: process.arch
    },
    hardware: hardware
      ? {
          cpu: hardware.cpu?.name || null,
          ramGB: hardware.ram?.totalGB ?? null,
          gpu: hardware.nvidia?.name || null,
          vramGB: hardware.vramGB ?? null
        }
      : null,
    components: components.map((c) => ({
      id: c.id,
      name: c.name || c.id,
      version: c.version || null,
      channel: c.channel || null,
      // 相对安装根目录的路径，换盘也能用
      relativePath: c.targetPath && installRoot ? path.relative(installRoot, c.targetPath) : c.targetPath || null,
      pathAdded: Boolean(c.pathAdded)
    })),
    pathOrder: components.filter((c) => c.pathAdded && c.binDir).map((c) => c.binDir)
  }
}

async function writeLock(installRoot, lock) {
  const file = lockPath(installRoot)
  await fsp.mkdir(installRoot, { recursive: true })
  await fsp.writeFile(file, JSON.stringify(lock, null, 2), 'utf8')
  return file
}

async function readLock(file) {
  const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
  if (!raw || !Array.isArray(raw.components)) {
    throw new Error('这不是有效的 AutoED 环境锁文件')
  }
  return raw
}

/**
 * 把锁变成「可以照着装的清单」。
 * 未安装 / 版本不一致的都会被标出来，由界面决定怎么处理。
 */
/**
 * 从任意版本字符串里抠出纯数字部分。
 * 实测版本记录长这样："git version 2.56.0.windows.4"、"Python 3.12.7"、"2.5.1+cu128"，
 * 直接字符串比较会大面积误判。
 */
function versionKey(s) {
  const m = String(s || '').match(/\d+(?:\.\d+)*/)
  return m ? m[0] : ''
}

/** 前缀相等也算一致：锁写 3.12，机器上是 3.12.7，视为匹配 */
function versionMatch(have, want) {
  const a = versionKey(have)
  const b = versionKey(want)
  if (!b) return true
  if (!a) return false
  if (a === b) return true
  return a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

function diffLock(lock, installed = {}) {
  const rows = []
  for (const want of lock.components || []) {
    const have = installed[want.id]
    let status = 'missing'
    if (have) {
      status = versionMatch(have.version, want.version) ? 'ok' : 'version'
    }
    rows.push({
      id: want.id,
      name: want.name,
      want: want.version,
      have: have?.version || null,
      path: have?.path || null,
      status
    })
  }
  return rows
}

/**
 * 按锁生成可安装的计划（纯函数，便于单独测试）。
 *
 * @param {object} lock            锁对象
 * @param {string[]} ids           用户勾选的组件 id
 * @param {string} installRoot     安装根目录
 * @param {(id:string)=>object|null} resolveComponent  由调用方提供（通常是 recommend.getComponent）
 */
function planFromLock(lock, ids, installRoot, resolveComponent) {
  if (!lock || !Array.isArray(lock.components)) throw new Error('环境锁内容无效')
  if (!Array.isArray(ids) || !ids.length) throw new Error('没有勾选任何组件')

  const root = String(installRoot || lock.installRoot || '').trim() || pickInstallRoot()
  const picked = []
  const skipped = []

  for (const item of lock.components) {
    if (!ids.includes(item.id)) continue
    const comp = resolveComponent(item.id)
    if (!comp) {
      skipped.push({ id: item.id, name: item.name || item.id, reason: '当前版本不认识这个组件' })
      continue
    }
    if (comp.manualInstall) {
      skipped.push({ id: comp.id, name: comp.name, reason: '需要手动下载，无法自动重建' })
      continue
    }

    // 锁里存精确版本（3.12.7 / 22.11.0），组件要的是版本档位（3.12 / 22 / cu128）
    const versions = Array.isArray(comp.versions) ? comp.versions : null
    let versionId = comp.defaultVersion || null
    if (versions && item.version) {
      const raw = String(item.version)
      // 先按前缀匹配（3.12.7 → 3.12），再按包含匹配（2.5.1+cu128 → cu128，CUDA 写在后缀）
      const hit =
        versions.find((v) => raw.startsWith(String(v.id))) ||
        versions.find((v) => raw.includes(String(v.id)))
      if (hit) versionId = hit.id
    }
    const label = (versions && versions.find((v) => v.id === versionId)?.label) || comp.version

    const rel = item.relativePath
    let targetPath
    if (rel && path.isAbsolute(rel)) targetPath = rel
    else if (rel) targetPath = path.join(root, rel)
    else targetPath = path.join(root, comp.defaultSubdir || comp.id)

    picked.push({
      id: comp.id,
      name: comp.name,
      category: comp.category,
      version: label,
      versionId,
      versionNote: null,
      versions,
      channel: comp.channel,
      sizeMB: comp.sizeMB,
      why: comp.why,
      note: item.version ? `按环境锁：${item.version}` : '按环境锁重建',
      fit: 'optimal',
      requiresAdmin: Boolean(comp.requiresAdmin),
      manualInstall: false,
      manual: null,
      targetPath,
      locationFixed: false,
      locationNote: null,
      locationEditable: true,
      defaultSubdir: comp.defaultSubdir || comp.id
    })
  }

  const totalMB = picked.reduce((sum, c) => sum + (c.sizeMB || 0), 0)
  return {
    plan: {
      installRoot: root,
      components: picked,
      skipped,
      notes: [],
      usage: [],
      totals: {
        count: picked.length,
        sizeMB: totalMB,
        minutes: totalMB > 0 ? Math.max(2, Math.round(totalMB / 300 + picked.length * 1.5)) : 0
      }
    },
    skipped
  }
}

module.exports = {
  LOCK_NAME,
  LOCK_VERSION,
  buildLock,
  writeLock,
  readLock,
  diffLock,
  planFromLock,
  lockPath
}
