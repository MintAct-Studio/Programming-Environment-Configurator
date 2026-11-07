'use strict'
const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染进程与主进程之间唯一的通道。
 * 只暴露具名方法，渲染进程拿不到任何 Node 能力。
 */
contextBridge.exposeInMainWorld('autoed', {
  probe: () => ipcRenderer.invoke('env:probe'),
  buildPlan: (payload) => ipcRenderer.invoke('plan:build', payload),
  exportPlan: (plan) => ipcRenderer.invoke('plan:export', plan),
  startInstall: (payload) => ipcRenderer.invoke('install:start', payload),

  // 路径与诊断
  validatePath: (path) => ipcRenderer.invoke('path:validate', { path }),
  pickPath: (title) => ipcRenderer.invoke('path:pick', { title }),
  getStatus: (installRoot) => ipcRenderer.invoke('status:get', { installRoot }),
  migrate: (payload) => ipcRenderer.invoke('migrate:start', payload),
  uninstall: (payload) => ipcRenderer.invoke('uninstall:start', payload),

  // 手动安装（VS Code）
  openManualUrl: (url) => ipcRenderer.invoke('manual:open', { url }),
  // 打开外部链接（主进程有域名白名单）
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', { url }),
  importManual: (payload) => ipcRenderer.invoke('manual:import', payload),

  // 可直装软件
  appCatalog: () => ipcRenderer.invoke('apps:catalog'),
  appVersions: (appId) => ipcRenderer.invoke('apps:versions', { appId }),
  installApp: (payload) => ipcRenderer.invoke('apps:install', payload),
  onAppProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('apps:progress', handler)
    return () => ipcRenderer.removeListener('apps:progress', handler)
  },

  // 本地设置（是否已读注意事项）
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 界面语言词典
  getI18n: () => ipcRenderer.invoke('i18n:get'),

  // 面板独立窗口与跨窗口同步
  detachPanel: (payload) => ipcRenderer.invoke('panel:detach', payload),
  syncGet: () => ipcRenderer.invoke('sync:get'),
  syncSet: (patch) => ipcRenderer.send('sync:set', patch),
  onSyncChanged: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('sync:changed', handler)
    return () => ipcRenderer.removeListener('sync:changed', handler)
  },
  reinstall: (payload) => ipcRenderer.invoke('diag:reinstall', payload),
  prioritize: (payload) => ipcRenderer.invoke('diag:prioritize', payload),
  resolution: (installRoot) => ipcRenderer.invoke('diag:resolution', { installRoot }),
  fixResolution: (payload) => ipcRenderer.invoke('diag:fixResolution', payload),
  syncAction: (action) => ipcRenderer.send('sync:action', action),
  onSyncAction: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('sync:action', handler)
    return () => ipcRenderer.removeListener('sync:action', handler)
  },

  // 高级：网络 / 日志 / 环境锁
  advancedState: () => ipcRenderer.invoke('advanced:state'),
  setProxy: (proxy) => ipcRenderer.invoke('advanced:setProxy', { proxy }),
  exportLog: () => ipcRenderer.invoke('advanced:exportLog'),
  parseLog: () => ipcRenderer.invoke('advanced:parseLog'),
  exportLock: (installRoot) => ipcRenderer.invoke('advanced:exportLock', { installRoot }),
  readLock: (path) => ipcRenderer.invoke('advanced:readLock', { path }),
  planFromLock: (payload) => ipcRenderer.invoke('advanced:planFromLock', payload),

  // 自动更新
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('update:state', handler)
    return () => ipcRenderer.removeListener('update:state', handler)
  },

  onInstallProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('install:progress', handler)
    return () => ipcRenderer.removeListener('install:progress', handler)
  },
  notifyReady: () => ipcRenderer.send('ui:ready')
})
