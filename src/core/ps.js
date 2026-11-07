'use strict'
/**
 * 调用系统自带 PowerShell 的统一入口。
 *
 * 设计要点（对应"零环境"约束）：
 *  - 不用 wmic：Win11 24H2 已移除 WMIC，只能用 CIM
 *  - 显式 -ExecutionPolicy Bypass：企业组策略常把脚本执行设为 Restricted，
 *    不加这个参数，程序在别人的机器上会静默失败
 *  - 强制 UTF-8 输出：否则中文会乱码
 *  - windowsHide：不闪黑框
 */
const { execFile } = require('node:child_process')

const BASE_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command'
]

const PRELUDE = [
  '$ProgressPreference = "SilentlyContinue"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$ErrorActionPreference = "SilentlyContinue"'
].join('\n')

/** 执行一段 PowerShell，返回 stdout 字符串 */
function runPowerShell(script, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [...BASE_ARGS, `${PRELUDE}\n${script}`],
      { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error((stderr || err.message || '').trim()))
          return
        }
        resolve(stdout)
      }
    )
  })
}

/** 执行 PowerShell 并把最后输出的 JSON 解析成对象 */
async function runPowerShellJson(script, opts) {
  const out = await runPowerShell(script, opts)
  const text = String(out).trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    // 某些系统会在 JSON 前打印警告，取最后一行再试一次
    const lastLine = text.split(/\r?\n/).filter(Boolean).pop()
    return JSON.parse(lastLine)
  }
}

module.exports = { runPowerShell, runPowerShellJson }
