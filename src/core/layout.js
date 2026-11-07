'use strict'
/**
 * 组件安装位置解析。
 *
 * 两种策略：
 *  - flexible：默认放在 <安装根目录>/<defaultSubdir>，用户可逐个覆盖
 *  - fixed：位置由上游安装器决定，不给用户选（目前只有 MSVC）
 *
 * MSVC 装在哪不是我们能定的：微软的安装器把主目录、共享组件、包缓存
 * 分别放在 C:\Program Files (x86)、C:\ProgramData 下，用 --installPath
 * 只能挪走主目录，缓存和共享组件仍在 C 盘。与其给一个"看起来能改、
 * 实际改不干净"的选项，不如明确告诉用户"这一项固定在 C 盘"。
 */
const path = require('node:path')

function resolveLocation(component, { installRoot, overrides = {} }) {
  if (component.locationPolicy === 'fixed') {
    return {
      path: component.fixedPath || '',
      fixed: true,
      note: component.locationNote || '该项由上游安装器决定位置，无法自定义',
      editable: false
    }
  }

  const override = overrides[component.id]
  const base = override && String(override).trim() ? String(override).trim() : path.join(installRoot, component.defaultSubdir || component.id)

  return {
    path: path.resolve(base),
    fixed: false,
    note: '',
    editable: true
  }
}

/** 取盘符（大写到 D: 形式），失败返回 null */
function driveOf(target) {
  const m = /^([a-zA-Z]):/.exec(String(target || ''))
  return m ? `${m[1].toUpperCase()}:` : null
}

module.exports = { resolveLocation, driveOf }
