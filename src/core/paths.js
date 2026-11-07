'use strict'
/**
 * 用户级 PATH 管理。
 *
 * 只写 HKCU（HKEY_CURRENT_USER\Environment\Path），不需要管理员，
 * 也绝不动系统级 PATH。每次改动都把旧值记进 journal，便于回滚。
 * 用 [Environment]::SetEnvironmentVariable(..., 'User') 写入时，
 * .NET 会自行广播 WM_SETTINGCHANGE，新开的终端就能看到。
 *
 * 长度保护：Windows 上 PATH 太长会被截断，而且截断后是"别人家的软件先坏"，
 * 用户根本想不到是装环境造成的。所以写入前必须卡一道。
 */
const { runPowerShell, runPowerShellJson } = require('./ps')
const fsp = require('node:fs/promises')
const path = require('node:path')

/** 超过这个长度开始提醒（多数 Installer 按 2047 截断，留出余量） */
const SOFT_LIMIT = 1800
/** 超过这个长度直接拒绝写入 */
const HARD_LIMIT = 3000

/** 把字符串安全地嵌进 PowerShell 单引号字符串 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

async function getUserPath() {
  const out = await runPowerShellJson('[Environment]::GetEnvironmentVariable("Path","User") | ConvertTo-Json -Compress', { timeout: 15000 })
  return typeof out === 'string' ? out : ''
}

/** 系统级 PATH（只读，绝不修改） */
async function getMachinePath() {
  const out = await runPowerShellJson('[Environment]::GetEnvironmentVariable("Path","Machine") | ConvertTo-Json -Compress', { timeout: 15000 })
  return typeof out === 'string' ? out : ''
}

function splitPath(value) {
  return String(value || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 在"真实生效"的 PATH 里解析一个命令。
 *
 * 不能直接跑 `where`：主进程的环境变量是启动时继承的，刚写进注册表的条目它还看不见。
 * 也不能只看用户 PATH：Windows 的查找顺序是「系统 PATH → 用户 PATH」。
 * 所以这里读注册表，按真实顺序逐个探测文件。
 */
async function resolveCommand(command) {
  const name = String(command || '').replace(/\.exe$/i, '')
  if (!name) return null

  const [machine, user] = await Promise.all([getMachinePath(), getUserPath()])
  const dirs = [...splitPath(machine), ...splitPath(user)]
  const exts = ['.exe', '.cmd', '.bat', '']

  for (let i = 0; i < dirs.length; i++) {
    for (const ext of exts) {
      const file = path.join(dirs[i], name + ext)
      try {
        const st = await fsp.stat(file)
        if (st.isFile()) {
          return {
            file,
            dir: dirs[i],
            index: i,
            fromMachine: i < splitPath(machine).length
          }
        }
      } catch (err) {
        // ENOENT 才是"没有"；EACCES/EPERM 说明文件存在但读不了
        // （微软商店的 WindowsApps 就是这种：stat 被拒，但敲命令真会启动它）
        if (err && err.code !== 'ENOENT') {
          return {
            file,
            dir: dirs[i],
            index: i,
            fromMachine: i < splitPath(machine).length,
            inaccessible: true
          }
        }
      }
    }
  }
  return null
}

/**
 * 确保 AutoED 的目录在解析顺序里胜出：
 * 如果该命令当前解析到别处，就把我们的目录提到用户 PATH 最前面再验一次。
 *
 * 注意：系统级 PATH 永远排在用户 PATH 之前。如果冲突来自系统级
 * （比如 C:\Python39 这种），不需要管理员权限是改不了的，只能如实告知。
 */
async function ensureCommandFirst(command, binDir) {
  const target = String(binDir || '').trim()
  if (!target) return { ok: false, reason: '缺少目录' }

  const before = await resolveCommand(command)
  if (before && path.dirname(before.file).toLowerCase() === target.toLowerCase()) {
    return { ok: true, before: before.file, after: before.file, fixed: false }
  }

  let changed = false
  try {
    const res = await prioritizeUserPath(target)
    changed = res.changed
  } catch (err) {
    return { ok: false, before: before?.file || null, error: err.message }
  }

  const after = await resolveCommand(command)
  const ok = Boolean(after && path.dirname(after.file).toLowerCase() === target.toLowerCase())

  return {
    ok,
    before: before?.file || null,
    after: after?.file || null,
    fixed: changed,
    blockedByMachinePath: Boolean(!ok && after && after.fromMachine)
  }
}

/** 纯函数：算加入 entry 之后 PATH 的长度与是否越界，便于单测 */
function evaluatePathLength(current, entry) {
  const value = String(current || '')
  const target = String(entry || '').trim()
  const entries = value.split(';').map((s) => s.trim()).filter(Boolean)

  const exists = entries.some((e) => e.toLowerCase() === target.toLowerCase())
  const projected = exists ? value : value ? `${value};${target}` : target
  const projectedLength = projected.length

  return {
    currentLength: value.length,
    projectedLength,
    entryLength: target.length,
    entries: entries.length,
    exists,
    overSoft: projectedLength > SOFT_LIMIT,
    overHard: projectedLength > HARD_LIMIT,
    softLimit: SOFT_LIMIT,
    hardLimit: HARD_LIMIT
  }
}

/** 供诊断页展示 */
async function analyzeUserPath() {
  const current = await getUserPath()
  const entries = current.split(';').map((s) => s.trim()).filter(Boolean)
  return {
    length: current.length,
    entries: entries.length,
    softLimit: SOFT_LIMIT,
    hardLimit: HARD_LIMIT,
    level: current.length > HARD_LIMIT ? 'over' : current.length > SOFT_LIMIT ? 'warn' : 'ok'
  }
}

async function isInUserPath(entry) {
  const current = await getUserPath()
  const entries = current.split(';').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return entries.includes(String(entry).trim().toLowerCase())
}

/**
 * 追加一个目录到用户 PATH（已存在则跳过）。
 * 写入前会去重（大小写不敏感），并对长度做软/硬两道保护。
 * @returns {Promise<{added:boolean, previous:string, length:number, warning?:string}>}
 * @throws 需要写入但会超过硬上限时抛错（code = PATH_TOO_LONG）
 */
async function addToUserPath(entry) {
  const target = String(entry || '').trim()
  if (!target) return { added: false, previous: '', length: 0 }

  const current = await getUserPath()
  const evalResult = evaluatePathLength(current, target)

  if (evalResult.exists) {
    return { added: false, previous: current, length: current.length }
  }

  if (evalResult.overHard) {
    const err = new Error(
      `用户 PATH 已经 ${evalResult.currentLength} 字符，再加一条会到 ${evalResult.projectedLength}（上限 ${HARD_LIMIT}）。\n` +
        '继续写下去会被 Windows 截断，导致其它软件的命令先失效。\n' +
        '建议：到「高级 → 日志」导出报告，然后手动清理 PATH 里失效的目录再重试。'
    )
    err.code = 'PATH_TOO_LONG'
    err.detail = evalResult
    throw err
  }

  // 去重后再写：既压缩长度，也避免同一目录重复出现
  const script = [
    `$target = ${psQuote(target)}`,
    '$current = [Environment]::GetEnvironmentVariable("Path","User")',
    'if ($null -eq $current) { $current = "" }',
    '$seen = New-Object System.Collections.Generic.HashSet[string]',
    '$clean = New-Object System.Collections.Generic.List[string]',
    'foreach ($e in ($current -split ";")) {',
    '  if ([string]::IsNullOrWhiteSpace($e)) { continue }',
    '  $t = $e.Trim()',
    '  if ($seen.Add($t.ToLower())) { $clean.Add($t) }',
    '}',
    'if ($seen.Contains($target.ToLower())) {',
    '  [pscustomobject]@{ added = $false; previous = $current; length = $current.Length } | ConvertTo-Json -Compress',
    '} else {',
    '  $clean.Add($target)',
    '  $new = ($clean -join ";")',
    '  [Environment]::SetEnvironmentVariable("Path", $new, "User")',
    '  [pscustomobject]@{ added = $true; previous = $current; length = $new.Length } | ConvertTo-Json -Compress',
    '}'
  ].join('\n')

  const result = await runPowerShellJson(script, { timeout: 20000 })
  const out = {
    added: Boolean(result?.added),
    previous: result?.previous ?? '',
    length: Number(result?.length) || evalResult.projectedLength
  }

  if (evalResult.overSoft) {
    out.warning =
      `用户 PATH 已达 ${out.length} 字符（软上限 ${SOFT_LIMIT}）。` +
      '再多装几个组件可能会被 Windows 截断，建议清理其中的失效目录。'
  }

  return out
}

/** 把目录从用户 PATH 移除（回滚用） */
async function removeFromUserPath(entry) {
  const script = [
    `$target = ${psQuote(entry)}`,
    '$current = [Environment]::GetEnvironmentVariable("Path","User")',
    'if ($null -eq $current) { $current = "" }',
    '$entries = @($current -split ";" | Where-Object { $_ -ne "" })',
    '$kept = @($entries | Where-Object { $_.Trim().ToLower() -ne $target.Trim().ToLower() })',
    'if ($kept.Count -eq $entries.Count) {',
    '  "unchanged"',
    '} else {',
    '  [Environment]::SetEnvironmentVariable("Path", ($kept -join ";"), "User")',
    '  "removed"',
    '}'
  ].join('\n')

  // 这里返回的是纯文本 "removed"/"unchanged"，不是 JSON
  const out = String(await runPowerShell(script, { timeout: 20000 })).trim()
  return out === 'removed'
}

/** 还原到指定 PATH 值（回滚用，最精确） */
async function restoreUserPath(previous) {
  const script = `[Environment]::SetEnvironmentVariable("Path", ${psQuote(previous)}, "User")`
  await runPowerShell(script, { timeout: 20000 })
}

/**
 * 把某个目录提到用户 PATH 的最前面（成为"默认"）。
 * 多版本共存时，靠 PATH 顺序决定 python 命令指向哪一版。
 */
async function prioritizeUserPath(entry) {
  const target = String(entry || '').trim()
  if (!target) return { changed: false, previous: '', length: 0 }

  const current = await getUserPath()
  const entries = current.split(';').map((s) => s.trim()).filter(Boolean)
  const kept = entries.filter((e) => e.toLowerCase() !== target.toLowerCase())

  const alreadyFirst = kept.length !== entries.length && entries[0] && entries[0].toLowerCase() === target.toLowerCase()
  if (alreadyFirst) return { changed: false, previous: current, length: current.length }

  const next = [target, ...kept].join(';')
  if (next.length > HARD_LIMIT) {
    const err = new Error(
      `调整 PATH 顺序会让总长度达到 ${next.length} 字符（上限 ${HARD_LIMIT}）。请先清理失效目录。`
    )
    err.code = 'PATH_TOO_LONG'
    throw err
  }

  await runPowerShell(`[Environment]::SetEnvironmentVariable("Path", ${psQuote(next)}, "User")`, { timeout: 20000 })

  const out = { changed: true, previous: current, length: next.length }
  if (next.length > SOFT_LIMIT) {
    out.warning = `用户 PATH 已达 ${next.length} 字符（软上限 ${SOFT_LIMIT}），建议清理失效目录。`
  }
  return out
}

module.exports = {
  SOFT_LIMIT,
  HARD_LIMIT,
  getUserPath,
  getMachinePath,
  isInUserPath,
  addToUserPath,
  removeFromUserPath,
  restoreUserPath,
  prioritizeUserPath,
  resolveCommand,
  ensureCommandFirst,
  analyzeUserPath,
  evaluatePathLength
}
