<#
.SYNOPSIS
  用证书库里的证书直接签名打包（不读取、不生成任何 .pfx）。

.DESCRIPTION
  私钥始终留在 Cert:\CurrentUser\My，由 Windows 保护。
  electron-builder 通过 signtoolOptions.certificateSha1 指定用哪张证书，
  signtool 会调用系统 API 完成签名，私钥不出存储。

.PARAMETER Thumbprint
  指定证书指纹。默认自动查找主题为 AutoED Development 的证书。

.PARAMETER TimestampUrl
  RFC3161 时间戳服务器。默认不盖时间戳。
  原因：DigiCert / Sectigo / Entrust / GlobalSign 的公共 TSA 在国内经常完全连不通，
  而盖时间戳会让整个打包直接失败。自签的开发证书本来就不被 Windows 信任，
  时间戳带来的收益很小；等换成正式证书再指定，例如：
    -TimestampUrl http://timestamp.digicert.com

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\build-signed.ps1
#>
param(
  [string]$Thumbprint = '',
  [string]$TimestampUrl = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

if (-not $Thumbprint) {
  $cert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -like '*CN=AutoED Development*' -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if (-not $cert) {
    Write-Host '没有找到可用的签名证书。' -ForegroundColor Red
    Write-Host '先执行：powershell -ExecutionPolicy Bypass -File tools\make-dev-cert.ps1'
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

Write-Host '使用证书库中的证书签名：' -ForegroundColor Cyan
Write-Host "  $($cert.Subject)"
Write-Host "  $Thumbprint"
Write-Host '  私钥不会离开 Windows 证书存储。'
Write-Host ''

# 优先用 PATH 里的 npm；如果本机装了 AutoED 自己的 Node，再用它
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) {
  $fallback = Join-Path $env:LOCALAPPDATA 'AutoED-env\node'
  if (Test-Path $fallback) {
    $nodeExe = Get-ChildItem $fallback -Recurse -Filter 'npm.cmd' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeExe) {
      $env:PATH = "$($nodeExe.DirectoryName);$env:PATH"
      $npm = $nodeExe.FullName
    }
  }
}
if (-not $npm) {
  Write-Host '找不到 npm。先安装 Node.js 18+ 并确保 npm 在 PATH 里。' -ForegroundColor Red
  exit 1
}

$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

# 关键：走证书库签名，不设置 CSC_LINK
Remove-Item Env:\CSC_LINK -ErrorAction SilentlyContinue
Remove-Item Env:\CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:\WIN_CSC_LINK -ErrorAction SilentlyContinue
Remove-Item Env:\WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

Set-Location $root
$buildArgs = @("--config.win.signtoolOptions.certificateSha1=$Thumbprint")
if ($TimestampUrl) {
  Write-Host "时间戳服务器：$TimestampUrl" -ForegroundColor Cyan
  $buildArgs += "--config.win.signtoolOptions.rfc3161TimeStampServer=$TimestampUrl"
  Remove-Item Env:\ELECTRON_BUILDER_OFFLINE -ErrorAction SilentlyContinue
} else {
  # electron-builder 在未配置时间戳时默认回退到 timestamp.digicert.com，
  # 而它在国内基本连不通，会让整个打包失败。这个环境变量是官方唯一的关闭开关
  # （只影响时间戳，不影响其它步骤）。
  $env:ELECTRON_BUILDER_OFFLINE = 'true'
  Write-Host '不盖时间戳（自签证书场景下足够；正式发布时用 -TimestampUrl 指定）' -ForegroundColor DarkGray
}
& $npm run dist -- @buildArgs

if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '打包失败，请检查上面的输出。' -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host ''
Write-Host '打包完成，验证签名：' -ForegroundColor Green
& (Join-Path $PSScriptRoot 'verify-sign.ps1')
