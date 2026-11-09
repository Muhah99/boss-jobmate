# 从源码构建 Boss Jobmate 职伴 v0.5.1

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

以下命令在源码根目录执行，按实际构建步骤整理。独立验收复用了已从官方取得的 npm 缓存和固定运行组件下载件，未重复下载全部大组件；具体范围见文末。

## 1. 安装应用依赖并构建前端

先安装上述 Node/npm 开发工具，执行：

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd --prefix web ci --no-audit --no-fund
npm.cmd run build
```

开发记录中，两份锁文件分别安装 93 和 66 个包，Vite 7.3.7 构建了 1653 个模块，产物位于 web/dist/。此次 npm 提示 esbuild 的 postinstall 尚待策略许可，但实际前端构建通过锁文件安装的 Windows x64 可选二进制完成。

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

该命令使用绝对路径。开发构建生成的 EXE 产品版本为 0.5.1，文件及程序集版本为 0.5.1.128。

## 4. 先组装不含浏览器版

此时源码工作目录中应没有 runtime/browser/。在与源码并列的全新输出目录组包，不使用已经运行并带有个人数据的安装目录作为输入。

```powershell
$output = Join-Path (Split-Path $root -Parent) 'boss-jobmate-build-v0.5.1'
New-Item -ItemType Directory -Path $output | Out-Null
$without = Join-Path $output 'boss-jobmate-v0.5.1-without-chromium'
& "$root/runtime/node/node.exe" "$root/scripts/package-windows.mjs" --directory-only --output $without
& "$root/runtime/powershell/pwsh.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "$root/scripts/zip-package.ps1" -PackagePath $without -ZipPath "$without.zip"
```

打包脚本复制应用、依赖、运行组件和根 README，排除 runtime/packages/ 下载缓存，不复制 data/。输出目录必须尚不存在。命令中的 Bypass 仅作用于该 PowerShell 进程。

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
$with = Join-Path $output 'boss-jobmate-v0.5.1-with-chromium'
& "$root/runtime/node/node.exe" "$root/scripts/package-windows.mjs" --directory-only --output $with
& "$root/runtime/powershell/pwsh.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "$root/scripts/zip-package.ps1" -PackagePath $with -ZipPath "$with.zip"
```

两包应使用同一套应用源码及版本。组包脚本会写入生成时间，因此自行重建的 ZIP 不承诺与发布 ZIP 逐字节相同。浏览器对应源码、第三方权利及重新构建路径见根 [README.md](README.md#chromium-版本版权与对应源码) 和含浏览器包内 runtime/browser/licenses/。

## 验证范围

公开源码及双包共 42 项独立发行检查通过。独立空目录按两份原锁文件安装依赖，重新构建前端和 Launcher，执行 Node 许可与 Python 准备、原不含浏览器版组包及压缩。独立验证复用开发从官方 registry 取得的 npm 缓存，以及固定 Node、PowerShell、Python 和 pypdf 下载件；Node 许可脚本实际从官方 tag 下载。

重建前端产物与正式包逐字一致。不含版重建组包与正式包的差异限于重编 Launcher 及两份生成清单；清单除发行时间外按字段一致，不承诺可重复生成字节完全相同的 EXE 或 ZIP。

两份正式 ZIP 均重新解压并与各自正式目录逐文件核对；含版另核 256 个 Chromium 文件与固定官方归档、460 份许可／来源文件与旧发行包一致。独立复跑组包和压缩的是不含版，含版依实际成品及固定输入核验。

从不含浏览器版实际 ZIP 另解副本，通过原 start、HTTP／MCP 版本 0.5.1、空白初始化状态及原 stop 检查；测试进程和监听已结束。两正式解压根没有运行且不含 data/。

本轮未验证含浏览器版启动、原生窗口、浏览器交互、实际求职业务或跨电脑运行。公开源码不附内部开发测试套件；已移除引用缺失套件的 npm run check，不能将不存在的测试入口当作验收方法。
