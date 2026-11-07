'use strict'
/**
 * 统一日志：内存环形缓冲 + 按天落盘。
 *
 * 目的不是"记录一切"，而是出问题时能拿出证据：
 * 用户点一下「导出日志」，就能把最近发生的事发给开发者。
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const MAX_ENTRIES = 3000
const buffer = []
let filePath = null

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 设定日志目录（通常是 <installRoot>/.autoed/logs） */
function init(dir) {
  try {
    filePath = path.join(dir, `autoed-${today()}.log`)
    fsp.mkdir(dir, { recursive: true }).catch(() => {})
  } catch {
    filePath = null
  }
}

function push(level, scope, message) {
  const entry = {
    t: new Date().toISOString(),
    level,
    scope,
    message: typeof message === 'string' ? message : safeString(message)
  }
  buffer.push(entry)
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)

  if (filePath) {
    const line = `[${entry.t}] [${level}] [${scope}] ${entry.message}\n`
    fs.appendFile(filePath, line, () => {})
  }
  return entry
}

function safeString(v) {
  try {
    if (v instanceof Error) return `${v.name}: ${v.message}`
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

module.exports = {
  init,
  info: (scope, message) => push('info', scope, message),
  warn: (scope, message) => push('warn', scope, message),
  error: (scope, message) => push('error', scope, message),
  tail: (n = 300) => buffer.slice(-n),
  all: () => buffer.slice(),
  text: () =>
    buffer.map((e) => `[${e.t}] [${e.level}] [${e.scope}] ${e.message}`).join('\n'),
  file: () => filePath
}
