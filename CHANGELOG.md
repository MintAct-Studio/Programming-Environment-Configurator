# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.9.0] — 2026-11-07

首个公开版本。

### 新增

- **界面多语言**：默认英语，可切换中文 / 日本語 / 한국어 / Русский / Français
  - 六种语言各 445 条译文，覆盖界面、诊断、日志解读与教程正文
  - 采用 gettext 思路，中文原文即 key，新增文案不需要维护一套 key 表
  - 缺失条目按「当前语言 → 英语 → 原文」回退，不会出现空白
- **默认安装目录按盘符探测**：优先复用已有环境，其次选剩余空间最大的非系统盘，都没有才退到用户目录
  - 之前写死 `D:\AutoED-env`，在没有 D 盘的机器上会直接失败
- **`sign:artifacts` 脚本**：打包与签名拆成两步，签名后自动重算 `latest.yml` 哈希

### 修复

- `readSettings()` 遇到带 BOM 的 JSON 会抛错，导致所有设置（安装目录、语言、教程状态）静默丢失
- 存储卡片固定读取 D 盘剩余空间，装到别的盘时显示错误
- 系统位数显示成 `64 位-bit`（`os.arch` 本身已带单位）
- 俄语等长文案把顶栏按钮挤成两行

### 变更

- `build-signed.ps1` 默认不盖时间戳：electron-builder 在未配置时间戳时会硬编码回退到
  `timestamp.digicert.com`，该域名在国内基本不可达，会让整个打包失败。
  需要时间戳时用 `-TimestampUrl` 显式指定。
- `build-signed.ps1` 不再写死本机 Node 路径，改为从 PATH 查找

### 已知限制

- 使用自签开发证书，Windows SmartScreen 会提示「未知发布者」
- 自动更新未配置（`build.publish` 为占位地址）
- 界面长尾文案（部分日志解读分支）尚未覆盖全部六种语言

## 更早的版本

0.1.0 – 0.8.0 为内部迭代，未公开发布。主要能力演进：

- 硬件探测、规则引擎、四通道安装编排、PATH 保护
- 诊断窗口（迁移 / 重装 / 卸载）、软件库、环境锁
- 下载源三层校验（数字签名 / 哈希基线 / 多镜像比对）
- 代码签名与私钥存储方案

[0.9.0]: https://github.com/MintAct-Studio/Programming-Environment-Configurator/releases/tag/0.9.0
