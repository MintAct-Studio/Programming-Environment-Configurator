'use strict'
/**
 * 权限探测 —— 只读，绝不请求提权。
 *
 * 四种状态：
 *   already-elevated   进程已具管理员权限（UAC 关闭，或本就从提权环境启动）
 *   admin-filtered     管理员账户 + UAC 开启 → 当前是标准令牌，但"可以"提权
 *   portable           标准用户，永远无法提权
 *   elevation-blocked  管理员账户但提权被策略禁用 / 无交互桌面
 *
 * 关键点：UAC 过滤后的令牌里，Administrators 组仍然存在，但被标记为
 * "仅用于拒绝(deny-only)"。此时 IsInRole(Administrator) 返回 false，
 * 但用户其实具备提权能力 —— 必须靠 whoami /groups 的属性位才能分辨。
 */
const { runPowerShellJson } = require('./ps')

const SCRIPT = [
  '$id = [Security.Principal.WindowsIdentity]::GetCurrent()',
  '$principal = New-Object Security.Principal.WindowsPrincipal($id)',
  '$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  '$lines = @(& whoami /groups)',
  '$adminLine = $lines | Where-Object { $_ -match "S-1-5-32-544" } | Select-Object -First 1',
  '$denyOnly = $false',
  'if ($adminLine) { $denyOnly = ($adminLine -match "deny only") -or ($adminLine -match "仅用于拒绝") }',
  '$lua = $null',
  'try { $lua = (Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" -Name EnableLUA -ErrorAction Stop).EnableLUA } catch { }',
  '$sessionId = (Get-Process -Id $PID).SessionId',
  '[pscustomobject]@{',
  '  userName    = $id.Name',
  '  elevated    = [bool]$elevated',
  '  inAdminGroup= [bool]$adminLine',
  '  denyOnly    = [bool]$denyOnly',
  '  uacEnabled  = ($lua -eq 1)',
  '  interactive = [bool][Environment]::UserInteractive',
  '  sessionId   = [int]$sessionId',
  '} | ConvertTo-Json -Compress'
].join('\n')

const LABELS = {
  'already-elevated': {
    title: '便携模式',
    short: '已提权',
    detail: '当前进程已具备管理员权限。AutoED 仍然只做用户级改动，不写系统目录、不动系统设置。',
    tone: 'ok'
  },
  'admin-filtered': {
    title: '便携模式',
    short: '可提权',
    detail: '当前是管理员账户，但 UAC 已把权限过滤成标准令牌。AutoED 全程以标准权限运行，不需要提权。',
    tone: 'info'
  },
  portable: {
    title: '便携模式',
    short: '无管理员权限',
    detail: '当前账户不是管理员，全程不会弹 UAC，所有组件都装在用户目录里。',
    tone: 'warn'
  },
  'elevation-blocked': {
    title: '便携模式',
    short: '提权被禁用',
    detail: '当前环境禁止提权（策略限制或无交互桌面），全程不会弹 UAC。',
    tone: 'warn'
  }
}

/** 把原始探测结果归类成状态机的一个状态 */
function classify(raw) {
  if (!raw) return 'portable'
  // 无交互桌面（服务会话 / Session 0）不能弹 UAC
  if (!raw.interactive || raw.sessionId === 0) return 'elevation-blocked'
  if (raw.elevated) return 'already-elevated'
  if (!raw.uacEnabled) return 'already-elevated'
  if (raw.inAdminGroup) return 'admin-filtered'
  return 'portable'
}

async function probePermission() {
  let raw = null
  try {
    raw = await runPowerShellJson(SCRIPT, { timeout: 20000 })
  } catch (err) {
    raw = null
  }
  const state = classify(raw)
  const label = LABELS[state]
  return {
    state,
    ...label,
    canElevate: state === 'admin-filtered',
    isElevated: state === 'already-elevated',
    // 便携模式：默认通道。只有已经是完整权限时才允许 requiresAdmin 组件
    defaultChannel: 'portable',
    raw: raw || null
  }
}

module.exports = { probePermission, classify }
