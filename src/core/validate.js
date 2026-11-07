'use strict'
/**
 * 安装前的路径与空间校验。
 *
 * 三条规则，对应三类常见翻车：
 *  1. 路径非法      → 含 : * ? " < > |、超长、结尾是空格或点
 *  2. 目录不可写    → 探针文件建不出来（权限 / 只读盘 / 路径不存在且无法创建）
 *  3. 空间不够      → 剩余 < 组件体积 × 1.5
 */
const fsp = require('node:fs/promises')
const path = require('node:path')

const { pickInstallRoot } = require('./drive')

const INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/
const SYSTEM_DIRS = [
  /^[a-z]:\\windows\\/i,
  /^[a-z]:\\program files/i,
  /^[a-z]:\\programdata\\/i
]

function validateTarget(raw) {
  const value = String(raw || '').trim()
  if (!value) return { ok: false, error: '路径不能为空' }

  if (!/^[a-zA-Z]:\\/.test(value) && !/^\\\\/.test(value)) {
    return { ok: false, error: `必须是绝对路径，例如 ${path.join(pickInstallRoot(), 'python')}` }
  }
  // 去掉盘符后再判断非法字符
  const rest = value.slice(2)
  if (INVALID_CHARS.test(rest)) {
    return { ok: false, error: '路径不能包含 : * ? " < > | 这些字符' }
  }
  if (/[\\/]$/.test(value) && value.length > 3) {
    return { ok: false, error: '路径结尾不要带反斜杠' }
  }
  if (/\s$/.test(value) || /\.$/.test(value)) {
    return { ok: false, error: '路径结尾不能是空格或点号' }
  }
  if (value.length > 200) {
    return { ok: false, error: `路径过长（${value.length} 字符），建议控制在 200 字符以内` }
  }
  if (SYSTEM_DIRS.some((re) => re.test(value))) {
    return { ok: false, error: '不要装到系统目录（Windows / Program Files / ProgramData）' }
  }
  if (/[\u4e00-\u9fa5]/.test(rest)) {
    return { ok: true, warning: '路径包含中文，个别老工具可能识别异常，建议用纯英文路径' }
  }
  return { ok: true }
}

/** 真正建个临时文件试试，比查权限位可靠 */
async function probeWritable(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true })
    const probe = path.join(dir, `.autoed-write-test-${process.pid}`)
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe, { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `目录不可写：${err.message}` }
  }
}

/**
 * 按盘汇总预计占用。
 * @param {Array<{targetPath:string,sizeMB:number,name:string}>} items
 * @param {object} hardware 硬件信息（含 byLetter 空闲空间）
 */
function summarizeUsage(items, hardware) {
  const drives = new Map()
  for (const item of items) {
    const drive = /^([a-zA-Z]):/.exec(item.targetPath || '')?.[0]?.toUpperCase()
    if (!drive) continue
    const entry = drives.get(drive) || { drive, sizeMB: 0, names: [] }
    entry.sizeMB += item.sizeMB || 0
    entry.names.push(item.name)
    drives.set(drive, entry)
  }

  return [...drives.values()].map((entry) => {
    // entry.drive 已是 "D:" 形式，不能再补冒号
    const free = hardware?.byLetter?.[entry.drive]?.freeGB
    return {
      ...entry,
      freeGB: typeof free === 'number' ? free : null,
      enough: typeof free === 'number' ? (entry.sizeMB / 1024) * 1.5 <= free : null
    }
  })
}

module.exports = { validateTarget, probeWritable, summarizeUsage }
