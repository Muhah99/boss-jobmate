Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$picker = [Windows.Forms.OpenFileDialog]::new()
$picker.Title = '选择 Codex CLI 可执行程序'
$picker.Filter = 'Codex 程序 (*.exe)|*.exe'
if ($picker.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) {
    @{ path = $picker.FileName } | ConvertTo-Json -Compress
} else { 'null' }
$picker.Dispose()
