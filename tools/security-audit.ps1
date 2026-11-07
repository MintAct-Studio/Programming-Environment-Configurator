<#
.SYNOPSIS
  安全审计：检查代码签名相关的风险项。

.DESCRIPTION
  逐项检查并给出结论：
    1. 私钥是否可导出（可导出 = 可以被复制走）
    2. 磁盘上是否存在 .pfx / .snk 等私钥文件
    3. 自签名证书是否被装进了信任库（影响范围有多大）
    4. dist 下的产物是否已签名
    5. 证书有效期

  退出码：0 = 未发现高风险项；1 = 发现高风险项。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\security-audit.ps1
#>
param(
  [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Continue'
$risk = 0
$warn = 0

function Section($title) {
  Write-Host ''
  Write-Host "── $title " -ForegroundColor Cyan -NoNewline
  Write-Host ('─' * [Math]::Max(0, 46 - $title.Length)) -ForegroundColor DarkGray
}

function OK($text) { Write-Host "  [安全] $text" -ForegroundColor Green }
function WARN($text) { Write-Host "  [注意] $text" -ForegroundColor Yellow; $script:warn++ }
function RISK($text) { Write-Host "  [风险] $text" -ForegroundColor Red; $script:risk++ }
function INFO($text) { Write-Host "         $text" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '  AutoED 代码签名安全审计' -ForegroundColor White
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray

# ---------- 1. 证书与私钥 ----------
Section '签名证书'

$certs = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -like '*CN=AutoED Development*' }

if (-not $certs) {
  INFO '证书库里没有 AutoED 开发证书（说明还没做过签名）'
} else {
  foreach ($c in $certs) {
    INFO "主题: $($c.Subject)"
    INFO "指纹: $($c.Thumbprint)"
    INFO "有效期至: $($c.NotAfter.ToString('yyyy-MM-dd'))"

    if ($c.NotAfter -lt (Get-Date)) {
      RISK '证书已过期'
    } elseif ($c.NotAfter -lt (Get-Date).AddDays(30)) {
      WARN "证书将在 $([int]($c.NotAfter - (Get-Date)).TotalDays) 天后过期"
    }

    if ($c.HasPrivateKey) {
      $exportable = $false
      try {
        $exportable = $c.PrivateKey.CspKeyContainerInfo.Exportable
      } catch {
        # CNG 密钥读不到 CspKeyContainerInfo，按不可导出处理
        $exportable = $false
      }
      if ($exportable) {
        RISK "私钥可导出（$($c.Thumbprint)）——任何人拿到你的 Windows 账户即可复制走"
        INFO '建议重新生成：tools\make-dev-cert.ps1（默认不可导出）'
      } else {
        OK "私钥不可导出，受 DPAPI 保护"
      }
      INFO "私钥位置: Cert:\CurrentUser\My\$($c.Thumbprint)"
    }
  }
}

# ---------- 2. 磁盘上的私钥文件 ----------
Section '磁盘上的私钥文件'

$patterns = @('*.pfx', '*.p12', '*.snk', '*.keystore')
$found = @()
foreach ($p in $patterns) {
  $found += Get-ChildItem $ProjectRoot -Filter $p -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' }
}

if (-not $found) {
  OK '项目目录内没有发现私钥文件'
} else {
  foreach ($f in $found) {
    RISK "发现私钥文件: $($f.FullName)"
    INFO "大小 $([math]::Round($f.Length/1KB,1)) KB，修改时间 $($f.LastWriteTime.ToString('yyyy-MM-dd'))"
    INFO '如果不需要备份，请立刻删除；需要备份请转移到加密介质后删除'
  }
}

# ---------- 3. 信任库 ----------
Section '信任库安装情况'

$inRoot = Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -like '*CN=AutoED Development*' }
$inPub = Get-ChildItem Cert:\CurrentUser\TrustedPublisher -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -like '*CN=AutoED Development*' }

if (-not $inRoot -and -not $inPub) {
  OK '没有安装自签名根证书（最安全的状态，但签名不会被认为是可信发布者）'
} else {
  if ($inRoot) {
    WARN "已把自签名根证书装进「受信任的根证书颁发机构」（$($inRoot.Count) 张）"
    INFO '含义：本机无条件信任这张证书签的任何程序'
    INFO '这属于「为了让自签名生效」的正常代价，但绝不应该出现在公开发布说明里'
  }
  if ($inPub) {
    OK "已装进「受信任的发布者」（$($inPub.Count) 张）"
  }
  INFO '移除方法: tools\trust-dev-cert.ps1 -Remove'
}

# ---------- 4. 产物签名 ----------
Section 'dist 产物签名'

$distDir = Join-Path $ProjectRoot 'dist'
if (-not (Test-Path $distDir)) {
  INFO 'dist 不存在（还没打包）'
} else {
  $exes = Get-ChildItem $distDir -Filter '*.exe' -File -ErrorAction SilentlyContinue
  if (-not $exes) {
    INFO 'dist 下没有 exe'
  } else {
    foreach ($e in $exes) {
      $sig = Get-AuthenticodeSignature $e.FullName
      switch ($sig.Status) {
        'Valid' { OK "$($e.Name) — 已签名" }
        'NotSigned' { WARN "$($e.Name) — 未签名（SmartScreen 会拦）" }
        default { WARN "$($e.Name) — $($sig.Status)" }
      }
    }
  }
}

# ---------- 5. 打包白名单 ----------
Section '打包范围'

$pkgPath = Join-Path $ProjectRoot 'package.json'
if (Test-Path $pkgPath) {
  $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
  $files = $pkg.build.files
  $leak = $files | Where-Object { $_ -match 'certs|\.pfx' }
  if ($leak) {
    RISK "打包白名单包含证书目录: $($leak -join ', ')"
  } else {
    OK "打包白名单: $($files -join ', ')"
    INFO '证书目录不在其中，私钥不会被打进安装包'
  }
}

# ---------- 结论 ----------
Write-Host ''
Write-Host '──────────────── 结论 ────────────────' -ForegroundColor DarkGray
if ($risk -eq 0 -and $warn -eq 0) {
  Write-Host ' 未发现问题。' -ForegroundColor Green
  exit 0
}
if ($risk -eq 0) {
  Write-Host " 没有高风险项，$warn 项提示。" -ForegroundColor Yellow
  exit 0
}
Write-Host " 发现 $risk 项高风险、$warn 项提示，请按上面的建议处理。" -ForegroundColor Red
exit 1
