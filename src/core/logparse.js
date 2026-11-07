'use strict'
/**
 * 日志解析：把一大段天书翻译成「是什么问题、怎么办」。
 *
 * 规则按"最能解释问题"的顺序排列，命中即归类；同一条规则可能命中多行，
 * 只保留计数和前两条原文，避免刷屏。
 */

/** level: error 会让整体判定为失败；warn 只是提示 */
const RULES = [
  {
    id: 'proxy-refused',
    level: 'error',
    test: /ECONNREFUSED|ECONNRESET|socket hang up|connect ETIMEDOUT|ENETUNREACH|EAI_AGAIN/i,
    title: '网络连不上',
    meaning: '请求根本没发出去，或者连上就被断开。',
    fix: [
      '如果你在用代理（Clash / v2ray 等），确认端口填对了（常见 7890、7897、10808）',
      '关掉代理再试一次，排除代理本身的问题',
      '公司或校园网可能拦 GitHub，换手机热点验证'
    ]
  },
  {
    id: 'proxy-config',
    level: 'error',
    test: /Proxy|代理/i,
    title: '代理配置有问题',
    meaning: '系统或应用里的代理地址无法使用。',
    fix: ['在「高级 → 网络」里检查代理地址格式：http://127.0.0.1:7890', '留空表示不使用代理']
  },
  {
    id: 'tls',
    level: 'error',
    test: /UNABLE_TO_VERIFY|CERT_|self.signed|EPROTO|unable to verify the first certificate/i,
    title: 'HTTPS 证书校验失败',
    meaning: '有软件在中间解密流量（公司网关、杀毒软件、代理的 MITM），证书对不上。',
    fix: [
      '在「高级 → 网络」里填上正确的代理，让代理自己处理证书',
      '临时把杀毒软件的 HTTPS 扫描关掉试试',
      '如果是公司网络，需要导入公司的根证书'
    ]
  },
  {
    id: 'rate-limit',
    level: 'error',
    test: /rate limit|API rate limit exceeded|403 Forbidden.*api\.github/i,
    title: 'GitHub API 限流',
    meaning: '同一出口 IP 每小时只能查 60 次，学校或公司的共享网络很容易用光。',
    fix: [
      '等一小时会自动恢复',
      'AutoED 会回退到内置版本清单，功能不受影响',
      '如果频繁出现，说明这个出口 IP 被很多人共用'
    ]
  },
  {
    id: 'httperr',
    level: 'error',
    test: /HTTP (4\d\d|5\d\d)/i,
    title: '服务器返回错误',
    meaning: '地址存在但服务器拒绝或出错，多半是版本已下架或镜像挂了。',
    fix: ['点「刷新」重新获取版本列表', '换一个版本再试', '换镜像（高级 → 网络）']
  },
  {
    id: 'stall',
    level: 'error',
    // 注意用 \b：否则 "Installed" 里也含 "stalled"，正常日志会被误报
    test: /停滞|\bstalled\b|\baborted\b|ETIMEDOUT.*download/i,
    title: '下载卡住不动',
    meaning: '连接建立了但长时间没有数据，通常是线路被限速或镜像已经失效。',
    fix: ['AutoED 会自动换下一个镜像', '如果反复出现，改用代理或换个网络']
  },
  {
    id: 'sha',
    level: 'error',
    test: /校验失败|sha256|SHA256|checksum/i,
    title: '文件校验不过',
    meaning: '下载下来的文件不完整或被改写。',
    fix: ['再点一次安装会自动重新下载', '反复失败说明镜像在篡改内容，换镜像或走代理']
  },
  {
    id: 'disk',
    level: 'error',
    test: /ENOSPC|not enough space|空间不足|No space left/i,
    title: '磁盘空间不足',
    meaning: '目标盘装不下了。',
    fix: ['清理目标盘', '在首页把「安装到」换到别的盘']
  },
  {
    id: 'perm',
    level: 'error',
    test: /EACCES|EPERM|拒绝访问|Access is denied/i,
    title: '没有写入权限',
    meaning: '目标目录不可写，或被其他进程占用。',
    fix: [
      '换一个可写的目录（不要选 C:\\Program Files 或 C:\\Windows）',
      '确认该软件没有正在运行'
    ]
  },
  {
    id: 'notfound-cmd',
    level: 'error',
    test: /不是内部或外部命令|is not recognized as an internal|CommandNotFoundException/i,
    title: '命令找不到',
    meaning: 'PATH 里没有这个工具，或者装完没有重开终端。',
    fix: ['关掉终端重新打开', '到「诊断」里看 PATH 是否登记成功']
  },
  {
    id: 'py-module',
    level: 'error',
    test: /ModuleNotFoundError|ImportError: No module named/i,
    title: 'Python 库缺失',
    meaning: '当前解释器里没装这个包，或者装到了另一个环境。',
    fix: ['确认用的是 AutoED 装的那个 python', '用 uv pip install 安装依赖']
  },
  {
    id: 'node-modules',
    level: 'error',
    test: /ERESOLVE|peer dep|npm ERR!/i,
    title: 'npm 依赖冲突',
    meaning: '两个包的依赖要求互相打架。',
    fix: ['优先用 pnpm（AutoED 已提供）', '必要时加 --legacy-peer-deps']
  },
  {
    id: 'uv-missing',
    level: 'error',
    test: /uv: command not found|uv 不存在|找不到 uv/i,
    title: 'uv 未安装',
    meaning: 'Python 组件依赖 uv，但 uv 没装或不在 PATH。',
    fix: ['回到首页，把 uv 一起选上再装']
  }
]

/** 明显是正常的输出行，统计时忽略 */
const NOISE = /^(npm notice|npm warn deprecated|Downloading|Downloaded|progress|正在|已)/i

function parse(text) {
  const src = String(text || '')
  const lines = src.split(/\r?\n/).filter((l) => l.trim())

  const hits = new Map() // id -> { rule, count, samples: [] }
  let errorLines = 0
  let warnLines = 0

  for (const line of lines) {
    const isErr = /\b(error|failed|失败|异常)\b/i.test(line)
    const isWarn = /\b(warn|警告)\b/i.test(line)
    if (isErr) errorLines++
    else if (isWarn) warnLines++

    if (NOISE.test(line)) continue

    for (const rule of RULES) {
      if (!rule.test.test(line)) continue
      const rec = hits.get(rule.id) || { rule, count: 0, samples: [] }
      rec.count++
      if (rec.samples.length < 3) rec.samples.push(line.trim().slice(0, 240))
      hits.set(rule.id, rec)
      break
    }
  }

  const matches = [...hits.values()].sort((a, b) => {
    if (a.rule.level !== b.rule.level) return a.rule.level === 'error' ? -1 : 1
    return b.count - a.count
  })

  const fatal = matches.some((m) => m.rule.level === 'error')
  const verdict = matches.length
    ? fatal
      ? '发现问题，下面是对应的原因和处理办法'
      : '没有致命错误，只有提示'
    : lines.length
      ? '没认出已知的错误模式，可以把这份日志发给开发者'
      : '文件是空的'

  return {
    ok: true,
    stats: { lines: lines.length, errorLines, warnLines, bytes: Buffer.byteLength(src) },
    verdict,
    matches: matches.map((m) => ({
      id: m.rule.id,
      level: m.rule.level,
      title: m.rule.title,
      meaning: m.rule.meaning,
      fix: m.rule.fix,
      count: m.count,
      samples: m.samples
    }))
  }
}

module.exports = { parse, RULES }
