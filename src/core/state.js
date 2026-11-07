'use strict'
/**
 * 已安装组件的状态注册表（<安装根目录>/.autoed/state.json）。
 *
 * 记录每个组件装在哪、版本是什么、哪个目录进了 PATH。
 * 诊断页、迁移功能、以及 python/node 这类"依赖另一个组件"的通道都读它。
 */
const fsp = require('node:fs/promises')
const path = require('node:path')

function stateFile(installRoot) {
  return path.join(installRoot, '.autoed', 'state.json')
}

async function loadState(installRoot) {
  try {
    return JSON.parse(await fsp.readFile(stateFile(installRoot), 'utf8'))
  } catch {
    return {}
  }
}

async function saveState(installRoot, state) {
  const file = stateFile(installRoot)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(state, null, 2), 'utf8')
}

async function markInstalled(installRoot, id, info) {
  const state = await loadState(installRoot)
  state[id] = { ...info, installedAt: new Date().toISOString() }
  await saveState(installRoot, state)
  return state
}

module.exports = { loadState, saveState, markInstalled, stateFile }
