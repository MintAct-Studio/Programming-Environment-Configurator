'use strict'
/**
 * 模型库：按 AI 模型类别管理本地模型文件。
 *
 * 目录约定：
 *   <installRoot>\models\<类别>\<模型 id>\<文件>
 *   <installRoot>\models\index.json     —— 登记表（哪些模型已就绪、在哪）
 *
 * 两种来源通道：
 *   github —— 走现有下载器（自动选镜像、断点续传、校验）
 *   page   —— 官方只提供网页下载（HuggingFace / ModelScope），给链接 + 允许登记本地目录
 */
const fsp = require('node:fs/promises')
const path = require('node:path')

const { download } = require('./net')
const logger = require('./logger')

const CATALOG = require('../data/models.json')
const BY_ID = new Map(CATALOG.models.map((m) => [m.id, m]))

/** 模型根目录 */
function modelsRoot(installRoot) {
  return path.join(installRoot, 'models')
}

function indexFile(installRoot) {
  return path.join(modelsRoot(installRoot), 'index.json')
}

async function readIndex(installRoot) {
  try {
    const raw = await fsp.readFile(indexFile(installRoot), 'utf8')
    const doc = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return doc && doc.installed ? doc : { installed: {} }
  } catch {
    return { installed: {} }
  }
}

async function writeIndex(installRoot, doc) {
  await fsp.mkdir(modelsRoot(installRoot), { recursive: true })
  await fsp.writeFile(indexFile(installRoot), JSON.stringify(doc, null, 2), 'utf8')
}

/** 目录大小（MB，保留一位） */
async function dirSizeMB(dir) {
  let total = 0
  async function walk(d) {
    let entries
    try {
      entries = await fsp.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) await walk(p)
      else {
        try {
          total += (await fsp.stat(p)).size
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  await walk(dir)
  return Math.round((total / 1048576) * 10) / 10
}

/** 清单 + 本机状态 */
async function catalog(installRoot) {
  const doc = installRoot ? await readIndex(installRoot) : { installed: {} }
  const installed = doc.installed || {}

  const models = []
  for (const m of CATALOG.models) {
    const rec = installed[m.id]
    let present = false
    if (rec && rec.path) {
      present = await fsp
        .stat(rec.path)
        .then(() => true)
        .catch(() => false)
    }
    models.push({
      ...m,
      installed: present,
      installedPath: present ? rec.path : null,
      installedAt: present ? rec.at || null : null
    })
  }

  return {
    categories: CATALOG.categories,
    models,
    modelsRoot: installRoot ? modelsRoot(installRoot) : null
  }
}

/**
 * 下载一个 github 通道的模型。
 * @returns 安装记录
 */
async function install({ id, installRoot, onProgress = () => {} }) {
  const model = BY_ID.get(id)
  if (!model) throw new Error(`未知的模型：${id}`)
  if (model.channel !== 'github' || !model.url) {
    throw new Error('这个模型需要从官方页面下载后再导入')
  }

  const dir = path.join(modelsRoot(installRoot), model.category, model.id)
  await fsp.mkdir(dir, { recursive: true })
  const target = path.join(dir, model.file || path.basename(model.url))

  onProgress({ phase: 'download', percent: 0, message: `下载 ${model.name}` })
  const res = await download(model.url, target, {
    onProgress: (p) => onProgress({ phase: 'download', percent: p.percent, message: `下载 ${model.name}` }),
    onRetry: (r) => onProgress({ phase: 'download', percent: 0, message: `${r.source} 失败，换下一个源` })
  })

  const size = await fsp.stat(target).then((s) => s.size).catch(() => 0)
  const doc = await readIndex(installRoot)
  doc.installed[model.id] = {
    path: target,
    size,
    at: new Date().toISOString(),
    source: model.vendor,
    via: res && res.source ? res.source : 'github'
  }
  await writeIndex(installRoot, doc)

  logger.info('models', `${model.id} 已下载到 ${target}（${Math.round(size / 1048576)} MB）`)
  onProgress({ phase: 'done', percent: 100, message: `${model.name} 就绪` })
  return doc.installed[model.id]
}

/** 登记一个已经下载好的本地目录/文件（HuggingFace、ModelScope 那种只能网页下的） */
async function importLocal({ id, installRoot, sourcePath }) {
  const model = BY_ID.get(id)
  if (!model) throw new Error(`未知的模型：${id}`)

  const stat = await fsp.stat(sourcePath).catch(() => null)
  if (!stat) throw new Error('路径不存在')

  const doc = await readIndex(installRoot)
  doc.installed[model.id] = {
    path: sourcePath,
    size: stat.isDirectory() ? null : stat.size,
    at: new Date().toISOString(),
    source: model.vendor,
    via: 'manual'
  }
  await writeIndex(installRoot, doc)
  logger.info('models', `${model.id} 登记为本地路径 ${sourcePath}`)
  return doc.installed[model.id]
}

/**
 * 移除一个模型。
 * 只有装在本程序的 models 目录下的才删文件；登记的外部路径只取消登记。
 */
async function remove({ id, installRoot }) {
  const model = BY_ID.get(id)
  if (!model) throw new Error(`未知的模型：${id}`)

  const doc = await readIndex(installRoot)
  const rec = doc.installed[id]
  if (!rec) return { removed: false }

  const root = modelsRoot(installRoot)
  const inside = path.resolve(rec.path).toLowerCase().startsWith(path.resolve(root).toLowerCase())
  if (inside) {
    const dir = path.join(root, model.category, model.id)
    await fsp.rm(dir, { recursive: true, force: true })
    logger.info('models', `${id} 已从 ${dir} 删除`)
  } else {
    logger.info('models', `${id} 只取消登记，不动外部文件 ${rec.path}`)
  }

  delete doc.installed[id]
  await writeIndex(installRoot, doc)
  return { removed: true, deletedFiles: inside }
}

/** 打开模型所在目录用的路径 */
async function pathOf({ id, installRoot }) {
  const doc = await readIndex(installRoot)
  const rec = doc.installed[id]
  if (!rec) return null
  return rec.path
}

module.exports = { catalog, install, importLocal, remove, pathOf, modelsRoot, dirSizeMB }
