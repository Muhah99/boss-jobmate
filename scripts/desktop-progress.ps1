param([Parameter(Mandatory=$true)][string]$StatusFile)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Net.Http
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobmateHudNative {
 [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr handle,int index);
 [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr handle,int index,IntPtr value);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle,int command);
 public static IntPtr NoActivate(IntPtr handle,int message,IntPtr wParam,IntPtr lParam,ref bool handled) {
  if(message==0x0021){handled=true;return new IntPtr(3);}return IntPtr.Zero;
 }
 public static long[][] InteractiveRects=new long[0][];
 public static IntPtr HitTest(IntPtr handle,int message,IntPtr wParam,IntPtr lParam,ref bool handled) {
  if(message!=0x0084)return IntPtr.Zero;
  int x=(short)(lParam.ToInt64()&0xffff),y=(short)((lParam.ToInt64()>>16)&0xffff);
  foreach(var r in InteractiveRects)if(x>=r[0]&&x<r[2]&&y>=r[1]&&y<r[3])return IntPtr.Zero;
  handled=true;return new IntPtr(-1);
 }
}
'@
function Value($object,[string]$name,$fallback='') {
 $property=$object.PSObject.Properties[$name]
 if($property -and $null -ne $property.Value){return $property.Value};return $fallback
}
$script:readFailureLogged=$false;$script:diagnosticTaskId=''
function Write-HudDiagnostic([string]$phase,$failure) {
 try {
  $logRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../data/logs'));[IO.Directory]::CreateDirectory($logRoot)|Out-Null
  $logFile=Join-Path $logRoot 'desktop-errors.jsonl';$encoding=[Text.UTF8Encoding]::new($false)
  $task=if($script:diagnosticTaskId -match '^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$'){$script:diagnosticTaskId}else{$null}
  $record=[ordered]@{created_at=[DateTimeOffset]::UtcNow.ToString('o');component='progress';operation='hud';phase=$phase;outcome='error';task_id=$task;native_code=[int]$failure.Exception.HResult}
  $line=($record|ConvertTo-Json -Compress)+[Environment]::NewLine;$bytes=$encoding.GetByteCount($line);if($bytes -gt 1048576){return}
  $size=if(Test-Path -LiteralPath $logFile){(Get-Item -LiteralPath $logFile).Length}else{0}
  if($size+$bytes -gt 1048576){[IO.File]::WriteAllText($logFile,'',$encoding)}
  [IO.File]::AppendAllText($logFile,$line,$encoding)
 }catch{[Console]::Error.WriteLine('诊断未能保存。')}
}
function Read-Status {
 try{$data=[IO.File]::ReadAllText($StatusFile,[Text.Encoding]::UTF8)|ConvertFrom-Json;$script:readFailureLogged=$false;return $data}
 catch{if(-not $script:readFailureLogged -and (Test-Path -LiteralPath (Split-Path -Parent $StatusFile))){$script:readFailureLogged=$true;Write-HudDiagnostic 'hud.read' $_};return $null}
}
function Get-InstallationAddress {
 try {
  $recordPath=Join-Path $PSScriptRoot '../data/run/web.json'
  $record=Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8|ConvertFrom-Json
  $install=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
  if($record.root -eq $install -and $record.entry -eq (Join-Path $install 'runtime/web.mjs') -and [int]$record.port -gt 0 -and [int]$record.port -le 65535){return 'http://127.0.0.1:'+[int]$record.port}
 }catch{};return ''
}
function Test-StopUrl([string]$url) {
 $address=Get-InstallationAddress
 return $address -and $url -match ('^'+[regex]::Escape($address)+'/api/(?:workflow-tasks|applications/tasks)/[A-Za-z0-9_-]+/stop$')
}
function Test-CurrentInstallation {
 $projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
 $entryPath=Join-Path $projectRoot 'runtime/web.mjs';$nodePath=Join-Path $projectRoot 'runtime/node/node.exe'
 if(-not(Test-Path -LiteralPath $nodePath)){$nodePath=(Get-Command node.exe -ErrorAction Stop).Source}
 . (Join-Path $projectRoot 'runtime/instance.ps1')
 return $null -ne (Get-JobmateInstance)
}
$area=[Windows.SystemParameters]::WorkArea
$window=[Windows.Window]::new();$window.Title='boss-jobmate 进度';$window.WindowStyle='None';$window.ResizeMode='NoResize';$window.ShowInTaskbar=$false;$window.ShowActivated=$false;$window.Topmost=$true;$window.AllowsTransparency=$true;$window.Background='Transparent';$window.SizeToContent='Height';$window.FontFamily='Microsoft YaHei UI'
$surface=[Windows.Controls.Border]::new();$surface.CornerRadius=[Windows.CornerRadius]::new(12);$surface.BorderThickness=[Windows.Thickness]::new(1);$surface.BorderBrush='#D7E3EA';$surface.Background='#FDFEFF';$surface.Padding=[Windows.Thickness]::new(12)
$stack=[Windows.Controls.StackPanel]::new();$surface.Child=$stack;$window.Content=$surface
$notice=[Windows.Controls.TextBlock]::new();$notice.FontSize=28;$notice.FontWeight='Bold';$notice.Foreground='#3B8D86';$notice.Text='自动操作中，请勿使用键盘和鼠标';$notice.TextWrapping='Wrap';$notice.Margin=[Windows.Thickness]::new(0,0,0,12);$stack.Children.Add($notice)|Out-Null
$header=[Windows.Controls.Grid]::new();$stack.Children.Add($header)|Out-Null
foreach($width in @(28,0,1)){$column=[Windows.Controls.ColumnDefinition]::new();$column.Width=if($width -eq 0){[Windows.GridLength]::Auto}elseif($width -eq 1){[Windows.GridLength]::new(1,[Windows.GridUnitType]::Star)}else{[Windows.GridLength]::new($width)};$header.ColumnDefinitions.Add($column)}
$icon=[Windows.Controls.Image]::new();$icon.Stretch='Uniform';$icon.VerticalAlignment='Center';$icon.Width=22;$icon.Height=22;$header.Children.Add($icon)|Out-Null
$title=[Windows.Controls.TextBlock]::new();$title.FontSize=15;$title.FontWeight='SemiBold';$title.Foreground='#243746';$title.VerticalAlignment='Center';$title.TextWrapping='Wrap';[Windows.Controls.Grid]::SetColumn($title,1);$header.Children.Add($title)|Out-Null
$stage=[Windows.Controls.TextBlock]::new();$stage.FontSize=13;$stage.Foreground='#647786';$stage.VerticalAlignment='Center';$stage.Margin=[Windows.Thickness]::new(10,0,0,0);$stage.TextWrapping='Wrap';[Windows.Controls.Grid]::SetColumn($stage,2);$header.Children.Add($stage)|Out-Null
$messageScroll=[Windows.Controls.ScrollViewer]::new();$messageScroll.Margin=[Windows.Thickness]::new(0,8,0,0);$messageScroll.HorizontalScrollBarVisibility='Disabled';$messageScroll.VerticalScrollBarVisibility='Disabled';$messageScroll.CanContentScroll=$false;$messageScroll.Focusable=$true;$stack.Children.Add($messageScroll)|Out-Null
$stateLine=[Windows.Controls.TextBlock]::new();$stateLine.FontSize=12;$stateLine.Foreground='#647786';$stateLine.TextWrapping='Wrap';$messageScroll.Content=$stateLine
$footer=[Windows.Controls.Grid]::new();$footer.Margin=[Windows.Thickness]::new(0,8,0,0);$stack.Children.Add($footer)|Out-Null
foreach($width in @('Auto','*')){$column=[Windows.Controls.ColumnDefinition]::new();$column.Width=[Windows.GridLengthConverter]::new().ConvertFromString($width);$footer.ColumnDefinitions.Add($column)}
$toggle=[Windows.Controls.Button]::new();$toggle.Content='展开';$toggle.Padding=[Windows.Thickness]::new(0,4,8,4);$toggle.Background='Transparent';$toggle.BorderThickness=[Windows.Thickness]::new(0);$toggle.Foreground='#347F77';$footer.Children.Add($toggle)|Out-Null
$actions=[Windows.Controls.StackPanel]::new();$actions.Orientation='Horizontal';$actions.HorizontalAlignment='Right';[Windows.Controls.Grid]::SetColumn($actions,1);$footer.Children.Add($actions)|Out-Null
$button=[Windows.Controls.Button]::new();$button.Content='返回原页面';$button.Padding=[Windows.Thickness]::new(8,4,8,4);$button.Background='#F0F8F7';$button.BorderBrush='#CBE6E2';$button.Foreground='#347F77';$actions.Children.Add($button)|Out-Null
# EyeOff geometry mirrors the existing lucide-react icon (ISC), without a text caption.
$hideButton=[Windows.Controls.Button]::new();$hideButton.ToolTip='隐藏小窗口';[Windows.Automation.AutomationProperties]::SetName($hideButton,'隐藏小窗口');$hideButton.Width=28;$hideButton.Height=28;$hideButton.HorizontalAlignment='Right';$hideButton.Margin=[Windows.Thickness]::new(0,0,0,6);$hideButton.Background='Transparent';$hideButton.BorderThickness=[Windows.Thickness]::new(0);$hideButton.Foreground='#347F77'
$hideTemplate=[Windows.Controls.ControlTemplate]::new([Windows.Controls.Button]);$hideHost=[Windows.FrameworkElementFactory]::new([Windows.Controls.Border]);$hideHost.SetValue([Windows.Controls.Border]::BackgroundProperty,[Windows.Media.Brushes]::Transparent)
$hideContent=[Windows.FrameworkElementFactory]::new([Windows.Controls.ContentPresenter]);$hideContent.SetValue([Windows.FrameworkElement]::HorizontalAlignmentProperty,[Windows.HorizontalAlignment]::Center);$hideContent.SetValue([Windows.FrameworkElement]::VerticalAlignmentProperty,[Windows.VerticalAlignment]::Center);$hideHost.AppendChild($hideContent);$hideTemplate.VisualTree=$hideHost;$hideButton.Template=$hideTemplate
$eye=[Windows.Shapes.Path]::new();$eye.Data=[Windows.Media.Geometry]::Parse('M10.733 5.076 A10.744 10.744 0 0 1 21.938 11.651 A1 1 0 0 1 21.938 12.347 A10.747 10.747 0 0 1 20.494 14.837 M14.084 14.158 A3 3 0 0 1 9.842 9.916 M17.479 17.499 A10.75 10.75 0 0 1 2.062 12.348 A1 1 0 0 1 2.062 11.652 A10.75 10.75 0 0 1 6.508 6.509 M2 2 L22 22');$eye.Stroke='#347F77';$eye.StrokeThickness=2;$eye.StrokeStartLineCap='Round';$eye.StrokeEndLineCap='Round';$eye.Width=16;$eye.Height=16;$eye.Stretch='Uniform';$hideButton.Content=$eye
$stopButton=[Windows.Controls.Button]::new();$stopButton.Content='停止任务';$stopButton.Padding=[Windows.Thickness]::new(8,4,8,4);$stopButton.Margin=[Windows.Thickness]::new(6,0,0,0);$stopButton.Background='#FFF7ED';$stopButton.BorderBrush='#FED7AA';$stopButton.Foreground='#9A3412';$actions.Children.Add($stopButton)|Out-Null
$largeGrid=[Windows.Controls.Grid]::new()
foreach($width in @(124,1)){$column=[Windows.Controls.ColumnDefinition]::new();$column.Width=if($width -eq 1){[Windows.GridLength]::new(1,[Windows.GridUnitType]::Star)}else{[Windows.GridLength]::new($width)};$largeGrid.ColumnDefinitions.Add($column)}
$largeStack=[Windows.Controls.StackPanel]::new();[Windows.Controls.Grid]::SetColumn($largeStack,1)
# Browser automation retains its original independent, non-activating action window.
$linkWindow=[Windows.Window]::new();$linkWindow.WindowStyle='None';$linkWindow.ResizeMode='NoResize';$linkWindow.ShowInTaskbar=$false;$linkWindow.ShowActivated=$false;$linkWindow.Topmost=$true;$linkWindow.AllowsTransparency=$true;$linkWindow.Background='Transparent';$linkWindow.SizeToContent='WidthAndHeight'
$linkHook=[Delegate]::CreateDelegate([Windows.Interop.HwndSourceHook],[JobmateHudNative].GetMethod('NoActivate'))
$linkWindow.Add_SourceInitialized({$handle=[Windows.Interop.WindowInteropHelper]::new($linkWindow).Handle;[Windows.Interop.HwndSource]::FromHwnd($handle).AddHook($linkHook);$style=[JobmateHudNative]::GetWindowLongPtr($handle,-20).ToInt64() -bor 0x08000000 -bor 0x00000080;[void][JobmateHudNative]::SetWindowLongPtr($handle,-20,[IntPtr]$style)})
$jobsGrid=[Windows.Controls.Grid]::new()
foreach($width in @('28','*','Auto')){$column=[Windows.Controls.ColumnDefinition]::new();$column.Width=[Windows.GridLengthConverter]::new().ConvertFromString($width);$jobsGrid.ColumnDefinitions.Add($column)}
$jobsCopy=[Windows.Controls.StackPanel]::new();[Windows.Controls.Grid]::SetColumn($jobsCopy,1);$jobsCopy.Margin=[Windows.Thickness]::new(8,0,8,0)
$jobsRight=[Windows.Controls.StackPanel]::new();[Windows.Controls.Grid]::SetColumn($jobsRight,2);$jobsRight.VerticalAlignment='Top'
$jobsButtons=[Windows.Controls.StackPanel]::new();$jobsButtons.Orientation='Horizontal';$jobsButtons.HorizontalAlignment='Right';$jobsButtons.Margin=[Windows.Thickness]::new(0,7,0,0)
$abandonButton=[Windows.Controls.Button]::new();$abandonButton.Content='放弃';$abandonButton.Padding=[Windows.Thickness]::new(8,4,8,4);$abandonButton.Margin=[Windows.Thickness]::new(6,0,0,0);$abandonButton.Background='White';$abandonButton.BorderBrush='#D7E3EA';$abandonButton.Foreground='#B42318';$abandonButton.Visibility='Collapsed'
$guideGrid=[Windows.Controls.Grid]::new()
foreach($width in @('28','*','Auto','28')){$column=[Windows.Controls.ColumnDefinition]::new();$column.Width=[Windows.GridLengthConverter]::new().ConvertFromString($width);$guideGrid.ColumnDefinitions.Add($column)}
$guideIcon=[Windows.Controls.Image]::new();$guideIcon.Width=20;$guideIcon.Height=20;$guideIcon.VerticalAlignment='Center';$guideGrid.Children.Add($guideIcon)|Out-Null
$guideCopy=[Windows.Controls.StackPanel]::new();$guideCopy.Margin=[Windows.Thickness]::new(0,0,14,0);[Windows.Controls.Grid]::SetColumn($guideCopy,1);$guideGrid.Children.Add($guideCopy)|Out-Null
$guideTitle=[Windows.Controls.TextBlock]::new();$guideTitle.Text='初始化 · BOSS 资料准备';$guideTitle.FontSize=13;$guideTitle.FontWeight='SemiBold';$guideTitle.Foreground='#243746';$guideTitle.Margin=[Windows.Thickness]::new(0,0,0,3);$guideCopy.Children.Add($guideTitle)|Out-Null
$guidePrompt='请登录 BOSS，并完善在线简历和求职期望，准备好后点击【已完成】'
$guideMessage=[Windows.Controls.TextBlock]::new();$guideMessage.Text=$guidePrompt;$guideMessage.FontSize=12;$guideMessage.LineHeight=18;$guideMessage.TextWrapping='Wrap';$guideMessage.Foreground='#647786';$guideCopy.Children.Add($guideMessage)|Out-Null
$guideFeedback=[Windows.Controls.TextBlock]::new();$guideFeedback.FontSize=12;$guideFeedback.TextWrapping='Wrap';$guideFeedback.Foreground='#B42318';$guideFeedback.Margin=[Windows.Thickness]::new(0,3,0,0);$guideFeedback.Visibility='Collapsed';$guideCopy.Children.Add($guideFeedback)|Out-Null
$guideDone=[Windows.Controls.Button]::new();$guideDone.Content='已完成';$guideDone.IsEnabled=$false;$guideDone.FontSize=12;$guideDone.Padding=[Windows.Thickness]::new(12,6,12,6);$guideDone.MinHeight=32;$guideDone.VerticalAlignment='Center';$guideDone.Background='#0F766E';$guideDone.Foreground='White';$guideDone.BorderThickness=[Windows.Thickness]::new(0);[Windows.Controls.Grid]::SetColumn($guideDone,2);$guideGrid.Children.Add($guideDone)|Out-Null
$guideHide=[Windows.Controls.Button]::new();$guideHide.Content='×';$guideHide.FontSize=20;$guideHide.Width=28;$guideHide.Height=28;$guideHide.VerticalAlignment='Center';$guideHide.Background='Transparent';$guideHide.BorderThickness=[Windows.Thickness]::new(0);$guideHide.Template=$hideTemplate;$guideHide.Foreground='#647786';$guideHide.ToolTip='隐藏登录引导';[Windows.Automation.AutomationProperties]::SetName($guideHide,'隐藏登录引导');[Windows.Controls.Grid]::SetColumn($guideHide,3);$guideGrid.Children.Add($guideHide)|Out-Null
$script:guideRequest=$null;$script:guideLayout=$false;$script:guideChrome=$null;$script:guideError='';$script:guideStateRequest=$null;$script:guideStateAddress='';$script:guideReadAccepted=$false;$script:guideOtherRead=$false
$script:largeLayout=$null;$script:jobLayout=$null;$script:retryOperation='retry'

$script:returnUrl='';$script:stopUrl='';$script:requestedStop='';$script:finishedAt=$null;$script:lastType='';$script:messageKey='';$script:expanded=$false
$script:actionData=$null;$script:retryBusy=$false;$script:retryUncertain='';$script:followTask='';$script:lastTaskRead=[DateTimeOffset]::MinValue;$script:retryError='';$script:browserWasRunning=$false
$script:lastStatusRevision='';$script:visibilityRequest=$null;$script:retryRequest=$null;$script:retryOriginal=$null;$script:followPrevious='';$script:retryClient=[Net.Http.HttpClient]::new();$script:retryClient.Timeout=[TimeSpan]::FromSeconds(10)
$hook=[Delegate]::CreateDelegate([Windows.Interop.HwndSourceHook],[JobmateHudNative].GetMethod('HitTest'))
$window.Add_SourceInitialized({
 $handle=[Windows.Interop.WindowInteropHelper]::new($window).Handle;[Windows.Interop.HwndSource]::FromHwnd($handle).AddHook($hook)
 $style=[JobmateHudNative]::GetWindowLongPtr($handle,-20).ToInt64() -bor 0x00000080
 [void][JobmateHudNative]::SetWindowLongPtr($handle,-20,[IntPtr]$style)
})
function Update-InteractiveRegions {
 if(-not $window.IsVisible){return}
 $rects=[Collections.Generic.List[long[]]]::new()
 $controls=if($script:guideLayout){@($guideDone,$guideHide)}elseif($script:largeLayout){@()}else{@($toggle,$hideButton,$button,$stopButton,$abandonButton)};if($script:expanded -and -not $script:largeLayout -and -not $script:guideLayout){$controls+=@($messageScroll)}
 foreach($control in $controls){
  if($control.Visibility -ne 'Visible' -or $control.ActualWidth -le 0 -or $control.ActualHeight -le 0){continue}
  $a=$control.PointToScreen([Windows.Point]::new(0,0));$b=$control.PointToScreen([Windows.Point]::new($control.ActualWidth,$control.ActualHeight))
  $rects.Add([long[]]@([Math]::Floor($a.X),[Math]::Floor($a.Y),[Math]::Ceiling($b.X),[Math]::Ceiling($b.Y)))
 }
 [JobmateHudNative]::InteractiveRects=$rects.ToArray()
}
function Set-HudLayout([bool]$large,[bool]$jobs=$false,[bool]$guide=$false) {
  if($script:largeLayout -eq $large -and $script:jobLayout -eq $jobs -and $script:guideLayout -eq $guide){return}
 $surface.Child=$null;$messageScroll.Content=$null;$header.Children.Clear();$stack.Children.Clear();$largeGrid.Children.Clear();$largeStack.Children.Clear()
 $footer.Children.Clear();$linkWindow.Content=$null
 $actions.Children.Clear();$jobsGrid.Children.Clear();$jobsCopy.Children.Clear();$jobsRight.Children.Clear();$jobsButtons.Children.Clear()
 if(-not $jobs -or $large){foreach($control in @($button,$stopButton,$abandonButton)){$actions.Children.Add($control)|Out-Null}}
  $script:guideLayout=$guide;$surface.CornerRadius=[Windows.CornerRadius]::new(12)
  if($guide){
   $surface.Padding=[Windows.Thickness]::new(10,9,10,9);$surface.CornerRadius=[Windows.CornerRadius]::new(9);$surface.Child=$guideGrid;$linkWindow.Hide()
  }elseif($large){
   $surface.Padding=[Windows.Thickness]::new(16);$largeGrid.Children.Add($icon)|Out-Null;$largeGrid.Children.Add($largeStack)|Out-Null
  foreach($control in @($notice,$title,$stage,$stateLine)){$largeStack.Children.Add($control)|Out-Null}
  $stage.Margin=[Windows.Thickness]::new(0,6,0,0);$stateLine.Margin=[Windows.Thickness]::new(0,6,0,0);$surface.Child=$largeGrid;$linkWindow.Content=$actions
 }elseif($jobs){
  $surface.Padding=[Windows.Thickness]::new(12);$jobsGrid.Children.Add($icon)|Out-Null;$jobsGrid.Children.Add($jobsCopy)|Out-Null;$jobsGrid.Children.Add($jobsRight)|Out-Null
  foreach($control in @($title,$stage,$messageScroll,$toggle)){$jobsCopy.Children.Add($control)|Out-Null};$messageScroll.Content=$stateLine
  $jobsRight.Children.Add($hideButton)|Out-Null;$jobsRight.Children.Add($button)|Out-Null;$jobsRight.Children.Add($jobsButtons)|Out-Null
  foreach($control in @($stopButton,$abandonButton)){$jobsButtons.Children.Add($control)|Out-Null}
  $stage.Margin=[Windows.Thickness]::new(0,4,0,0);$stateLine.Margin=[Windows.Thickness]::new(0);$surface.Child=$jobsGrid;$linkWindow.Hide()
 }else{
  $surface.Padding=[Windows.Thickness]::new(12);foreach($control in @($notice,$header,$messageScroll,$footer)){$stack.Children.Add($control)|Out-Null}
  foreach($control in @($icon,$title,$stage)){$header.Children.Add($control)|Out-Null};foreach($control in @($toggle,$actions)){$footer.Children.Add($control)|Out-Null}
  $stage.Margin=[Windows.Thickness]::new(10,0,0,0);$stateLine.Margin=[Windows.Thickness]::new(0);$messageScroll.Content=$stateLine;$surface.Child=$stack;$linkWindow.Hide()
 }
 $hideButton.Visibility=if($jobs -and -not $large){'Visible'}else{'Collapsed'};$hideButton.Focusable=-not $large;
 $button.Focusable=-not $large;$stopButton.Focusable=-not $large;$stopButton.Margin=[Windows.Thickness]::new($(if($large){0}else{6}),0,0,0)
 $messageScroll.Focusable=-not $large;$script:largeLayout=$large;$script:jobLayout=$jobs
}
function Update-BrowserActions {
 if(-not $script:largeLayout -or -not $window.IsVisible){return}
 if($button.Visibility -eq 'Visible' -or $stopButton.Visibility -eq 'Visible' -or $abandonButton.Visibility -eq 'Visible'){
  if($stopButton.Visibility -eq 'Visible'){$linkWindow.Top=8}else{$linkWindow.Left=$window.Left+$window.Width-148;$linkWindow.Top=$window.Top+$window.ActualHeight-38}
  $linkWindow.Show();$linkWindow.UpdateLayout()
  if($stopButton.Visibility -eq 'Visible'){$linkWindow.Left=[Math]::Round(([Windows.SystemParameters]::PrimaryScreenWidth-$linkWindow.ActualWidth)/2)}
 }else{$linkWindow.Hide()}
}
function Update-BodyLayout {
  if($script:guideLayout){$window.UpdateLayout();Update-InteractiveRegions;return}
 if($script:largeLayout){
  $toggle.Visibility='Collapsed';$footer.Visibility='Collapsed';$messageScroll.Height=[double]::NaN;$messageScroll.VerticalScrollBarVisibility='Disabled'
  $window.UpdateLayout();Update-InteractiveRegions;Update-BrowserActions;return
 }
 if($script:jobLayout){
  $window.UpdateLayout();$messageScroll.Height=[double]::NaN;$messageScroll.VerticalScrollBarVisibility='Disabled';$toggle.Visibility='Collapsed'
  $window.UpdateLayout();Update-InteractiveRegions;return
 }
 $width=[Math]::Max(1,$window.Width-2*$surface.Padding.Left-2)
 $stateLine.Measure([Windows.Size]::new($width,[double]::PositiveInfinity));$full=$stateLine.DesiredSize.Height
 $twoLines=[Math]::Ceiling(2*$stateLine.FontFamily.LineSpacing*$stateLine.FontSize)
 $toggle.Visibility=if($full -gt $twoLines+0.5){'Visible'}else{'Collapsed'}
 $toggle.Content=if($script:expanded){'收起'}else{'展开'}
 $footer.Visibility=if($toggle.Visibility -eq 'Visible' -or $button.Visibility -eq 'Visible' -or $stopButton.Visibility -eq 'Visible'){'Visible'}else{'Collapsed'}
 $messageScroll.Height=0;$surface.Measure([Windows.Size]::new($window.Width,[double]::PositiveInfinity));$fixed=$surface.DesiredSize.Height
 $wanted=if($script:expanded){$full}else{[Math]::Min($full,$twoLines)}
 $messageScroll.Height=[Math]::Max(0,[Math]::Min($wanted,$area.Bottom-$window.Top-12-$fixed))
 $messageScroll.VerticalScrollBarVisibility=if($script:expanded){'Auto'}else{'Disabled'}
 $window.UpdateLayout();Update-InteractiveRegions
}
$toggle.Add_Click({$script:expanded=-not $script:expanded;$messageScroll.ScrollToTop();Update-BodyLayout})
$button.Add_Click({if(($address=Get-InstallationAddress) -and $script:returnUrl -match ('^'+[regex]::Escape($address)+'/(?:\?page=(?:init|config|profile|tasks|review|today)(?:&hud_task=[A-Za-z0-9_-]+)?)?$') -and (Test-CurrentInstallation)){& (Join-Path $PSScriptRoot '../open.ps1') -ReturnUrl $script:returnUrl | Out-Null}})
$hideButton.Add_Click({
 if($script:visibilityRequest -or $script:retryBusy){return}
 try{
  $id=[string](Value $script:actionData 'taskId');$current=Read-HudTask $id;$address=Get-InstallationAddress
  if((Value $current 'type') -eq 'browser' -or -not(Value $current 'window_controls' $false) -or -not $address){return}
  $hideButton.IsEnabled=$false;$body=[Net.Http.StringContent]::new('{'+'"hidden":true}',[Text.Encoding]::UTF8,'application/json')
  $script:visibilityRequest=$script:retryClient.PostAsync(($address+'/api/workflow-tasks/'+$id+'/window'),$body)
 }catch{Write-HudDiagnostic 'hud.visibility' $_;$hideButton.IsEnabled=$true}
})
function Complete-HudVisibility {
 if(-not $script:visibilityRequest -or -not $script:visibilityRequest.IsCompleted){return}
 $http=$null
 try{$http=$script:visibilityRequest.GetAwaiter().GetResult();$answer=$http.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json;if(-not $http.IsSuccessStatusCode -or -not $answer.ok){throw '窗口显示状态未能保存'}}
 catch{Write-HudDiagnostic 'hud.visibility' $_;$script:retryError='未能隐藏小窗口，请返回原页面查看。'}
 finally{if($http){$http.Dispose()};$script:visibilityRequest=$null;$hideButton.IsEnabled=$true}
}
function Apply-HudVisibility($data) {
 if((Value $data 'type' 'background') -ne 'browser' -and [bool](Value $data 'window_hidden' $false)){$window.Hide();$linkWindow.Hide();return}
 if(-not $window.IsVisible){$window.Show();[void][JobmateHudNative]::ShowWindow([Windows.Interop.WindowInteropHelper]::new($window).Handle,4)}
 Update-BodyLayout
}
function Update-InitGuideControls {
 $status=if($null -eq $script:guideChrome){'checking'}else{[string](Value $script:guideChrome 'status' 'checking')}
 $ready=$status -eq 'ready' -and [bool](Value $script:guideChrome 'installed' $false)
 $busy=$null -ne $script:guideRequest -or $script:guideReadAccepted -or $script:guideOtherRead
 $guideDone.IsEnabled=$ready -and -not $busy
 $guideDone.Content=if($busy){'处理中…'}elseif($status -in @('unknown','checking')){'检测中…'}else{'已完成'}
 $guideHide.IsEnabled=-not $busy
 $guideFeedback.Text=if($script:guideError){$script:guideError}elseif($status -in @('error','missing') -or $status -eq 'ready' -and -not $ready){'浏览器未就绪，请在软件页面重新检测。'}else{''}
 $guideFeedback.Visibility=if($guideFeedback.Text){'Visible'}else{'Collapsed'}
}
function Update-InitGuideState {
 if(-not $script:guideLayout){return}
 if($script:guideStateRequest){
  if(-not $script:guideStateRequest.IsCompleted){return}
  $http=$null
  try{
   $http=$script:guideStateRequest.GetAwaiter().GetResult();$state=$http.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json
   if(-not $http.IsSuccessStatusCode -or -not $state.ok -or $script:guideStateAddress -cne (Get-InstallationAddress)){throw '本实例状态未能核对'}
   $script:guideChrome=Value $state 'browserCheck' $null
   $script:guideOtherRead=@((Value $state 'tasks' @())|Where-Object{(Value $_ 'kind') -eq 'expectations' -and (Value $_ 'status') -in @('queued','running','paused')}).Count -gt 0
  }catch{$script:guideChrome=[pscustomobject]@{status='error';installed=$false}}
  finally{if($http){$http.Dispose()};$script:guideStateRequest=$null}
  Update-InitGuideControls
 }
 if(([DateTimeOffset]::UtcNow-$script:lastTaskRead).TotalSeconds -lt 1.5){return}
 $script:lastTaskRead=[DateTimeOffset]::UtcNow
 try{
  $script:guideStateAddress=Get-InstallationAddress;if(-not $script:guideStateAddress){throw '当前安装未就绪'}
  $script:guideStateRequest=$script:retryClient.GetAsync(($script:guideStateAddress+'/api/state'))
 }catch{$script:guideChrome=[pscustomobject]@{status='error';installed=$false};Update-InitGuideControls}
}
function Start-InitGuideRequest([bool]$hide) {
 if($script:guideRequest -or -not $script:guideLayout){return}
 if(-not $hide -and ($script:guideReadAccepted -or $script:guideOtherRead)){Update-InitGuideControls;return}
 if(-not $hide -and ($null -eq $script:guideChrome -or (Value $script:guideChrome 'status') -ne 'ready' -or -not [bool](Value $script:guideChrome 'installed' $false))){Update-InitGuideControls;return}
 try{
  if(-not(Test-CurrentInstallation)){throw '当前安装未就绪，请返回原页面核对'}
  $address=Get-InstallationAddress;if(-not $address){throw '当前安装未就绪，请返回原页面核对'}
  $path=if($hide){'/api/browser/init-guide'}else{'/api/expectations/read'}
  $json=if($hide){'{"hidden":true}'}else{'{"prepared":true,"target":"onboarding","source":"init-guide"}'}
  $body=[Net.Http.StringContent]::new($json,[Text.Encoding]::UTF8,'application/json')
  $script:guideError='';$guideDone.Content='处理中…';$guideDone.IsEnabled=$false;$guideHide.IsEnabled=$false
  $script:guideRequest=$script:retryClient.PostAsync(($address+$path),$body)
 }catch{Write-HudDiagnostic 'hud.init-guide' $_;$script:guideError='未能提交，请返回原页面核对。';Update-InitGuideControls}
}
function Complete-InitGuideRequest {
 if(-not $script:guideRequest -or -not $script:guideRequest.IsCompleted){return}
 $http=$null
 try{
  $http=$script:guideRequest.GetAwaiter().GetResult();$answer=$http.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json
  if(-not $http.IsSuccessStatusCode -or -not $answer.ok){throw '引导操作未完成'}
  if($null -ne (Value $answer 'task' $null)){$script:guideReadAccepted=$true}
 }catch{Write-HudDiagnostic 'hud.init-guide' $_;$script:guideError='未能确认操作结果，请返回原页面核对；不会自动再次提交。'}
 finally{if($http){$http.Dispose()};$script:guideRequest=$null;Update-InitGuideControls}
}
$guideDone.Add_Click({Start-InitGuideRequest $false})
$guideHide.Add_Click({Start-InitGuideRequest $true})
function Read-HudTask([string]$taskId) {
 if($taskId -notmatch '^[A-Za-z0-9_-]+$' -or -not(Test-CurrentInstallation)){throw '原任务或安装已失效'}
 $address=Get-InstallationAddress;if(-not $address){throw '当前安装未就绪'}
 $response=Invoke-RestMethod -Uri ($address+'/api/workflow-tasks/'+$taskId+'/progress') -Method Get -TimeoutSec 10
 if(-not $response.ok -or $response.task.id -cne $taskId){throw '原任务状态未能核对'}
 $data=$response.progress
 foreach($name in @('return_url','retry_return_url','resume_return_url','retry_url','progress_url','stop_url','pause_url','resume_url','abandon_url')){if((Value $data $name) -match '^/'){ $data.$name=$address+$data.$name }}
 $data|Add-Member -NotePropertyName type -NotePropertyValue ([string](Value $data 'type' (Value $script:actionData 'type' 'background'))) -Force
 if(-not(Value $data 'title')){$data|Add-Member -NotePropertyName title -NotePropertyValue ([string](Value $script:actionData 'title' '处理中')) -Force}
 return $data
}
function Return-PausedBrowserTask($data) {
 if(-not $script:browserWasRunning){return $false}
 if(-not(Value $data 'job_actions' $false) -or (Value $data 'status') -ne 'paused' -or (Value $data 'type') -ne 'browser'){return $false}
 # Re-read this installation/task before returning focus; pausing is not a safe stop yet.
 $current=Read-HudTask ([string](Value $data 'taskId'))
 if((Value $current 'status') -ne 'paused' -or (Value $current 'type') -ne 'browser'){return $false}
 $address=Get-InstallationAddress;$url=[string](Value $current 'return_url')
 if(-not $address -or $url -cne ($address+'/?page=tasks&hud_task='+[string](Value $current 'taskId'))){return $false}
 $window.Hide();$linkWindow.Hide()
 try{& (Join-Path $PSScriptRoot '../open.ps1') -ReturnUrl $url -FocusReturn | Out-Null}
 catch{Write-HudDiagnostic 'hud.pause-return' $_}
 finally{$window.Close()}
 return $true
}
function Open-HudOperation($data,[string]$operation='retry') {
 $address=Get-InstallationAddress;$url=[string](Value $data ($operation+'_return_url'))
 if($address -and $url -match ('^'+[regex]::Escape($address)+'/\?page=(init|config|profile|tasks|review|today)&hud_task=[A-Za-z0-9_-]+&hud_action=(?:retry|resume)$') -and (Test-CurrentInstallation)){
  & (Join-Path $PSScriptRoot '../open.ps1') -ReturnUrl $url | Out-Null
 }
}
function Invoke-HudRetry {
 if($script:retryBusy -or $script:retryUncertain){return}
 $script:retryOperation='retry'
 $original=$script:actionData;$taskId=[string](Value $original 'taskId');$latest=Read-Status
 if($latest -and (Value $latest 'taskId') -cne $taskId -and -not($script:followTask -ceq $taskId -and (Value $latest 'taskId') -ceq $script:followPrevious)){Update-ProgressContent $latest;return}
 $script:retryBusy=$true;$script:retryError='';$stopButton.IsEnabled=$false;$stopButton.Content='正在重试…';$window.UpdateLayout()
 try {
  $current=Read-HudTask $taskId
  if((Value $current 'retry_kind') -eq 'navigate'){Update-ProgressContent $current;Open-HudOperation $current;return}
  if((Value $current 'retry_kind') -ne 'direct' -or $current.status -ne 'failed'){Update-ProgressContent $current;return}
  $address=Get-InstallationAddress;$url=[string](Value $current 'retry_url')
  $prefix='^'+[regex]::Escape($address)
  if($url -notmatch ($prefix+'/api/workflow-tasks/'+[regex]::Escape($taskId)+'/retry$')){throw '原任务重试地址不匹配'}
  $script:retryOriginal=$original
  $body=[Net.Http.StringContent]::new('{}',[Text.Encoding]::UTF8,'application/json')
  $script:retryRequest=$script:retryClient.PostAsync($url,$body)
 }catch{
  Write-HudDiagnostic 'hud.retry' $_
  $script:retryError='暂时无法重试，请返回原页面查看。';$script:actionData.retry_kind=''
 }finally{
  if(-not $script:retryRequest){$script:retryBusy=$false}
  if($script:actionData){Update-ProgressContent $script:actionData}
 }
}
function Invoke-HudJobAction([string]$operation) {
 if($script:retryBusy -or $script:retryUncertain){return}
 $script:retryBusy=$true;$script:retryError='';$script:retryOperation=$operation
 try {
  $current=Read-HudTask ([string](Value $script:actionData 'taskId'));$taskId=[string](Value $current 'taskId')
  if($operation -eq 'resume' -and (Value $current 'resume_kind') -eq 'navigate'){Open-HudOperation $current 'resume';return}
  $url=[string](Value $current ($operation+'_url'));$address=Get-InstallationAddress
  if($operation -notin @('pause','resume','abandon') -or $url -cne ($address+'/api/workflow-tasks/'+$taskId+'/'+$operation)){Update-ProgressContent $current;return}
  $payload=if($operation -eq 'abandon'){'{"confirmed":true}'}else{'{}'}
  $script:retryOriginal=$current;$body=[Net.Http.StringContent]::new($payload,[Text.Encoding]::UTF8,'application/json')
  $script:retryRequest=$script:retryClient.PostAsync($url,$body)
 }catch{Write-HudDiagnostic 'hud.job-action' $_;$script:retryError='本次操作未能受理，请返回原页面核对。'}
 finally{if(-not $script:retryRequest){$script:retryBusy=$false};if($script:actionData){Update-ProgressContent $script:actionData}}
}
$abandonButton.Add_Click({
 if($script:retryBusy){return}
 $current=Read-HudTask ([string](Value $script:actionData 'taskId'));Update-ProgressContent $current
 if(-not(Value $current 'abandon_url')){return}
 $answer=[Windows.MessageBox]::Show($window,[string](Value $current 'abandon_hint'),'放弃当前未完成环节',[Windows.MessageBoxButton]::OKCancel,[Windows.MessageBoxImage]::Warning,[Windows.MessageBoxResult]::Cancel)
 if($answer -eq [Windows.MessageBoxResult]::OK){Invoke-HudJobAction 'abandon'}
})
function Complete-HudRetry {
 if(-not $script:retryRequest -or -not $script:retryRequest.IsCompleted){return}
 $original=$script:retryOriginal;$taskId=[string](Value $original 'taskId');$http=$null
 try{
  $http=$script:retryRequest.GetAwaiter().GetResult()
  $response=$http.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json
  if((Value $response 'ok' $null) -eq $false){$script:retryError=[string](Value $response 'error' '重试未受理，请返回原页面处理。');return}
  if(-not $http.IsSuccessStatusCode -or -not(Value $response 'task') -or -not(Value $response.task 'id')){throw '重试结果暂不明确'}
  $newId=[string]$response.task.id;$latest=Read-Status
  if($latest -and (Value $latest 'taskId') -notin @($taskId,$newId)){return}
  $script:followTask=$newId;$script:followPrevious=$taskId;$script:retryUncertain='';$script:lastTaskRead=[DateTimeOffset]::UtcNow
  Update-ProgressContent ([pscustomobject]@{taskId=$newId;status=$response.task.status;type=(Value $original 'type' 'background');title=(Value $original 'title' '处理中');stage='操作已受理，正在读取任务状态';return_url=(Value $original 'return_url');retry_kind=''})
  try{Update-ProgressContent (Read-HudTask $newId)}catch{$script:retryError='重试已受理，请返回原页面查看实际任务状态。'}
 }catch{
  Write-HudDiagnostic 'hud.retry' $_;$script:retryUncertain=$taskId
  try{Update-ProgressContent (Read-HudTask $taskId)}catch{}
 }finally{
  if($http){$http.Dispose()};$script:retryRequest=$null;$script:retryOriginal=$null;$script:retryBusy=$false
  if($script:actionData){Update-ProgressContent $script:actionData}
 }
}
$stopButton.Add_Click({
 if((Value $script:actionData 'job_actions' $false) -or (Value $script:actionData 'task_actions' $false)){
  $operation=if((Value $script:actionData 'status') -eq 'paused'){'resume'}elseif((Value $script:actionData 'status') -in @('queued','running')){'pause'}else{''}
  if($operation){Invoke-HudJobAction $operation;return}
 }
 if((Value $script:actionData 'retry_kind') -and (Value $script:actionData 'status') -in @('failed','waiting','awaiting_confirmation')){Invoke-HudRetry;return}
 if(-not(Test-StopUrl $script:stopUrl) -or -not(Test-CurrentInstallation)){return}
 $script:requestedStop=$script:stopUrl;$stopButton.IsEnabled=$false;$stopButton.Content='正在停止…'
 try{Invoke-RestMethod -Uri $script:stopUrl -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10|Out-Null}
 catch{Write-HudDiagnostic 'hud.stop' $_;$script:requestedStop='';$stopButton.IsEnabled=$true;$stopButton.Content='停止任务';$stateLine.Text='停止请求未完成，请返回原页面处理。';Update-BodyLayout}
})
function Update-ProgressContent($data) {
 if($null -ne $data -and (Value $data 'type') -eq 'init-guide'){
  $script:actionData=$data;$script:diagnosticTaskId='';$script:finishedAt=$null
  if(-not $script:guideLayout){$script:guideChrome=$null;$script:guideReadAccepted=$false;$script:guideOtherRead=$false;$script:lastTaskRead=[DateTimeOffset]::MinValue}
  $window.Width=[Math]::Min(560,$area.Width-24);$window.Left=[Math]::Round($area.Left+($area.Width-$window.Width)/2);$window.Top=$area.Top+12
  Set-HudLayout $false $false $true
  $guideAsset=Join-Path $PSScriptRoot '../assets/runtime/automation-robot.png'
  if(Test-Path -LiteralPath $guideAsset){$guideIcon.Source=[Windows.Media.Imaging.BitmapImage]::new([Uri][IO.Path]::GetFullPath($guideAsset))}
  Update-InitGuideControls;Update-InitGuideState
  Update-BodyLayout;return
 }

 $script:diagnosticTaskId=if($null -ne $data){[string](Value $data 'taskId')}else{''}
 if($null -eq $data){$data=[pscustomobject]@{}}
  if(-not $script:actionData -or (Value $script:actionData 'taskId') -cne (Value $data 'taskId') -or (Value $script:actionData 'status') -cne (Value $data 'status') -or ((Value $data 'status') -notin @('failed','waiting','awaiting_confirmation') -and -not(Value $data 'job_actions' $false))){$script:retryError=''}
  if(-not $script:actionData -or (Value $script:actionData 'taskId') -cne (Value $data 'taskId')){$script:browserWasRunning=$false}
  if((Value $data 'type') -eq 'browser' -and (Value $data 'status') -in @('queued','running','pausing')){$script:browserWasRunning=$true}
  $script:actionData=$data
  if($script:retryUncertain -and ((Value $data 'taskId') -cne $script:retryUncertain -or (Value $data 'status') -notin @('failed'))){$script:retryUncertain='';$script:retryError=''}
 $status=[string](Value $data 'status');$type=[string](Value $data 'type' 'background');$area=[Windows.SystemParameters]::WorkArea
 $large=$type -eq 'browser';$window.Width=if($large){[Math]::Min(820,$area.Width-24)}else{[Math]::Min(440,$area.Width-24)};$window.Left=$area.Left+($area.Width-$window.Width)/2;$window.Top=if($large){$area.Top+$area.Height*0.25}else{$area.Top+12}
 $isJobs=[bool](Value $data 'job_actions' $false) -or [bool](Value $data 'task_actions' $false)
 Set-HudLayout $large $isJobs
 $notice.Visibility=if($large){'Visible'}else{'Collapsed'};$header.ColumnDefinitions[0].Width=[Windows.GridLength]::new($(if($large){124}else{28}));$icon.Width=if($large){104}else{22};$icon.Height=$icon.Width
 if($type -ne $script:lastType){$asset=if($large){'automation-shield.png'}else{'automation-robot.png'};$assetPath=Join-Path $PSScriptRoot ('../assets/runtime/'+$asset);if(Test-Path -LiteralPath $assetPath){$icon.Source=[Windows.Media.Imaging.BitmapImage]::new([Uri]::new([IO.Path]::GetFullPath($assetPath)))};$script:lastType=$type}
 $title.Text=[string](Value $data 'title' '处理中');$stageText=[string](Value $data 'stage' '等待处理完成')
 $stageLabels=@{'个人介绍拆解'='整理个人经历';'正在拆解个人介绍'='正在整理你的经历与能力…';'正在审核个人介绍拆解结果'='正在核对整理结果…';'正在审核拆解结果'='正在核对整理结果…'};if($stageLabels.ContainsKey($stageText)){$stageText=$stageLabels[$stageText]}
  $message=switch($status){'failed'{[string](Value $data 'error' '处理失败，请返回原页面重试或放弃')};'waiting'{'等待当前处理结束后确认本次更新'};'awaiting_confirmation'{'请返回原页面确认本次更新影响范围'};'paused'{'已保留当前阶段、参数及已完成结果。'};'pausing'{'等待当前操作结束并保存结果，到达安全停点后暂停。'};'completed'{'处理成功'};'success'{'处理成功'};'abandoned'{'任务已放弃'};'cancelled'{'任务已取消'};'user_action_required'{'请在本项目浏览器完成登录或安全验证'};default{[string](Value $data 'message' '处理中')}}
  $omitRepeatedTitle=$status -eq 'failed' -and [bool](Value $data 'omit_repeated_title' $false)
  if($omitRepeatedTitle){
   if($message.StartsWith($title.Text+"`r`n",[StringComparison]::Ordinal)){$message=$message.Substring($title.Text.Length+2)}
   elseif($message.StartsWith($title.Text+"`n",[StringComparison]::Ordinal)){$message=$message.Substring($title.Text.Length+1)}
  }
  if($status -in @('failed','waiting','awaiting_confirmation') -and (Value $data 'retry_hint')){$message+="`n"+[string](Value $data 'retry_hint')}
  if($script:retryUncertain){$message+=if($isJobs){"`n操作结果暂不明确，请返回原页面核对；不会自动再次提交。"}else{"`n重试结果暂不明确，请返回原页面核对；不会自动再次提交。"}}elseif($script:retryError){$message+="`n"+$script:retryError}
 $errorLabels=@{'拆解编号沿用无效'='经历条目编号沿用无效';'拆解出处不在当前介绍原文中'='经历条目出处不在当前介绍原文中';'请先完成个人介绍拆解和求职期望'='请先完成个人经历整理和求职期望'};if($errorLabels.ContainsKey($message)){$message=$errorLabels[$message]}
 $message=$message -creplace '^(?:个人介绍拆解失败：)+','个人经历整理未完成：' -creplace '^(?:个人介绍审核失败：)+','整理结果核对未完成：'
 $key=@([string](Value $data 'taskId'),$type,$status,$title.Text,$stageText,$message)-join "`n"
 if($key -cne $script:messageKey){$script:expanded=$false;$messageScroll.ScrollToTop();$script:messageKey=$key}
 $completed=Value $data 'completed' $null;$total=Value $data 'total' $null
 if($null -ne $completed -and $null -ne $total -and [double]$total -ge 0 -and [double]$completed -ge 0 -and [double]$completed -le [double]$total){$stageText+=' · '+$completed+' / '+$total}
 if($large){$stage.Text=$stageText;$stateLine.Text=$message}else{
  $stage.Text=switch($status){'paused'{'已暂停'};'pausing'{'正在暂停'};'queued'{'等待处理'};'failed'{'处理失败'};'completed'{'处理成功'};'success'{'处理成功'};'abandoned'{'任务已放弃'};'cancelled'{'任务已取消'};'user_action_required'{'等待你操作'};default{'处理中'}}
  if($omitRepeatedTitle -and $stageText -ceq $title.Text){$stateLine.Text=$message}else{
   $stateLine.Text=$stageText;if($message -and $message -cne $stage.Text -and $message -cne $stageText -and ($status -eq 'failed' -or $message -cne '处理中')){$stateLine.Text+="`n"+$message}
  }
 }
 $stateLine.Foreground=if($status -eq 'failed'){'#B42318'}else{'#647786'}
 $script:returnUrl=[string](Value $data 'return_url');$script:stopUrl=[string](Value $data 'stop_url')
  $showReturn=$status -in @('failed','user_action_required','waiting','awaiting_confirmation');$showRetry=$status -in @('failed','waiting','awaiting_confirmation') -and [string](Value $data 'retry_kind') -in @('direct','navigate');$showStop=$status -in @('queued','running','user_action_required') -and (Test-StopUrl $script:stopUrl)
  $button.Visibility=if($showReturn){'Visible'}else{'Collapsed'};$stopButton.Visibility=if($showStop -or $showRetry){'Visible'}else{'Collapsed'}
  $stopButton.IsEnabled=if($showRetry){-not $script:retryBusy -and -not $script:retryUncertain}else{$script:requestedStop -ne $script:stopUrl}
  $stopButton.Content=if($showRetry){if($script:retryUncertain){'正在核对…'}elseif($script:retryBusy){'正在重试…'}else{'重试'}}elseif($stopButton.IsEnabled){'停止任务'}else{'正在停止…'}
  $stopButton.Background=if($showRetry){'#F0F8F7'}else{'#FFF7ED'};$stopButton.BorderBrush=if($showRetry){'#CBE6E2'}else{'#FED7AA'};$stopButton.Foreground=if($showRetry){'#347F77'}else{'#9A3412'}
 $abandonButton.Visibility='Collapsed'
 if($isJobs){
  $stopButton.Background='#F0F8F7';$stopButton.BorderBrush='#CBE6E2';$stopButton.Foreground='#347F77'
  $button.Visibility=if($large){'Collapsed'}else{'Visible'};$showJobAction=$status -in @('queued','running','pausing','paused','failed')
  $stopButton.Visibility=if($showJobAction){'Visible'}else{'Collapsed'}
  $stopButton.IsEnabled=$showJobAction -and $status -ne 'pausing' -and -not $script:retryBusy -and -not $script:retryUncertain
  $stopButton.Content=if($script:retryBusy){switch($script:retryOperation){'pause'{'正在暂停…'};'resume'{'正在恢复…'};'abandon'{'正在放弃…'};default{'正在重试…'}}}else{switch($status){'paused'{'恢复'};'failed'{'重试'};'pausing'{'正在暂停…'};default{'暂停'}}}
  $abandonButton.Visibility=if($status -in @('paused','failed')){'Visible'}else{'Collapsed'};$abandonButton.IsEnabled=-not $script:retryBusy -and -not $script:retryUncertain
 }
 Update-BodyLayout
}
$timer=[Windows.Threading.DispatcherTimer]::new();$timer.Interval=[TimeSpan]::FromMilliseconds(350)
$timer.Add_Tick({
  Complete-InitGuideRequest
  Complete-HudVisibility
  Complete-HudRetry
 $data=Read-Status;if($null -eq $data){return};$status=[string](Value $data 'status')
 if($status -in @('closed','hidden','abandoned')){$window.Close();return}
 # Keep the last displayed HTTP state until this task's status file is updated.
 $revision=[string](Value $data 'updated_at');$fileTaskId=[string](Value $data 'taskId')
 if($revision -and $revision -ceq $script:lastStatusRevision -and $script:actionData -and (Value $script:actionData 'taskId') -ceq $fileTaskId -and ((Value $data 'job_actions' $false) -or (Value $data 'task_actions' $false))){$data=$script:actionData;$status=[string]$data.status}
 $script:lastStatusRevision=$revision
 if(((Value $data 'job_actions' $false) -or (Value $data 'task_actions' $false)) -and -not $script:retryBusy -and ([DateTimeOffset]::UtcNow-$script:lastTaskRead).TotalSeconds -ge 1.5){$script:lastTaskRead=[DateTimeOffset]::UtcNow;try{$data=Read-HudTask ([string](Value $data 'taskId'));$status=[string]$data.status}catch{Write-HudDiagnostic 'hud.job-state' $_}}
  if($script:followTask){
   if((Value $data 'taskId') -notin @($script:followTask,$script:followPrevious)){$script:followTask=''}
   elseif((Value $data 'taskId') -eq $script:followTask -and $status -ne 'failed'){$script:followTask=''}
   elseif(([DateTimeOffset]::UtcNow-$script:lastTaskRead).TotalSeconds -ge 1.5){
    $script:lastTaskRead=[DateTimeOffset]::UtcNow
    try{$data=Read-HudTask $script:followTask;$status=[string]$data.status}catch{if($script:actionData){$data=$script:actionData;$status=[string]$data.status}}
   }elseif($script:actionData){$data=$script:actionData;$status=[string]$data.status}
  }
 Update-ProgressContent $data
 Apply-HudVisibility $data
 try{if(Return-PausedBrowserTask $data){return}}catch{Write-HudDiagnostic 'hud.pause-return' $_}
 if($status -eq 'failed' -and (Test-StopUrl $script:stopUrl) -and $script:requestedStop -eq $script:stopUrl){$window.Close();return}
 if($status -in @('completed','success','abandoned','cancelled')){if($null -eq $script:finishedAt){$script:finishedAt=[DateTimeOffset]::UtcNow};if(([DateTimeOffset]::UtcNow-$script:finishedAt).TotalSeconds -ge 2){$window.Close()}}else{$script:finishedAt=$null}
})
$window.Add_Loaded({Update-BodyLayout});$window.Add_Closed({$timer.Stop();$script:retryClient.Dispose();$linkWindow.Close();$window.Dispatcher.InvokeShutdown()});Update-ProgressContent (Read-Status);$timer.Start();$window.Show();[void][JobmateHudNative]::ShowWindow([Windows.Interop.WindowInteropHelper]::new($window).Handle,4);[Windows.Threading.Dispatcher]::Run()
