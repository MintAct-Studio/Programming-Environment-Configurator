'use strict'
/**
 * 下载器：断点续传 + 镜像回退 + SHA256 校验。
 *
 * 国内直连 GitHub 经常被重置（实测本项目首次下载就是卡在 60% 断流），
 * 所以每个 URL 都按「直连 → 国内镜像」的顺序逐个尝试，失败自动换。
 * 半成品写到 *.part，续传时带 Range 头接着传，避免每次都从 0 开始。
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const http = require('./http')
const logger = require('./logger')

/** URL → 镜像改写规则，按优先级排列 */
const MIRRORS = [
  { name: '直连', build: (url) => url },
  { name: 'ghfast', build: (url) => `https://ghfast.top/${url}` },
  { name: 'geekertao', build: (url) => `https://ghfile.geekertao.top/${url}` },
  { name: 'ghproxy', build: (url) => `https://ghproxy.net/${url}` }
]

function isGitHub(url) {
  return /^https?:\/\/(github\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com)\//.test(url)
}

function mirrorUrls(url) {
  if (!isGitHub(url)) return [url]
  return MIRRORS.map((m) => m.build(url))
}

/**
 * 单次下载（支持续传）。
 *
 * 带「停滞检测」：连接可能建立起后一个字节都不发（实测 GitHub 镜像会这样），
 * 所以只要 60 秒没有新数据就主动中断，让上层换下一个源——
 * 否则整个过程会无声地挂死。
 */
async function downloadOnce(url, dest, { onProgress, signal, idleTimeoutMs = 60000 } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const part = `${dest}.part`

  let start = 0
  try {
    start = (await fsp.stat(part)).size
  } catch {
    start = 0
  }

  const controller = new AbortController()
  let watchdog = setTimeout(() => controller.abort(), idleTimeoutMs)
  const touch = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => controller.abort(), idleTimeoutMs)
  }

  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })

  try {
    const headers = start > 0 ? { Range: `bytes=${start}-` } : {}
    // 走统一的 fetch 适配层，这样设置了代理时下载也能跟着走代理
    const res = await http.fetchWith(url, { headers, redirect: 'follow', signal: controller.signal })
    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    }

    // 服务器不支持 Range（返回 200）时，只能从头来
    const appending = res.status === 206 && start > 0
    if (!appending && start > 0) {
      await fsp.rm(part, { force: true })
      start = 0
    }

    const total = appending
      ? start + Number(res.headers.get('content-length') || 0)
      : Number(res.headers.get('content-length') || 0)

    let received = start
    const file = fs.createWriteStream(part, { flags: appending ? 'a' : 'w' })

    if (onProgress && total > 0) onProgress({ received, total, percent: Math.min(100, (received / total) * 100) })

    // Node 的 fetch 返回 Web ReadableStream，没有 .on()，必须先转成 Node 流
    const nodeStream = Readable.fromWeb(res.body)
    nodeStream.on('data', (chunk) => {
      touch()
      received += chunk.length
      if (onProgress) onProgress({ received, total, percent: total ? Math.min(100, (received / total) * 100) : 0 })
    })

    await pipeline(nodeStream, file)
    await fsp.rename(part, dest)
    return { bytes: received }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`下载停滞超过 ${Math.round(idleTimeoutMs / 1000)} 秒，已中断`)
    }
    throw err
  } finally {
    clearTimeout(watchdog)
  }
}

/** 探测单个 URL 的下载速度（拉一小段就断开） */
async function probeSpeed(url, { bytes = 262144, timeoutMs = 8000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()

  try {
    const res = await http.fetchWith(url, {
      headers: { Range: `bytes=0-${bytes - 1}` },
      redirect: 'follow',
      signal: controller.signal
    })
    if (!res.ok && res.status !== 206) return { url, speed: 0, error: `HTTP ${res.status}` }

    const reader = res.body.getReader()
    let got = 0
    while (got < bytes) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.length
    }
    reader.cancel().catch(() => {})

    const seconds = Math.max((Date.now() - started) / 1000, 0.05)
    return { url, speed: got / seconds, bytes: got }
  } catch (err) {
    return { url, speed: 0, error: err.name === 'AbortError' ? '超时' : err.message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 带镜像回退的下载。
 *
 * 关键：不能"第一个能通的就用"——实测直连 GitHub 能通但只有 10 KB/s，
 * 而镜像能到 4 MB/s。所以先并发测速，再按速度从快到慢依次尝试。
 */
async function download(url, dest, { onProgress, onRetry } = {}) {
  const candidates = mirrorUrls(url)
  const labels = candidates.map((_, i) => (isGitHub(url) ? MIRRORS[i].name : '直连'))

  if (onRetry) onRetry({ attempt: 0, total: candidates.length, source: '测速', error: '' })

  const probes = await Promise.all(candidates.map((c) => probeSpeed(c)))
  const ranked = probes
    .map((p, i) => ({ ...p, label: labels[i] }))
    .filter((p) => p.speed > 0)
    .sort((a, b) => b.speed - a.speed)

  const errors = []
  const order = ranked.length ? ranked : candidates.map((c, i) => ({ url: c, label: labels[i], speed: 0 }))

  for (const candidate of order) {
    try {
      const result = await downloadOnce(candidate.url, dest, { onProgress })
      return { ...result, source: candidate.label, speed: candidate.speed }
    } catch (err) {
      errors.push(`${candidate.label}: ${err.message}`)
      if (onRetry) onRetry({ attempt: errors.length, total: order.length, source: candidate.label, error: err.message })
    }
  }

  throw new Error(`所有下载源均失败\n${errors.join('\n')}`)
}

/** 计算文件 SHA256 */
async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

/** 校验下载文件（expected 为小写十六进制，可带 " *filename" 后缀） */
async function verifyFile(file, expected) {
  const want = String(expected).trim().split(/\s+/)[0].toLowerCase()
  const actual = (await sha256File(file)).toLowerCase()
  return { ok: actual === want, actual, expected: want }
}

module.exports = { download, downloadOnce, sha256File, verifyFile, mirrorUrls, isGitHub }
