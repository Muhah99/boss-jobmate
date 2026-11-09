# Boss Jobmate 职伴 v0.5.1

Windows x64 便携应用。可筛选岗位、准备投递、审阅消息，并在确认后执行实际投递。含 Chromium 版附带浏览器，不含 Chromium 版使用系统默认浏览器打开应用首页，BOSS 操作使用本机已安装的 Chrome。

## 双击打开

完整解压整个文件夹到可写目录，然后双击根目录 **boss-jobmate.exe**。无需打开命令行、填写端口或输入网址。软件监听本机127.0.0.1，由操作系统自动分配可用端口；启动就绪后自动打开本目录实际页面。同目录已运行时，重复双击打开原实例。

端口可能随重启变化，请用图标打开，不要把旧固定网址或上次地址当作启动入口。关闭网页不会停止后台。不同解压目录各有自己的程序、data目录及实际地址。

保留open.ps1、start.ps1、stop.ps1供排查。停止本包后台：

```powershell
.\runtime\node\node.exe .\runtime\launch.mjs stop
```

Bypass仅用于该进程，不改变系统执行策略。停止只针对本目录的后台，不会停止其他安装。移动文件夹前先停止本包后台，再移动整个文件夹并双击图标。启动失败会显示中文错误，可查看本目录data/logs/web-error.log。过长的解压路径会提示移到较短目录。

## 数据和依赖

内置浏览器通常直接使用runtime/browser。若当前用户能读包和写data，但无法为原browser目录补足沙箱读取权限，程序仅将本包浏览器资源自动准备到本安装的data/browser-runtime，首页与BOSS启动共同使用准备后的路径；无需移动整个软件或以管理员启动，不关闭沙箱。已具备必要权限时不重复写权限；准备副本随本安装移动/复制，不使用其他安装的绝对路径。该目录只含可再生成的浏览器资源及源文件大小/时间元信息，不迁移两个专用profile、登录或业务库；相同资源重复打开复用，原包资源版本变化后重新准备。关闭该安装浏览器后可删除该资源副本，下次需要时会重新生成；原runtime/browser及其许可须保留。清空data也会清掉这份可再生成资源，不影响程序从原包重新准备。首次自动准备会额外占用一份包内浏览器资源所需空间。准备失败会保留阶段/底层错误，不会报告浏览器已就绪。

首次运行为空白初始化，不含个人资料、PDF、密钥、Chrome登录或CLI授权。业务和用户数据统一保存在**解压目录data/**：SQLite/设置/API密钥、PDF、个人介绍/事实、任务/投递安排/消息、日志、运行地址及进度/恢复记录；应用临时文件在data/temp/。CLI的CODEX_HOME为data/cli-home/，工作目录为data/agent-workspace/；BOSS专用浏览器资料在data/chrome-profile/，软件页面的内置浏览器资料在data/app-browser-profile/；两者分离，仍全部位于data。清理所有数据会关闭本安装这两类浏览器并清空资料；若原软件页面也被关闭，清空后自动重开本安装初始化页面。备份先停止后台，再保存整个data目录。

应用页面使用相对接口地址，业务资料由本目录数据库保存，不依赖某一端口下的浏览器本地存储。BOSS登录仍使用本目录专用Chrome资料。重启后使用图标打开新地址；原地址的旧标签不会自动迁移。

包内自带Node24和Python3.13.7/pypdf6.19.0及依赖。需要Windows x64、自带.NET Framework4.x、系统Windows PowerShell5.1或包内PowerShell7及所需桌面组件。软件优先使用完整的runtime/browser/内置Chromium，其次检测系统已安装Chrome；两者均不可用时，在系统配置下载安装Chrome并重新检测。含浏览器/不含浏览器两包使用同一套程序，没有运行模式开关。无内置时，软件首页仍由系统默认浏览器打开，允许通过Edge等进入修复页面；BOSS操控只支持内置Chromium或已安装Chrome。选择CLI路线需要自行安装兼容Codex CLI，并按本包CODEX_HOME环境登录。DeepSeek路线仍由用户配置凭据和网络。跨机器登录状态可用性未验，可能需要重新安装程序或登录。

MCP连接使用包内runtime/node/node.exe及runtime/mcp.mjs的绝对路径。先双击图标或使用start.ps1启动本目录后台，MCP会读取本目录data/run/web.json的实际端口并核对安装身份，无需配置固定端口。移动包后应更新外部MCP配置的文件绝对路径。

应用业务及用户数据在data内，不代表系统盘零写入。Windows、PowerShell、浏览器及CLI仍可能使用系统临时目录、缓存和日志；Python模块缓存可能在包内runtime/python。未为系统临时文件额外改造。

## 使用前须知

首次打开需完成初始化。BOSS 操作需在本应用的专用浏览器中登录，遇到验证时按页面提示处理。模型使用已配置的 DeepSeek 或 Codex CLI，通勤计算需要相应地图服务配置。实际发送须在应用中确认。筛选阶段从一页详情就绪到下一页导航以 5–10 秒为目标，必要处理超出目标时直接继续，实际耗时由页面和运行环境决定。

本项目许可与个人求职补充授权见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。第三方组件按各自条款分发。

## 每日使用统计

打开任意页面时，同一data目录按北京时间每天最多尝试上报一次使用事件；云端仅按来源IP/日期计数，不上传业务内容、账号、密钥或设备标识。失败当天不重试，可能漏计；PV为上报次数，UV为独立公网IP数，不代表精确人数。复制或清空data会失去去重历史。关闭网页不取消后台任务。

浏览器安装自动检测仅在实际显示初始化第一步时启用。可手动重新检测，业务入口仍执行必要检查。系统配置显示当前来源，确认缺失时提供官网下载，保留重新检测；岗位任务页仅在确认缺失时提供修复入口。检测本身失败沿现有错误提示显示，不据此判断未安装或引导下载。含浏览器版的内置程序为官方开发快照Chromium 158.0.8111.0（Win64构建1721610），不称稳定版。浏览器更新由用户决定。

## 浏览器版权与源码取得

本文件所列包内路径均相对于软件解压根目录。

含浏览器形态保留 `runtime/browser/LICENSE` 和 `runtime/browser/licenses/`：第三方声明TXT/HTML、451份正文、801条组件来源记录，以及Microsoft SDK原始RTF/REDIST。固定浏览器、LGPL/MPL对应源码、依赖与官方Windows构建路径详见`runtime/browser/licenses/SOURCE-ACCESS.md`、`runtime/browser/licenses/SOURCE-REQUIREMENTS.csv` 和根目录“开源说明.txt”。无浏览器形态不附浏览器文件及其专属声明；Node/Python/应用依赖许可继续保留。

接收者按各组件原许可证取得、修改和使用其源码。FFmpeg在该固定Windows快照中静态进入chrome.dll，修改后须按对应Chromium源码/依赖和官方构建说明重新组合，而非替换一份ffmpeg.dll。未限制许可证允许的库修改、调试或重新链接，未将整个应用统一归为LGPL，也未声称已经实测重编该快照。附带D3DCompiler_47.dll仅按Microsoft SDK许可允许的Windows应用范围使用/再分发，其版权、免责及完整条款见 `runtime/browser/licenses/microsoft/` 和 `runtime/browser/licenses/licenses/L0451.txt`；第三方权利不受本应用说明缩减。

## Chromium 版本、版权与对应源码

含浏览器便携包使用未修改的官方 Chromium **158.0.8111.0 / Windows x64 / snapshot 1721610**，属于开发快照。另提供不含浏览器包；程序优先使用包内可用 Chromium，否则检测系统 Chrome。两包使用同一套应用。

- [固定浏览器下载](https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/1721610/chrome-win.zip)、[该构建 REVISIONS](https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/1721610/REVISIONS)。普通使用请下载本项目发布的完整便携包；官方原归档含未随本应用分发的测试/安装工具。
- [固定 Chromium 源码 74eb2202cbe994c6ab816eed1874954d0d84ed5b](https://chromium.googlesource.com/chromium/src/+/74eb2202cbe994c6ab816eed1874954d0d84ed5b/)、[固定 DEPS（第三方依赖仓库及版本）](https://chromium.googlesource.com/chromium/src/+/74eb2202cbe994c6ab816eed1874954d0d84ed5b/DEPS)。源码目录可逐文件取得，或使用对应仓库的 Git 版本记录取得；嵌套依赖继续按各自固定 DEPS 取得。
- [同提交 Windows 官方构建说明](https://chromium.googlesource.com/chromium/src/+/74eb2202cbe994c6ab816eed1874954d0d84ed5b/docs/windows_build_instructions.md)、[该快照 Windows builder 参数](https://chromium.googlesource.com/chromium/src/+/74eb2202cbe994c6ab816eed1874954d0d84ed5b/infra/config/generated/builders/ci/win-archive-rel/gn-args.json)。构建 Chromium 而非 Google Chrome，使用 REVISIONS/DEPS 对应版本；依照官方工具链和构建说明重新构建所需目标。

**LGPL 对应部分与修改/重新链接路径：** FFmpeg 使用 [Chromium 固定分支 42a2a7a2b2ceb0b1554af1e99a8cdaae189404bb](https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/42a2a7a2b2ceb0b1554af1e99a8cdaae189404bb/)，保留其 Chromium 修改、配置和构建文件；[Blink 固定源码](https://chromium.googlesource.com/chromium/src/+/74eb2202cbe994c6ab816eed1874954d0d84ed5b/third_party/blink/)包含其文件级 LGPL 部分。此 Windows 快照将 FFmpeg 静态合入 chrome.dll，并非替换一份 ffmpeg.dll 即可。要修改适用库并重新组合浏览器，取得上述固定 Chromium、对应依赖、库源码和构建材料，按官方 Windows 说明及 builder 参数修改并构建 Chromium。没有将整个 Blink 或整个应用统一改为 LGPL；每份文件按保留的上游授权适用。本项目未修改浏览器二进制，不限制接收者对 LGPL 组件进行其许可证允许的修改、调试或重新链接；未声称已经实测重新编译该快照。

**MPL 对应源码：** [Hunspell（含 Chromium 本地修改）](https://chromium.googlesource.com/chromium/src/+/74eb2202cbe994c6ab816eed1874954d0d84ed5b/third_party/hunspell/)、[Symphonia 固定 Rust 源码及其他 vendored crates](https://chromium.googlesource.com/chromium/src/+/74eb2202cbe994c6ab816eed1874954d0d84ed5b/third_party/rust/chromium_crates_io/vendor/)、[Blink](https://chromium.googlesource.com/chromium/src/+/74eb2202cbe994c6ab816eed1874954d0d84ed5b/third_party/blink/)、[Mozilla/url_parse 固定源码](https://quiche.googlesource.com/googleurl/+/94ff147fe0b96b4cca5d6d316b9af6210c0b8051/url/third_party/mozilla/)可通过这些公开固定版本入口取得，按对应 MPL 版本保留源码权利。完整文件级/组件级来源、许可及实际/保守范围说明随含浏览器包的 `runtime/browser/licenses/SOURCE-REQUIREMENTS.csv` 与 `COMPONENTS.csv` 提供；其中 Android/ChromeOS、未分发字典或测试组件不被冒充为本 Windows 包实际附带。

其他固定依赖包括 [V8](https://chromium.googlesource.com/v8/v8/+/94bfc15fbee9b05276068d92bf585ab961c80fd1/)、[ANGLE](https://chromium.googlesource.com/angle/angle/+/b82a564646a26535ccedfa7a69134c0fd6654ac2/)、[Dawn](https://dawn.googlesource.com/dawn/+/b6bbb62f92f7298da92f79edbdf06e3ce4af225f/)、[SwiftShader](https://swiftshader.googlesource.com/SwiftShader/+/cddb5c91b23ff70a1f607ea31610aa0d7f4b5ad5/)和 [WebRTC](https://webrtc.googlesource.com/src/+/4fdd50a57b79826ea87cc5170be78b6444d9cdf9/)，其余依赖见固定 DEPS 和随包组件表。源码提供对应上游的可修改文件及其构建输入，不向普通用户要求自行编译，也不额外提供自制重新链接工具或多年书面源码承诺。

**随包声明：** 含浏览器包保留 `runtime/browser/LICENSE`、`runtime/browser/licenses/THIRD_PARTY_NOTICES.txt`（另有 HTML）、451份许可正文、801条组件来源引用，以及 `runtime/browser/licenses/microsoft/` 内的原始 SDK 条款和 REDIST。D3DCompiler_47.dll 为 Microsoft Windows SDK 再分发组件，仅用于受其许可允许的 Windows 应用，按随附微软条款使用和再分发；Dawn 的 dxcompiler.dll 依其自身保留声明适用，不能把两者混为同一个许可证。第三方软件按各自版权、免责和许可条款提供；本项目说明不替换或限制这些权利。安装包的简短“开源说明.txt”用于指向本说明及包内离线材料。

## PowerShell 运行环境

Windows x64桌面：优先系统Windows PowerShell5.1；本实例启动前检查所需组件，缺失/能力不足时选用本包runtime/powershell内官方7.6.9 LTS。EXE先调用包内Node，缺少5.1也能进入同一选择链；同实例HUD/UIA/返回网页/清理及其他现用脚本沿已选绝对路径，业务失败不自动切换或重跑。安全策略/权限明确拒绝不会改用备用绕过。运行环境不可用时停止启动并提示具体原因。

无需全局安装、改PATH或系统执行策略。包内7来源/许可见runtime/powershell-manifest.json、runtime/powershell/LICENSE.txt及ThirdPartyNotices.txt；保留完整随附组件。仅支持实测Windows x64桌面环境，不保证所有Windows、企业管控、多屏或远程桌面。EXE仍需Windows.NET Framework4.x和包内Node。
