'use strict'
/**
 * 下载源完整性巡检。
 *
 * 解决的问题：AutoED 会从「直连 GitHub + 若干国内镜像」里挑最快的下载。
 * 镜像都是第三方代理——如果其中某个被投毒，用户装进去的就是带毒的程序。
 *
 * 做法：同一个文件从每个源各取一段，比较内容哈希。
 *   - 各源一致 → 说明镜像没有篡改（至少前缀一致）
 *   - 某个源不一致 → 立刻标红，并在安装时跳过它
 *
 * 用法：
 *   node tools/verify-sources.js             # 只比对前 512 KB（快）
 *   node tools/verify-sources.js --full      # 完整下载并比对（慢但最严格）
 *   node tools/verify-sources.js --only=uv   # 只查某个组件
 */
const crypto = require('node:crypto')

const SOURCES = require('../src/core/sources.json')
const http = require('../src/core/http')
const { mirrorUrls, isGitHub } = require('../src/core/net')

const SAMPLE_BYTES = 512 * 1024
const args = process.argv.slice(2)
const FULL = args.includes('--full')
const onlyArg = args.find((a) => a.startsWith('--only='))
const ONLY = onlyArg ? onlyArg.split('=')[1] : null

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

async function ghLatestAsset(spec) {
  const rel = await http.json(`https://api.github.com/repos/${spec.repo}/releases/latest`, { timeoutMs: 20000 })
  const assets = rel.assets || []
  let asset = null
  if (spec.asset) asset = assets.find((a) => a.name === spec.asset)
  else if (spec.assetPattern) {
    const re = new RegExp(spec.assetPattern, 'i')
    asset = assets.find((a) => re.test(a.name))
  }
  if (!asset) throw new Error('找不到匹配的资产')
  return { name: asset.name, url: asset.browser_download_url, size: asset.size, version: rel.tag_name }
}

/** 从某个源取样本并算哈希 */
async function sample(url, bytes) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const headers = FULL ? {} : { Range: `bytes=0-${bytes - 1}` }
    headers['user-agent'] = 'AutoED-SourceCheck/1.0'
    const res = await http.fetchWith(url, { headers, redirect: 'follow', signal: controller.signal })
    if (!res.ok && res.status !== 206) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return {
      ok: true,
      status: res.status,
      bytes: buf.length,
      total: Number(res.headers.get('content-length') || 0),
      hash: sha256(buf)
    }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? '超时' : err.message }
  } finally {
    clearTimeout(timer)
  }
}

async function checkComponent(id, spec) {
  let asset
  try {
    asset = await ghLatestAsset(spec)
  } catch (err) {
    return { id, ok: false, error: `解析失败：${err.message}`, sources: [] }
  }

  const urls = mirrorUrls(asset.url)
  const labels = isGitHub(asset.url) ? ['直连', 'ghfast', 'geekertao', 'ghproxy'] : ['直连']
  const size = FULL ? asset.size : Math.min(SAMPLE_BYTES, asset.size || SAMPLE_BYTES)

  console.log(`\n${id}  ${asset.version}  ${asset.name}  ${(asset.size / 1048576).toFixed(1)} MB`)
  console.log(`  比对范围：${FULL ? '完整文件' : `前 ${(size / 1024).toFixed(0)} KB`}`)

  const results = []
  for (let i = 0; i < urls.length; i++) {
    const label = labels[i] || `源${i}`
    const r = await sample(urls[i], size)
    results.push({ label, ...r })
    const shown = r.ok ? `${r.hash.slice(0, 16)}…  ${r.bytes} 字节` : `失败：${r.error}`
    console.log(`  ${label.padEnd(10)} ${shown}`)
  }

  const good = results.filter((r) => r.ok)
  const reference = good.find((r) => r.label === '直连') || good[0]
  const tampered = []
  const broken = results.filter((r) => !r.ok).map((r) => r.label)

  if (reference) {
    for (const r of good) {
      if (r.label === reference.label) continue
      if (r.hash !== reference.hash) tampered.push(r.label)
    }
  }

  if (tampered.length) {
    console.log(`  ⚠ 与「${reference.label}」内容不一致：${tampered.join('、')}`)
  } else if (good.length > 1) {
    console.log(`  ✓ 所有可用源内容一致`)
  }
  if (broken.length) console.log(`  · 不可用：${broken.join('、')}`)

  return {
    id,
    ok: tampered.length === 0 && good.length > 0,
    tampered,
    broken,
    reference: reference ? reference.label : null,
    hash: reference ? reference.hash : null,
    sources: results
  }
}

;(async () => {
  console.log('='.repeat(60))
  console.log(' AutoED 下载源完整性巡检')
  console.log(` 模式：${FULL ? '完整比对' : '前缀抽样'}　时间：${new Date().toLocaleString()}`)
  console.log('='.repeat(60))

  const ids = Object.keys(SOURCES).filter(
    (id) => id !== '_comment' && SOURCES[id].provider === 'github' && (!ONLY || id === ONLY)
  )

  const report = []
  for (const id of ids) {
    report.push(await checkComponent(id, SOURCES[id]))
  }

  console.log('\n' + '='.repeat(60))
  const bad = report.filter((r) => !r.ok)
  const tampered = report.filter((r) => r.tampered?.length)
  if (!bad.length) {
    console.log(` 结论：${report.length} 个组件全部通过`)
  } else {
    console.log(` 结论：${report.length} 个组件中有 ${bad.length} 个存在问题`)
    for (const r of tampered) console.log(`   ⚠ ${r.id}：${r.tampered.join('、')} 与直连不一致`)
    for (const r of report.filter((x) => x.error)) console.log(`   ✗ ${r.id}：${r.error}`)
  }
  console.log('='.repeat(60))

  // 非零退出码，便于接进 CI
  process.exit(bad.length ? 1 : 0)
})().catch((err) => {
  console.error('巡检失败：', err.message)
  process.exit(2)
})
