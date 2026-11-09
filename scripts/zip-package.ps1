param([Parameter(Mandatory=$true)][string]$PackagePath,[Parameter(Mandatory=$true)][string]$ZipPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$root = (Get-Item -LiteralPath $PackagePath).FullName.TrimEnd('\')
$topLevel = if (Test-Path -LiteralPath (Join-Path $root 'runtime/browser/chrome.exe') -PathType Leaf) { 'BJC' } else { 'BJM' }
$extension = [IO.Path]::GetExtension($ZipPath)
if (-not $extension) {
    $ZipPath += '.zip'
} elseif ($extension -ne '.zip') {
    throw 'ZipPath must have a .zip extension.'
}
$destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ZipPath)
# Keep the versioned ZIP filename independent of its short internal installation directory.
$archive = [IO.Compression.ZipFile]::Open($destination, [IO.Compression.ZipArchiveMode]::Create)
try {
    [void]$archive.CreateEntry("$topLevel/")
    foreach ($item in Get-ChildItem -LiteralPath $root -Recurse) {
        $relative = $item.FullName.Substring($root.Length + 1).Replace('\', '/')
        if ($item.PSIsContainer) {
            [void]$archive.CreateEntry("$topLevel/$relative/")
        } else {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $item.FullName, "$topLevel/$relative", [IO.Compression.CompressionLevel]::Optimal)
        }
    }
} finally {
    $archive.Dispose()
}
