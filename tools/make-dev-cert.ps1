<#
.SYNOPSIS
  生成自签名代码签名证书（仅限内部分发）。

.DESCRIPTION
  ============================ 安全须知 ============================
  这张证书的私钥可以给任意程序签名，而被信任的机器会认为那些程序"可信"。
  私钥一旦泄露，后果等同于把本机信任库交出去。

  因此本脚本的默认行为是：
    * 私钥标记为「不可导出」，只存在于证书存储里，由 Windows DPAPI 保护
    * 只导出 .cer（公开证书，可以随便发给别人）
    * 不生成 .pfx

  需要备份私钥时才用 -ExportPfx，并且强制要求一个强口令。
  ================================================================

.PARAMETER Password
  仅在 -ExportPfx 时需要。至少 16 位，且不能是弱口令。

.PARAMETER ExportPfx
  导出 .pfx（含私钥）。默认不导出。导出后请立刻转移到加密介质。

.PARAMETER OutDir
  输出目录，默认 certs\（已在 .gitignore 中忽略）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\make-dev-cert.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\make-dev-cert.ps1 -ExportPfx -Password "a-long-random-passphrase-123456"
#>
param(
  [string]$Password = '',
  [switch]$ExportPfx,
  [string]$OutDir = (Join-Path $PSScriptRoot '..\certs')
)

$ErrorActionPreference = 'Stop'

Write-Host '========================================' -ForegroundColor DarkYellow
Write-Host ' 代码签名证书生成' -ForegroundColor DarkYellow
Write-Host '========================================' -ForegroundColor DarkYellow
Write-Host ''

# ---- 只有导出 PFX 时才要口令，且必须是强口令 ----
$exportable = $false
if ($ExportPfx) {
  $weak = @('autoed-dev', 'password', '123456', '12345678', 'admin', 'test', 'qwerty')
  if ([string]::IsNullOrWhiteSpace($Password)) {
    Write-Host '已指定 -ExportPfx，但没有提供 -Password。' -ForegroundColor Red
    Write-Host '请提供一个不少于 16 位的口令。' -ForegroundColor Yellow
    exit 1
  }
  if ($Password.Length -lt 16) {
    Write-Host "口令太短（$($Password.Length) 位），至少 16 位。" -ForegroundColor Red
    exit 1
  }
  if ($weak -contains $Password.ToLower()) {
    Write-Host "口令 '$Password' 属于常见弱口令，拒绝使用。" -ForegroundColor Red
    exit 1
  }
  $exportable = $true
  Write-Host '警告：你将导出含私钥的 .pfx。' -ForegroundColor Red
  Write-Host '  这个文件能签署任何程序。请勿放入网盘、聊天记录、代码仓库。' -ForegroundColor Yellow
  Write-Host ''
}

if (-not (Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

Write-Host '正在创建证书（私钥不可导出）...' -ForegroundColor Cyan

$params = @{
  Type              = 'CodeSigningCert'
  Subject           = 'CN=AutoED Development, O=AutoED, C=CN'
  KeyUsage          = 'DigitalSignature'
  FriendlyName      = 'AutoED Dev Signing'
  CertStoreLocation = 'Cert:\CurrentUser\My'
  KeyExportPolicy   = if ($exportable) { 'Exportable' } else { 'NonExportable' }
  KeyLength         = 2048
  HashAlgorithm     = 'SHA256'
  NotAfter          = (Get-Date).AddYears(1)
}

$cert = New-SelfSignedCertificate @params
$thumb = $cert.Thumbprint

# 只导出公开证书
$cerPath = Join-Path $OutDir 'autoed-dev.cer'
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

if ($ExportPfx) {
  $pwd = ConvertTo-SecureString -String $Password -Force -AsPlainText
  $pfxPath = Join-Path $OutDir 'autoed-dev.pfx'
  Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null
}

Write-Host ''
Write-Host '----------------------------------------' -ForegroundColor DarkGray
Write-Host ' 证书已创建' -ForegroundColor Green
Write-Host '----------------------------------------' -ForegroundColor DarkGray
Write-Host "主题      : $($cert.Subject)"
Write-Host "指纹      : $thumb"
Write-Host "有效期至  : $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host ''
Write-Host '【私钥在哪里】' -ForegroundColor Yellow
Write-Host "  Cert:\CurrentUser\My\$thumb"
Write-Host '  受 Windows DPAPI 保护，只有当前这个 Windows 账户能使用。'
if (-not $exportable) {
  Write-Host '  私钥标记为「不可导出」——无法被复制成文件。' -ForegroundColor Green
} else {
  Write-Host "  ！！已导出到 $pfxPath —— 泄露后攻击者可给任意程序签名。" -ForegroundColor Red
}
Write-Host ''
Write-Host "公开证书  : $cerPath"
Write-Host '  （.cer 只含公钥，可以放心发给别人安装）'
Write-Host ''
Write-Host '【下一步】' -ForegroundColor Yellow
Write-Host '  1. 让自己机器信任它：'
Write-Host '       powershell -ExecutionPolicy Bypass -File tools\trust-dev-cert.ps1'
Write-Host '  2. 用证书库直接签名打包（不产生任何 pfx 文件）：'
Write-Host '       powershell -ExecutionPolicy Bypass -File tools\build-signed.ps1'
Write-Host '  3. 检查安全状态：'
Write-Host '       powershell -ExecutionPolicy Bypass -File tools\security-audit.ps1'
