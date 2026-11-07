# AutoED

**Read your hardware → recommend an environment → install it in one click.**

A Windows 10/11 tool that sets up programming environments. Nothing goes to the system drive by default, no administrator rights are needed, every run is a real install, and the result is reproducible.

> 中文说明在下方。English summary below.

---

## English summary

AutoED detects your CPU, RAM, GPU and disks, recommends a concrete set of components for what you want to build (web, backend, data, machine learning, C/C++), and installs them at a path you choose.

**Why not just ask an AI agent to set it up?** It can install things, but it cannot guarantee three properties: the result is **not reproducible**, versions **overwrite each other**, and when something breaks there is **no way to diagnose it**. AutoED targets exactly those three.

- **Hardware-aware** — reads real VRAM and driver version, not just the GPU name
- **Per-version isolation** — each Python version lives in its own directory; uninstalling one never touches another
- **Pick your versions** — Python 3.10–3.13, Node 18–22, PyTorch CUDA variants
- **Diagnostics** — move, reinstall, uninstall; PATH usage and a check that commands actually resolve to what AutoED installed
- **Software library** — Notepad++, Neovim, ripgrep, GitHub CLI, DBeaver install directly
- **Environment lock** — export the current setup; anyone who has the file can rebuild the exact same environment
- **Network** — four mirrors probed in parallel, resumable downloads, optional HTTP proxy
- **Supply chain** — three layers of verification (Authenticode signature, hash baseline, cross-mirror comparison); any failure aborts the install and deletes the file
- **UI in English (default), 中文, 日本語, 한국어, Русский, Français**

**Two invariants:** no administrator rights required, and nothing written to the system directory.

AutoED does not promise "zero configuration" or "installs anything". It promises that **the commands work afterwards and the environment is reproducible**.

**Download:** see [Releases](https://github.com/MintAct-Studio/Programming-Environment-Configurator/releases). Windows x64, portable or NSIS installer.

> The current builds are signed with a self-signed development certificate, so SmartScreen will warn about an unknown publisher — choose *Run anyway*. Checksums are in `latest.yml`.

---

```
版本 0.9.0　|　Windows 10/11 x64　|　MIT
```

---

## 目录

- [它能做什么](#它能做什么)
- [快速开始](#快速开始)
- [能力详解](#能力详解)
- [设计原则](#设计原则)
- [打包与签名](#打包与签名)
- [开发用命令行开关](#开发用命令行开关)
- [目录结构](#目录结构)
- [已知限制](#已知限制)
- [踩过的坑](#踩过的坑)

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **硬件检测** | CPU、内存、显卡（显存读注册表真值）、硬盘、系统版本 |
| **场景推荐** | 网页前端 / 后端服务 / 数据分析 / 机器学习 / C++，可多选 |
| **版本自选** | Python 3.10–3.13、Node LTS/22/20/18、PyTorch CUDA 变体 |
| **一次安装** | 四路镜像并发测速、断点续传、逐文件 SHA256 校验 |
| **零管理员** | 只写当前用户 PATH，不动系统目录 |
| **位置可控** | 默认 `D:\AutoED-env`，每个组件都能改，按盘预估占用 |
| **装完能管** | 诊断窗口：迁移 / 重装 / 卸载，显示路径、版本、体积 |
| **软件库** | 5 个可直装（带版本选择）+ 6 个官方链接 |
| **环境锁** | 导出环境快照，别人可一键复现；也可导入比对后按需重建 |
| **日志** | 落盘 + 一键导出 + 解析常见报错并给处理办法 |
| **代理** | 支持 HTTP 代理，版本查询与下载都走它 |

---

## 快速开始

```bash
# 开发运行
npm install
npm start

# 打包（未签名）
npm run dist

# 打包（用证书库签名，需要先执行 cert:dev / cert:trust）
npm run build:signed
```

产物在 `dist/`：

```
AutoED-Setup-<版本>.exe      安装版（可选安装目录）
AutoED-<版本>-portable.exe   便携版（双击即用）
latest.yml                   自动更新清单
```

---

## 能力详解

### 组件与版本

| 类别 | 组件 | 可选版本 |
|---|---|---|
| 基础 | Git（MinGit 便携版） | 最新稳定版 |
| Python | uv、Python | **3.13 / 3.12 / 3.11 / 3.10**（每个版本独立目录，可并存） |
| Node | Node.js、pnpm | **LTS / 22 / 20 / 18** |
| C++ | w64devkit（GCC）、CMake、Ninja | 最新稳定版 |
| AI | PyTorch | **自动匹配 / cu128 / cu126 / cu130** |
| 编辑器 | VS Code | 手动下载 + 导入 |

版本由 `src/data/components.json` 的 `versions` 字段定义，安装时透传到对应通道。
场景可用 `versionHints` 给默认值（数据方向默认 3.12，AI 方向默认 3.11）。

### Python 版本隔离

每个 Python 版本装在独立目录，互不影响：

```
D:\AutoED-env\python\3.12\bin\python.exe
D:\AutoED-env\python\3.11\bin\python.exe
D:\AutoED-env\python\3.10\bin\python.exe
```

- 装 3.10 不会再覆盖 3.12，卸载 3.10 也不会带走 3.12
- **默认版本 = 在 PATH 里排最前的那个**；新装的版本会自动置顶
- 想换回来：诊断窗口的 Python 行逐版本列出，点「设为默认」即可（把该版本的 bin 提到 PATH 最前）

### 安装通道

| 通道 | 用于 | 做法 |
|---|---|---|
| `zip` | Git、uv、CMake、Ninja | 下载 → 校验 → `tar.exe` 解压 |
| `7zsfx` | w64devkit | 7-Zip 自解压包静默展开 |
| `uv-python` | Python | `uv python install <版本> --default` |
| `fnm-node` | Node | `fnm install <大版本>` |
| `pip-venv` | PyTorch | 建 venv → 按 CUDA 变体选索引源安装 |
| `manual` | VS Code | 给下载页 + 导入已下载目录 |

每个组件的流程一致：**解析 → 下载 → 校验 → 解压/执行 → 登记 PATH → 验证**，任一步失败即回滚本轮改动。

### 软件库

**可直接安装**（GitHub Releases 直链，带版本下拉）：
Notepad++ · Neovim · ripgrep · GitHub CLI · DBeaver

**只给官方地址**：PyCharm · IntelliJ IDEA · JetBrains Toolbox · Postman · Docker Desktop · Windows Terminal

### 环境锁

```json
{
  "lockVersion": 1,
  "toolVersion": "0.9.0",
  "installRoot": "D:\\AutoED-env",
  "components": [
    { "id": "python", "version": "3.12.7", "relativePath": "python" }
  ],
  "pathOrder": ["D:\\AutoED-env\\python\\bin"]
}
```

- **导出**：记录精确版本 + 相对路径 + PATH 顺序
- **比对**：逐项标出 一致 / 版本不同 / 缺失（版本比较会抠数字段，`git version 2.56.0.windows.4` 对 `2.56.0.4` 判为一致）
- **按锁重建**：**勾选**要补的组件才执行，一致的默认不勾

### 日志

- 落盘：`<安装目录>\.autoed\logs\autoed-YYYY-MM-DD.log`
- 内存保留最近 3000 条，未捕获异常也写入
- **导出**：生成一个 txt，含版本、系统、代理状态、硬件摘要、已装组件、完整日志
- **解析**：内置 13 类规则，能认出网络/证书/限流/磁盘/权限/依赖冲突等并给出处理办法

### 代理与离线兜底

- 「高级 → 网络」填 `http://127.0.0.1:7890`，API 查询和文件下载都走它
- Node 自带的 `fetch` 不读代理，所以统一走 Electron 的 `net.fetch`（`src/core/http.js`）
- GitHub API 不可用时按顺序回退：**磁盘缓存 → GitHub API → 内置清单**（`src/data/releases.json`）

### 独立窗口

每个栏目右上角有 `⤢`：点击或按住标题栏拖到窗口外，即成为独立窗口。诊断本身就是独立窗口。
主窗口是唯一的数据所有者，通过 `sync:set` 广播，独立窗口只读 + 通过 `sync:action` 回传操作。

### 启动画面

三句轮换，每次启动换一句且不与上次重复（`src/renderer/splash-quotes.js`）：

```
I am the master of fate                     我是命运的统帅
The best way out is always through          最好的出路，永远是穿过去
It always seems impossible until it's done  事成之前，总觉得不可能
```

启动画面与主窗口**同尺寸同位置**，淡出后露出主界面。

---

## 设计原则

1. **零管理员**：只写 `HKCU\Environment`，不装服务、不写系统目录、不需要 UAC
2. **不默认写 C 盘**：自动挑剩余空间最大的非系统盘（已有环境则原地复用），没有其它盘时才退到用户目录
3. **失败可回滚**：每轮改动记入 journal，失败时还原 PATH 与目录
4. **不代下 VS Code**：微软只给单一 CDN，实测 0.3 MB/s，塞进自动流程只会让人以为卡死
5. **PATH 有上限保护**：超过 1800 字符告警，超过 3000 字符拒绝写入（截断会连累其它软件）
6. **长路径安全**：超过 240 字符的路径自动加 `\\?\` 前缀
7. **安装前查空间**：下载与解压前分别检查目标盘剩余空间
8. **装完自检命令解析**：装完会按真实 PATH 顺序解析一次（不是跑 `where`，因为它读的是进程旧环境），
   如果命令指向别处（典型：微软商店的 python 占位程序），自动把自己的目录提到最前；改不了就明确告知原因
9. **下载源可信**：数字签名 → 哈希（发布方/内置基线/本机记录）→ 多镜像内容比对，三层校验，任一层不过就中止

---

## 打包与签名

签名方案、私钥位置、风险与撤销流程见 **[SECURITY.md](SECURITY.md)**。

```bash
npm run cert:dev                # 生成证书（私钥不可导出，不产生 pfx）
npm run cert:trust -- -Force    # 装进当前用户信任库
npm run dist                    # 打包（不签名）
npm run sign:artifacts          # 给 dist 下的 exe 补签名，并重算 latest.yml
npm run cert:verify             # 检查签名状态
npm run security:audit          # 安全自查
```

### 为什么打包和签名是两步

electron-builder 在**没配置时间戳服务器**时会硬编码回退到 `timestamp.digicert.com`，
而这个域名在国内基本连不通，结果是整个打包在最后一步失败，报错只有一句
`SignerSign() failed (-2146885598)`，很难查。

所以拆成两步：

- `npm run dist` 只打包，输出未签名 exe
- `npm run sign:artifacts` 用 `signtool` 逐个补签名，然后按**签名后**的文件重算 `latest.yml`

`npm run build:signed` 仍然可用（会在打包时一并签名），但它默认**不盖时间戳**——
自签证书本来就不被 Windows 信任，时间戳收益很小。要用真实时间戳：

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-signed.ps1 -TimestampUrl http://timestamp.digicert.com
```

> 换正式证书发布时，务必配上能连通的 RFC3161 服务器，否则签名在证书过期后失效。

### 供应链校验

```bash
npm run verify:sources            # 巡检各下载源内容是否一致
npm run verify:sources -- --full  # 完整比对
npm run checksums:refresh         # 刷新内置哈希基线
```

没有证书时 `npm run dist` 出的是未签名包，**SmartScreen 会拦截**——只用于本地测试。

---

## 开发用命令行开关

| 开关 | 作用 |
|---|---|
| `--screenshot=<路径>` | 渲染完成后截图并退出 |
| `--splash-shot=<路径>` | 只截启动画面 |
| `--splash-quote=<n>` | 固定显示第 n 句启动语 |
| `--detached=<栏目>` | 以独立窗口启动（`hw`/`scenarios`/`plan`/`support`/`diag`） |
| `--show-software` / `--show-advanced` / `--show-tutorial` | 启动时直接打开对应弹层 |
| `--demo=<场景>` | 自动勾选方向，如 `--demo=ai,cpp` |
| `--demo-lock=<文件>` | 启动时载入环境锁并比对 |
| `--shot-scroll=<选择器>` | 截图前把该元素滚到可视区 |
| `--no-tutorial` | 跳过新手引导 |
| `--debug-renderer` | 打印独立窗口的渲染进程日志 |

---

## 界面语言

默认英语，右上角下拉可切换 **中文 / 日本語 / 한국어 / Русский / Français**。

- 词典在 `src/i18n/*.json`，**中文原文即 key**（gettext 风格），不用维护一套 key 表
- 带变量的句子用 `{占位符}` 模板，语序可随语言调整：
  `T('共 {n} 项 · 约 {size} · 预计 {min} 分钟', { n: 5, size: '2.7 GB', min: 17 })`
- 没进词典的文案会原样显示中文，不会报错或留空

```bash
npm run i18n:check      # 检查六种语言的键是否对齐
npm run i18n:extract    # 从源码重新抽取待翻文案
```

## 目录结构

```
src/
├── main/
│   ├── main.js        主进程：窗口、IPC、更新、签名相关
│   └── preload.js     预加载：唯一暴露给渲染进程的接口
├── core/
│   ├── hardware.js    硬件探测（CIM / 注册表）
│   ├── permission.js  权限模型（4 种状态）
│   ├── recommend.js   规则引擎：硬约束过滤 + 加权排序
│   ├── installer.js   安装编排：6 种通道 + 回滚
│   ├── net.js         下载器：镜像测速 / 续传 / 校验
│   ├── http.js        代理感知的 fetch 适配层
│   ├── archive.js     解压（tar / 7zsfx，长路径安全）
│   ├── fsutil.js      长路径与磁盘空间
│   ├── paths.js       用户 PATH 管理（含长度保护）
│   ├── state.js       已装组件注册表
│   ├── migrate.js     迁移与状态报告
│   ├── uninstall.js   卸载
│   ├── apps.js        软件库（直装）
│   ├── lockfile.js    环境锁
│   ├── logger.js      日志
│   ├── logparse.js    日志解析
│   └── sources.json   各组件的下载源定义
├── data/
│   ├── components.json  组件清单（含可选版本）
│   ├── scenarios.json   场景定义
│   └── releases.json    内置版本兜底清单
└── renderer/
    ├── index.html / app.js / styles.css
    └── splash.html / splash.js / splash-quotes.js

tools/
├── make-dev-cert.ps1    生成签名证书
├── trust-dev-cert.ps1   安装/卸载信任
├── build-signed.ps1     证书库签名打包
├── verify-sign.ps1      检查签名
├── security-audit.ps1   安全自查
└── build-releases.js    刷新内置版本清单
```

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **Python 多版本** | 每个版本装在独立目录（`python\3.12`、`python\3.11`），互不覆盖；`python` 命令指向 PATH 里最靠前的那个，可在诊断窗口一键切换默认 |
| **不支持项目级环境隔离** | 一个全局默认环境，项目专用依赖请自行建 venv |
| **不锁 pip / npm 包** | 环境锁只管工具链，库的版本归 `requirements.txt` / `package-lock.json` |
| **不支持离线安装** | 需要联网；内网环境暂无离线包 |
| **自签名证书** | 只适合内部分发；公开发布必须换 OV/EV 证书，详见 SECURITY.md |
| **自动更新地址** | `publish.url` 目前是占位符，未配置真实托管 |

---

## 踩过的坑

都是实际踩到并已在代码里处理的，记下来避免重复：

**下载**
- 直连 GitHub 能通但只有 10 KB/s，所以必须**先并发测速再选源**，不能"能通就用"
- 镜像会"连上但一个字节不发"，必须做 **60 秒停滞检测**，否则整条流程无声挂死
- 服务器不支持 Range 时返回 200，此时必须丢弃 `.part` 从头来

**解压**
- `tar.exe` 比 `Expand-Archive` 快一个数量级，且系统自带
- 7z 自解压包的落地路径依赖包内结构，必须先解到临时目录再搬
- 路径超过 260 字符不加 `\\?\` 会 ENOENT

**PATH**
- 长度过长会被 Windows 截断，而且**先坏的是别人家的软件**，用户想不到是装环境导致的
- 写入前要按大小写不敏感去重，否则同一目录能占两份长度

**Python**
- `uv python install --default` 会把 `python.exe` 指向新装版本，这是静默行为，必须提示用户

**签名**
- electron-builder 26 把 `rfc3161TimeStampServer` 移到了 `win.signtoolOptions` 下，放错层直接 schema 校验失败
- PowerShell 5.1 读无 BOM 的 UTF-8 脚本会乱码，乱码里的字节会破坏引号配对 → 所有 `.ps1` 必须带 BOM

**界面**
- 长面板截图时 `scrollIntoView` 对"本身就是滚动容器"的元素无效，要显式设 `scrollTop`
- 诊断统计目录体积，串行遍历 6.6 GB 要 3.5 秒；改成按目录批次并发后 660 ms

---

## 许可证

[MIT](LICENSE)
