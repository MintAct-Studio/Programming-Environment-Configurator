'use strict'
/**
 * 硬件采集 —— 全部走 CIM（不用 wmic，Win11 24H2 起已移除）。
 *
 * 采集的每一项都对应一个"会影响推荐结果"的判断：
 *   CPU 架构/核心数   → 选 x64 包、决定编译并行度
 *   内存总量/频率     → 决定能不能上深度学习栈
 *   GPU 型号/显存     → 决定 PyTorch 用 CPU 版还是 CUDA 版
 *   磁盘介质/剩余空间 → 决定装 VS Build Tools 还是轻量工具链
 *   OS 版本/构建号    → 决定 winget 是否存在
 *
 * 两个踩过的坑（值得保留注释）：
 *  1. MSFT_PhysicalDisk 不在 root\cimv2，而在 root\Microsoft\Windows\Storage，
 *     用默认命名空间查会抛"无效类"，导致磁盘信息全空。
 *  2. Win32_VideoController.AdapterRAM 是 32 位字段，显存超过 4 GB 会溢出成
 *     4293918720 之类的假值。真实容量要读注册表的 HardwareInformation.qwMemorySize。
 */
const { runPowerShellJson } = require('./ps')

const SCRIPT = [
  '$os = Get-CimInstance Win32_OperatingSystem',
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
  '$mem = @(Get-CimInstance Win32_PhysicalMemory)',
  '$gpus = @(Get-CimInstance Win32_VideoController)',
  '$vols = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")',
  '',
  '# 磁盘：先试 Storage 命名空间，失败再退回 Get-PhysicalDisk',
  '$phys = @()',
  'try { $phys = @(Get-CimInstance -Namespace "root\\Microsoft\\Windows\\Storage" -ClassName MSFT_PhysicalDisk -ErrorAction Stop) } catch { }',
  'if ($phys.Count -eq 0) { try { $phys = @(Get-PhysicalDisk -ErrorAction Stop) } catch { } }',
  '',
  '# 显存：注册表 qwMemorySize 是 64 位真实值',
  '$vramMap = @{}',
  '$cls = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}"',
  'Get-ChildItem $cls -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
  '  if ($p.DriverDesc -and $p."HardwareInformation.qwMemorySize") { $vramMap["$($p.DriverDesc)"] = [double]$p."HardwareInformation.qwMemorySize" }',
  '}',
  '',
  '$memInfo = $mem | ForEach-Object { [pscustomobject]@{ capacityGB = [math]::Round($_.Capacity/1GB,0); speedMHz = [int]$_.Speed; slot = "$($_.DeviceLocator)" } }',
  '$gpuInfo = $gpus | ForEach-Object {',
  '  $name = "$($_.Name)"',
  '  $bytes = 0.0; $src = "none"',
  '  if ($vramMap.ContainsKey($name)) { $bytes = $vramMap[$name]; $src = "registry" }',
  '  elseif ($_.AdapterRAM -gt 0) { $bytes = [double]$_.AdapterRAM; $src = "adapterram" }',
  '  [pscustomobject]@{ name = $name; driverVersion = "$($_.DriverVersion)"; vramBytes = $bytes; vramSource = $src }',
  '}',
  '$diskInfo = $phys | ForEach-Object {',
  '  $mt = "$($_.MediaType)"; $bus = "$($_.BusType)"',
  '  [pscustomobject]@{',
  '    model = "$($_.FriendlyName)"',
  '    media = $mt',
  '    bus = $bus',
  '    sizeGB = [math]::Round($_.Size/1GB,0)',
  '    isSSD = ($mt -eq "4") -or ($mt -match "SSD") -or ($bus -eq "17") -or ($bus -match "NVMe")',
  '  }',
  '}',
  '$volInfo = $vols | ForEach-Object { [pscustomobject]@{ letter = "$($_.DeviceID)"; totalGB = [math]::Round($_.Size/1GB,1); freeGB = [math]::Round($_.FreeSpace/1GB,1) } }',
  '',
  '$totalRam = 0',
  'if ($mem.Count -gt 0) { $totalRam = [math]::Round((($mem | Measure-Object -Property Capacity -Sum).Sum)/1GB,1) }',
  '',
  '[pscustomobject]@{',
  '  os = [pscustomobject]@{ caption = "$($os.Caption)"; version = "$($os.Version)"; build = "$($os.BuildNumber)"; arch = "$($os.OSArchitecture)" }',
  '  cpu = [pscustomobject]@{',
  '    name = ("$($cpu.Name)" -replace "\\s+"," ").Trim()',
  '    cores = [int]$cpu.NumberOfCores',
  '    threads = [int]$cpu.NumberOfLogicalProcessors',
  '    maxMHz = [int]$cpu.MaxClockSpeed',
  '    addressWidth = [int]$cpu.AddressWidth',
  '  }',
  '  ram = [pscustomobject]@{',
  '    totalGB = $totalRam',
  '    sticks = $memInfo',
  '    stickCount = [int]$mem.Count',
  '    maxSpeedMHz = [int](($mem | Measure-Object -Property Speed -Maximum).Maximum)',
  '  }',
  '  gpus = $gpuInfo',
  '  disks = $diskInfo',
  '  volumes = $volInfo',
  '} | ConvertTo-Json -Depth 6 -Compress'
].join('\n')

const NVIDIA_RE = /nvidia|geforce|quadro|tesla|rtx|gtx/i

/** AdapterRAM 溢出的特征值：>= 4 GB 时这个 32 位字段就不可信了 */
const ADAPTER_RAM_CAP = 4 * 1024 ** 3

function toArray(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return [value]
  return []
}

/** 把原始数据加工成推荐引擎能直接用的形状 */
function normalize(raw) {
  const gpus = toArray(raw.gpus).filter((g) => g.name && !/microsoft basic|remote/i.test(g.name))

  const nvidia = gpus.find((g) => NVIDIA_RE.test(g.name)) || null
  let vramGB = 0
  if (nvidia) {
    if (nvidia.vramSource === 'registry' && nvidia.vramBytes > 0) {
      vramGB = Math.round(nvidia.vramBytes / 1024 ** 3)
    } else if (nvidia.vramBytes > 0 && nvidia.vramBytes < ADAPTER_RAM_CAP) {
      // AdapterRAM 只在小于 4 GB 时可信
      vramGB = Math.round(nvidia.vramBytes / 1024 ** 3)
    }
  }

  const disks = toArray(raw.disks)
  const hasSsd = disks.some((d) => d.isSSD || /nvme/i.test(String(d.bus || '')))

  const volumes = toArray(raw.volumes)
  const byLetter = {}
  for (const v of volumes) byLetter[v.letter] = v

  const ram = raw.ram || { totalGB: 0, stickCount: 0, sticks: [] }

  return {
    os: raw.os || {},
    cpu: raw.cpu || {},
    ram,
    gpus,
    nvidia,
    vramGB,
    disks,
    hasSsd,
    volumes,
    byLetter,
    is64: String(raw.os?.arch || '').includes('64'),
    summary: {
      ramGB: ram.totalGB,
      cores: raw.cpu?.cores || 0,
      threads: raw.cpu?.threads || 0,
      hasNvidia: Boolean(nvidia),
      vramGB,
      hasSsd
    }
  }
}

async function probeHardware() {
  const raw = await runPowerShellJson(SCRIPT, { timeout: 30000 })
  return normalize(raw || {})
}

module.exports = { probeHardware, normalize }
