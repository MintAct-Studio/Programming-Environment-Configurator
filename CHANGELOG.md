# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.10.0] — 2026-11-16

### 新增

- **模型库**：顶栏新增「模型库」，按 AI 模型类别管理本地模型
  - 六个类别：视觉、声纹、语音合成（TTS）、语音识别（ASR）、向量检索、大语言模型
  - 内置 17 个模型，标注参数量、体积、许可证与来源
  - 能直连官方的（YOLOv8n/s、Real-ESRGAN、InsightFace buffalo_l）一键下载，走镜像 + 断点续传
  - 只能网页下载的（HuggingFace / ModelScope）给出官方地址，下好后可「登记已下载」把本地目录登记进来
  - 已就绪/未就绪状态、打开所在目录、移除（只删本程序装的那份，登记的外部路径只取消登记）
  - 模型落在 `<安装目录>\models\<类别>\<模型 id>\`，登记表是 `models\index.json`

### 变更

- **改名为「模型环境控制器」**（英文 Model Environment Controller）
  - 界面标题、窗口标题、安装包显示名、README 全部更新，六种语言都有对应译名
  - **内部标识保持不变**：exe 名 `AutoED.exe`、appId `org.autoed.app`、`%APPDATA%\autoed`、默认环境目录 `D:\AutoED-env`、`autoed.lock.json`
  - 原因：改这些会让老用户的设置、PATH 记录、已装组件全部失联

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
