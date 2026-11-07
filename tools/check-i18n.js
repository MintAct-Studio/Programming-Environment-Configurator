const fs = require('node:fs')
const path = require('node:path')

const dir = path.join(__dirname, '..', 'src', 'i18n')
const langs = ['en', 'zh', 'ja', 'ko', 'ru', 'fr']
const base = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')))
console.log('基准条目:', base.length)

let bad = 0
for (const l of langs) {
  const p = path.join(dir, l + '.json')
  if (!fs.existsSync(p)) {
    console.log('  ' + l + ': 缺失')
    bad++
    continue
  }
  let d
  try {
    d = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    console.log('  ' + l + ': JSON 解析失败 ' + e.message)
    bad++
    continue
  }
  const keys = Object.keys(d)
  const missing = base.filter((k) => !(k in d))
  const extra = keys.filter((k) => !base.includes(k))
  const empty = keys.filter((k) => !String(d[k]).trim())
  const parts = [keys.length + ' 条']
  if (missing.length) parts.push('缺 ' + missing.length)
  if (extra.length) parts.push('多 ' + extra.length)
  if (empty.length) parts.push('空 ' + empty.length)
  console.log('  ' + l + ': ' + parts.join(' | '))
  if (missing.length) {
    bad++
    for (const m of missing.slice(0, 5)) console.log('      缺: ' + m)
  }
}
process.exit(bad ? 1 : 0)
