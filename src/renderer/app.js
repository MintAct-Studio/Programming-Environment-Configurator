'use strict'

/**
 * 独立窗口模式：同一个页面被拖出后，用 ?detached=<栏目> 打开，
 * 只显示对应栏目，其余全部隐藏。数据来自主窗口通过 sync:set 广播的快照。
 */
const DETACHED_PANEL = new URLSearchParams(location.search).get('detached') || ''
if (DETACHED_PANEL) {
  document.body.dataset.panel = DETACHED_PANEL
  document.documentElement.classList.add('is-detached')
}
const isDetached = () => Boolean(DETACHED_PANEL)

const state = {
  permission: null,
  hardware: null,
  scenarios: [],
  selected: new Set(),
  overrides: {},
  versionChoices: {},
  showLocations: false,
  plan: null,
  status: null
}

const $ = (sel) => document.querySelector(sel)

/** 带占位符的模板翻译：T('共 {n} 项', { n: 5 }) */
const T = (template, vars) => window.i18n.tf(template, vars)

/**
 * 界面语言：加载词典并翻译当前 DOM，绑定右上角的语言切换。
 * 默认英语；切换语言后写入设置并刷新窗口，保证所有已渲染内容重新按新语言生成。
 */
async function setupLocale() {
  const lang = await window.i18n.init().catch(() => 'en')
  const sel = $('#langSelect')
  if (!sel) return lang
  sel.value = lang
  sel.addEventListener('change', async (e) => {
    const next = e.target.value
    if (next === lang) return
    await window.autoed.setSettings({ locale: next }).catch(() => {})
    location.reload()
  })
  return lang
}

/* ---------- 小工具 ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

let toastTimer = null
function toast(message) {
  const box = $('#toast')
  box.textContent = message
  box.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => box.classList.remove('is-visible'), 3600)
}

function formatSize(mb) {
  if (!mb) return '—'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/* ---------- 权限徽章 ---------- */

function renderPermission(permission) {
  const badge = $('#permissionBadge')
  badge.className = `badge badge--${permission.tone}`
  badge.textContent = permission.title
  badge.title = permission.detail
}

/* ---------- 设备卡片 ---------- */

function hwCard(label, value, sub) {
  const card = el('div', 'hw-card')
  card.append(el('div', 'hw-card__label', label), el('div', 'hw-card__value', value))
  if (sub) card.append(el('div', 'hw-card__sub', sub))
  return card
}

function renderHardware(hw) {
  const grid = $('#hwGrid')
  grid.innerHTML = ''

  const cpu = hw.cpu || {}
  grid.append(
    hwCard(
      '处理器',
      cpu.name || '未知',
      cpu.cores ? T('{cores} 核 {threads} 线程 · {mhz} MHz', { cores: cpu.cores, threads: cpu.threads, mhz: cpu.maxMHz }) : ''
    )
  )

  const ram = hw.ram || {}
  grid.append(
    hwCard(
      '内存',
      ram.totalGB ? `${ram.totalGB} GB` : '未知',
      ram.stickCount
        ? ram.maxSpeedMHz
          ? T('{n} 条 · {mhz} MHz', { n: ram.stickCount, mhz: ram.maxSpeedMHz })
          : T('{n} 条', { n: ram.stickCount })
        : ''
    )
  )

  let gpuName = '未检测到独立显卡'
  let gpuSub = ''
  if (hw.nvidia) {
    gpuName = hw.nvidia.name
    if (hw.vramGB) {
      gpuSub = hw.nvidia.driverVersion
        ? T('显存约 {gb} GB · 驱动 {driver}', { gb: hw.vramGB, driver: hw.nvidia.driverVersion })
        : T('显存约 {gb} GB', { gb: hw.vramGB })
    } else {
      gpuSub = T('NVIDIA · 显存未知')
    }
  } else if (hw.gpus && hw.gpus.length) {
    gpuName = hw.gpus[0].name
    gpuSub = T('集显 / 未识别为 NVIDIA')
  }
  grid.append(hwCard('显卡', gpuName, gpuSub))

  const disk = (hw.disks && hw.disks[0]) || null
  // 显示「安装盘」的剩余空间；取不到安装盘再退回第一个盘。
  // 之前写死 D 盘，装到别的盘时这里会显示错。
  const rootLetter = (($('#installRoot') && $('#installRoot').value.trim().match(/^([A-Za-z]):/) || [])[1] || '').toUpperCase()
  const letterKey =
    rootLetter && hw.byLetter && hw.byLetter[`${rootLetter}:`]
      ? `${rootLetter}:`
      : hw.byLetter
        ? Object.keys(hw.byLetter)[0]
        : null
  const freeGB = letterKey ? hw.byLetter[letterKey].freeGB : null
  const freeDrive = letterKey ? letterKey.replace(':', '') : ''
  grid.append(
    hwCard(
      '存储',
      hw.hasSsd ? 'SSD / NVMe' : disk ? disk.media || '磁盘' : '未知',
      disk
        ? `${String(disk.model || '').trim()}${
            freeGB !== null ? ` · ${T('{drive} 盘剩余 {gb} GB', { drive: freeDrive, gb: freeGB })}` : ''
          }`
        : ''
    )
  )

  const os = hw.os || {}
  // os.arch 可能是 "64 位" 或 "x64"，取数字再用模板，避免出现 "64 位-bit"
  const archRaw = String(os.arch || '')
  const archDigits = (archRaw.match(/\d+/) || [])[0]
  let osSub = archRaw
  if (os.build) {
    osSub = archDigits ? T('构建 {build} · {arch} 位', { build: os.build, arch: archDigits }) : `${os.build} · ${archRaw}`.trim()
  }
  grid.append(hwCard('操作系统', os.caption || '未知', osSub))
}

function renderHwNotes(plan) {
  const list = $('#hwNotes')
  list.innerHTML = ''
  for (const note of plan.notes || []) {
    list.append(el('li', '', typeof note === 'string' ? T(note) : T(note.text, note.vars)))
  }
}

/* ---------- 场景 ---------- */

function renderScenarios(scenarios) {
  const grid = $('#scenarioGrid')
  grid.innerHTML = ''
  for (const scenario of scenarios) {
    const card = el('button', 'scenario')
    card.type = 'button'
    card.dataset.id = scenario.id
    card.append(
      el('div', 'scenario__icon', scenario.icon),
      el('div', 'scenario__name', scenario.name),
      el('div', 'scenario__desc', scenario.desc)
    )
    card.addEventListener('click', () => toggleScenario(scenario.id))
    grid.append(card)
  }
}

function toggleScenario(id) {
  // 独立窗口里改选：转发给主窗口，由它重建方案后再广播回来
  if (isDetached()) {
    window.autoed.syncAction({ type: 'toggle-scenario', id })
    return
  }

  if (state.selected.has(id)) state.selected.delete(id)
  else state.selected.add(id)

  document.querySelectorAll('.scenario').forEach((node) => {
    node.classList.toggle('is-active', state.selected.has(node.dataset.id))
  })

  refreshPlan()
}

/* ---------- 方案 ---------- */

const FIT_LABEL = { optimal: '最优', good: '可用', tight: '勉强' }

async function refreshPlan() {
  const body = $('#planBody')
  const summary = $('#planSummary')

  if (state.selected.size === 0) {
    body.innerHTML = ''
    body.append(el('p', 'empty', '选择上面至少一个方向，这里会给出针对这台机器的方案。'))
    summary.textContent = ''
    $('#usageBar').hidden = true
    $('#exportBtn').disabled = true
    $('#installBtn').disabled = true
    state.plan = null
    return
  }

  const plan = await window.autoed.buildPlan({
    scenarioIds: [...state.selected],
    installRoot: $('#installRoot').value.trim(),
    overrides: state.overrides,
    versions: state.versionChoices
  })
  state.plan = plan
  renderPlan(plan)
  pushSync()
}

function renderUsage(plan) {
  const bar = $('#usageBar')
  bar.innerHTML = ''
  if (!plan.usage || !plan.usage.length) {
    bar.hidden = true
    return
  }
  bar.hidden = false

  for (const entry of plan.usage) {
    const chip = el('div', 'usage-chip')
    if (entry.enough === false) chip.classList.add('is-tight')
    chip.append(el('strong', '', entry.drive))
    chip.append(el('span', '', T('预计 +{size}', { size: formatSize(entry.sizeMB) })))
    if (entry.freeGB !== null) chip.append(el('span', '', T('· 剩余 {gb} GB', { gb: entry.freeGB })))
    chip.title = entry.names.join('、')
    bar.append(chip)
  }
}

function renderPlan(plan) {
  const body = $('#planBody')
  body.innerHTML = ''
  renderUsage(plan)

  if (!plan.components.length) {
    body.append(el('p', 'empty', '这台机器的条件不满足所选方向的任何组件，请查看下方原因。'))
  } else {
    const table = el('table', 'plan-table')
    const head = el('thead')
    const headRow = el('tr')
    const titles = ['组件', '版本', '适配', '体积']
    if (state.showLocations) titles.splice(3, 0, '安装位置')
    for (const title of titles) headRow.append(el('th', '', title))
    head.append(headRow)
    table.append(head)

    const tbody = el('tbody')
    for (const comp of plan.components) {
      const row = el('tr')

      const nameCell = el('td')
      nameCell.append(el('div', 'comp-name', comp.name))
      nameCell.append(el('div', 'comp-why', comp.why))
      if (comp.note) nameCell.append(el('div', 'comp-note', T(comp.note, comp.noteVars)))

      const versionCell = el('td')
      if (Array.isArray(comp.versions) && comp.versions.length) {
        const wrap = el('div', 'ver-wrap')
        const select = el('select', 'ver-select')
        select.dataset.id = comp.id
        for (const v of comp.versions) {
          const opt = el('option', '', v.label || v.id)
          opt.value = v.id
          if (v.id === comp.versionId) opt.selected = true
          select.append(opt)
        }
        select.addEventListener('change', () => onVersionChange(comp, select.value))
        wrap.append(select)
        if (comp.versionNote) wrap.append(el('div', 'ver-note', T(comp.versionNote, comp.versionNoteVars)))
        versionCell.append(wrap)
      } else {
        versionCell.append(el('div', 'comp-version', comp.version))
      }
      if (comp.requiresAdmin) versionCell.append(el('div', 'tag tag--admin', '需要管理员'))
      if (comp.manualInstall) versionCell.append(el('div', 'tag tag--admin', '需手动下载'))

      const fitCell = el('td')
      fitCell.append(el('span', `tag tag--${comp.fit}`, FIT_LABEL[comp.fit] || comp.fit))

      const sizeCell = el('td', 'comp-version', formatSize(comp.sizeMB))

      row.append(nameCell, versionCell, fitCell)

      if (state.showLocations) {
        const locCell = el('td')
        if (comp.locationEditable) {
          const input = el('input', 'loc-input')
          input.type = 'text'
          input.value = comp.targetPath
          input.spellcheck = false
          input.dataset.id = comp.id
          input.addEventListener('change', () => onLocationChange(comp, input))
          locCell.append(input)
        } else {
          const fixed = el('div', 'loc-fixed')
          fixed.append(el('span', '', '🔒'))
          const box = el('div')
          box.append(el('div', 'loc-fixed__path', comp.targetPath))
          box.append(el('div', '', comp.locationNote || '该组件无法选择安装位置'))
          fixed.append(box)
          locCell.append(fixed)
        }
        row.append(locCell)
      }

      row.append(sizeCell)
      tbody.append(row)
    }
    table.append(tbody)
    body.append(table)
  }

  // 需要手动下载的组件：给出为什么不由程序下载，以及完整的下载与导入步骤
  for (const comp of plan.components.filter((c) => c.manualInstall)) {
    body.append(renderManualBox(comp))
  }

  if (plan.skipped.length) {
    const box = el('div', 'skipped')
    box.append(el('strong', '', `已跳过 ${plan.skipped.length} 项`))
    const ul = el('ul')
    for (const item of plan.skipped) ul.append(el('li', '', `${item.name}：${item.reason}`))
    box.append(ul)
    body.append(box)
  }

  $('#planSummary').textContent = plan.totals.count
    ? T('共 {n} 项 · 约 {size} · 预计 {min} 分钟', {
        n: plan.totals.count,
        size: formatSize(plan.totals.sizeMB),
        min: plan.totals.minutes
      })
    : ''

  $('#exportBtn').disabled = plan.components.length === 0
  $('#installBtn').disabled = plan.components.length === 0
}

/** 切换组件版本：更新计划、重算体积与时长，然后重绘 */
function onVersionChange(comp, versionId) {
  const plan = state.plan
  if (!plan) return
  const item = plan.components.find((c) => c.id === comp.id)
  if (!item) return

  const hit = (item.versions || []).find((v) => v.id === versionId)
  if (!hit) return

  item.versionId = hit.id
  item.version = hit.label || hit.id
  item.versionNote = hit.note || null
  item.versionNoteVars = hit.noteVars || null
  if (typeof hit.sizeMB === 'number') item.sizeMB = hit.sizeMB
  state.versionChoices[comp.id] = hit.id

  // 重算总计
  const totalMB = plan.components.reduce((s, c) => s + (c.sizeMB || 0), 0)
  plan.totals.sizeMB = totalMB
  plan.totals.minutes = totalMB > 0 ? Math.max(2, Math.round(totalMB / 300 + plan.components.length * 1.5)) : 0

  renderPlan(plan)
}

function renderManualBox(comp) {
  const box = el('div', 'manual-box')

  const head = el('div', 'manual-box__head')
  head.append(el('span', 'manual-box__badge', '需手动下载'))
  head.append(el('strong', '', comp.name))
  box.append(head)

  box.append(el('p', 'manual-box__why', comp.manual.why))

  const steps = el('ol', 'manual-box__steps')
  for (const step of comp.manual.steps) steps.append(el('li', '', step))
  box.append(steps)

  const actions = el('div', 'manual-box__actions')

  const openBtn = el('button', 'ghost ghost--sm', '打开下载页')
  openBtn.addEventListener('click', () => window.autoed.openManualUrl(comp.manual.downloadPage))
  actions.append(openBtn)

  const importBtn = el('button', 'ghost ghost--sm', '导入已下载的目录')
  importBtn.addEventListener('click', async () => {
    const result = await window.autoed.importManual({
      id: comp.id,
      installRoot: $('#installRoot').value.trim()
    })
    if (result.ok) {
      toast(`${comp.name} 已导入（${result.version}），code 命令可用`)
      await loadDiagnostics()
      if (!$('#diagnosticsPanel').hidden) {
        $('#diagnosticsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    } else if (!result.canceled) {
      toast(result.error || '导入失败')
    }
  })
  actions.append(importBtn)

  box.append(actions)
  return box
}

async function onLocationChange(comp, input) {
  const value = input.value.trim()
  const check = await window.autoed.validatePath(value)

  input.classList.toggle('is-invalid', !check.ok)

  if (!check.ok) {
    toast(check.error)
    input.value = comp.targetPath
    return
  }
  if (check.warning) toast(check.warning)

  if (value === comp.targetPath) return
  state.overrides[comp.id] = value
  await refreshPlan()
}

/* ---------- 诊断 ---------- */

async function loadDiagnostics() {
  const root = $('#installRoot').value.trim()
  const status = await window.autoed.getStatus(root)
  state.status = status
  renderDiagnostics(status)
}

function renderDiagnostics(status) {
  const body = $('#diagBody')
  body.innerHTML = ''

  if (!status.components.length) {
    body.append(el('p', 'empty', `${status.installRoot || '该目录'} 下还没有 AutoED 安装的组件。`))
    $('#diagSummary').textContent = ''
    return
  }

  const pathInfo = status.pathInfo
  const summary = [
    T('共 {n} 项', { n: status.components.length }),
    T('占用 {size}', { size: formatSize(status.totalMB) })
  ]
  if (pathInfo) summary.push(`PATH ${pathInfo.length}/${pathInfo.hardLimit}`)

  const sumEl = $('#diagSummary')
  sumEl.textContent = summary.join(' · ')
  sumEl.className = 'hint'
  if (pathInfo && pathInfo.level === 'over') {
    sumEl.classList.add('path-over')
    sumEl.title = `用户 PATH 已超过 ${pathInfo.hardLimit} 字符，可能被 Windows 截断，建议清理失效目录`
  } else if (pathInfo && pathInfo.level === 'warn') {
    sumEl.classList.add('path-warn')
    sumEl.title = `用户 PATH 接近 ${pathInfo.softLimit} 字符上限，再加组件有被截断的风险`
  } else if (pathInfo) {
    sumEl.title = `用户 PATH 共 ${pathInfo.entries} 条，长度正常`
  }

  const grid = el('div', 'diag-grid')
  for (const item of status.components) {
    const row = el('div', 'diag-row')

    row.append(el('div', 'diag-row__name', item.id))

    const pathBox = el('div')
    pathBox.append(el('div', 'diag-row__path', item.path))
    if (!item.exists) pathBox.append(el('div', 'diag-row__meta diag-missing', '目录不存在（可能被手动删除或移动）'))
    row.append(pathBox)

    const meta = el('div', 'diag-row__meta')
    meta.textContent = item.version || '未知版本'
    if (item.binDir && item.binDir !== item.path) meta.append(el('div', '', item.binDir))

    // 多版本（Python）：逐版本列出，可一键切换默认
    if (item.variants && Object.keys(item.variants).length > 1) {
      const box = el('div', 'diag-variants')
      for (const [ver, v] of Object.entries(item.variants)) {
        const line = el('div', 'diag-variant')
        const active = String(item.binDir || '').toLowerCase() === String(v.binDir || '').toLowerCase()
        line.append(el('span', 'diag-variant__ver', `v${ver}`))
        line.append(el('span', 'diag-variant__path', v.path || ''))
        if (active) {
          line.append(el('span', 'diag-variant__tag', '默认'))
        } else {
          const btn = el('button', 'ghost ghost--sm', '设为默认')
          btn.addEventListener('click', () => setDefaultVariant(item, ver, btn))
          line.append(btn)
        }
        box.append(line)
      }
      meta.append(box)
    }
    row.append(meta)

    const actions = el('div', 'diag-row__actions')
    const moveBtn = el('button', 'ghost ghost--sm', '迁移')
    moveBtn.disabled = !item.exists
    moveBtn.addEventListener('click', () => migrate(item))

    const reinstallBtn = el('button', 'ghost ghost--sm', '重装')
    reinstallBtn.title = '按当前记录的版本重新下载并覆盖安装'
    reinstallBtn.addEventListener('click', () => reinstall(item))

    const removeBtn = el('button', 'ghost ghost--sm danger', '卸载')
    removeBtn.addEventListener('click', () => uninstall(item))

    actions.append(moveBtn, reinstallBtn, removeBtn)
    row.append(actions)

    grid.append(row)
  }
  body.append(grid)

  // 装的东西是不是真的会被用上——异步检查，不拖慢列表渲染
  checkCommandResolution()
}

/** 检查几个关键命令实际解析到哪个目录 */
async function checkCommandResolution() {
  const host = $('#diagBody')
  const old = host.querySelector('.diag-warn')
  if (old) old.remove()

  const root = $('#installRoot').value.trim()
  const res = await window.autoed.resolution(root).catch(() => null)
  if (!res || !res.ok) return

  const bad = res.rows.filter((r) => !r.ok)
  if (!bad.length) return

  const box = el('div', 'diag-warn')
  box.append(el('div', 'diag-warn__title', `有 ${bad.length} 个命令没指向 AutoED 装的版本`))
  box.append(el('div', 'hint', '这通常是 PATH 里有更早的同名程序（常见：微软商店的 python 占位程序）。'))

  for (const r of bad) {
    const line = el('div', 'diag-warn__row')
    line.append(el('code', 'diag-warn__cmd', r.command))
    line.append(el('span', 'diag-warn__actual', r.actual || '未找到'))
    const btn = el('button', 'ghost ghost--sm', '修正')
    btn.addEventListener('click', () => fixResolution(r, btn))
    line.append(btn)
    box.append(line)
  }
  host.prepend(box)
}

async function fixResolution(row, btn) {
  btn.disabled = true
  btn.textContent = '修正中…'
  try {
    const res = await window.autoed.fixResolution({
      installRoot: $('#installRoot').value.trim(),
      id: row.id
    })
    if (res.ok) {
      toast(`${row.command} 已指向 AutoED 的版本，新开的终端生效`)
      await loadDiagnostics()
    } else if (res.blockedByMachinePath) {
      toast('冲突来自系统级 PATH，修改需要管理员权限')
    } else {
      toast(res.error || '修正失败')
    }
  } catch (err) {
    toast('修正失败：' + (err.message || '未知错误'))
  } finally {
    btn.disabled = false
    btn.textContent = '修正'
  }
}

async function migrate(item) {
  const picked = await window.autoed.pickPath(`选择 ${item.id} 的新位置`)
  if (picked.canceled || !picked.path) return

  const check = await window.autoed.validatePath(picked.path)
  if (!check.ok) {
    toast(check.error)
    return
  }

  toast(`正在把 ${item.id} 从 ${item.path} 迁移到 ${picked.path}…`)
  const result = await window.autoed.migrate({
    installRoot: $('#installRoot').value.trim(),
    id: item.id,
    toPath: picked.path
  })

  if (result.ok) {
    toast(result.unchanged ? '位置没有变化' : `已迁移到 ${result.to}`)
    await loadDiagnostics()
    await refreshPlan()
  } else {
    toast(result.error)
  }
}

async function uninstall(item) {
  const result = await window.autoed.uninstall({
    installRoot: $('#installRoot').value.trim(),
    id: item.id
  })

  if (result.ok) {
    const size = result.sizeMB >= 1024 ? `${(result.sizeMB / 1024).toFixed(1)} GB` : `${result.sizeMB} MB`
    toast(`已卸载 ${item.id}，释放 ${size}`)
    await loadDiagnostics()
    if (state.selected.size) await refreshPlan()
  } else if (!result.canceled) {
    toast(result.error || '卸载失败')
  }
}

/** 把某个 Python 版本设为默认（PATH 顺序决定 python 指向谁） */
async function setDefaultVariant(item, version, btn) {
  const original = btn.textContent
  btn.disabled = true
  btn.textContent = '切换中…'
  try {
    const res = await window.autoed.prioritize({
      installRoot: $('#installRoot').value.trim(),
      id: item.id,
      version
    })
    if (res.ok) {
      toast(res.changed ? `已把 Python ${version} 设为默认（新开的终端生效）` : `Python ${version} 本来就是默认`)
      if (res.warning) toast(res.warning)
      await loadDiagnostics()
    } else {
      toast(res.error || '切换失败')
    }
  } catch (err) {
    toast('切换失败：' + (err.message || '未知错误'))
  } finally {
    btn.disabled = false
    btn.textContent = original
  }
}

/** 重装：按现有记录重新下载并覆盖安装 */
async function reinstall(item) {
  const root = $('#installRoot').value.trim()
  const ok = window.confirm(
    `重装 ${item.id}？\n\n会重新下载 ${item.version || '当前记录的版本'}，覆盖到\n${item.path}\n\n目录里的其他文件不会被删除。`
  )
  if (!ok) return

  toast(`正在重装 ${item.id}…`)
  const res = await window.autoed
    .reinstall({ installRoot: root, id: item.id })
    .catch((e) => ({ ok: false, error: e.message }))

  if (res.ok) {
    toast(`${item.id} 重装完成`)
    await loadDiagnostics()
    if (state.selected.size) await refreshPlan()
  } else {
    toast(res.error || '重装失败')
  }
}

/* ---------- 自动更新 ---------- */

let updateInfo = { status: 'idle' }

function renderUpdateButton(info) {
  updateInfo = info
  const btn = $('#updateBtn')
  if (!btn) return

  switch (info.status) {
    case 'available':
      btn.hidden = false
      btn.disabled = false
      btn.textContent = `更新 ${info.version}`
      btn.title = `发现新版本 ${info.version}，点击下载`
      break
    case 'downloading':
      btn.hidden = false
      btn.disabled = true
      btn.textContent = `下载中 ${info.percent || 0}%`
      break
    case 'ready':
      btn.hidden = false
      btn.disabled = false
      btn.textContent = '待重启更新'
      btn.title = '点击选择何时重启'
      break
    default:
      // checking / none / dev / unsupported / error / idle：不显示
      btn.hidden = true
      break
  }
}

async function onUpdateClick() {
  if (updateInfo.status === 'available') {
    const state = await window.autoed.downloadUpdate()
    renderUpdateButton(state)
    return
  }
  if (updateInfo.status === 'ready') {
    $('#updateDialogText').textContent = `新版本 ${updateInfo.version} 已下载完成，重启后生效。安装组件的过程不会被中断。`
    $('#updateDialog').hidden = false
  }
}

async function restartForUpdate() {
  $('#updateDialog').hidden = true
  const result = await window.autoed.installUpdate()
  if (!result.ok) toast(result.error || '重启失败')
}

window.autoed.onUpdateState(renderUpdateButton)

/* ---------- 安装 ---------- */

const progressRows = new Map()

function ensureRow(id, name) {
  if (progressRows.has(id)) return progressRows.get(id)

  const wrap = el('div', 'progress-item')
  const head = el('div', 'progress-item__head')
  const status = el('span', 'progress-item__status', '○')
  const nameEl = el('span', 'progress-item__name', name)
  head.append(status, nameEl)

  const msg = el('div', 'progress-item__msg', '等待中')
  const bar = el('div', 'progress-bar')
  const fill = el('div', 'progress-bar__fill')
  bar.append(fill)

  wrap.append(head, msg, bar)
  $('#progressList').append(wrap)

  const row = { wrap, status, nameEl, msg, bar, fill }
  progressRows.set(id, row)
  return row
}

function setRowState(row, value, text) {
  row.wrap.classList.remove('is-running', 'is-done', 'is-failed', 'is-skipped')
  row.wrap.classList.add(`is-${value}`)
  if (text) row.msg.textContent = text
}

function handleInstallEvent(event) {
  const summary = $('#progressSummary')

  switch (event.type) {
    case 'install-start':
      progressRows.clear()
      $('#progressList').innerHTML = ''
      summary.textContent = `共 ${event.total} 个组件`
      break

    case 'component-start': {
      const row = ensureRow(event.id, event.name)
      setRowState(row, 'running', '准备中…')
      summary.textContent = `正在安装 ${event.index + 1}/${event.total}`
      break
    }

    case 'component-progress': {
      const row = ensureRow(event.id, event.name)
      if (typeof event.percent === 'number') {
        row.fill.style.width = `${event.percent}%`
        row.msg.textContent = `${event.message} ${event.percent.toFixed(0)}%`
      } else {
        row.msg.textContent = event.message || ''
        if (event.phase === 'extract' || event.phase === 'path' || event.phase === 'verify') row.fill.style.width = '100%'
      }
      break
    }

    case 'component-done': {
      const row = ensureRow(event.id, event.name)
      row.fill.style.width = '100%'
      setRowState(row, 'done', `${event.version || '已安装'}　→　${event.path}`)
      row.status.textContent = '✓'
      break
    }

    case 'component-skipped': {
      const row = ensureRow(event.id, event.name)
      row.bar.hidden = true
      setRowState(row, 'skipped', event.reason)
      row.status.textContent = '–'
      break
    }

    case 'component-manual': {
      const row = ensureRow(event.id, event.name)
      row.bar.hidden = true
      setRowState(row, 'skipped', `${event.reason}（见上方下载说明）`)
      row.status.textContent = '⬇'
      break
    }

    case 'component-failed': {
      const row = ensureRow(event.id, event.name)
      setRowState(row, 'failed', event.reason)
      row.status.textContent = '✗'
      break
    }

    case 'rollback-start':
      summary.textContent = `安装失败，正在回滚 ${event.count} 项改动…`
      break

    case 'rollback-done':
      summary.textContent = '已回滚，系统保持原状'
      break

    case 'install-done':
      summary.textContent = '安装完成'
      break

    default:
      break
  }
}

window.autoed.onInstallProgress(handleInstallEvent)

async function startInstall(skipConfirm = false) {
  if (!state.plan || !state.plan.components.length) return

  const root = $('#installRoot').value.trim()
  const names = state.plan.components.map((c) => `${c.name} → ${c.targetPath}`).join('\n· ')
  const usage = (state.plan.usage || [])
    .map(
      (u) =>
        T('{drive}: 预计 +{size}', { drive: u.drive, size: formatSize(u.sizeMB) }) +
        (u.freeGB !== null ? T('（剩余 {gb} GB）', { gb: u.freeGB }) : '')
    )
    .join('\n')

  const confirmed = skipConfirm || window.confirm(
    `即将安装 ${state.plan.components.length} 个组件：\n\n· ${names}\n\n预计占用：\n${usage}\n\n安装会修改当前用户的 PATH 环境变量（不需要管理员权限）。继续？`
  )
  if (!confirmed) return

  $('#progressPanel').hidden = false
  $('#installBtn').disabled = true
  $('#exportBtn').disabled = true
  $('#progressPanel').scrollIntoView({ behavior: 'smooth', block: 'start' })

  const result = await window.autoed.startInstall({ plan: state.plan, installRoot: root })

  $('#installBtn').disabled = false
  $('#exportBtn').disabled = false

  if (result.ok) {
    toast('全部组件安装完成')
    await loadDiagnostics()
  } else if (result.error) {
    toast(`安装未开始：${result.error}`)
  } else {
    toast('安装失败并已回滚，详情见下方进度')
  }
}

/* ---------- 新手教程 / 注意事项 ---------- */

const NOTES = [
  {
    icon: '🛡',
    title: '系统权限：它会改什么、不会改什么',
    items: [
      '默认走<strong>便携模式</strong>，全程不弹 UAC，不需要管理员权限。',
      '只写<strong>当前用户的 PATH</strong>（注册表 HKCU\\Environment），不碰系统级 PATH。',
      '不写系统目录、不改系统设置、不安装 Windows 服务、不产生卸载注册项。',
      'C/C++ 使用 <strong>MinGW-w64（GCC）</strong>，不安装 MSVC —— 因此全程不需要任何提权操作。',
      'PATH 有<strong>长度保护</strong>：超过 1800 字符会提醒，超过 3000 字符直接拒绝写入，避免被 Windows 截断后连累其它软件。',
      '每个组件都能随时<strong>迁移 / 重装 / 卸载</strong>，卸载会同时清掉 PATH 条目。'
    ]
  },
  {
    icon: '🌐',
    title: '网络：连不上 GitHub 怎么办',
    items: [
      '内置<strong>镜像自动测速</strong>：直连、ghfast、geekertao、ghproxy 四路并发测速，选最快的下载，支持断点续传。',
      '如果所在网络需要代理：打开顶部<strong>「高级 → 网络」</strong>填上代理地址（如 http://127.0.0.1:7890），版本查询和文件下载都会走它。',
      'GitHub 接口不可用时，程序会自动回退到<strong>内置版本清单</strong>，仍然可以安装，不会白屏。',
      'VS Code 不由本程序下载：微软只提供单一 CDN，实测约 0.3 MB/s，改成「打开下载页 → 导入已下载的目录」。',
      '合规提醒：使用任何网络代理或加速工具，请遵守当地法律法规和所在网络的管理规定。'
    ]
  },
  {
    icon: '🧩',
    title: '版本可以自己选',
    items: [
      '<strong>Python</strong> 可选 3.13 / 3.12 / 3.11 / 3.10；<strong>Node.js</strong> 可选 LTS / 22 / 20 / 18。',
      '<strong>PyTorch</strong> 可选「自动匹配」或指定 CUDA 12.8 / 12.6 / 13.0；自动匹配会按显卡和驱动挑。',
      '在推荐方案里直接改下拉框，<strong>装的就是你选的那个版本</strong>，体积和时间也会跟着重算。',
      '数据方向默认 Python 3.12（预编译包最全），AI 方向默认 3.11（深度学习生态最成熟）。',
      '每个 Python 版本装在<strong>独立目录</strong>（python\\3.12、python\\3.11、…），互不覆盖，卸载一个也不会带走别的。',
      '新装的版本会自动成为默认（PATH 里排最前）。想换回来：诊断窗口的 Python 行里，点对应版本的「<strong>设为默认</strong>」。'
    ]
  },
  {
    icon: '📦',
    title: '装完之后还能做什么',
    items: [
      '<strong>诊断窗口</strong>：每行显示路径、版本、体积，可一键迁移、重装、卸载。',
      '<strong>软件库</strong>：Notepad++、Neovim、ripgrep、GitHub CLI、DBeaver 可直接安装（带版本选择）；PyCharm、IDEA、Postman、Docker 等给出官方地址。',
      '<strong>环境锁</strong>：把当前环境导出成一个文件，别人拿到就能装成一模一样；也能读入别人的锁，勾选要补的组件一键重建。',
      '<strong>日志</strong>：出问题先「导出日志」，「解析日志文件」能认出网络、证书、限流、磁盘、权限等常见报错并给处理办法。'
    ]
  },
  {
    icon: '🔲',
    title: '界面：栏目可以拖出来',
    items: [
      '每个栏目右上角有个 <strong>⤢</strong>：点一下，或者按住标题栏<strong>拖到窗口外</strong>，就会变成独立窗口。',
      '适合双屏：把「推荐方案」拖到副屏，主屏继续看设备信息。',
      '<strong>诊断</strong>本身就是一个独立窗口，不占主界面。',
      '独立窗口里的选择会和主窗口同步；关掉它不影响任何正在进行的安装。'
    ]
  },
  {
    icon: '🧭',
    title: '可能遇到的现象与处理办法',
    items: [
      '首次打开时几秒没有反应：硬件检测要启动 PowerShell 并查询 CIM，期间界面显示骨架屏，属正常现象。',
      '装完 VS Code 后 <strong>code 命令不生效</strong>：PATH 只在新建进程时读取，重开一个终端即可。',
      '<strong>cmake --version</strong> 与安装记录不一致：w64devkit 自带一份 CMake 且排在 PATH 前面，两者都能正常构建。',
      '杀毒软件拦截：正式发布的安装包已做<strong>代码签名</strong>；若仍被拦，请把 AutoED 加入白名单后运行。',
      '安装中途失败：会自动<strong>回滚</strong>本次对 PATH 和目录的改动，不会留下半套环境。',
      '显存读不到时按保守策略处理：可能把可用的 NVIDIA 显卡判成 CPU 模式，方案里能看到对应说明。'
    ]
  },
  {
    icon: '💡',
    title: '几条使用建议',
    items: [
      '安装位置优先选<strong>非系统盘</strong>（AutoED 会自动挑剩余空间最大的盘），单个深度学习环境就可能占几 GB。',
      '同一个方向装一次就够，已安装的组件重复执行会被跳过或覆盖。',
      '搬动组件请用诊断里的「<strong>迁移</strong>」按钮，不要自己剪切文件夹 —— 否则 PATH 会指向不存在的路径。',
      '诊断窗口顶部会显示 <strong>PATH 用量</strong>（如 357/3000）。变黄说明快满，该清理失效目录了。'
    ]
  }
]

let tutorialFirstRun = false

function renderTutorial() {
  const body = $('#tutorialBody')
  if (body.childElementCount) return

  for (const section of NOTES) {
    const box = el('div', 'note-section')
    const title = el('div', 'note-section__title')
    title.append(el('span', 'note-section__icon', section.icon))
    title.append(el('span', '', section.title))
    box.append(title)

    const ul = el('ul')
    for (const item of section.items) {
      const li = el('li')
      // 内容由本文件维护，允许用 <strong> 强调关键词。
      // 整条作为 key 翻译（含标签），否则 DOM 层会把它拆成多个文本节点各翻各的。
      li.innerHTML = window.i18n.t(item)
      ul.append(li)
    }
    box.append(ul)
    body.append(box)
  }
}

function openTutorial(firstRun) {
  tutorialFirstRun = Boolean(firstRun)
  renderTutorial()
  $('#tutorialOk').textContent = firstRun ? '我已了解，开始使用' : '知道了'
  $('#tutorial').hidden = false
}

async function closeTutorial() {
  $('#tutorial').hidden = true
  await window.autoed.setSettings({ notesSeen: true })

  const btn = $('#notesBtn')
  const wasHidden = btn.hidden
  btn.hidden = false

  // 第一次收起时，让新出现的入口闪红三次，把注意力引过去
  if (tutorialFirstRun && wasHidden) {
    btn.classList.add('flash-red')
    btn.addEventListener('animationend', () => btn.classList.remove('flash-red'), { once: true })
    toast('以后随时可以点左上角「注意事项」重新查看')
  }
  tutorialFirstRun = false
}

/* ---------- 启动 ---------- */

/* ---------- 独立窗口 ---------- */

const PANEL_LABEL = {
  hw: '设备信息',
  scenarios: '你要做什么',
  plan: '推荐方案',
  support: '助力发电',
  diag: '诊断'
}

async function initDetached(params) {
  await setupLocale()
  const panel = DETACHED_PANEL
  const stage = (s) => {
    window.__stage = s
  }
  document.title = `AutoED · ${PANEL_LABEL[panel] || panel}`

  try {
    stage('settings')
    const settings = await window.autoed.getSettings()
    state.defaultInstallRoot = settings.defaultInstallRoot || ''
    $('#installRoot').value = settings.lastInstallRoot || settings.defaultInstallRoot || ''
    stage('settings-done')

    // 只有「设备信息」「你要做什么」需要硬件探测；诊断/方案/助力发电不需要，
    // 否则独立窗口会白等好几秒
    if (panel === 'hw' || panel === 'scenarios') {
      const data = await window.autoed.probe()
      state.permission = data.permission
      state.hardware = data.hardware
      state.scenarios = data.scenarios
    }

    if (panel === 'hw') {
      renderPermission(state.permission)
      renderHardware(state.hardware)
      const blank = await window.autoed.buildPlan({
        scenarioIds: [],
        installRoot: $('#installRoot').value.trim()
      })
      renderHwNotes(blank)
    }

    if (panel === 'scenarios') {
      renderScenarios(state.scenarios)
      const sync = await window.autoed.syncGet()
      applySelection(sync.selection || [])
      window.autoed.onSyncChanged((s) => applySelection(s.selection || []))
    }

    if (panel === 'plan') {
      const sync = await window.autoed.syncGet()
      applySelection(sync.selection || [])
      if (sync.plan) {
        state.plan = sync.plan
        renderPlan(sync.plan)
      } else {
        $('#planBody').innerHTML = '<p class="empty">主窗口还没有生成方案。先在那里选一个方向。</p>'
      }
      window.autoed.onSyncChanged((s) => {
        applySelection(s.selection || [])
        if (s.plan) {
          state.plan = s.plan
          renderPlan(s.plan)
        }
      })
    }

    if (panel === 'diag') {
      stage('diag')
      const root = $('#installRoot') ? $('#installRoot').value.trim() : ''
      if (!root) throw new Error('安装目录为空，无法读取诊断信息')
      await loadDiagnostics()
      stage('diag-done')
      window.autoed.onSyncChanged(() => loadDiagnostics())
      window.autoed.onInstallProgress((ev) => {
        if (ev.type === 'component-done' || ev.type === 'component-failed') loadDiagnostics()
      })
    }

    window.autoed.notifyReady()
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    console.error('[detached]', err)
    // 独立窗口里 toast 是隐藏的，错误必须写进面板，否则用户只看到一片空白
    const host = $('#diagBody') || $('#planBody') || $('main')
    if (host) host.innerHTML = `<p class="empty">加载失败：${msg}</p>`
  }
}

function applySelection(ids) {
  state.selected = new Set(ids)
  document.querySelectorAll('.scenario').forEach((node) => {
    node.classList.toggle('is-active', state.selected.has(node.dataset.id))
  })
}

/* ---------- 拖出成独立窗口 ---------- */

const DETACHABLE = [
  { panel: 'hw', section: '#panel-hw' },
  { panel: 'scenarios', section: '#panel-scenarios' },
  { panel: 'plan', section: '#panel-plan' },
  { panel: 'support', section: '#panel-support' }
]

function setupDetach() {
  if (isDetached()) return

  for (const d of DETACHABLE) {
    const section = $(d.section)
    if (!section) continue

    const headBox = section.querySelector('.panel__head')
    const handle = headBox || section
    handle.classList.add('drag-handle')

    const btn = el('button', 'ghost ghost--sm detach-btn', '⤢')
    btn.title = '点击或按住拖出，成为独立窗口'
    btn.setAttribute('aria-label', `把${PANEL_LABEL[d.panel]}拖出成独立窗口`)
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      window.autoed.detachPanel({ panel: d.panel }).catch(() => {})
    })

    if (headBox) {
      // 统一收进右侧工具区，避免把「重新检测」之类的按钮挤到标题旁边
      let tools = headBox.querySelector('.panel__tools')
      if (!tools) {
        tools = el('div', 'panel__tools')
        ;[...headBox.children].forEach((child) => {
          if (child.tagName !== 'H2') tools.append(child)
        })
        headBox.append(tools)
      }
      tools.append(btn)
    } else {
      // 助力发电这种没有标题栏的，按钮浮在右上角
      section.classList.add('panel--floating-btn')
      section.append(btn)
    }

    // 拖拽：pointer capture 保证在窗口外松手也能收到 pointerup
    let start = null
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      if (e.target.closest('button, input, select, a, textarea')) return
      start = { x: e.screenX, y: e.screenY }
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {}
      section.classList.add('is-dragging')
    })
    handle.addEventListener('pointerup', (e) => {
      if (!start) return
      const dx = e.screenX - start.x
      const dy = e.screenY - start.y
      start = null
      section.classList.remove('is-dragging')
      if (Math.abs(dx) < 40 && Math.abs(dy) < 40) return
      window.autoed
        .detachPanel({ panel: d.panel, x: e.screenX, y: e.screenY })
        .then((res) => {
          if (res && res.ok) toast(`已在独立窗口中打开「${PANEL_LABEL[d.panel]}」`)
        })
        .catch(() => {})
    })
    handle.addEventListener('pointercancel', () => {
      start = null
      section.classList.remove('is-dragging')
    })
  }
}

/** 把主窗口的状态推给已打开的独立窗口 */
function pushSync(patch = {}) {
  if (isDetached()) return
  window.autoed.syncSet({
    selection: [...state.selected],
    installRoot: $('#installRoot') ? $('#installRoot').value.trim() : '',
    plan: state.plan,
    ...patch
  })
}

async function init() {
  const params = new URLSearchParams(location.search)
  if (isDetached()) return initDetached(params)

  await setupLocale()

  try {
    const data = await window.autoed.probe()

    state.permission = data.permission
    state.hardware = data.hardware
    state.scenarios = data.scenarios

    renderPermission(data.permission)
    renderHardware(data.hardware)
    renderScenarios(data.scenarios)

    // 面板拖出与跨窗口同步（独立窗口里不启用）
    setupDetach()
    window.autoed.onSyncAction((action) => {
      if (!action) return
      if (action.type === 'toggle-scenario') toggleScenario(action.id)
    })
    $('#installRoot').addEventListener('change', () => pushSync())

    const blank = await window.autoed.buildPlan({ scenarioIds: [], installRoot: $('#installRoot').value.trim() })
    renderHwNotes(blank)

    if (params.get('locations') === '1') {
      state.showLocations = true
      $('#customizeBtn').textContent = '隐藏位置'
    }
    const demo = params.get('demo')
    if (demo) {
      for (const id of demo.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (state.scenarios.some((s) => s.id === id)) state.selected.add(id)
      }
      document.querySelectorAll('.scenario').forEach((node) => {
        node.classList.toggle('is-active', state.selected.has(node.dataset.id))
      })
      await refreshPlan()
    }

    if (params.get('diag') === '1') {
      $('#diagnosticsPanel').hidden = false
      await loadDiagnostics()
    }

    if (params.get('software') === '1') openSoftware()
    if (params.get('advanced') === '1') openAdvanced()

    const lockPath = params.get('lock')
    if (lockPath) {
      openAdvanced()
      window.autoed
        .readLock(lockPath)
        .then((res) => {
          if (res && res.ok) renderLockResult(res)
          else if (res && res.error) toast('读取环境锁失败：' + res.error)
        })
        .catch(() => {})
    }

    // 开发用：?installone=ninja —— 只装一个小组件，用来截取真实的安装进度画面
    const installOne = params.get('installone')
    if (installOne) {
      const status = await window.autoed.getStatus($('#installRoot').value.trim())
      const rec = (status.components || []).find((c) => c.id === installOne)
      if (rec) {
        const built = await window.autoed.planFromLock({
          lock: {
            installRoot: $('#installRoot').value.trim(),
            components: [{ id: installOne, name: rec.id, version: rec.version, relativePath: null }]
          },
          ids: [installOne],
          installRoot: $('#installRoot').value.trim()
        })
        if (built && built.ok) {
          state.plan = built.plan
          // 故意不 await：让界面先就绪，截图才能拍到"安装进行中"
          startInstall(true).catch(() => {})
        }
      }
    }

    // 新手教程：首次启动弹出一次，之后收进"注意事项"按钮
    const settings = await window.autoed.getSettings()
    // 安装目录：有历史记录就用历史，否则用探测出来的默认值（不写死 D:）
    state.defaultInstallRoot = settings.defaultInstallRoot || ''
    state.installRoot = settings.lastInstallRoot || settings.defaultInstallRoot || ''
    if (!$('#installRoot').value.trim()) $('#installRoot').value = state.installRoot
    // 硬件卡片里的「剩余空间」要按安装盘算，但渲染时设置还没读出来，这里补一次
    if (state.hardware) renderHardware(state.hardware)
    const force = params.get('tutorial')
    if (force === '1') {
      openTutorial(true)
    } else if (force === '0') {
      $('#notesBtn').hidden = false
    } else if (!settings.notesSeen) {
      openTutorial(true)
    } else {
      $('#notesBtn').hidden = false
    }

    // 更新状态：静默获取，有新版才亮出按钮
    window.autoed
      .updateState()
      .then(renderUpdateButton)
      .catch(() => {})

    if (params.get('install') === '1') {
      await startInstall(true)
      window.autoed.notifyReady()
      return
    }

    window.autoed.notifyReady()
  } catch (err) {
    $('#permissionBadge').className = 'badge badge--warn'
    $('#permissionBadge').textContent = '检测失败'
    toast(`检测失败：${err.message}`)
  }
}

$('#exportBtn').addEventListener('click', async () => {
  if (!state.plan) return
  const result = await window.autoed.exportPlan(state.plan)
  if (result.saved) toast(`方案已导出：${result.filePath}`)
})

$('#installBtn').addEventListener('click', () => startInstall(false))

$('#redetect').addEventListener('click', init)

$('#installRoot').addEventListener('change', () => {
  state.overrides = {}
  if (state.selected.size) refreshPlan()
  if (!$('#diagnosticsPanel').hidden) loadDiagnostics()
})

$('#customizeBtn').addEventListener('click', () => {
  state.showLocations = !state.showLocations
  $('#customizeBtn').textContent = state.showLocations ? '隐藏位置' : '自定义位置'
  if (state.plan) renderPlan(state.plan)
})

// 诊断改为独立窗口：状态、迁移、卸载、重装都在那个窗口里操作
$('#diagBtn').addEventListener('click', async () => {
  const res = await window.autoed.detachPanel({ panel: 'diag' }).catch(() => null)
  if (!res || !res.ok) {
    // 极端情况下退回到主窗口内联显示
    const panel = $('#diagnosticsPanel')
    panel.hidden = false
    await loadDiagnostics()
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
})

$('#diagRefresh').addEventListener('click', loadDiagnostics)

$('#notesBtn').addEventListener('click', () => openTutorial(false))
$('#tutorialOk').addEventListener('click', closeTutorial)

$('#updateBtn').addEventListener('click', onUpdateClick)
$('#updateLater').addEventListener('click', () => {
  $('#updateDialog').hidden = true
  toast('已推迟更新，重启程序后仍可选择立即生效')
})
$('#updateNow').addEventListener('click', restartForUpdate)

// 助力发电：交给系统浏览器打开（主进程有域名白名单）
const supportBtn = $('#supportBtn')
if (supportBtn) {
  supportBtn.addEventListener('click', async () => {
    supportBtn.disabled = true
    try {
      const res = await window.autoed.openExternal('https://afdian.com/a/MinthavePower')
      if (res && res.ok === false) {
        toast(`链接没能打开：${res.error || '未知原因'}。可手动访问 afdian.com/a/MinthavePower`)
      }
    } catch {
      toast('链接没能打开，可手动访问 afdian.com/a/MinthavePower')
    } finally {
      setTimeout(() => { supportBtn.disabled = false }, 800)
    }
  })
}

/* ---------------- 软件库 ---------------- */

// 只放官方地址。体积与安装方式按官方当前分发形式标注，改版后可能需要更新。
const SOFTWARE = [
  {
    name: 'PyCharm Community',
    vendor: 'JetBrains',
    tag: 'Python IDE',
    size: '约 900 MB',
    admin: '需管理员',
    portable: '无便携版',
    why: 'Python 专用 IDE：调试器、重构、虚拟环境管理都比编辑器顺手。社区版免费。',
    tip: '官方只提供 .exe 安装器。想避开 UAC：先装 JetBrains Toolbox，再从 Toolbox 里装 PyCharm，它会落在用户目录下。',
    url: 'https://www.jetbrains.com/pycharm/download/'
  },
  {
    name: 'IntelliJ IDEA Community',
    vendor: 'JetBrains',
    tag: 'Java / Kotlin IDE',
    size: '约 1.2 GB',
    admin: '需管理员',
    portable: '无便携版',
    why: 'Java、Kotlin、Spring 生态最完整的 IDE。社区版免费，和 PyCharm 操作习惯一致。',
    tip: '同一个 Toolbox 可以同时管理 PyCharm 和 IDEA，升级也由它负责。',
    url: 'https://www.jetbrains.com/idea/download/'
  },
  {
    name: 'JetBrains Toolbox',
    vendor: 'JetBrains',
    tag: 'IDE 管理器',
    size: '约 30 MB',
    admin: '免管理员',
    portable: '用户目录',
    why: '用它装 JetBrains 系列 IDE，全部落在 %LOCALAPPDATA%，不写系统目录、不弹 UAC。',
    tip: '这是让 PyCharm 免管理员安装的最省事路径。',
    url: 'https://www.jetbrains.com/toolbox-app/'
  },
  {
    name: 'Postman',
    vendor: 'Postman',
    tag: '接口调试',
    size: '约 300 MB',
    admin: '免管理员',
    portable: '用户目录',
    why: '调后端接口、存请求集合、生成代码片段。写 Web 后端时几乎必用。',
    url: 'https://www.postman.com/downloads/'
  },
  {
    name: 'Docker Desktop',
    vendor: 'Docker',
    tag: '容器',
    size: '约 600 MB',
    admin: '需管理员',
    portable: '无便携版',
    why: '跑数据库、消息队列、部署测试环境最省事。',
    tip: '需要管理员权限，且要先启用 WSL2。它和 AutoED 的「零管理员」理念冲突，按需再装。',
    url: 'https://www.docker.com/products/docker-desktop/'
  },
  {
    name: 'Windows Terminal',
    vendor: 'Microsoft',
    tag: '终端',
    size: '约 20 MB',
    admin: '免管理员',
    portable: '商店安装',
    why: '比系统自带控制台好用得多：多标签、分屏、字体和配色都能调。',
    url: 'https://apps.microsoft.com/detail/9n0dx20hk701'
  }
]

function renderLinkCard(s) {
  const card = el('div', 'soft-item')

  const head = el('div', 'soft-item__head')
  head.append(el('div', 'soft-item__name', s.name))
  head.append(el('div', 'soft-item__tag', s.tag))
  card.append(head)

  const meta = el('div', 'soft-item__meta')
  meta.append(el('span', 'chip', s.size))
  meta.append(el('span', `chip ${s.admin === '免管理员' ? 'chip--ok' : 'chip--warn'}`, s.admin))
  meta.append(el('span', 'chip', s.portable))
  card.append(meta)

  card.append(el('div', 'soft-item__why', s.why))
  if (s.tip) card.append(el('div', 'soft-item__tip', s.tip))

  const actions = el('div', 'soft-item__actions')
  const btn = el('button', 'ghost ghost--sm', '打开下载页')
  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      const res = await window.autoed.openManualUrl(s.url)
      if (res && res.ok === false) toast(`打不开：${res.error || '未知原因'}`)
    } catch {
      toast('打不开下载页，可手动访问 ' + s.url)
    } finally {
      setTimeout(() => { btn.disabled = false }, 800)
    }
  })
  actions.append(btn)
  card.append(actions)

  return card
}

/** 可直装软件的卡片：版本下拉 + 安装 + 进度 */
function renderInstallCard(app) {
  const card = el('div', 'soft-item soft-item--install')
  card.dataset.appId = app.id

  const head = el('div', 'soft-item__head')
  head.append(el('div', 'soft-item__name', app.name))
  head.append(el('div', 'soft-item__tag', app.sizeHint || ''))
  card.append(head)

  const meta = el('div', 'soft-item__meta')
  meta.append(el('span', 'chip chip--ok', '免管理员'))
  meta.append(el('span', 'chip', '解压即用'))
  meta.append(el('span', 'chip', '可直装'))
  card.append(meta)

  card.append(el('div', 'soft-item__why', app.desc))

  const row = el('div', 'soft-install-row')
  const select = el('select', 'ver-select')
  select.disabled = true
  const placeholder = el('option', '', '读取版本…')
  placeholder.value = ''
  select.append(placeholder)
  row.append(select)

  const btn = el('button', 'primary ghost--sm', '安装')
  btn.disabled = true
  row.append(btn)
  card.append(row)

  const status = el('div', 'soft-status')
  card.append(status)

  // 异步拉版本列表
  window.autoed
    .appVersions(app.id)
    .then((res) => {
      if (!res.ok) {
        status.textContent = `读不到版本列表：${res.error}`
        status.classList.add('soft-status--err')
        return
      }
      select.innerHTML = ''
      for (const v of res.versions) {
        const label = /^v/i.test(v.version) ? v.version : `v${v.version}`
        const opt = el('option', '', label)
        opt.value = v.version
        select.append(opt)
      }
      select.disabled = false
      btn.disabled = false
    })
    .catch(() => {
      status.textContent = '读不到版本列表（网络或 GitHub 限流）'
      status.classList.add('soft-status--err')
    })

  btn.addEventListener('click', async () => {
    const version = select.value
    if (!version) return
    btn.disabled = true
    select.disabled = true
    status.className = 'soft-status'
    status.textContent = '准备中…'
    try {
      const root = $('#installRoot').value.trim() || state.defaultInstallRoot || ''
      const res = await window.autoed.installApp({ appId: app.id, version, installRoot: root })
      if (res.ok) {
        status.className = 'soft-status soft-status--ok'
        status.textContent = `已装到 ${res.path}`
      } else {
        status.className = 'soft-status soft-status--err'
        status.textContent = res.error || '安装失败'
      }
    } catch (err) {
      status.className = 'soft-status soft-status--err'
      status.textContent = '安装失败：' + (err.message || '未知错误')
    } finally {
      btn.disabled = false
      select.disabled = false
    }
  })

  return card
}

function renderSoftware() {
  const body = $('#softBody')
  if (body.dataset.rendered) return

  // 1) 可直接安装
  const secA = el('div', 'soft-section')
  const headA = el('div', 'soft-section__head')
  headA.append(el('div', 'soft-section__title', '可直接安装'))
  headA.append(el('span', 'hint', '自动下载官方压缩包、校验并解压到你设定的目录'))
  secA.append(headA)
  const gridA = el('div', 'soft-grid')
  const loading = el('div', 'soft-item')
  loading.append(el('div', 'soft-item__why', '正在读取软件目录…'))
  gridA.append(loading)
  secA.append(gridA)
  body.append(secA)

  window.autoed
    .appCatalog()
    .then((apps) => {
      gridA.innerHTML = ''
      for (const app of apps) gridA.append(renderInstallCard(app))
    })
    .catch(() => {
      gridA.innerHTML = ''
      gridA.append(el('div', 'soft-item__why', '读取软件目录失败，请检查网络'))
    })

  // 2) 只能跳转下载页
  const secB = el('div', 'soft-section')
  const headB = el('div', 'soft-section__head')
  headB.append(el('div', 'soft-section__title', '其他软件（跳转官方下载页）'))
  headB.append(el('span', 'hint', '体积大或没有官方压缩包，用浏览器下载更快'))
  secB.append(headB)
  const gridB = el('div', 'soft-grid')
  for (const s of SOFTWARE) gridB.append(renderLinkCard(s))
  secB.append(gridB)
  body.append(secB)

  body.dataset.rendered = '1'
}

function openSoftware() {
  renderSoftware()
  $('#software').hidden = false
}

function closeSoftware() {
  $('#software').hidden = true
}

$('#softBtn').addEventListener('click', openSoftware)
$('#softClose').addEventListener('click', closeSoftware)
$('#software').addEventListener('click', (e) => {
  if (e.target.id === 'software') closeSoftware()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#software').hidden) closeSoftware()
})

// 安装进度：把主进程推来的 phase/percent 写回对应卡片
if (window.autoed.onAppProgress) {
  window.autoed.onAppProgress((p) => {
    const card = document.querySelector(`.soft-item--install[data-app-id="${p.appId}"]`)
    if (!card) return
    const status = card.querySelector('.soft-status')
    if (!status) return
    status.className = 'soft-status'
    const pct = typeof p.percent === 'number' ? ` ${Math.round(p.percent)}%` : ''
    status.textContent = `${p.message || p.phase}${pct}`
  })
}

/* ---------------- 高级面板：网络 / 日志 / 环境锁 ---------------- */

function openAdvanced() {
  $('#advanced').hidden = false
  loadAdvancedState()
}
function closeAdvanced() {
  $('#advanced').hidden = true
}

async function loadAdvancedState() {
  try {
    const s = await window.autoed.advancedState()
    $('#proxyInput').value = s.proxy || ''
    const st = $('#proxyStatus')
    st.className = 'adv-note'
    st.textContent = s.proxy ? `当前使用代理：${s.proxy}` : '当前：跟随系统（未设置代理）'
    $('#logFileHint').textContent = s.logFile ? `日志文件：${s.logFile}` : '日志文件：尚未创建'
  } catch (err) {
    const st = $('#proxyStatus')
    st.textContent = '读取设置失败：' + (err.message || '未知错误')
    st.className = 'adv-note adv-note--err'
  }
}

async function saveProxy(value) {
  const st = $('#proxyStatus')
  st.className = 'adv-note'
  st.textContent = '正在应用…'
  try {
    const res = await window.autoed.setProxy(value)
    if (!res.ok) {
      st.className = 'adv-note adv-note--err'
      st.textContent = res.error || '设置失败'
      return
    }
    st.className = 'adv-note adv-note--ok'
    st.textContent = res.proxy ? `已启用代理：${res.proxy}` : '已改为跟随系统'
    toast(res.proxy ? '代理已启用' : '已关闭代理')
  } catch (err) {
    st.className = 'adv-note adv-note--err'
    st.textContent = '设置失败：' + (err.message || '未知错误')
  }
}

function renderLogResult(res) {
  const box = $('#logResult')
  box.hidden = false
  box.innerHTML = ''
  if (!res.ok) {
    box.append(el('div', 'adv-note adv-note--err', res.error || '解析失败'))
    return
  }
  box.append(el('div', '', res.verdict))
  box.append(
    el('div', 'adv-note', `${res.stats.lines} 行 · 报错 ${res.stats.errorLines} 行 · 警告 ${res.stats.warnLines} 行`)
  )
  for (const m of res.matches) {
    const item = el('div')
    const head = el('div')
    head.append(el('strong', '', `【${m.title}】`))
    head.append(el('span', 'adv-note', ` 命中 ${m.count} 次`))
    item.append(head)
    item.append(el('div', 'adv-note', m.meaning))
    const ul = el('ul', 'adv-fix')
    for (const f of m.fix) ul.append(el('li', '', f))
    item.append(ul)
    if (m.samples?.length) item.append(el('div', 'adv-sample', m.samples[0]))
    box.append(item)
  }
}

let lockCtx = null

function renderLockResult(res) {
  const box = $('#lockResult')
  box.hidden = false
  box.innerHTML = ''
  if (!res.ok) {
    box.append(el('div', 'adv-note adv-note--err', res.error || '读取失败'))
    return
  }
  lockCtx = res
  const { lock, rows } = res
  const made = (lock.createdAt || '').slice(0, 19).replace('T', ' ')
  box.append(el('div', '', `来自 ${lock.tool || 'AutoED'} ${lock.toolVersion || ''} · 创建于 ${made}`))

  const table = el('table', 'adv-table')
  const head = el('tr')
  for (const t of ['', '组件', '锁里要求', '当前', '状态']) head.append(el('th', '', t))
  table.append(head)

  for (const r of rows) {
    const tr = el('tr')
    const pick = el('td')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'adv-check'
    cb.value = r.id
    // 已一致的不勾选——重建是「可选项」，默认只处理有问题的
    cb.checked = r.status !== 'ok'
    pick.append(cb)
    tr.append(pick)

    tr.append(el('td', '', r.name))
    tr.append(el('td', '', r.want || '-'))
    tr.append(el('td', '', r.have || '未安装'))
    tr.append(
      r.status === 'ok'
        ? el('td', 'adv-ok', '一致')
        : r.status === 'version'
          ? el('td', 'adv-drift', '版本不同')
          : el('td', 'adv-miss', '缺失')
    )
    table.append(tr)
  }
  box.append(table)

  const actions = el('div', 'adv-row adv-row--top')
  const pickAll = el('button', 'ghost ghost--sm', '全选待处理')
  pickAll.addEventListener('click', () => {
    const boxes = box.querySelectorAll('input.adv-check')
    boxes.forEach((cb, i) => {
      cb.checked = rows[i].status !== 'ok'
    })
  })
  const rebuild = el('button', 'primary ghost--sm', '按锁重建所选')
  rebuild.addEventListener('click', () => rebuildFromLock(box, rebuild))
  actions.append(pickAll, rebuild)
  box.append(actions)
  box.append(el('div', 'adv-note', '只重建勾选的组件；已经一致的不必重装。'))
}

/** 按勾选项生成计划，然后复用首页那条安装流水线 */
async function rebuildFromLock(box, btn) {
  if (!lockCtx) return
  const ids = [...box.querySelectorAll('input.adv-check:checked')].map((cb) => cb.value)
  if (!ids.length) {
    toast('先勾选要重建的组件')
    return
  }

  const original = btn.textContent
  btn.disabled = true
  btn.textContent = '准备中…'
  try {
    const res = await window.autoed.planFromLock({
      lock: lockCtx.lock,
      ids,
      installRoot: lockCtx.installRoot
    })
    if (!res.ok) {
      toast('无法生成计划：' + (res.error || '未知错误'))
      return
    }
    state.plan = res.plan
    $('#installRoot').value = res.plan.installRoot
    closeAdvanced()
    await startInstall(true)
  } catch (err) {
    toast('重建失败：' + (err.message || '未知错误'))
  } finally {
    btn.disabled = false
    btn.textContent = original
  }
}

$('#advBtn').addEventListener('click', openAdvanced)
$('#advClose').addEventListener('click', closeAdvanced)
$('#advanced').addEventListener('click', (e) => {
  if (e.target.id === 'advanced') closeAdvanced()
})

$('#proxySave').addEventListener('click', () => saveProxy($('#proxyInput').value.trim()))
$('#proxyClear').addEventListener('click', () => {
  $('#proxyInput').value = ''
  saveProxy('')
})

$('#logExport').addEventListener('click', async () => {
  const res = await window.autoed.exportLog().catch((e) => ({ ok: false, error: e.message }))
  if (res.ok) toast(`日志已导出：${res.filePath}`)
  else if (!res.canceled) toast('导出失败：' + (res.error || '未知错误'))
})

$('#logParse').addEventListener('click', async () => {
  const res = await window.autoed.parseLog().catch((e) => ({ ok: false, error: e.message }))
  if (res.canceled) return
  renderLogResult(res)
})

$('#lockExport').addEventListener('click', async () => {
  const root = $('#installRoot').value.trim()
  const res = await window.autoed.exportLock(root).catch((e) => ({ ok: false, error: e.message }))
  if (res.ok) toast(`环境锁已导出（${res.count} 个组件）`)
  else if (!res.canceled) toast('导出失败：' + (res.error || '未知错误'))
})

$('#lockRead').addEventListener('click', async () => {
  const res = await window.autoed.readLock().catch((e) => ({ ok: false, error: e.message }))
  if (res.canceled) return
  renderLockResult(res)
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#advanced').hidden) closeAdvanced()
})

init()
