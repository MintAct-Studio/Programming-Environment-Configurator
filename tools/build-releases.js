/**
 * 生成内置版本清单 src/data/releases.json。
 *
 * 目的：GitHub API 挂了或被限流时，AutoED 仍然知道"上次已知可用的版本和下载地址"。
 * 下载地址是 github.com/.../releases/download/... 的固定形式，不需要 API 也能下。
 *
 * 用法：node tools/build-releases.js
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SOURCES = require(path.join(ROOT, 'src/core/sources.json'))
const { APPS } = require(path.join(ROOT, 'src/core/apps.js'))

const OUT = path.join(ROOT, 'src/data/releases.json')

async function gh(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'AutoED' }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

function pickAsset(spec, assets) {
  if (spec.asset) return assets.find((a) => a.name === spec.asset)
  if (spec.assetPattern) {
    const re = new RegExp(spec.assetPattern, 'i')
    return assets.find((a) => re.test(a.name))
  }
  return null
}

async function main() {
  const out = {
    generatedAt: new Date().toISOString(),
    note: '内置兜底清单，仅在 GitHub API 不可用时使用。重新生成：node tools/build-releases.js',
    components: {},
    apps: {}
  }

  for (const [id, spec] of Object.entries(SOURCES)) {
    if (spec.provider !== 'github' || !spec.repo) continue
    try {
      const rel = await gh(`https://api.github.com/repos/${spec.repo}/releases/latest`)
      const asset = pickAsset(spec, rel.assets || [])
      if (!asset) {
        console.log(`  ${id}: 没有匹配的资源，跳过`)
        continue
      }
      out.components[id] = {
        version: rel.tag_name,
        assetName: asset.name,
        url: asset.browser_download_url,
        size: asset.size
      }
      console.log(`  ${id}: ${rel.tag_name} / ${asset.name}`)
    } catch (e) {
      console.log(`  ${id}: 获取失败 ${e.message}`)
    }
  }

  for (const app of APPS) {
    try {
      const rels = await gh(`https://api.github.com/repos/${app.repo}/releases?per_page=20`)
      const re = new RegExp(app.asset, 'i')
      const versions = []
      const seen = new Set()
      for (const rel of rels) {
        if (rel.draft || rel.prerelease) continue
        const asset = (rel.assets || []).find((a) => re.test(a.name))
        if (!asset) continue
        const m = re.exec(asset.name)
        const version = ((m && m[1]) || String(rel.tag_name || '')).replace(/^v/i, '')
        if (!/^\d/.test(version) || seen.has(version)) continue
        seen.add(version)
        versions.push({
          version,
          tag: rel.tag_name,
          assetName: asset.name,
          url: asset.browser_download_url,
          size: asset.size
        })
        if (versions.length >= 6) break
      }
      out.apps[app.id] = { versions }
      console.log(`  ${app.id}: ${versions.map((v) => v.version).join(', ')}`)
    } catch (e) {
      console.log(`  ${app.id}: 获取失败 ${e.message}`)
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8')
  console.log(`\n已写入 ${OUT}`)
}

main()
