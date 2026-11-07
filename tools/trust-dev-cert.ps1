<#
.SYNOPSIS
  把自签名代码签名证书装进「当前用户」的信任库。

.DESCRIPTION
  ========================= 请先读完再执行 =========================
  这一步会让 Windows **无条件信任**这张证书签名的所有程序。
  也就是说：任何拿到这张证书私钥的人，都能给你这台机器做一个
  "没有警告的 AutoED"——你分不出来真假。

  这和安全软件提示"请把本程序加入信任列表"是同一种机制，
  而恶意软件最爱用的正是这一招。

  所以：
    * 只在你自己的/你要负责的机器上执行
    * 不要把它写进面向公众的安装说明
    * 执行完请确认私钥不可导出（tools\security-audit.ps1）

  不加 -Force 时本脚本只做检查，不会改动任何东西。
  =================================================================

.PARAMETER CertPath
  .cer 文件路径，默认 certs\autoed-dev.cer

.PARAMETER Force
  确认执行安装。没有这个开关只显示警告。

.PARAMETER Remove
  从信任库移除（推荐在不再需要时执行）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\trust-dev-cert.ps1
  powershell -ExecutionPolicy Bypass -File tools\trust-dev-cert.ps1 -Force
  powershell -ExecutionPolicy Bypass -File tools\trust-dev-cert.ps1 -Remove
#>
param(
  [string]$CertPath = (Join-Path $PSScriptRoot '..\certs\autoed-dev.cer'),
  [switch]$Force,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $CertPath)) {
  Write-Host "找不到证书：$CertPath" -ForegroundColor Red
  Write-Host '先执行：powershell -ExecutionPolicy Bypass -File tools\make-dev-cert.ps1'
  exit 1
}

$resolved = (Resolve-Path $CertPath).Path
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $resolved
$thumb = $cert.Thumbprint

Write-Host ''
Write-Host "证书主题 : $($cert.Subject)" -ForegroundColor Cyan
Write-Host "指纹     : $thumb" -ForegroundColor Cyan
Write-Host ''

if ($Remove) {
  $removedAny = $false
  foreach ($storeName in @('Root', 'TrustedPublisher')) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'CurrentUser')
    $store.Open('ReadWrite')
    $found = $store.Certificates | Where-Object { $_.Thumbprint -eq $thumb }
    if ($found) {
      $store.Remove($found)
      Write-Host "已从 $storeName 移除" -ForegroundColor Yellow
      $removedAny = $true
    } else {
      Write-Host "$storeName 里没有这张证书" -ForegroundColor DarkGray
    }
    $store.Close()
  }
  if ($removedAny) {
    Write-Host ''
    Write-Host '信任已撤销。之后用这张证书签的程序会重新显示"未知发布者"。' -ForegroundColor Green
  }
  exit 0
}

# ---- 不加 -Force 只做提示，不改动系统 ----
if (-not $Force) {
  Write-Host '========================================' -ForegroundColor Red
  Write-Host ' 这一步有真实的安全影响' -ForegroundColor Red
  Write-Host '========================================' -ForegroundColor Red
  Write-Host ''
  Write-Host '执行后，本机会无条件信任下面这张证书签名的所有程序：' -ForegroundColor Yellow
  Write-Host "  $($cert.Subject)"
  Write-Host ''
  Write-Host '这意味着：' -ForegroundColor Yellow
  Write-Host '  * 拿到这张证书私钥的人，可以做一个"没有警告"的假 AutoED'
  Write-Host '  * Windows 不会拦，你也看不出区别'
  Write-Host ''
  Write-Host '私钥位置（由 Windows DPAPI 保护）：' -ForegroundColor Yellow
  $priv = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $thumb }
  if ($priv) {
    Write-Host "  Cert:\CurrentUser\My\$thumb"
    $exp = $false
    try { $exp = $priv.PrivateKey.CspKeyContainerInfo.Exportable } catch { $exp = $false }
    if ($exp) {
      Write-Host '  ！！该私钥当前「可导出」，请先换成不可导出的证书' -ForegroundColor Red
    } else {
      Write-Host '  私钥不可导出 ✓' -ForegroundColor Green
    }
  } else {
    Write-Host '  （本机证书库里没有对应私钥，只能用于验证签名，不能用于签名）' -ForegroundColor DarkGray
  }
  Write-Host ''
  Write-Host '确认理解后，加 -Force 执行：' -ForegroundColor Yellow
  Write-Host '  powershell -ExecutionPolicy Bypass -File tools\trust-dev-cert.ps1 -Force'
  Write-Host ''
  Write-Host '撤销：同样的命令加 -Remove' -ForegroundColor DarkGray
  exit 2
}

foreach ($storeName in @('Root', 'TrustedPublisher')) {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'CurrentUser')
  $store.Open('ReadWrite')
  $exists = $store.Certificates | Where-Object { $_.Thumbprint -eq $thumb }
  if ($exists) {
    Write-Host "$storeName 已存在，跳过" -ForegroundColor DarkGray
  } else {
    $store.Add($cert)
    Write-Host "已导入 $storeName" -ForegroundColor Green
  }
  $store.Close()
}

Write-Host ''
Write-Host '完成。验证签名：' -ForegroundColor Yellow
Write-Host '  powershell -ExecutionPolicy Bypass -File tools\verify-sign.ps1'
Write-Host '安全自查：' -ForegroundColor Yellow
Write-Host '  powershell -ExecutionPolicy Bypass -File tools\security-audit.ps1'
