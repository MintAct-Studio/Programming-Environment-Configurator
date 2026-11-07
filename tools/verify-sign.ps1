<#
.SYNOPSIS
  检查 dist 下安装包 / 便携版的代码签名状态。

.DESCRIPTION
  Status 含义：
    Valid           签名有效（若证书受信任，用户不会看到警告）
    NotSigned       没有签名 → SmartScreen 会拦
    HashMismatch    文件被改过，或签名后又被重打包
    UnknownError    其它问题

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\verify-sign.ps1
#>
param(
  [string]$DistDir = (Join-Path $PSScriptRoot '..\dist')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $DistDir)) {
  Write-Host "找不到目录：$DistDir" -ForegroundColor Red
  exit 1
}

$files = Get-ChildItem $DistDir -Filter '*.exe' -File | Sort-Object Name
if (-not $files) {
  Write-Host 'dist 下没有 exe，先执行 npm run dist' -ForegroundColor Yellow
  exit 1
}

$bad = 0
foreach ($f in $files) {
  $sig = Get-AuthenticodeSignature $f.FullName
  $status = $sig.Status
  $color = switch ($status) {
    'Valid' { 'Green' }
    'NotSigned' { 'Red' }
    default { 'Yellow' }
  }

  $who = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '(无)' }
  $trusted = '(未知)'
  if ($sig.SignerCertificate) {
    $trusted = if ($sig.SignerCertificate.Verify()) { '证书受信任' } else { '证书不受信任（自签名常见）' }
  }

  Write-Host ("{0,-32} {1,-14} {2}" -f $f.Name, $status, $trusted) -ForegroundColor $color
  Write-Host ("    签名者: {0}" -f $who) -ForegroundColor DarkGray

  if ($status -ne 'Valid') { $bad++ }
}

Write-Host ''
if ($bad -eq 0) {
  Write-Host '全部文件签名有效。' -ForegroundColor Green
  exit 0
}

Write-Host "$bad 个文件没有有效签名。" -ForegroundColor Red
Write-Host '正式发布前请用 OV/EV 证书重新打包；内部分发可让用户先导入 certs\autoed-dev.cer。' -ForegroundColor Yellow
exit 2
