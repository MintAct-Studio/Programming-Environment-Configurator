'use strict'
/**
 * 组件迁移：把已安装的组件搬到另一个目录，并同步 PATH 与状态记录。
 *
 * 为什么不让用户手动搬：搬目录意味着 PATH 里那条记录失效，
 * 用户下次打开终端会发现命令没了，却不知道原因。这里一次做全。
 */
const fsp = require('node:fs/promises')
const path = require('node:path')

const { loadState, saveState } = require('./state')
const { addToUserPath, removeFromUserPath } = require('./paths')
const { driveOf } = require('./layout')
const { validateTarget } = require('./validate')

async function pathExists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function migrateComponent({ installRoot, id, toPath }) {
  const state = await loadState(installRoot)
  const entry = state[id]
  if (!entry) throw new Error('该组件没有安装记录，无法迁移')

  const check = validateTarget(toPath)
  if (!check.ok) throw new Error(check.error)

  const from = entry.path
  const to = path.resolve(toPath)

  if (from.toLowerCase() === to.toLowerCase()) {
    return { ok: true, unchanged: true, from, to }
  }
  if (await pathExists(to)) {
    const entries = await fsp.readdir(to).catch(() => [])
    if (entries.length) throw new Error(`目标目录已存在且不为空：${to}`)
  }

  const fromDrive = driveOf(from)
  const toDrive = driveOf(to)
  const sameDrive = fromDrive === toDrive

  // 目标盘空间检查（同盘移动不占额外空间）
  let moved = false
  await fsp.mkdir(path.dirname(to), { recursive: true })

  try {
    if (sameDrive) {
      await fsp.rename(from, to)
    } else {
      await fsp.cp(from, to, { recursive: true })
      await fsp.rm(from, { recursive: true, force: true })
    }
    moved = true

    // PATH：撤掉旧的 bin 目录，挂上新的
    const relativeBin = entry.binDir ? path.relative(from, entry.binDir) : ''
    const newBinDir = relativeBin ? path.join(to, relativeBin) : to

    if (entry.binDir) await removeFromUserPath(entry.binDir)
    await addToUserPath(newBinDir)

    const next = { ...state, [id]: { ...entry, path: to, binDir: newBinDir, movedAt: new Date().toISOString() } }
    await saveState(installRoot, next)

    const journal = path.join(installRoot, '.autoed', 'journal.jsonl')
    await fsp.appendFile(
      journal,
      `${JSON.stringify({ at: new Date().toISOString(), event: 'moved', id, from, to, crossDrive: !sameDrive })}\n`,
      'utf8'
    )

    return { ok: true, from, to, crossDrive: !sameDrive, binDir: newBinDir }
  } catch (err) {
    // 搬迁失败时把已经动过的目录尽量放回去
    if (moved && !(await pathExists(from)) && (await pathExists(to))) {
      await fsp.rename(to, from).catch(() => {})
    }
    throw new Error(`迁移失败：${err.message}`)
  }
}

/** 诊断用：列出已安装组件的当前状态与实际存在性 */
async function buildStatusReport({ installRoot }) {
  const state = await loadState(installRoot)
  // 并发检查目录是否存在：串行时 11 个组件（含一个在机械盘/E 盘的）要等三四秒
  const rows = await Promise.all(
    Object.entries(state).map(async ([id, info]) => ({
      id,
      path: info.path,
      binDir: info.binDir,
      version: info.version,
      versions: Array.isArray(info.versions) ? info.versions : null,
      variants: info.variants && typeof info.variants === 'object' ? info.variants : null,
      installedAt: info.installedAt,
      exists: await pathExists(info.binDir || info.path)
    }))
  )
  const totalMB = rows.reduce(async (accPromise, row) => {
    const acc = await accPromise
    try {
      const entries = await fsp.readdir(row.path, { withFileTypes: true })
      let size = 0
      for (const entry of entries) {
        if (entry.isDirectory()) {
          size += await dirSize(path.join(row.path, entry.name))
        } else {
          size += (await fsp.stat(path.join(row.path, entry.name)).catch(() => ({ size: 0 }))).size
        }
      }
      return acc + size
    } catch {
      return acc
    }
  }, Promise.resolve(0))

  const [sizeBytes, pathInfo] = await Promise.all([
    totalMB,
    require('./paths').analyzeUserPath().catch(() => null)
  ])

  return {
    installRoot,
    components: rows,
    totalMB: Math.round(sizeBytes / 1024 / 1024),
    pathInfo
  }
}

async function dirSize(dir) {
  // 逐文件 await 统计一棵几 GB 的目录树要好几秒，所以按目录批次并发
  let total = 0
  let batch = [dir]

  while (batch.length) {
    const next = []
    const results = await Promise.all(
      batch.map(async (current) => {
        let entries = []
        try {
          entries = await fsp.readdir(current, { withFileTypes: true })
        } catch {
          return { size: 0, dirs: [] }
        }
        const dirs = []
        const files = []
        for (const entry of entries) {
          const full = path.join(current, entry.name)
          if (entry.isDirectory()) dirs.push(full)
          else files.push(full)
        }
        const sizes = await Promise.all(
          files.map((f) => fsp.stat(f).then((s) => s.size).catch(() => 0))
        )
        return { size: sizes.reduce((a, b) => a + b, 0), dirs }
      })
    )
    for (const r of results) {
      total += r.size
      next.push(...r.dirs)
    }
    batch = next
  }
  return total
}

module.exports = { migrateComponent, buildStatusReport }
