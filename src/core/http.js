'use strict'
/**
 * 统一的 HTTP 入口。
 *
 * 为什么不让各模块直接用 fetch：
 *  Node 自带的 fetch **不读代理设置**，也不会走系统代理。
 *  Electron 的 net.fetch 会跟随 session 的代理配置，所以只要能用就用它，
 *  拿不到（比如在纯 Node 里跑测试）再退回全局 fetch。
 */
const logger = require('./logger')

let proxyRules = ''

/** 由主进程在设置变更时调用 */
function setProxy(rules) {
  proxyRules = String(rules || '').trim()
  return proxyRules
}

function getProxy() {
  return proxyRules
}

function electronNet() {
  try {
    // 只有在 Electron 主进程里才拿得到 net
    const electron = require('electron')
    if (electron && electron.net && typeof electron.net.fetch === 'function') return electron.net
  } catch {
    /* 纯 Node 环境，忽略 */
  }
  return null
}

/**
 * 先试 Electron 的 net.fetch（走代理），失败再退回全局 fetch。
 * 注意：不要在 fetch 外层吞掉 AbortError——超时判断依赖它。
 */
async function fetchWith(url, opts = {}) {
  const net = electronNet()
  if (net) {
    try {
      return await net.fetch(url, opts)
    } catch (err) {
      if (err && err.name === 'AbortError') throw err
      logger.warn('http', `net.fetch 失败，退回内置 fetch：${err.message}`)
    }
  }
  return fetch(url, opts)
}

/** GET 一个 JSON，带超时与状态码信息 */
async function json(url, { timeoutMs = 15000, headers = {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetchWith(url, {
      headers: { accept: 'application/json', 'user-agent': 'AutoED', ...headers },
      signal: controller.signal,
      redirect: 'follow'
    })
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim())
      err.status = res.status
      throw err
    }
    const data = await res.json()
    logger.info('http', `GET ${url} → ${res.status} (${Date.now() - started}ms)`)
    return data
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)
      e.code = 'TIMEOUT'
      logger.warn('http', `GET ${url} 超时`)
      throw e
    }
    logger.warn('http', `GET ${url} 失败：${err.message}`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { fetchWith, json, setProxy, getProxy }
