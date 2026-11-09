# 从源码构建 Boss Jobmate 职伴 v0.5.2

普通用户请使用 [Releases](https://github.com/Muhah99/boss-jobmate/releases) 中的 Windows 便携包。本文面向需要修改程序和自行构建的开发者。

## 源码和安装包的区别

公开源码包括应用代码、前端源码、启动与打包脚本、必要资源、两份 npm 锁文件及许可说明。源码不附 Node、PowerShell、Python、Chromium 的完整运行目录，也不附 node_modules、前端构建产物、生成的 EXE 或用户数据。

便携包是在源码构建结果上加入运行组件；下载源码压缩包后不能直接双击运行。

根目录 [README.md](README.md) 是随包使用说明；仓库展示页位于 [.github/README.md](.github/README.md)，独立维护，不覆盖随包说明。

## 环境与固定输入

在全新的 Windows x64 工作目录准备源码。开发构建使用 Node **24.19.0**、npm **11.17.0** 和 Windows .NET Framework x64 C# 编译器。下载依赖需要网络。

| 输入 | 版本与准备位置 |
| --- | --- |
| npm 依赖 | 根目录及 web/ 各自的 package-lock.json，通过 npm ci 安装 |
| Node | 24.19.0，runtime/node/node.exe |
| PowerShell | 7.6.9，完整发行 ZIP 解到 runtime/powershell/ |
| Python / pypdf | 3.13.7 / 6.19.0，由 scripts/prepare-python.ps1 准备 |
| 可选 Chromium | 158.0.8111.0，Windows x64 快照 1721610，runtime/browser/ |

具体固定来源记录于 [distribution.json](runtime/distribution.json)、[powershell-manifest.json](runtime/powershell-manifest.json) 和 [python-manifest.json](runtime/python-manifest.json)。保留所有组件随附许可。

以下命令沿用 v0.5.1 已验证的构建输入与步骤，版本号更新为 v0.5.2。v0.5.2 的定向验证重点是压缩脚本、双包解压及隔离启动，没有重新执行 v0.5.1 全部从源准备验证；具体范围见文末。

## 1. 安装应用依赖并构建前端

先安装上述 Node/npm 开发工具，执行：

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd --prefix web ci --no-audit --no-fund
npm.cmd run build
```

v0.5.1 开发记录中，两份锁文件分别安装 93 和 66 个包，Vite 7.3.7 构建了 1653 个模块，产物位于 web/dist/。此次 npm 提示 esbuild 的 postinstall 尚待策略许可，但实际前端构建通过锁文件安装的 Windows x64 可选二进制完成。

## 2. 准备随包运行组件

### Node 与 PowerShell

```powershell
$root = (Get-Location).Path
$cache = Join-Path $root 'runtime/packages'
New-Item -ItemType Directory -Force -Path "$root/runtime/node", $cache | Out-Null

Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.19.0/win-x64/node.exe' -OutFile "$root/runtime/node/node.exe"
& "$root/runtime/node/node.exe" --version
& "$root/runtime/node/node.exe" "$root/scripts/prepare-node-license.mjs"

$psManifest = Get-Content -LiteralPath "$root/runtime/powershell-manifest.json" -Raw | ConvertFrom-Json
$psZip = Join-Path $cache 'PowerShell-7.6.9-win-x64.zip'
Invoke-WebRequest -Uri $psManifest.download -OutFile $psZip
Expand-Archive -LiteralPath $psZip -DestinationPath "$root/runtime/powershell"
& "$root/runtime/powershell/pwsh.exe" -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
```

Node 许可脚本从固定版本的官方仓库取得许可，输出 runtime/licenses/NODE-LICENSE.txt。PowerShell 使用完整官方 ZIP，保留 LICENSE.txt、ThirdPartyNotices.txt 和运行组件，不需要全局安装或修改 PATH。

### Python 与 pypdf

```powershell
$pythonManifest = Get-Content -LiteralPath "$root/runtime/python-manifest.json" -Raw | ConvertFrom-Json
Invoke-WebRequest -Uri $pythonManifest.python_url -OutFile "$cache/python-3.13.7-embed-amd64.zip"
Invoke-WebRequest -Uri $pythonManifest.pypdf_url -OutFile "$cache/pypdf-6.19.0-wheel.zip"
& "$root/runtime/powershell/pwsh.exe" -NoProfile -File "$root/scripts/prepare-python.ps1"
```

脚本解压 Python、安装 wheel、设置本地模块路径并写入许可和清单。输出位于 runtime/python/ 和 runtime/licenses/；准备时的自查不生成 Python 字节码缓存。

## 3. 编译 Windows 启动器

```powershell
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll "/win32icon:$root\build\boss-jobmate.ico" "/out:$root\boss-jobmate.exe" "$root\scripts\Launcher.cs"
```

该命令使用绝对路径。开发构建生成的 EXE 产品版本为 0.5.2，文件及程序集版本为 0.5.2.128。

## 4. 先组装不含浏览器版

此时源码工作目录中应没有 runtime/browser/。在与源码并列的全新输出目录组包，不使用已经运行并带有个人数据的安装目录作为输入。

```powershell
$output = Join-Path (Split-Path $root -Parent) 'boss-jobmate-build-v0.5.2'
New-Item -ItemType Directory -Path $output | Out-Null
$without = Join-Path $output 'boss-jobmate-v0.5.2-without-chromium'
& "$root/runtime/node/node.exe" "$root/scripts/package-windows.mjs" --directory-only --output $without
& "$root/runtime/powershell/pwsh.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "$root/scripts/zip-package.ps1" -PackagePath $without -ZipPath "$without.zip"
```

打包脚本复制应用、依赖、运行组件和根 README，排除 runtime/packages/ 下载缓存，不复制 data/。压缩脚本根据包内是否存在 runtime/browser/chrome.exe，将 ZIP 内顶层目录设为含版 BJC/ 或不含版 BJM/，不取组装目录的长名称；ZIP 文件名仍包含版本号。输出目录必须尚不存在。命令中的 Bypass 仅作用于该 PowerShell 进程。

## 5. 可选：准备 Chromium 并组装含浏览器版

本次含浏览器版的构建还依赖已发布的 [v0.5 投递文案更新含浏览器包](https://github.com/Muhah99/boss-jobmate/releases/download/v0.5-delivery-wording-dev2/boss-jobmate-v0.5-delivery-wording-dev2-with-chromium.zip)。该旧包仅用于取得浏览器文件清单和随附许可、来源材料，不用它覆盖应用源码或代替应用构建。

实际准备过程如下：

1. 下载 distribution.json 中固定的[官方 Chromium 归档](https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/1721610/chrome-win.zip)，解压至单独的临时目录。
2. 将上述旧发行包解压至另一个临时目录，不运行它。
3. 对照旧包 runtime/browser/ 的文件相对路径，排除顶层 LICENSE 和 licenses/ 子目录，从官方归档 chrome-win/ 中复制对应的 256 个文件到源码工作目录 runtime/browser/，保持路径。不要把官方归档中的额外测试或安装工具一起复制。
4. 从旧包复制 runtime/browser/LICENSE 以及 runtime/browser/licenses/，共 460 份许可、组件来源及再分发材料，保留原路径。

官方浏览器归档未附本项目分发所需的整套许可与来源索引，因此当前含浏览器版不能仅靠官方浏览器 ZIP 完成准备。开发核对了上述 256 个官方文件与旧包对应文件的字节一致性；本项目未重新编译 Chromium。该浏览器属于开发快照。

浏览器准备完毕后，执行：

```powershell
$with = Join-Path $output 'boss-jobmate-v0.5.2-with-chromium'
& "$root/runtime/node/node.exe" "$root/scripts/package-windows.mjs" --directory-only --output $with
& "$root/runtime/powershell/pwsh.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "$root/scripts/zip-package.ps1" -PackagePath $with -ZipPath "$with.zip"
```

两包应使用同一套应用源码及版本。组包脚本会写入生成时间，因此自行重建的 ZIP 不承诺与发布 ZIP 逐字节相同。浏览器对应源码、第三方权利及重新构建路径见根 [README.md](README.md#chromium-版本版权与对应源码) 和含浏览器包内 runtime/browser/licenses/。

## 验证范围

v0.5.2 保留 v0.5.1 的 137 个维护文件路径，127 个文件逐字不变；10 个更新涉及压缩脚本、版本和发行说明。依赖、SDK 示例、PowerShell 资源、第三方许可及前端产物保持原字节。两个 ZIP 分别包含 4,913（含浏览器）和 4,197（不含浏览器）个文件；共用内容一致。

独立验收使用 Windows PowerShell 5.1 的 Expand-Archive，在全新的 65 和 125 字符父目录分别完整解压两规格，共四次；解压文件与实际 ZIP 逐文件、逐字节一致。125 字符父目录下，最长文件路径为 258，最长目录为 216；两规格最长包内文件路径均为 132。

两个深目录隔离副本通过原 start、首页及初始化页、静态资源、空白 state、HTTP／MCP 0.5.2 和原 stop 核验，测试进程与监听均已结束。正式 ZIP 与已验件逐字节一致，正式解压根无 data/，正式 EXE 未运行。

运行组件准备与从源码构建基础沿用 v0.5.1 的独立证据：双锁安装、前端与 Launcher 编译、Node 许可与 Python 准备、不含版组包均已验证。该轮复用了官方 npm 缓存和固定下载件，未重复下载全部大组件；本轮不将历史验证说成重新执行。

Explorer 实屏、外部用户电脑、其他路径长度、浏览器交互和真实业务未验。缩短包内目录改善兼容性，不保证任意深目录都可解压。公开源码不附内部开发测试套件。
