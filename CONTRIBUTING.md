# 参与贡献

感谢你愿意花时间。这个项目主要面向 Windows，用 Electron + 原生 JS 写成，没有前端框架。

---

## 开发环境

需要 **Node.js 18+**（开发和打包都用它）和 **Windows 10/11**。

```powershell
git clone https://github.com/MintAct-Studio/Programming-Environment-Configurator.git
cd Programming-Environment-Configurator
npm install
npm start
```

国内网络建议先设置镜像，否则下载 Electron 会很慢：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
```

---

## 项目结构

```
src/
├── main/          主进程：窗口、IPC、更新、开屏
│   ├── main.js
│   └── preload.js 唯一暴露给渲染进程的接口（contextIsolation 开着）
├── core/          纯逻辑，不依赖 electron，可单独 node 运行
│   ├── hardware.js    硬件探测（CIM / 注册表）
│   ├── recommend.js   规则引擎：硬约束过滤 + 加权排序
│   ├── installer.js   安装编排：各通道 + 回滚
│   ├── net.js        下载器：镜像测速 / 续传 / 校验
│   ├── drive.js      默认安装目录探测
│   ├── paths.js      PATH 读写、长度保护、命令解析
│   ├── verify.js     Authenticode + 哈希基线
│   └── …
├── renderer/      界面（原生 DOM，无框架）
│   ├── app.js     所有交互逻辑
│   ├── i18n.js    运行时翻译
│   └── index.html
├── i18n/          六种语言词典，中文原文即 key
└── data/          组件清单、场景、哈希基线
```

**改 core 里的东西时请注意**：这些模块不 `require('electron')`，这样它们能被单元测试直接调用。

---

## 修改界面文案（多语言）

文案的中文原文就是词典的 key。改文案时三步：

1. 直接改源码里的中文（`app.js` 或 `*.html`）
2. 抽出待翻条目：
   ```powershell
   npm run i18n:extract
   ```
3. 在各语言 JSON 里补上译文，然后校验键是否对齐：
   ```powershell
   npm run i18n:check
   ```

带变量的句子用 `{占位符}`，语序可以随语言调整：

```js
T('共 {n} 项 · 约 {size} · 预计 {min} 分钟', { n: 5, size: '2.7 GB', min: 17 })
```

**没有翻译的条目会回退到英语，再回退到中文**，所以只提交中文不会被拦住，但 `i18n:check` 会提示差异。

---

## 调试用命令行开关

```powershell
npm start -- --demo=ai --no-tutorial          # 自动勾选方向，跳过教程
npm start -- --screenshot=out.png             # 渲染完截图并退出
npm start -- --detached=diag                  # 以独立窗口打开诊断
npm start -- --dump-text=left.json            # 导出界面上仍是中文的文本（查翻译覆盖率）
```

完整列表见 README。

---

## 提交前请自检

```powershell
npm run i18n:check       # 六种语言键是否对齐
node --check src/renderer/app.js   # 语法
npm start                # 至少手动跑一遍主流程
```

如果改了 `tools/*.ps1`，**务必确认文件带 UTF-8 BOM**：

```powershell
$bytes = [IO.File]::ReadAllBytes('tools\xxx.ps1')[0..2]
"$($bytes[0].ToString('X2'))$($bytes[1].ToString('X2'))$($bytes[2].ToString('X2'))"   # 应为 EFBBBF
```

PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，中文注释会让整个脚本语法错误。

---

## 提交信息

用 `type: 说明` 的格式，中文即可：

```
feat: 支持选择 Node 22
fix: 卸载后 PATH 残留空目录
docs: 补打包说明
refactor: 把镜像测速拆到 net.js
```

---

## 提 PR 之前

- [ ] 一个 PR 只做一件事，不要混入无关的重新格式化
- [ ] 改了用户可见文案 → 跑过 `npm run i18n:check`
- [ ] 改了 `.ps1` → 确认 BOM 还在
- [ ] 新增依赖请说明理由（这个项目刻意保持很少的依赖）

---

## 安全相关

**不要**在 issue 或 PR 里贴私钥、证书密码、token。签名方案见 [SECURITY.md](SECURITY.md)。

如果你发现了安全问题，请走 SECURITY.md 里的流程，不要开公开 issue。
