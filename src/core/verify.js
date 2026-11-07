'use strict'
/**
 * 供应链校验：下载来的东西到底是不是官方那份？
 *
 * 三层，从强到弱：
 *  1. Authenticode 数字签名 —— 最强。篡改者没有厂商的私钥，签不出来。
 *     对解压后的主程序校验，签名无效或发布者变了就中止。
 *  2. 官方哈希 / 内置基线 —— 次强。发布方给了 .sha256 就比，
 *     我们自己的 checksums.json 里有记录也比。
 *  3. 首次记录（TOFU）—— 最弱，但能防止"以后被换掉"。
 *     第一次装的哈希记在本机，以后每次都要对上；对不上就中止。
 *
 * 任何一层不通过都会中止安装并删掉可疑文件，绝不"装着试试"。
 */
const fsp = require('node:fs/promises')
const path = require('node:path')

const { sha256File } = require('./net')
const { runPowerShellJson } = require('./ps')

const BASELINE_PATH = path.join(__dirname, '..', 'data', 'checksums.json')

let baseline = null

/** 内置基线：{ "uv@uv-x86_64-...zip": { sha256, publisher } } */
function loadBaseline() {
  if (baseline) return baseline
  try {
    baseline = require(BASELINE_PATH)
  } catch {
    baseline = { entries: {} }
  }
  return baseline
}

function baselineKey(componentId, assetName) {
  return `${componentId}@${assetName}`
}

function getBaseline(componentId, assetName) {
  const b = loadBaseline()
  return b.entries?.[baselineKey(componentId, assetName)] || null
}

/* ---------- 本机哈希记录 ---------- */

function hashStoreFile(installRoot) {
  return path.join(installRoot, '.autoed', 'hashes.json')
}

async function readHashStore(installRoot) {
  try {
    return JSON.parse(await fsp.readFile(hashStoreFile(installRoot), 'utf8'))
  } catch {
    return {}
  }
}

async function writeHashStore(installRoot, store) {
  const file = hashStoreFile(installRoot)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(store, null, 2), 'utf8')
}

/* ---------- Authenticode ---------- */

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 读取一个可执行文件的数字签名。
 * @returns {{ok:boolean, status:string, subject:string|null, signed:boolean}}
 */
async function authenticode(file) {
  const script = [
    `$p = ${psQuote(file)}`,
    'if (-not (Test-Path -LiteralPath $p)) {',
    '  [pscustomobject]@{ status = "Missing"; subject = $null } | ConvertTo-Json -Compress',
    '} else {',
    '  $s = Get-AuthenticodeSignature -LiteralPath $p',
    '  $sub = $null',
    '  if ($s.SignerCertificate) { $sub = $s.SignerCertificate.Subject }',
    '  [pscustomobject]@{ status = $s.Status.ToString(); subject = $sub } | ConvertTo-Json -Compress',
    '}'
  ].join('\n')

  try {
    const out = await runPowerShellJson(script, { timeout: 30000 })
    const status = String(out?.status || 'Unknown')
    return {
      ok: status === 'Valid',
      signed: status === 'Valid' || status === 'UnknownError' || status === 'HashMismatch',
      status,
      subject: out?.subject || null
    }
  } catch (err) {
    return { ok: false, signed: false, status: `查询失败: ${err.message}`, subject: null }
  }
}

/* ---------- 归档哈希校验 ---------- */

/**
 * 校验下载文件的哈希。
 * @param {object} opts
 * @param {string} opts.file           待校验文件
 * @param {string} [opts.publishedSha] 发布方提供的哈希（.sha256）
 * @param {string} opts.componentId
 * @param {string} opts.assetName
 * @param {string} opts.installRoot
 * @returns {Promise<{ok:boolean, level:string, actual:string, expected?:string, reason?:string}>}
 */
async function checkArchiveHash({ file, publishedSha, componentId, assetName, installRoot }) {
  const actual = (await sha256File(file)).toLowerCase()

  // 1) 发布方给的哈希
  if (publishedSha) {
    const want = String(publishedSha).trim().split(/\s+/)[0].toLowerCase()
    if (want && actual !== want) {
      return { ok: false, level: 'published', actual, expected: want, reason: '与发布方提供的 SHA256 不一致' }
    }
    return { ok: true, level: 'published', actual, expected: want }
  }

  // 2) 内置基线
  const base = getBaseline(componentId, assetName)
  if (base?.sha256) {
    if (actual !== String(base.sha256).toLowerCase()) {
      return {
        ok: false,
        level: 'baseline',
        actual,
        expected: base.sha256,
        reason: '与内置基线哈希不一致（下载源可能被篡改）'
      }
    }
    return { ok: true, level: 'baseline', actual, expected: base.sha256 }
  }

  // 3) 首次记录
  const store = await readHashStore(installRoot)
  const key = baselineKey(componentId, assetName)
  const prev = store[key]
  if (prev?.sha256) {
    if (prev.sha256 !== actual) {
      return {
        ok: false,
        level: 'tofu',
        actual,
        expected: prev.sha256,
        reason: `同一个文件这次下载到的哈希与上次（${prev.at || '未知时间'}）不同`
      }
    }
    return { ok: true, level: 'tofu', actual, expected: prev.sha256 }
  }

  store[key] = { sha256: actual, at: new Date().toISOString(), assetName }
  await writeHashStore(installRoot, store)
  return { ok: true, level: 'tofu-new', actual }
}

module.exports = {
  getBaseline,
  loadBaseline,
  authenticode,
  checkArchiveHash,
  readHashStore,
  writeHashStore,
  hashStoreFile,
  baselineKey
}
