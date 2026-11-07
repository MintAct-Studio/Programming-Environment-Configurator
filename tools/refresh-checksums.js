'use strict'
/**
 * 生成内置哈希基线 src/data/checksums.json。
 *
 * 作用：让「第一次安装」也能校验，而不是只能靠 TOFU（首次信任）。
 * TOFU 的弱点很明显——如果第一次下载时源就被投毒，恶意文件的哈希会成为"基准"。
 * 有了随程序分发的基线，就能和开发者验证过的哈希对上。
 *
 * 用法：
 *   node tools/refresh-checksums.js              # 全部组件（要下载完整文件）
 *   node tools/refresh-checksums.js --only=uv    # 只更新指定组件
 *   node tools/refresh-checksums.js --only=uv,ninja
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const SOURCES = require('../src/core/sources.json')
const http = require('../src/core/http')
const { download } = require('../src/core/net')

const OUT = path.join(__dirname, '..', 'src', 'data', 'checksums.json')

const args = process.argv.slice(2)
const onlyArg = args.find((a) => a.startsWith('--only='))
const ONLY = onlyArg ? onlyArg.split('=')[1].split(',').map((s) => s.trim()) : null

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

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

;(async () => {
  let doc = { entries: {} }
  try {
    doc = JSON.parse(await fsp.readFile(OUT, 'utf8'))
    if (!doc.entries) doc.entries = {}
  } catch {
    /* 首次生成 */
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'autoed-sum-'))
  const ids = Object.keys(SOURCES).filter(
    (id) => id !== '_comment' && SOURCES[id].provider === 'github' && (!ONLY || ONLY.includes(id))
  )

  let ok = 0
  let fail = 0

  for (const id of ids) {
    const spec = SOURCES[id]
    try {
      const asset = await ghLatestAsset(spec)
      process.stdout.write(`${id.padEnd(12)} ${asset.version.padEnd(24)} ${(asset.size / 1048576).toFixed(1)} MB … `)

      const file = path.join(tmp, asset.name)
      await download(asset.url, file, {})
      const sum = await sha256File(file)
      await fsp.rm(file, { force: true })

      doc.entries[`${id}@${asset.name}`] = {
        sha256: sum,
        version: asset.version,
        size: asset.size,
        at: new Date().toISOString()
      }
      console.log(sum.slice(0, 16) + '… ✓')
      ok++
    } catch (err) {
      console.log(`失败：${err.message}`)
      fail++
    }
  }

  await fsp.rm(tmp, { recursive: true, force: true })
  doc.generatedAt = new Date().toISOString()

  await fsp.writeFile(OUT, JSON.stringify(doc, null, 2), 'utf8')
  console.log(`\n已写入 ${OUT}`)
  console.log(`成功 ${ok} 个，失败 ${fail} 个，共 ${Object.keys(doc.entries).length} 条基线`)
  process.exit(fail ? 1 : 0)
})().catch((err) => {
  console.error('生成失败：', err.message)
  process.exit(2)
})
