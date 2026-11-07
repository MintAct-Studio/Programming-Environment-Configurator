'use strict'
/**
 * 卸载组件。
 *
 * 三步：撤 PATH 条目 → 删除目录 → 抹掉状态记录。
 * 之所以要有这个模块，而不是让用户自己删文件夹：
 * PATH 里会留下指向空目录的死条目，命令从此失效且很难排查。
 */
const fsp = require('node:fs/promises')
const path = require('node:path')

const { loadState, saveState } = require('./state')
const { removeFromUserPath } = require('./paths')

/** 组件间依赖：卸载前者会让后者失效，UI 上要提醒 */
const DEPENDENTS = {
  uv: ['python-3.11', 'python-3.12', 'torch-cuda', 'torch-cpu'],
  fnm: ['node-lts'],
  'python-3.11': ['torch-cuda', 'torch-cpu'],
  'python-3.12': ['torch-cuda', 'torch-cpu']
}

/** 拒绝明显危险的删除目标 */
function assertSafeTarget(target) {
  const value = String(target || '')
  if (!/^[a-zA-Z]:\\/.test(value)) throw new Error(`拒绝删除非法路径：${value}`)
  if (/^[a-zA-Z]:\\?$/.test(value)) throw new Error('拒绝删除磁盘根目录')

  const lower = value.toLowerCase()
  const forbidden = ['c:\\windows', 'c:\\program files', 'c:\\programdata', 'c:\\users']
  if (forbidden.some((f) => lower === f || lower === `${f}\\`)) {
    throw new Error(`拒绝删除系统目录：${value}`)
  }
}

async function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries = []
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else total += (await fsp.stat(full).catch(() => ({ size: 0 }))).size
    }
  }
  return Math.round(total / 1024 / 1024)
}

/** 只读：算出要删什么、多大、有没有别人依赖它 */
async function planUninstall({ installRoot, id }) {
  const state = await loadState(installRoot)
  const entry = state[id]
  if (!entry) throw new Error('找不到该组件的安装记录')

  const dependents = (DEPENDENTS[id] || []).filter((dep) => state[dep])

  return {
    id,
    path: entry.path,
    binDir: entry.binDir || '',
    sizeMB: await dirSize(entry.path),
    dependents
  }
}

async function uninstallComponent({ installRoot, id }) {
  const info = await planUninstall({ installRoot, id })
  assertSafeTarget(info.path)

  if (info.binDir) await removeFromUserPath(info.binDir)
  await fsp.rm(info.path, { recursive: true, force: true })

  const state = await loadState(installRoot)
  delete state[id]
  await saveState(installRoot, state)

  const journal = path.join(installRoot, '.autoed', 'journal.jsonl')
  await fsp.mkdir(path.dirname(journal), { recursive: true })
  await fsp.appendFile(
    journal,
    `${JSON.stringify({ at: new Date().toISOString(), event: 'uninstalled', id, path: info.path, sizeMB: info.sizeMB })}\n`,
    'utf8'
  )

  return { ok: true, ...info }
}

module.exports = { uninstallComponent, planUninstall, DEPENDENTS }
