param([Parameter(Mandatory=$true)][string]$PackagePath,[Parameter(Mandatory=$true)][string]$ZipPath)
$ErrorActionPreference = 'Stop'
Compress-Archive -LiteralPath $PackagePath -DestinationPath $ZipPath -CompressionLevel Optimal
