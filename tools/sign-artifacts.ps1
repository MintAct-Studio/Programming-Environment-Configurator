<#
.SYNOPSIS
  给 dist 下已打包好的 exe 补签名，并刷新 latest.yml 里的哈希。

.DESCRIPTION
  为什么不直接在 electron-builder 里签：
    1. 它在未配置时间戳时会硬编码回退到 timestamp.digicert.com，
       该域名在国内基本连不通，会让整个打包失败；
    2. 它的签名报错信息很少（只有一个 SignerSign 失败码），排查困难。
  打包用 npm run dist，签名用这个脚本，两步都独立可控。

  私钥始终留在 Cert:\CurrentUser\My，signtool 通过 /sha1 从证书库取，
  不读取也不生成任何 .pfx。

.PARAMETER Thumbprint
  证书指纹。默认自动查找主题为 AutoED Development 的证书。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\sign-artifacts.ps1
#>
param(
  [string]$Thumbprint = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# ---- 找证书 ----
if (-not $Thumbprint) {
  $cert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -like '*CN=AutoED Development*' -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if (-not $cert) {
    Write-Host '没有找到可用的签名证书。先执行 tools\make-dev-cert.ps1' -ForegroundColor Red
    exit 1
  }
  $Thumbprint = $cert.Thumbprint
} else {
  $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $Thumbprint } | Select-Object -First 1
  if (-not $cert) {
    Write-Host "证书库里没有指纹为 $Thumbprint 的证书。" -ForegroundColor Red
    exit 1
  }
}

if (-not $cert.HasPrivateKey) {
  Write-Host '这张证书没有私钥，无法签名。' -ForegroundColor Red
  exit 1
}

# ---- 找 signtool（electron-builder 缓存里那份最稳，不依赖装 SDK）----
$signtool = $null
$cache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
if (Test-Path $cache) {
  $signtool = Get-ChildItem $cache -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'windows-10\\x64' } |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signtool) {
  $kit = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'x64' } | Select-Object -Last 1 -ExpandProperty FullName
  if ($kit) { $signtool = $kit }
}
if (-not $signtool) {
  Write-Host '找不到 signtool.exe（既没有 electron-builder 缓存，也没装 Windows SDK）。' -ForegroundColor Red
  exit 1
}

Write-Host '签名证书：' -ForegroundColor Cyan
Write-Host "  $($cert.Subject)"
Write-Host "  $Thumbprint"
Write-Host "  signtool: $signtool"
Write-Host ''

$targets = Get-ChildItem (Join-Path $root 'dist') -Filter '*.exe' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notmatch '__uninstaller' }
if (-not $targets) {
  Write-Host 'dist 下没有 exe，先执行 npm run dist' -ForegroundColor Red
  exit 1
}

$failed = 0
foreach ($file in $targets) {
  Write-Host "签名 $($file.Name) …" -NoNewline
  & $signtool sign /sha1 $Thumbprint /fd sha256 /d "AutoED" $file.FullName 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host ' 失败' -ForegroundColor Red
    $failed++
    continue
  }
  $sig = Get-AuthenticodeSignature $file.FullName
  Write-Host " $($sig.Status)" -ForegroundColor Green
}

if ($failed) {
  Write-Host "$failed 个文件签名失败" -ForegroundColor Red
  exit 1
}

# ---- 刷新 latest.yml：签名会改变文件内容，哈希必须重算 ----
$node = $null
foreach ($cand in @('D:\AutoED-env\node\node-versions\v26.13.0\installation\node.exe', 'node')) {
  if ($cand -eq 'node') { if (Get-Command node -ErrorAction SilentlyContinue) { $node = 'node' } }
  elseif (Test-Path $cand) { $node = $cand }
}
if ($node) {
  $script = @'
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const dir = path.join(process.cwd(), 'dist')
const pkg = require(path.join(process.cwd(), 'package.json'))
const files = fs.readdirSync(dir).filter(f => /\.exe$/i.test(f) && !/__uninstaller/i.test(f))
const entry = f => {
  const buf = fs.readFileSync(path.join(dir, f))
  return { url: f, sha512: crypto.createHash('sha512').update(buf).digest('base64'), size: buf.length }
}
const list = files.map(entry)
const setup = list.find(x => /Setup/i.test(x.url)) || list[0]
const yml = [
  'version: ' + pkg.version,
  'files:',
  ...list.map(x => `  - url: ${x.url}\n    sha512: ${x.sha512}\n    size: ${x.size}`),
  'path: ' + setup.url,
  'sha512: ' + setup.sha512,
  'releaseDate: \'' + new Date().toISOString() + '\''
].join('\n')
fs.writeFileSync(path.join(dir, 'latest.yml'), yml + '\n', 'utf8')
console.log('latest.yml 已按签名后的文件重算')
'@
  $script | & $node --input-type=commonjs - 2>&1 | Out-String | ForEach-Object { $_.Trim() }
} else {
  Write-Host '没找到 node，跳过 latest.yml 刷新' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '验收：' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'verify-sign.ps1')
