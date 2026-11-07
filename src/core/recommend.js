'use strict'
/**
 * 规则引擎 —— 硬约束过滤 + 加权排序 + 可解释推荐。
 *
 * 设计原则：
 *  1. 先过"一票否决"的硬约束（权限、内存、显存、磁盘、架构），再做排序
 *  2. 每条推荐都带 why，用户能看懂为什么装这个
 *  3. 虚拟组件（cpp-toolchain / torch）在运行时按本机情况解析成具体实现
 */
const fs = require('node:fs')
const path = require('node:path')

const { resolveLocation } = require('./layout')
const { summarizeUsage } = require('./validate')
const { pickInstallRoot } = require('./drive')

const COMPONENTS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/components.json'), 'utf8'))
const SCENARIOS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/scenarios.json'), 'utf8'))
const BY_ID = new Map(COMPONENTS.map((c) => [c.id, c]))

const CATEGORY_ORDER = { 基础工具: 0, Python: 1, Node: 1, AI: 1, 'C++': 2, 编辑器: 3 }

/** 默认安装目录：已有环境就复用，否则挑空间最大的非系统盘，再兜底到用户目录 */
function defaultInstallRoot() {
  return pickInstallRoot()
}

function getScenarios() {
  return SCENARIOS
}

function driveLetterOf(target) {
  const m = /^([a-zA-Z]):/.exec(String(target || ''))
  return m ? `${m[1].toUpperCase()}:` : null
}

function freeGBFor(target, hardware) {
  const letter = driveLetterOf(target)
  if (!letter) return null
  const vol = hardware.byLetter?.[letter]
  return vol ? vol.freeGB : null
}

/**
 * 虚拟组件解析：把"意图"翻译成本机可用的具体实现。
 * 这一步是整个引擎里唯一带业务判断的地方，其余都是数据驱动。
 */
function resolveVirtual(id, ctx) {
  // 旧 id 兼容：合并后的 Python 组件
  if (id === 'python-3.12' || id === 'python-3.11') {
    return { id: 'python', note: null }
  }

  if (id === 'cpp-toolchain') {
    // 只提供便携版 MinGW：不请求管理员权限，全程不弹 UAC。
    // （MSVC 需要提权且强制占 C 盘 2–4 GB，已从产品中移除）
    return {
      id: 'w64devkit',
      note: '使用 MinGW-w64（GCC）：解压即用、免管理员；分发给他人时需附带运行库'
    }
  }

  if (id === 'torch') {
    const hw = ctx.hardware
    if (!hw.nvidia) {
      return { id: 'torch-cpu', note: '未检测到可用的 NVIDIA 显卡，使用 CPU 版' }
    }
    if (hw.vramGB && hw.vramGB >= 6 && hw.ram.totalGB >= 16) {
      // note 用占位符，由渲染层按当前语言填充（含显卡名和显存）
      return {
        id: 'torch-cuda',
        note: '检测到 {name}（显存约 {gb} GB），启用 GPU 加速',
        noteVars: { name: hw.nvidia.name, gb: hw.vramGB }
      }
    }
    return {
      id: 'torch-cpu',
      note: '检测到 NVIDIA 显卡，但显存需 ≥ 6 GB 且内存需 ≥ 16 GB 才能稳定跑 CUDA，先用 CPU 版'
    }
  }

  return { id, note: null }
}

/** 硬约束：返回不可安装的原因，可安装则返回 null */
function checkConstraints(comp, ctx) {
  const req = comp.requires || {}
  const hw = ctx.hardware

  if (comp.requiresAdmin && !ctx.permission.isElevated) {
    const extra = comp.locationPolicy === 'fixed' ? '；该组件固定安装在 C 盘，约占用 2–4 GB' : ''
    return `需要管理员权限，当前为${ctx.permission.title}${extra}`
  }
  if (req.minRamGB && hw.ram.totalGB < req.minRamGB) {
    return `需要 ${req.minRamGB} GB 内存，本机 ${hw.ram.totalGB} GB`
  }
  if (req.nvidia && !hw.nvidia) {
    return '需要 NVIDIA 显卡'
  }
  if (req.minVramGB && hw.vramGB > 0 && hw.vramGB < req.minVramGB) {
    return `需要 ${req.minVramGB} GB 显存，本机约 ${hw.vramGB} GB`
  }
  if (req.minFreeDiskGB) {
    const free = freeGBFor(ctx.installRoot, hw)
    if (free !== null && free < req.minFreeDiskGB) {
      return `需要 ${req.minFreeDiskGB} GB 可用空间，${driveLetterOf(ctx.installRoot)} 仅剩 ${free} GB`
    }
  }
  return null
}

/** 适配度：给用户一个"这套配置跑起来爽不爽"的直观判断 */
function fitOf(comp, hw) {
  const req = comp.requires || {}
  if (req.minRamGB) {
    const ratio = hw.ram.totalGB / req.minRamGB
    if (ratio >= 1.5) return 'optimal'
    if (ratio >= 1) return 'good'
    return 'tight'
  }
  if (comp.category === 'AI' && !hw.nvidia) return 'good'
  return 'optimal'
}

function buildPlan({
  scenarioIds = [],
  installRoot = null,
  overrides = {},
  versions = {},
  permission,
  hardware
}) {
  const ctx = { permission, hardware, installRoot: installRoot || defaultInstallRoot() }
  const picked = []
  const skipped = []
  const notes = []
  const seen = new Set()

  for (const sid of scenarioIds) {
    const scenario = SCENARIOS.find((s) => s.id === sid)
    if (!scenario) continue
    for (const rawId of scenario.components) {
      const resolved = resolveVirtual(rawId, ctx)
      const comp = BY_ID.get(resolved.id)
      if (!comp || seen.has(comp.id)) continue
      seen.add(comp.id)

      const reason = checkConstraints(comp, ctx)
      if (reason) {
        skipped.push({ id: comp.id, name: comp.name, reason })
        continue
      }

      // ---- 版本选择 ----
      // 优先级：用户显式选择 > 场景提示 > 组件默认 > 列表第一项
      const list = Array.isArray(comp.versions) && comp.versions.length ? comp.versions : null
      let versionId = null
      let versionLabel = comp.version
      let versionNote = null
      let sizeMB = comp.sizeMB
      if (list) {
        const hint = (scenario.versionHints || {})[comp.id]
        const wanted = versions[comp.id] || hint || comp.defaultVersion
        const hit =
          list.find((v) => v.id === wanted) ||
          list.find((v) => v.id === comp.defaultVersion) ||
          list[0]
        versionId = hit.id
        versionLabel = hit.label || hit.id
        versionNote = hit.note || null
        if (typeof hit.sizeMB === 'number') sizeMB = hit.sizeMB
      }

      // ---- 安装位置 ----
      // 需要按版本隔离的组件（Python）：每个版本一个独立目录，
      // 互相不覆盖，卸载某个版本也不会带走其它版本。
      let locationComp = comp
      let locationOverrides = overrides
      if (comp.versionedSubdir && versionId) {
        locationComp = { ...comp, defaultSubdir: path.join(comp.defaultSubdir || comp.id, versionId) }
        // 用户自定义了根目录时，版本目录挂在它下面
        if (overrides[comp.id]) {
          locationOverrides = { ...overrides, [comp.id]: path.join(String(overrides[comp.id]), versionId) }
        }
      }
      const location = resolveLocation(locationComp, { installRoot: ctx.installRoot, overrides: locationOverrides })

      picked.push({
        id: comp.id,
        name: comp.name,
        category: comp.category,
        version: versionLabel,
        versionId,
        versionNote,
        versions: list,
        channel: comp.channel,
        sizeMB,
        why: comp.why,
        note: resolved.note,
        noteVars: resolved.noteVars || null,
        fit: fitOf(comp, ctx.hardware),
        requiresAdmin: comp.requiresAdmin,
        manualInstall: Boolean(comp.manualInstall),
        manual: comp.manual || null,
        targetPath: location.path,
        locationFixed: location.fixed,
        locationNote: location.note,
        locationEditable: location.editable,
        defaultSubdir: comp.defaultSubdir || comp.id
      })
    }
  }

  picked.sort((a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9))

  // 整机层面的提示：这些不是"装不了"，而是"用起来会难受"
  const hw = ctx.hardware
  if (hw.ram.totalGB > 0 && hw.ram.totalGB < 8) {
    notes.push('内存不足 8 GB：编译和索引都会明显变慢，建议后续加内存条')
  }
  if (!hw.hasSsd) {
    notes.push('检测到机械硬盘：包安装和项目索引会成倍变慢，换 SSD 的收益比升级 CPU 更大')
  }
  if (!hw.is64) {
    notes.push('当前系统为 32 位：绝大多数现代工具链只提供 64 位版本，方案可能大面积不可用')
  }
  if (hw.nvidia && !hw.vramGB) {
    notes.push('无法读取显存容量（Windows 的显存在 4 GB 以上会溢出），已按保守策略处理')
  }

  const totalMB = picked.reduce((sum, c) => sum + c.sizeMB, 0)
  const minutes = totalMB > 0 ? Math.max(2, Math.round(totalMB / 300 + picked.length * 1.5)) : 0
  const usage = summarizeUsage(picked, hardware)

  return {
    installRoot: ctx.installRoot,
    components: picked,
    skipped,
    notes,
    usage,
    totals: {
      count: picked.length,
      sizeMB: totalMB,
      minutes
    }
  }
}

module.exports = {
  buildPlan,
  getScenarios,
  getComponent: (id) => BY_ID.get(id) || null,
  resolveVirtual,
  checkConstraints,
  defaultInstallRoot
}
