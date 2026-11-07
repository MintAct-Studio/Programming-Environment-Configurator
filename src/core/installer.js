'use strict'
/**
 * 安装编排器。
 *
 * 支持四类安装通道，其余流程完全一致：
 *   zip / 7zsfx  —— 下载归档再解压（Git、uv、CMake、Ninja、w64devkit、VS Code）
 *   uv-python    —— 调用 uv 下载并注册 Python 解释器
 *   fnm-node     —— 调用 fnm 安装 Node 运行时
 *
 * 每个组件的五步：解析 → 下载 → 校验 → 解压/执行 → 登记 PATH → 验证。
 * 任一步失败即中断并回滚本轮已做的改动。
 */
const fsp = require('node:fs/promises')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')

const { download, verifyFile } = require('./net')
const { extract } = require('./archive')
const { addToUserPath, restoreUserPath, prioritizeUserPath, ensureCommandFirst } = require('./paths')
const { loadState, markInstalled } = require('./state')
const http = require('./http')
const logger = require('./logger')
const { ensureSpace, isRiskyPath } = require('./fsutil')
const { checkArchiveHash, authenticode, readHashStore, writeHashStore } = require('./verify')
const SOURCES = require('./sources.json')

const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** 解析阶段的日志：没有 ctx 时也能记 */
function ctxLog(level, message) {
  if (level === 'warn') logger.warn('installer', message)
  else logger.info('installer', message)
}

/* ---------- 工具函数 ---------- */

async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

function run(exe, args, { cwd, env, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { cwd, env, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${path.basename(exe)} 执行失败：${(stderr || err.message || '').trim()}`))
        return
      }
      resolve({ stdout: String(stdout).trim(), stderr: String(stderr).trim() })
    })
  })
}

/**
 * 流式执行：把子进程输出逐行回调出去（用于 pip 这类会长时间打印进度的命令）。
 * uv/pip 用 \r 刷进度条，所以要按 \r\n 一起切，避免堆积出超长单行。
 */
function runStreaming(exe, args, { env, cwd, onLine, timeout = 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true })
    let output = ''
    let stderrText = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('安装超时（超过 60 分钟）'))
    }, timeout)

    const handle = (chunk) => {
      const text = chunk.toString('utf8')
      output += text
      for (const raw of text.split(/[\r\n]+/)) {
        const line = raw.trim()
        if (line) onLine?.(line)
      }
    }

    child.stdout.on('data', handle)
    child.stderr.on('data', (chunk) => {
      stderrText += chunk.toString('utf8')
      handle(chunk)
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ output })
      else reject(new Error(`命令退出码 ${code}：${stderrText.split(/[\r\n]+/).filter(Boolean).slice(-3).join(' ').slice(0, 400)}`))
    })
  })
}

/* ---------- 下载源解析 ---------- */

// 内置兜底清单：API 挂了也能装（地址是 releases/download 的固定形式，不需要 API）
const BUNDLED = require('../data/releases.json')

async function ghRequest(url) {
  return http.json(url, { timeoutMs: 15000 })
}

function bundledSource(id) {
  const hit = BUNDLED.components?.[id]
  if (!hit) return null
  return {
    id,
    version: hit.version,
    assetName: hit.assetName,
    url: hit.url,
    size: hit.size || 0,
    sha256Url: null,
    fromBundle: true,
    at: 0
  }
}

async function resolveSource(id, { cacheDir }) {
  const spec = SOURCES[id]
  if (!spec) throw Object.assign(new Error('该组件尚未接入安装通道'), { code: 'NOT_IMPLEMENTED' })

  if (spec.provider === 'command') {
    return { id, provider: 'command', kind: spec.kind, size: 0 }
  }

  if (spec.provider === 'http') {
    // 这类地址会给 302 跳到 CDN，先 HEAD 一次拿真实大小
    let size = 0
    try {
      const head = await fetch(spec.url, { method: 'HEAD', redirect: 'follow' })
      size = Number(head.headers.get('content-length') || 0)
    } catch {
      size = 0
    }
    return { id, url: spec.url, assetName: spec.assetName, size, provider: 'http' }
  }

  const cacheFile = path.join(cacheDir, 'sources-cache.json')
  let cache = {}
  try {
    cache = JSON.parse(await fsp.readFile(cacheFile, 'utf8'))
  } catch {
    cache = {}
  }
  const hit = cache[id]
  if (hit && Date.now() - hit.at < CACHE_TTL_MS && (hit.url || hit.provider === 'command')) return hit

  // API 优先；失败则退回磁盘缓存（哪怕过期）→ 内置清单。任何一步能拿到就继续。
  let release = null
  try {
    release = await ghRequest(`https://api.github.com/repos/${spec.repo}/releases/latest`)
  } catch (err) {
    if (hit && hit.url) {
      ctxLog('warn', `GitHub API 不可用（${err.message}），使用磁盘缓存的 ${id}`)
      return hit
    }
    const fallback = bundledSource(id)
    if (fallback) {
      ctxLog('warn', `GitHub API 不可用（${err.message}），使用内置清单的 ${id} ${fallback.version}`)
      return fallback
    }
    throw err
  }

  const assets = release.assets || []

  let asset = null
  if (spec.asset) asset = assets.find((a) => a.name === spec.asset)
  else if (spec.assetPattern) {
    const re = new RegExp(spec.assetPattern, 'i')
    asset = assets.find((a) => re.test(a.name))
  }
  if (!asset) throw new Error(`${spec.repo} 的最新发布中找不到匹配的资产`)

  const shaAsset = assets.find((a) => a.name === `${asset.name}.sha256`)
  const record = {
    id,
    version: release.tag_name,
    assetName: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    sha256Url: shaAsset ? shaAsset.browser_download_url : null,
    at: Date.now()
  }

  cache[id] = record
  await fsp.mkdir(cacheDir, { recursive: true }).catch(() => {})
  await fsp.writeFile(cacheFile, JSON.stringify(cache, null, 2), 'utf8').catch(() => {})
  return record
}

/* ---------- 通道：归档 ---------- */

async function installArchive(component, spec, ctx, targetPath) {
  const changes = []
  ctx.emit({ phase: 'resolve', message: `解析 ${component.name} 的下载地址` })
  const source = await resolveSource(component.id, { cacheDir: ctx.cacheDir })

  // 路径过长会解压失败，提前提醒（无法自动修复，只能告知）
  if (isRiskyPath(targetPath)) {
    const msg = `${component.name} 的安装路径已有 ${targetPath.length} 字符，接近 Windows 260 上限；解压深层目录时可能失败。建议换一个更短的路径。`
    logger.warn('path', msg)
    ctx.emit({ type: 'warning', message: msg })
  }

  const archive = path.join(ctx.cacheDir, source.assetName)
  const cached = await fsp.stat(archive).then((s) => s.size > 0).catch(() => false)

  if (!cached) {
    // 下载前先看缓存盘够不够
    await ensureSpace(ctx.cacheDir, (source.size || 0) * 1.15, `下载 ${component.name}`)
    ctx.emit({ phase: 'download', percent: 0, message: `下载 ${source.assetName}${source.size ? `（${(source.size / 1024 / 1024).toFixed(1)} MB）` : ''}` })
    const dl = await download(source.url, archive, {
      onProgress: (p) => ctx.emit({
        phase: 'download',
        percent: p.percent,
        message: `下载 ${source.assetName}`,
        received: p.received,
        total: p.total
      }),
      onRetry: (r) => ctx.emit({ phase: 'mirror', message: r.attempt === 0 ? '测试各下载源速度…' : `${r.source} 失败，切换下一个源（${r.attempt}/${r.total}）` })
    })
    ctx.emit({ phase: 'mirror', message: `下载完成（来源 ${dl.source}，${(dl.speed / 1024 / 1024).toFixed(1)} MB/s）` })
  }

  // ---- 完整性校验：发布方哈希 → 内置基线 → 本机首次记录 ----
  ctx.emit({ phase: 'verify-sum', message: '校验下载文件完整性' })

  let publishedSha = null
  if (source.sha256Url) {
    try {
      const shaFile = `${archive}.sha256`
      await download(source.sha256Url, shaFile, {})
      publishedSha = await fsp.readFile(shaFile, 'utf8')
    } catch (err) {
      logger.warn('verify', `获取发布方哈希失败：${err.message}`)
    }
  }

  const hashCheck = await checkArchiveHash({
    file: archive,
    publishedSha,
    componentId: component.id,
    assetName: source.assetName,
    installRoot: ctx.installRoot
  }).catch((err) => ({ ok: false, level: 'error', reason: err.message, actual: '', expected: '' }))

  if (!hashCheck.ok) {
    await fsp.rm(archive, { force: true }).catch(() => {})
    logger.error('verify', `${component.id} 哈希校验失败：${hashCheck.reason}（期望 ${hashCheck.expected}，实际 ${hashCheck.actual}）`)
    throw new Error(
      `安全检查未通过，已中止安装并删除下载文件。\n\n` +
        `${component.name}：${hashCheck.reason}\n` +
        `期望：${hashCheck.expected || '未知'}\n实际：${hashCheck.actual || '未知'}\n\n` +
        '这通常意味着下载源被篡改。请换一个网络或稍后重试；如果持续出现，请把日志发给开发者。'
    )
  }

  if (hashCheck.level === 'tofu-new') {
    const msg = `${component.name}：该版本首次安装，已记录文件哈希（${hashCheck.actual.slice(0, 16)}…）。以后同一个文件必须完全一致，否则会中止安装。`
    logger.info('verify', msg)
    ctx.emit({ type: 'info', message: msg })
  } else {
    logger.info('verify', `${component.id} 哈希校验通过（${hashCheck.level}）`)
  }

  // 解压前检查目标盘：压缩包解开通常要 1.5–3 倍空间
  await ensureSpace(targetPath, (source.size || 0) * 2, `解压 ${component.name}`)

  ctx.emit({ phase: 'extract', message: `解压到 ${targetPath}` })
  const existedBefore = await exists(targetPath)
  await fsp.mkdir(targetPath, { recursive: true })
  if (!existedBefore) changes.push({ type: 'dir', path: targetPath })
  await extract(spec.kind, archive, targetPath, { stripTop: Boolean(spec.stripTop) })

  // ---- 数字签名校验：篡改者拿不到厂商私钥，这一层最难伪造 ----
  await verifyBinarySignature(component, spec, targetPath, ctx)

  const binDir = spec.bin ? path.join(targetPath, spec.bin) : targetPath

  // 有些组件需要额外的空目录才会进入"便携模式"（VS Code 靠 data 目录实现）
  for (const dir of spec.createDirs || []) {
    await fsp.mkdir(path.join(targetPath, dir), { recursive: true })
  }

  ctx.emit({ phase: 'path', message: '登记到用户 PATH' })
  const pathResult = await addToUserPath(binDir)
  if (pathResult.added) changes.push({ type: 'path', previous: pathResult.previous })
  if (pathResult.warning) {
    logger.warn('path', pathResult.warning)
    ctx.emit({ type: 'warning', message: pathResult.warning })
  }

  const version = await verifyComponent(spec, binDir, ctx, targetPath)
  return { version, binDir, changes }
}

/* ---------- 通道：uv 管理的 Python ---------- */

async function installUvPython(component, spec, ctx, targetPath) {
  const changes = []
  const uvPath = await toolBinary(ctx, 'uv', 'uv.exe')

  // ---- Python 版本：用户在界面上选的就用它，否则用源里的默认值 ----
  const pyVersion = component.versionId || spec.pythonVersion
  ctx.emit({ phase: 'resolve', message: `准备 Python ${pyVersion}` })
  const existedBefore = await exists(targetPath)
  await fsp.mkdir(targetPath, { recursive: true })
  if (!existedBefore) changes.push({ type: 'dir', path: targetPath })

  const binDir = path.join(targetPath, spec.bin || 'bin')
  ctx.emit({ phase: 'extract', message: `下载 Python ${pyVersion}（约 ${spec.sizeMB || 21} MB）` })

  await run(uvPath, ['python', 'install', pyVersion, '--default'], {
    env: {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: targetPath,
      UV_PYTHON_BIN_DIR: binDir
    }
  })

  // 每个版本一个独立目录，所以这里要把它提到 PATH 最前面：
  // 谁在最前，python 命令就指向谁——这就是"默认版本"。
  ctx.emit({ phase: 'path', message: '登记到用户 PATH 并设为默认版本' })
  const pathResult = await prioritizeUserPath(binDir)
  if (pathResult.changed) changes.push({ type: 'path', previous: pathResult.previous })
  if (pathResult.warning) {
    logger.warn('path', pathResult.warning)
    ctx.emit({ type: 'warning', message: pathResult.warning })
  }

  const version = await verifyComponent({ ...spec, verify: { file: 'python.exe', args: ['--version'] } }, binDir, ctx)

  // 版本隔离：目录各自独立，这里只提示"当前默认是哪个"
  const siblings = await listPythonVersions(path.dirname(targetPath))
  const msg =
    siblings.length > 1
      ? `Python ${pyVersion} 已就绪，并设为默认（python → ${version}）。其它版本：${siblings.filter((v) => v !== pyVersion).join('、') || '无'}，用 python<版本号> 调用或到诊断里切换默认。`
      : `Python ${pyVersion} 已就绪（python → ${version}）。`
  logger.info('python', msg)
  ctx.emit({ type: 'info', message: msg })

  return { version, binDir, changes, extra: { versions: siblings.length ? siblings : [pyVersion] } }
}

/** 扫描安装目录里已有的 Python 版本（uv 的 cpython-x.y.z-... 目录） */
async function listPythonVersions(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  const found = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const m = /^cpython-(\d+\.\d+\.\d+)/.exec(e.name)
    if (m) found.push(m[1])
  }
  return [...new Set(found)].sort((a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
    return 0
  })
}

/* ---------- 通道：fnm 管理的 Node ---------- */

async function installFnmNode(component, spec, ctx, targetPath) {
  const changes = []
  const fnmPath = await toolBinary(ctx, 'fnm', 'fnm.exe')

  // ---- Node 版本：'lts' 或具体大版本号 ----
  const wantNode = component.versionId && component.versionId !== 'lts' ? String(component.versionId) : null
  const nodeLabel = wantNode ? `Node ${wantNode}` : 'Node.js LTS'

  ctx.emit({ phase: 'resolve', message: `准备 ${nodeLabel}` })
  const existedBefore = await exists(targetPath)
  await fsp.mkdir(targetPath, { recursive: true })
  if (!existedBefore) changes.push({ type: 'dir', path: targetPath })

  ctx.emit({ phase: 'extract', message: `下载 ${nodeLabel}（约 30 MB）` })
  await run(fnmPath, wantNode ? ['install', wantNode] : ['install', '--lts'], {
    env: { ...process.env, FNM_DIR: targetPath }
  })

  // fnm 不接管 PATH，找它装好的那个版本目录自己登记
  const versionsDir = path.join(targetPath, 'node-versions')
  const versions = (await fsp.readdir(versionsDir, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && /^v\d/.test(d.name))
    .filter((d) => (wantNode ? d.name.startsWith(`v${wantNode}.`) : true))
    .map((d) => d.name)
    .sort((a, b) => {
      const pa = a.slice(1).split('.').map(Number)
      const pb = b.slice(1).split('.').map(Number)
      for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
      return 0
    })

  if (!versions.length) throw new Error('fnm 安装完成但没有找到 node 版本目录')
  const binDir = path.join(versionsDir, versions[versions.length - 1], 'installation')

  ctx.emit({ phase: 'path', message: '登记到用户 PATH' })
  const pathResult = await addToUserPath(binDir)
  if (pathResult.added) changes.push({ type: 'path', previous: pathResult.previous })
  if (pathResult.warning) {
    logger.warn('path', pathResult.warning)
    ctx.emit({ type: 'warning', message: pathResult.warning })
  }

  const version = await verifyComponent({ ...spec, verify: { file: 'node.exe', args: ['--version'] } }, binDir, ctx)
  return { version, binDir, changes }
}

/* ---------- 通道：Python 虚拟环境（PyTorch） ---------- */

/** 找一个已安装的 Python 解释器（优先 3.11，其次 3.12） */
async function findBasePython(ctx) {
  const candidates = [
    { id: 'python-3.11', tag: 'cp311', dir: 'python311' },
    { id: 'python-3.12', tag: 'cp312', dir: 'python' }
  ]
  for (const candidate of candidates) {
    const info = ctx.state?.[candidate.id]
    if (info?.binDir) {
      const exe = path.join(info.binDir, 'python.exe')
      if (await exists(exe)) return { exe, tag: candidate.tag, id: candidate.id }
    }
    const fallback = path.join(ctx.installRoot, candidate.dir, 'bin', 'python.exe')
    if (await exists(fallback)) return { exe: fallback, tag: candidate.tag, id: candidate.id }
  }
  return null
}

/**
 * 从 PyTorch 的 PEP 503 索引里找出最新的 CUDA 轮子版本。
 * 注意：索引根目录只列包名，轮子清单在 <索引>/torch/ 子路径下。
 */
async function latestCudaVersion(indexUrl, cudaTag, pyTag) {
  const pageUrl = `${indexUrl.replace(/\/+$/, '')}/torch/`
  const res = await fetch(pageUrl, { headers: { 'User-Agent': 'AutoED/0.1' } })
  if (!res.ok) return null

  const html = await res.text()
  const re = new RegExp(`torch-(\\d+\\.\\d+\\.\\d+)\\+${cudaTag}-${pyTag}-${pyTag}-win_amd64\\.whl`, 'g')
  const versions = [...html.matchAll(re)].map((m) => m[1])
  if (!versions.length) return null

  const cmp = (a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
    return 0
  }
  return versions.sort(cmp).pop()
}

async function installPipVenv(component, spec, ctx, targetPath) {
  const changes = []
  const uv = await toolBinary(ctx, 'uv', 'uv.exe')
  const base = await findBasePython(ctx)
  if (!base) throw new Error('需要先安装 Python 才能创建 AI 环境')

  const existedBefore = await exists(targetPath)
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
  if (!existedBefore) changes.push({ type: 'dir', path: targetPath })

  const pyVersion = base.tag.replace('cp', '').replace(/(\d)(\d+)/, '$1.$2')
  ctx.emit({ phase: 'extract', message: `用 Python ${pyVersion} 创建虚拟环境` })
  await run(uv, ['venv', '--python', base.exe, targetPath], { env: process.env })

  const venvPython = path.join(targetPath, 'Scripts', 'python.exe')
  if (!(await exists(venvPython))) throw new Error('虚拟环境创建失败：没有生成 python.exe')

  // uv 建的 venv 默认不含 pip，但新手习惯 `pip install`，所以补一个进去
  if (spec.bootstrap?.length) {
    ctx.emit({ phase: 'install', message: `安装基础工具：${spec.bootstrap.join(', ')}` })
    await run(uv, ['pip', 'install', '--python', venvPython, ...spec.bootstrap, '--index-url', spec.extraIndexUrl || spec.indexUrls?.[0]].filter(Boolean), {
      env: process.env
    })
  }

  // 解析要装的版本。CUDA 版必须带 +cuXXX 后缀，否则 pip 会从 PyPI 装成 CPU 版。
  let packages = [...(spec.packages || ['torch'])]
  let chosen = null

  if (spec.cudaVariants?.length) {
    // 用户指定了具体 CUDA 版本就只试那一个；选「自动」则按列表顺序探测
    const only = component.versionId && component.versionId !== 'auto' ? String(component.versionId) : null
    const variants = only ? spec.cudaVariants.filter((v) => v.tag === only) : spec.cudaVariants
    if (only && !variants.length) {
      throw new Error(`不支持的 CUDA 版本：${only}`)
    }
    ctx.emit({ phase: 'resolve', message: only ? `查询 ${only} 的轮子版本` : '查询可用的 CUDA 轮子版本' })
    search: for (const variant of variants) {
      for (const indexUrl of variant.indexUrls) {
        const version = await latestCudaVersion(indexUrl, variant.tag, base.tag).catch(() => null)
        if (version) {
          chosen = {
            tag: variant.tag,
            version,
            indexUrl,
            others: variant.indexUrls.filter((u) => u !== indexUrl)
          }
          break search
        }
      }
    }
    // 关键：找不到就报错。绝不能"安静地"退回 CPU 版——用户要的是 GPU 加速
    if (!chosen) {
      throw new Error(`找不到与本机 Python（${base.tag}）匹配的 CUDA 版 torch。已中止，避免误装成 CPU 版`)
    }
    packages = packages.map((p) => (p === 'torch' ? `torch==${chosen.version}+${chosen.tag}` : p))
    ctx.emit({ phase: 'install', message: `将安装 torch ${chosen.version}+${chosen.tag}（约 2.5 GB，请留出时间）` })
  } else {
    const list = [...(spec.indexUrls || [])]
    chosen = { tag: '', version: '', indexUrl: list[0], others: list.slice(1) }
  }

  const candidates = [chosen.indexUrl, ...(chosen.others || [])].filter(Boolean)
  let lastError = null

  for (let i = 0; i < candidates.length; i++) {
    const host = (() => {
      try {
        return new URL(candidates[i]).host
      } catch {
        return candidates[i]
      }
    })()
    const args = ['pip', 'install', '--python', venvPython, ...packages, '--index-url', candidates[i]]
    if (spec.extraIndexUrl) {
      args.push('--extra-index-url', spec.extraIndexUrl)
      // uv 默认 first-index 策略：只要第一个索引里有 torch 就只用它，
      // 会导致带 +cuXXX 的轮子被忽略、退化成 CPU 版。这里必须放开，
      // 让 PyTorch 索引和 PyPI 镜像一起参与解析（两个源都是可信镜像）。
      args.push('--index-strategy', 'unsafe-best-match')
    }

    try {
      ctx.emit({ phase: 'install', message: `从 ${host} 下载…` })
      await runStreaming(uv, args, {
        env: process.env,
        onLine: (line) => {
          if (/Downloading|Preparing|Installing|Resolved|error|ERROR/i.test(line)) {
            ctx.emit({ phase: 'install', message: line.slice(0, 150) })
          }
        }
      })
      lastError = null
      break
    } catch (err) {
      lastError = err
      if (i < candidates.length - 1) ctx.emit({ phase: 'install', message: `${host} 下载失败，自动换下一个源` })
    }
  }
  if (lastError) throw lastError

  // 验证：能 import，且 CUDA 版必须真的报告 cuda=True
  ctx.emit({ phase: 'verify', message: '验证 torch 可用性' })
  const code = spec.verify?.code || 'import torch; print(torch.__version__)'
  const { stdout } = await run(venvPython, ['-c', code], { env: process.env, timeout: 180000 })
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const version = lines[0] || 'torch'
  const cudaLine = lines[1] || ''

  if (spec.cudaVariants?.length && !/cuda=True/i.test(cudaLine)) {
    throw new Error(`torch 已安装但 CUDA 不可用（${cudaLine || '未返回状态'}），可能是驱动版本过低`)
  }

  // 独立的命令入口：不把 venv 的 Scripts 直接挂到 PATH，避免 python 被顶掉
  ctx.emit({ phase: 'path', message: '创建 ai-python / ai-pip 命令' })
  const shimDir = path.join(targetPath, 'bin')
  await fsp.mkdir(shimDir, { recursive: true })
  await fsp.writeFile(path.join(shimDir, 'ai-python.cmd'), '@echo off\r\n"%~dp0..\\Scripts\\python.exe" %*\r\n', 'utf8')
  await fsp.writeFile(path.join(shimDir, 'ai-pip.cmd'), '@echo off\r\n"%~dp0..\\Scripts\\python.exe" -m pip %*\r\n', 'utf8')

  const pathResult = await addToUserPath(shimDir)
  if (pathResult.added) changes.push({ type: 'path', previous: pathResult.previous })

  return {
    version: `${version}${cudaLine ? ` (${cudaLine})` : ''}`,
    binDir: shimDir,
    changes
  }
}

/* ---------- 辅助 ---------- */

/** 找一个已安装工具的可执行文件（如 python 通道要找 uv） */
async function toolBinary(ctx, toolId, exeName) {
  const info = ctx.state?.[toolId]
  if (info?.binDir) {
    const candidate = path.join(info.binDir, exeName)
    if (await exists(candidate)) return candidate
  }
  // 状态记录缺失时（早期版本装的组件）退回安装根目录下的默认位置
  const fallback = path.join(ctx.installRoot, toolId, exeName)
  if (await exists(fallback)) return fallback

  return exeName // 最后退回 PATH
}

async function verifyComponent(spec, binDir, ctx, targetPath) {
  if (!spec.verify) return ''
  ctx.emit({ phase: 'verify', message: '验证可执行' })
  // 组件可执行未必在 PATH 目录里：VS Code 的 Code.exe 在根目录，命令在 bin 下
  const exeRoot = spec.verify.inRoot ? targetPath || binDir : binDir
  const exePath = path.join(exeRoot, spec.verify.file)

  if (spec.verify.args) {
    const env = { ...process.env, PATH: `${binDir};${process.env.PATH || ''}` }
    const { stdout } = await run(exePath, spec.verify.args, { env, timeout: 60000 })
    return stdout.split(/\r?\n/)[0].trim()
  }

  // 无参数版本（如 VS Code）：确认可执行在，版本从 app/package.json 读
  if (!(await exists(exePath))) throw new Error(`找不到 ${exePath}`)

  const pkgFile = await findAppPackageJson(targetPath || binDir)
  if (!pkgFile) return '已安装'
  try {
    const json = JSON.parse(await fsp.readFile(pkgFile, 'utf8'))
    return json.version ? `${json.name || ''} ${json.version}`.trim() : '已安装'
  } catch {
    return '已安装'
  }
}

/**
 * 找 VS Code 的 app/package.json。
 * 新版 VS Code 把资源放在 <安装目录>/<commit 短哈希>/resources/app/ 下，
 * 不是固定的 resources/app/，所以两种布局都要试。
 */
async function findAppPackageJson(root) {
  const direct = path.join(root, 'resources', 'app', 'package.json')
  if (await exists(direct)) return direct

  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(root, entry.name, 'resources', 'app', 'package.json')
    if (await exists(candidate)) return candidate
  }
  return null
}

/* ---------- 编排 ---------- */

async function appendJournal(installRoot, entry) {
  const dir = path.join(installRoot, '.autoed')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.appendFile(path.join(dir, 'journal.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
}

async function rollback(entries, installRoot) {
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.type === 'path') await restoreUserPath(entry.previous)
      else if (entry.type === 'dir') await fsp.rm(entry.path, { recursive: true, force: true })
    } catch {
      // 回滚尽力而为
    }
  }
  await appendJournal(installRoot, { at: new Date().toISOString(), event: 'rollback', entries: entries.length })
}

async function installComponent(component, ctx) {
  // 手动安装类组件（目前是 VS Code）：我们只给下载方式和导入流程，不代下
  if (component.manualInstall) {
    throw Object.assign(new Error(component.manual?.why || '该组件需要手动下载'), { code: 'MANUAL' })
  }

  const spec = SOURCES[component.id]
  if (!spec) throw Object.assign(new Error('该组件尚未接入安装通道'), { code: 'NOT_IMPLEMENTED' })

  const targetPath = component.targetPath
  if (!targetPath) throw new Error('缺少安装路径')

  let info
  if (spec.kind === 'zip' || spec.kind === '7zsfx') info = await installArchive(component, spec, ctx, targetPath)
  else if (spec.kind === 'uv-python') info = await installUvPython(component, spec, ctx, targetPath)
  else if (spec.kind === 'fnm-node') info = await installFnmNode(component, spec, ctx, targetPath)
  else if (spec.kind === 'pip-venv') info = await installPipVenv(component, spec, ctx, targetPath)
  else throw Object.assign(new Error(`暂不支持的安装通道：${spec.kind}`), { code: 'NOT_IMPLEMENTED' })

  // ---- 装完自检：这个命令真的会用到我们装的那份吗？----
  await verifyCommandResolution(component, spec, info, ctx)
  return info
}

/**
 * 解压后的数字签名校验。
 *
 * 哈希能证明"文件没变"，但证明不了"文件是好人做的"——如果第一次下载时
 * 源就已经被投毒，TOFU 会把恶意文件的哈希当成基准。
 * 数字签名不一样：篡改者没有厂商的私钥，签不出来。
 *
 * 策略：
 *  - 签名有效：记录发布者；以后再出现不同发布者 → 中止
 *  - 签名哈希不匹配：文件被改过 → 中止
 *  - 未签名：记录；若之前是签名的，说明被换成赝品 → 中止
 */
async function verifyBinarySignature(component, spec, targetPath, ctx) {
  const file = spec.verify?.file
  if (!file) return

  const exePath = spec.verify?.inRoot
    ? path.join(targetPath, file)
    : path.join(targetPath, spec.bin || '', file)

  const isFile = await fsp.stat(exePath).then((s) => s.isFile()).catch(() => false)
  if (!isFile) return // 后面的存在性校验会报错

  const sig = await authenticode(exePath)
  const store = await readHashStore(ctx.installRoot).catch(() => ({}))
  const key = `pub:${component.id}`
  const prev = store[key]
  const who = String(sig.subject || '').replace(/^[^,]*CN=/, '').split(',')[0] || '未知发布者'

  if (sig.ok) {
    if (prev?.subject && prev.subject !== sig.subject) {
      throw new Error(
        `安全检查未通过，已中止安装。\n\n${component.name} 的数字签名发布者变了：\n` +
          `之前：${prev.subject}\n现在：${sig.subject}\n\n` +
          '这可能是官方换了签名证书，也可能是下载源被投毒。请核对官方发布说明后再决定是否继续。'
      )
    }
    if (!prev) {
      store[key] = { subject: sig.subject, at: new Date().toISOString() }
      await writeHashStore(ctx.installRoot, store).catch(() => {})
    }
    logger.info('verify', `${component.id} 签名有效：${who}`)
    ctx.emit({ type: 'info', message: `${component.name}：数字签名有效（${who}）` })
    return
  }

  if (sig.status === 'HashMismatch') {
    throw new Error(
      `安全检查未通过，已中止安装。\n\n${component.name} 的文件与它的数字签名不一致——说明文件在签名之后被改动过。`
    )
  }

  if (prev?.subject) {
    throw new Error(
      `安全检查未通过，已中止安装。\n\n${component.name} 之前带有数字签名（${prev.subject}），这次却没有。\n` +
        '官方不会把签名版换回未签名版，这通常意味着下载源被替换过。'
    )
  }

  store[key] = { subject: null, unsigned: true, at: new Date().toISOString() }
  await writeHashStore(ctx.installRoot, store).catch(() => {})
  logger.warn('verify', `${component.id} 无数字签名（状态 ${sig.status}），仅靠哈希校验`)
  ctx.emit({
    type: 'warning',
    message: `${component.name} 上游未提供数字签名，只能靠哈希保证完整性；已记录该状态。`
  })
}

/**
 * 安装后的可用性自检。
 *
 * 光把目录写进 PATH 不算装好——PATH 里可能还有别的同名程序排在前面
 * （最典型的是微软商店的 python.exe 占位程序）。这里按真实顺序解析一次，
 * 不对就自动把我们的目录提到最前，再不行就明确告诉用户原因。
 */
async function verifyCommandResolution(component, spec, info, ctx) {
  const file = spec.verify?.file
  if (!file || !info?.binDir) return

  const command = String(file).replace(/\.exe$/i, '')
  try {
    const res = await ensureCommandFirst(command, info.binDir)
    if (res.ok && !res.fixed) return

    if (res.ok && res.fixed) {
      const msg = `${command} 命令原本解析到 ${res.before}，已把 AutoED 的目录提到 PATH 最前；新开的终端会用 ${res.after}。`
      logger.warn('path', msg)
      ctx.emit({ type: 'warning', message: msg })
      return
    }

    const reason = res.blockedByMachinePath
      ? `冲突来自系统级 PATH（${res.after}），修改它需要管理员权限，AutoED 不会动它。`
      : `当前仍解析到 ${res.after || '未知位置'}。`
    const msg = `${component.name} 已安装到 ${info.binDir}，但直接敲 ${command} 可能不会用到它：${reason}`
    logger.warn('path', msg)
    ctx.emit({ type: 'warning', message: msg })
  } catch (err) {
    logger.warn('path', `自检 ${command} 失败：${err.message}`)
  }
}

async function installPlan({ plan, installRoot, cacheDir, emit }) {
  const ctx = {
    installRoot,
    cacheDir: cacheDir || path.join(installRoot, '.autoed', 'cache'),
    emit,
    state: await loadState(installRoot)
  }

  const applied = []
  const results = []
  const installedThisRun = []

  await fsp.mkdir(ctx.cacheDir, { recursive: true })
  emit({ type: 'install-start', total: plan.components.length })

  for (let i = 0; i < plan.components.length; i++) {
    const component = plan.components[i]
    const base = { index: i, id: component.id, name: component.name, total: plan.components.length }

    emit({ type: 'component-start', ...base })

    try {
      const info = await installComponent(component, {
        ...ctx,
        emit: (payload) => emit({ type: 'component-progress', ...base, ...payload })
      })

      applied.push(...info.changes)
      installedThisRun.push(component.id)
      results.push({ id: component.id, status: 'ok', version: info.version, path: info.binDir })

      // 多版本组件（Python）：把每个版本连同它的目录记下来，
      // 以后切换默认版本、单独卸载某个版本都要用。
      const previous = ctx.state[component.id] || {}
      const variants = { ...(previous.variants || {}) }
      if (component.versionId) {
        variants[component.versionId] = {
          path: component.targetPath,
          binDir: info.binDir,
          version: info.version
        }
      }

      ctx.state = await markInstalled(installRoot, component.id, {
        path: component.targetPath,
        binDir: info.binDir,
        version: info.version,
        ...(Object.keys(variants).length ? { variants } : {}),
        ...(info.extra || {})
      })

      emit({ type: 'component-done', ...base, version: info.version, path: info.binDir })
      await appendJournal(installRoot, {
        at: new Date().toISOString(),
        event: 'installed',
        id: component.id,
        version: info.version,
        path: info.binDir
      })
    } catch (err) {
      if (err.code === 'NOT_IMPLEMENTED' || err.code === 'MANUAL') {
        const status = err.code === 'MANUAL' ? 'manual' : 'skipped'
        results.push({ id: component.id, status, reason: err.message })
        emit({ type: status === 'manual' ? 'component-manual' : 'component-skipped', ...base, reason: err.message })
        continue
      }

      results.push({ id: component.id, status: 'failed', reason: err.message })
      emit({ type: 'component-failed', ...base, reason: err.message })
      await appendJournal(installRoot, {
        at: new Date().toISOString(),
        event: 'failed',
        id: component.id,
        reason: err.message
      })

      emit({ type: 'rollback-start', count: applied.length })
      await rollback(applied, installRoot)
      emit({ type: 'rollback-done' })
      return { ok: false, results, rolledBack: applied.length }
    }
  }

  emit({ type: 'install-done', results })
  return { ok: true, results, rolledBack: 0 }
}

/**
 * 导入手动下载的组件（目前是 VS Code）。
 * 用户自己在浏览器里下好 zip、解压到某个目录后，这里负责：
 * 校验可执行存在 → 建便携模式数据目录 → 登记 PATH → 写入状态记录。
 */
async function importManualComponent({ component, installRoot, dir }) {
  const manual = component.manual || {}
  const exeFile = manual.verifyFile || 'Code.exe'
  const target = path.resolve(dir)

  if (!(await exists(path.join(target, exeFile)))) {
    throw new Error(`所选目录里没有 ${exeFile}，请选择解压后的程序根目录`)
  }

  // VS Code 见到 data 目录就会以便携模式运行，用户数据不写 C 盘
  await fsp.mkdir(path.join(target, 'data'), { recursive: true })

  const binDir = path.join(target, 'bin')
  await addToUserPath(binDir)

  let version = '已导入'
  const pkgFile = await findAppPackageJson(target)
  if (pkgFile) {
    try {
      const json = JSON.parse(await fsp.readFile(pkgFile, 'utf8'))
      version = `${json.name || ''} ${json.version || ''}`.trim() || version
    } catch {
      // 版本读不到不影响可用性
    }
  }

  await markInstalled(installRoot, component.id, { path: target, binDir, version })
  await appendJournal(installRoot, {
    at: new Date().toISOString(),
    event: 'imported',
    id: component.id,
    path: target,
    version
  })

  return { ok: true, version, binDir, path: target }
}

module.exports = { installPlan, installComponent, resolveSource, importManualComponent, SOURCES }
