'use strict'
/**
 * 文件系统小工具：长路径与磁盘空间。
 *
 * 两个都是 Windows 上的真实坑：
 *  - 路径超过 260 字符，不less加 \\?\ 前缀就会 ENOENT（解压 node_modules 时必现）
 *  - 装到一半磁盘满了，报出来的是"解压失败"，用户根本不知道是空间不够
 */
const fsp = require('node:fs/promises')
const path = require('node:path')

/** Windows 传统路径上限 */
const MAX_PATH = 260
/** 超过这个长度就提前加前缀（给盘符和分隔符留余量） */
const LONG_PATH_THRESHOLD = 240

/**
 * 给超长路径加 \\?\ 前缀，让 Windows API 绕过 260 限制。
 * 相对路径和已经很短的路径原样返回。
 */
function toLongPath(p) {
  const value = String(p || '')
  if (!value) return value
  if (value.startsWith('\\\\?\\')) return value
  if (!path.isAbsolute(value)) return value
  if (value.length < LONG_PATH_THRESHOLD) return value
  // UNC 路径：\\server\share → \\?\UNC\server\share
  if (value.startsWith('\\\\')) return `\\\\?\\UNC\\${value.slice(2)}`
  return `\\\\?\\${value}`
}

/** 路径是否会超过 260（用于提前告警） */
function isRiskyPath(p) {
  return String(p || '').length >= LONG_PATH_THRESHOLD
}

/** 查某个目录所在卷的剩余字节数；拿不到返回 null */
async function freeBytes(dir) {
  let target = dir
  // statfs 需要一个已存在的路径
  for (let i = 0; i < 6; i++) {
    try {
      await fsp.access(target)
      break
    } catch {
      const parent = path.dirname(target)
      if (parent === target) return null
      target = parent
    }
  }
  try {
    const st = await fsp.statfs(toLongPath(target))
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/**
 * 确保某目录所在卷至少有 needBytes 可用。
 * @throws code = NO_SPACE
 */
async function ensureSpace(dir, needBytes, what) {
  if (!Number.isFinite(needBytes) || needBytes <= 0) return { ok: true, checked: false }
  const free = await freeBytes(dir)
  if (free === null) return { ok: true, checked: false }

  if (free < needBytes) {
    const err = new Error(
      `${what || '安装'} 需要约 ${formatBytes(needBytes)}，但 ${path.parse(dir).root} 只剩 ${formatBytes(free)}。\n` +
        '请清理后再试，或在首页把「安装到」换到空间更大的盘。'
    )
    err.code = 'NO_SPACE'
    err.free = free
    err.need = needBytes
    throw err
  }
  return { ok: true, checked: true, free }
}

module.exports = { toLongPath, isRiskyPath, freeBytes, ensureSpace, formatBytes, MAX_PATH, LONG_PATH_THRESHOLD }
