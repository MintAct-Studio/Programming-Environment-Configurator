'use strict'
/**
 * 归档解压。
 *
 * 只依赖 Windows 自带能力，不引入 npm 原生模块：
 *  - zip  → 系统自带的 tar.exe（bsdtar，Win10 1803+ 内置，实测比 Expand-Archive 快得多）
 *  - 7zsfx → 7-Zip 自解压包，直接以 -y -o 静默解压（w64devkit 就是这种格式）
 *
 * 所有路径都经过 toLongPath 处理：解压 node_modules 这类深层结构时，
 * 不less加 \\?\ 前缀会直接 ENOENT。
 */
const { execFile } = require('node:child_process')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { toLongPath } = require('./fsutil')

function run(file, args, { cwd, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${path.basename(file)} 失败: ${(stderr || err.message).trim()}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/** 解压 zip 到 dest（自动创建） */
async function extractZip(zipPath, dest) {
  const target = toLongPath(dest)
  await fsp.mkdir(target, { recursive: true })
  await run('tar.exe', ['-xf', toLongPath(zipPath), '-C', target])
}

/**
 * 去掉单层外壳目录。
 * 不少项目发布时会把内容套一层 `cmake-4.4.5-windows-x86_64/`，
 * 直接解压会让 bin 路径多一层。仅在"解压结果只有一个目录"时展平，
 * 多目录的结构（如 MinGit 的 cmd/mingw64/usr）不受影响。
 */
async function stripSingleTopDir(dest) {
  const root = toLongPath(dest)
  const entries = await fsp.readdir(root, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0].isDirectory()) return false

  const inner = path.join(root, entries[0].name)
  const staging = path.join(root, `.flatten-${Date.now()}`)
  await fsp.rename(inner, staging)
  for (const entry of await fsp.readdir(staging)) {
    await fsp.rename(path.join(staging, entry), path.join(root, entry))
  }
  await fsp.rmdir(staging)
  return true
}

/**
 * 解压 7-Zip 自解压包。
 * 先在临时目录里静默解压，再把产物搬到 dest —— 因为 SFX 的落地目录行为
 * 依赖包内路径，用临时目录隔离最稳妥。
 */
async function extract7zSfx(exePath, dest) {
  const tmp = toLongPath(path.join(path.dirname(dest), `.tmp-${path.basename(dest)}-${Date.now()}`))
  await fsp.mkdir(tmp, { recursive: true })
  try {
    await run(exePath, ['-y', `-o${tmp}`], { cwd: tmp })

    const entries = await fsp.readdir(tmp)
    // 包内可能再套一层同名目录，自动展平
    const sourceRoot = entries.length === 1 ? path.join(tmp, entries[0]) : tmp
    const stat = await fsp.stat(sourceRoot)
    const root = stat.isDirectory() ? sourceRoot : tmp

    const target = toLongPath(dest)
    await fsp.mkdir(target, { recursive: true })
    for (const entry of await fsp.readdir(root)) {
      await fsp.cp(path.join(root, entry), path.join(target, entry), { recursive: true })
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
}

/** 按 kind 分发 */
async function extract(kind, archivePath, dest, { stripTop = false } = {}) {
  if (kind === 'zip') {
    await extractZip(archivePath, dest)
    if (stripTop) await stripSingleTopDir(dest)
    return
  }
  if (kind === '7zsfx') return extract7zSfx(archivePath, dest)
  throw new Error(`不支持的归档类型: ${kind}`)
}

module.exports = { extract, extractZip, extract7zSfx, stripSingleTopDir }
