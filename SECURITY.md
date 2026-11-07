# 代码签名与私钥安全

这份文档说明 AutoED 的签名方案、**私钥在哪里**、有哪些风险，以及怎么撤销。

---

## 零、下载源与供应链校验（比签名更贴近用户）

AutoED 会从「直连 GitHub + 国内镜像」里挑最快的下载。镜像都是第三方代理——
如果其中某个被投毒，用户装进去的就是带毒的程序。所以有三层校验：

| 层级 | 检查什么 | 不通过时 |
|---|---|---|
| **1. 数字签名** | 解压后主程序的 Authenticode 签名与发布者 | **中止安装并回滚** |
| **2. 哈希** | 发布方 `.sha256` → 内置基线 → 本机首次记录 | **中止安装并删除文件** |
| **3. 源一致性** | 同一文件从各镜像取样，比对哈希 | 巡检报告标红 |

### 数字签名（最强）

篡改者没有厂商私钥，签不出来。实测本机各组件的签名情况：

```
uv       Valid   OpenAI OpCo
git      Valid   Johannes Schindelin
cmake    Valid   Kitware
gcc      Valid   Christopher Wellons
node     Valid   OpenJS Foundation
ninja    未签名
fnm      未签名
python   未签名（上游 python-build-standalone 不签）
```

规则：
- 签名有效 → 记录发布者；**以后再出现不同发布者就中止**
- 签名哈希不匹配（文件被改过）→ 中止
- 之前有签名、这次没有 → 中止（官方不会把签名版换回未签名版）

### 哈希基线

- `src/data/checksums.json`：随程序分发，人工/工具生成的已知好哈希
- `.autoed/hashes.json`：本机首次安装时记录的哈希（TOFU）
- 刷新基线：`npm run checksums:refresh`

### 源巡检

```bash
npm run verify:sources           # 抽样比对（快，512KB）
npm run verify:sources -- --full # 完整比对（慢，最严格）
npm run verify:sources -- --only=uv
```

输出示例（真实运行）：

```
ninja  v1.13.2  ninja-win.zip  0.3 MB
  直连        07fc8261b42b20e7…  291570 字节
  ghfast      07fc8261b42b20e7…  291570 字节
  ghproxy     07fc8261b42b20e7…  291570 字节
  ✓ 所有可用源内容一致
  · 不可用：geekertao（HTTP 429）
```

有源内容不一致时退出码非零，可直接接进 CI。

---

## 一、签名方案：先看结论

| 场景 | 用什么 | 用户会看到什么 |
|---|---|---|
| 自己机器 | 自签名证书（默认方案） | 无警告 |
| 校内 / 团队内分发 | 自签名证书 + 让用户导入 `.cer` | 导入后无警告 |
| 公开发布 | **必须买 OV / EV 证书** | 无警告，且不需要用户做任何事 |

**自签名证书绝不能用于公开发布。** 它要求用户"把一张根证书装进信任库"，
而这正是恶意软件常用的手段。让陌生人做这件事，本身就是不负责任的。

---

## 二、私钥在哪里

用默认方案生成的证书：

```
证书存储：Cert:\CurrentUser\My\<指纹>
```

查看具体位置：

```powershell
Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -like '*AutoED*' } |
  Select-Object Subject, Thumbprint, NotAfter, HasPrivateKey
```

特点：

- **受 Windows DPAPI 保护**，只有当前这个 Windows 账户能使用
- **标记为不可导出**（`KeyExportPolicy NonExportable`），无法被复制成文件
- 磁盘上**没有** `.pfx`、`.snk` 之类的私钥文件

> 换句话说：想盗用这张证书，必须能登录你这台电脑的这个账户。
> 这已经把"文件泄露"这条路径堵死了。

---

## 三、风险清单与缓解

### 已消除

| 风险 | 原状 | 现状 |
|---|---|---|
| 私钥落盘可复制 | `.pfx` 在 `certs/`，密码 `autoed-dev` | **不再生成 pfx**；私钥不可导出 |
| 弱口令 | 硬编码 | 需要导出时强制 ≥16 位，拒绝常见弱口令 |
| 私钥被打进安装包 | 未验证 | 已验证：打包白名单只有 `src/ assets/ package.json` |

### 仍然存在（无法靠技术消除）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **信任库被写入** | 装根证书后，本机无条件信任这张证书签的任何程序 | 只在自己负责的机器上装；`trust-dev-cert.ps1` 不加 `-Force` 不会执行 |
| **无法吊销** | 自签名没有 CRL / OCSP | 泄露后只能逐台 `trust-dev-cert.ps1 -Remove` |
| **证书有效期 1 年** | 过期后新签名失效 | 到期前重新生成并重签 |

### 不构成风险（常见误解）

| 担心 | 实际 |
|---|---|
| 别人拿到 `.cer` 能干什么 | 什么也干不了，`.cer` 只有公钥 |
| 能不能用来伪造 HTTPS 网站 | 不能。EKU 只声明了代码签名 |
| 会不会影响同机其他 Windows 用户 | 不会。装在 `CurrentUser`，不是 `LocalMachine` |

---

## 四、日常命令

```powershell
# 生成证书（不产生 pfx，私钥不可导出）
npm run cert:dev

# 让本机信任它（不加 -Force 只显示警告）
npm run cert:trust -- -Force

# 用证书库签名打包（不读任何 pfx）
npm run build:signed

# 检查签名状态
npm run cert:verify

# 安全自查
npm run security:audit
```

---

## 五、撤销与轮换

**撤销信任**（不再相信这张证书签的程序）：

```powershell
powershell -ExecutionPolicy Bypass -File tools/trust-dev-cert.ps1 -Remove
```

**轮换证书**（怀疑泄露时）：

1. 撤销信任（同上）
2. 从个人证书库删除旧证书
3. 重新执行 `npm run cert:dev`
4. 重新 `npm run cert:trust -- -Force`
5. 重新 `npm run build:signed`，旧版本作废

已签发的旧版本会重新显示"未知发布者"，这是**期望行为**。

---

## 六、换成正式证书

购买 OV / EV 证书后，**代码一行都不用改**：

```powershell
$env:CSC_LINK = 'C:\path\to\cert.pfx'
$env:CSC_KEY_PASSWORD = '证书密码'
npm run dist
```

或者把证书装进证书存储，用 `build-signed.ps1` 指定指纹：

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-signed.ps1 -Thumbprint <指纹>
```

EV 证书通常配硬件 U 盾，签名时插入即可。

---

## 七、给分发的建议

1. **只发 `.cer`，永远不发 `.pfx`**
2. `.cer` 可以放在安装包旁边，附一句说明：
   > 这是开发者自己的签名证书。导入后 Windows 不会再提示"未知发布者"。
   > 不想导入也可以，程序照样能用，只是首次运行会有一次提示。
3. 明确告知**卸载方式**（`-Remove`），别让用户装了不知道怎么撤
4. 不要把"导入证书"写进必读步骤——它是可选项，不是前提
