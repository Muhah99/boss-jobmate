param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot=Join-Path $projectRoot 'runtime'
$packageRoot=Join-Path $runtimeRoot 'packages'
$pythonRoot=Join-Path $runtimeRoot 'python'
$siteRoot=Join-Path $pythonRoot 'Lib/site-packages'
$pythonVersion='3.13.7'
$pypdfVersion='6.19.0'
$pythonUrl='https://www.python.org/ftp/python/3.13.7/python-3.13.7-embed-amd64.zip'
$pypdfUrl='https://files.pythonhosted.org/packages/3c/2c/c43c03eaf630435f023f1dc61ec4a4a78951ad5530a62c71cc89bde307b7/pypdf-6.19.0-py3-none-any.whl'
New-Item -ItemType Directory -Force -Path $packageRoot,$pythonRoot,$siteRoot|Out-Null
$pythonZip=Join-Path $packageRoot 'python-3.13.7-embed-amd64.zip'
$pypdfZip=Join-Path $packageRoot 'pypdf-6.19.0-wheel.zip'
if(-not(Test-Path -LiteralPath $pythonZip)){Invoke-WebRequest -Uri $pythonUrl -OutFile $pythonZip -UseBasicParsing}
if(-not(Test-Path -LiteralPath $pypdfZip)){Invoke-WebRequest -Uri $pypdfUrl -OutFile $pypdfZip -UseBasicParsing}
Expand-Archive -LiteralPath $pythonZip -DestinationPath $pythonRoot -Force
Expand-Archive -LiteralPath $pypdfZip -DestinationPath $siteRoot -Force
# The private runtime imports only its own library and wheel directory.
[IO.File]::WriteAllText((Join-Path $pythonRoot 'python313._pth'),"python313.zip`n.`nLib/site-packages`nimport site`n",[Text.UTF8Encoding]::new($false))
$python=Join-Path $pythonRoot 'python.exe'
& $python -I -B -c 'import json,sys,pypdf; print(json.dumps(dict(python=sys.version.split()[0],pypdf=pypdf.__version__,executable=sys.executable,library=pypdf.__file__)))'
if($LASTEXITCODE -ne 0){throw '包内 Python / pypdf 检查失败。'}
$licenseRoot=Join-Path $runtimeRoot 'licenses'
New-Item -ItemType Directory -Force -Path $licenseRoot|Out-Null
Copy-Item -LiteralPath (Join-Path $pythonRoot 'LICENSE.txt') -Destination (Join-Path $licenseRoot 'Python-3.13.7-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $siteRoot 'pypdf-6.19.0.dist-info/licenses/LICENSE') -Destination (Join-Path $licenseRoot 'pypdf-6.19.0-LICENSE.txt')
$manifest=@{python_version=$pythonVersion;python_url=$pythonUrl;pypdf_version=$pypdfVersion;pypdf_url=$pypdfUrl;architecture='windows-x64';licenses=@('licenses/Python-3.13.7-LICENSE.txt','licenses/pypdf-6.19.0-LICENSE.txt')}
[IO.File]::WriteAllText((Join-Path $runtimeRoot 'python-manifest.json'),($manifest|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
Write-Output '独立 PDF 运行时准备完成。发行包包含 runtime/python 和 runtime/licenses，不需要系统 Python。'
