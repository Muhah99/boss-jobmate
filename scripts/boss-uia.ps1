param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Status", "FocusDedicatedWindow", "ReadFirstJobSample", "CloseSampleWindow", "CloseTaskWindows", "ListExpectations", "SelectExpectation", "ListJobs", "ListJobsIncrement", "CollectJobsIncrement", "ReadJobDetails", "TrimTabs", "StartCommunication", "ApplyFromDetail", "LocateChat", "SendChatMessage", "PrepareChatBatch", "LocateChatFromBatch", "SendChatMessageFromBatch", "VerifyDelivery")]
    [string]$Action,
    [string]$ChromeProfileDirectory = "",
    [string]$ExpectationId = "",
    [string]$JobIdsBase64 = "",
    [string]$ExcludedJobIdsFile = "",
    [string]$ExcludedCompaniesBase64 = "",
    [string]$TitleFilterBase64 = "",
    [string]$SalaryTargetBase64 = "",
    [string]$PayloadBase64 = "",
    [ValidateRange(1, 1000)]
    [int]$Limit = 30,
    [ValidateRange(1, 60)]
    [int]$TargetNewCount = 30,
    [ValidateRange(1000, 60000)]
    [int]$ActionDelayMs = 2000,
    [ValidateRange(5000, 60000)]
    [int]$JobDetailSettleMinMs = 5000,
    [ValidateRange(5000, 60000)]
    [int]$JobDetailSettleMaxMs = 10000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)


function Test-SalaryOutsideTarget {
    param([string]$Salary, $Target)
    if ($null -eq $Target -or $null -eq $Target.salary_min_k -or $null -eq $Target.salary_max_k) { return $false }
    if ($Salary -notmatch '(?i)(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*K') { return $false }
    $minimum = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
    $maximum = [double]::Parse($Matches[2], [Globalization.CultureInfo]::InvariantCulture)
    if ($maximum -lt $minimum) { return $false }
    return ($maximum -lt [double]$Target.salary_min_k -or $minimum -gt [double]$Target.salary_max_k)
}

function Wait-JobDetail([switch]$Ready) {
    $minimum = if ($Ready) { 5000 } else { [Math]::Min($JobDetailSettleMinMs, $JobDetailSettleMaxMs) }
    $maximum = if ($Ready) { 7000 } else { [Math]::Max($JobDetailSettleMinMs, $JobDetailSettleMaxMs) }
    $delay = Get-Random -Minimum $minimum -Maximum ($maximum + 1)
    Start-Sleep -Milliseconds $delay
    return $delay
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BossWindowApi {
    [StructLayout(LayoutKind.Sequential)]
    public struct Point {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr parameter);

    public static IntPtr[] FindVisibleChromeWindows(int processId) {
        var found = new System.Collections.Generic.List<IntPtr>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr parameter) {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner != (uint)processId || !IsWindowVisible(hWnd)) return true;
            StringBuilder className = new StringBuilder(128);
            GetClassName(hWnd, className, className.Capacity);
            if (!className.ToString().StartsWith("Chrome_WidgetWin_")) return true;
            found.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }

    [DllImport("user32.dll")]
    public static extern bool GetPhysicalCursorPos(out Point point);

    [DllImport("user32.dll")]
    public static extern bool SetPhysicalCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@

function Text-FromCodes([int[]]$Codes) {
    return -join ($Codes | ForEach-Object { [char]$_ })
}

$recommendName = Text-FromCodes @(0x63A8, 0x8350)
$messageName = Text-FromCodes @(0x6D88, 0x606F)
$resumeName = Text-FromCodes @(0x7B80, 0x5386)
$loginName = Text-FromCodes @(0x767B, 0x5F55)
$registerName = Text-FromCodes @(0x6CE8, 0x518C)
$verificationName = Text-FromCodes @(0x5B89, 0x5168, 0x9A8C, 0x8BC1)
$captchaName = Text-FromCodes @(0x9A8C, 0x8BC1, 0x7801)
$descriptionHeading = Text-FromCodes @(0x804C, 0x4F4D, 0x63CF, 0x8FF0)
$addressHeading = Text-FromCodes @(0x5DE5, 0x4F5C, 0x5730, 0x5740)
$industryNames = @(
    (Text-FromCodes @(0x6240, 0x5C5E, 0x884C, 0x4E1A)),
    (Text-FromCodes @(0x884C, 0x4E1A))
)
$companySizeNames = @(
    (Text-FromCodes @(0x4EBA, 0x5458, 0x89C4, 0x6A21)),
    (Text-FromCodes @(0x516C, 0x53F8, 0x89C4, 0x6A21))
)
$startChatName = Text-FromCodes @(0x7ACB, 0x5373, 0x6C9F, 0x901A)
$continueChatName = Text-FromCodes @(0x7EE7, 0x7EED, 0x6C9F, 0x901A)
$stayHereName = Text-FromCodes @(0x7559, 0x5728, 0x6B64, 0x9875)
$sendName = Text-FromCodes @(0x53D1, 0x9001)
$sentName = Text-FromCodes @(0x5DF2, 0x53D1, 0x9001)
$sentToBossName = "$(Text-FromCodes @(0x5DF2, 0x5411))BOSS$(Text-FromCodes @(0x53D1, 0x9001, 0x6D88, 0x606F))"
$jobClosedName = Text-FromCodes @(0x804C, 0x4F4D, 0x5DF2, 0x5173, 0x95ED)
$headhunterName = Text-FromCodes @(0x730E, 0x5934)
$agencyCompanyName = Text-FromCodes @(0x4EE3, 0x62DB, 0x516C, 0x53F8)
$headhunterConsultantName = Text-FromCodes @(0x730E, 0x5934, 0x987E, 0x95EE)
$asciiColon = [char]0x003A
$fullwidthColon = [char]0xFF1A
$interestName = Text-FromCodes @(0x611F, 0x5174, 0x8DA3)
$communicateName = Text-FromCodes @(0x6C9F, 0x901A)
$deepChatName = Text-FromCodes @(0x6DF1, 0x804A)
$allContactsName = Text-FromCodes @(0x5168, 0x90E8)
$contactSearchName = Text-FromCodes @(0x641C, 0x7D22, 0x0033, 0x0030, 0x5929, 0x5185, 0x7684, 0x8054, 0x7CFB, 0x4EBA)
$middleDot = [char]0x00B7

function Clean-Text([object]$Value) {
    return ([string]$Value -replace '\s+', ' ').Trim()
}

function Wait-AfterAction([switch]$SendConfirmation) {
    $delay = if ($SendConfirmation) { $ActionDelayMs } else { Get-Random -Minimum 2000 -Maximum 4001 }
    Start-Sleep -Milliseconds $delay
}

function Get-Value([System.Windows.Automation.AutomationElement]$Element) {
    try {
        $pattern = $null
        if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            return [string]$pattern.Current.Value
        }
    } catch {}
    return ""
}

function Get-TextPatternValue([System.Windows.Automation.AutomationElement]$Element) {
    try {
        $pattern = $null
        if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
            return [string]$pattern.DocumentRange.GetText(-1)
        }
    } catch {}
    return ""
}

function Get-Root([object]$Window) {
    return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Window.MainWindowHandle)
}

function Get-Omnibox([System.Windows.Automation.AutomationElement]$Root) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit
    )
    $all = $Root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $condition
    )
    foreach ($element in $all) {
        try {
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
                $element.Current.ClassName -match "Omnibox") {
                return $element
            }
        } catch {}
    }
    return $null
}

function Get-CurrentAddress([System.Windows.Automation.AutomationElement]$Root, [switch]$ExplainFailure) {
    if (-not $ExplainFailure) {
        $omnibox = Get-Omnibox -Root $Root
        if (-not $omnibox) { return "" }
        return Get-Value -Element $omnibox
    }
    if (-not $Root) { throw 'address.root_missing' }
    try { $omnibox = Get-Omnibox -Root $Root }
    catch { throw ('address.omnibox_query_failed/' + $_.Exception.GetType().Name) }
    if (-not $omnibox) { throw 'address.omnibox_missing' }
    $pattern = $null
    try { $available = $omnibox.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) }
    catch { throw ('address.pattern_query_failed/' + $_.Exception.GetType().Name) }
    if (-not $available -or -not $pattern) { throw 'address.value_pattern_missing' }
    try { $value = [string]$pattern.Current.Value }
    catch { throw ('address.value_read_failed/' + $_.Exception.GetType().Name) }
    if (-not $value.Trim()) { throw 'address.value_empty' }
    return $value
}

function Test-ChromeProfileCommandLine([string]$CommandLine, [string]$ProfileDirectory) {
    if (-not $ProfileDirectory) { return $false }
    $match = [regex]::Match($CommandLine, '(?i)(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir=(?:"([^"]+)"|(\S+)))')
    if (-not $match.Success) { return $false }
    $candidateProfile = @($match.Groups | Select-Object -Skip 1 | Where-Object Success | Select-Object -First 1)[0].Value
    try {
        return [System.IO.Path]::GetFullPath($candidateProfile).TrimEnd([char[]]'\/') -ieq [System.IO.Path]::GetFullPath($ProfileDirectory).TrimEnd([char[]]'\/')
    } catch { return $false }
}

function Get-DedicatedChromeWindows([string]$ProfileDirectory) {
    if (-not $ProfileDirectory) { throw '本实例没有配置专用 Chrome 资料目录。' }
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue)) {
        if (-not (Test-ChromeProfileCommandLine -CommandLine ([string]$candidate.CommandLine) -ProfileDirectory $ProfileDirectory)) { continue }
        foreach ($windowHandle in @([BossWindowApi]::FindVisibleChromeWindows([int]$candidate.ProcessId))) {
            [pscustomobject]@{ Id = [int]$candidate.ProcessId; MainWindowHandle = $windowHandle; MainWindowTitle = '' }
        }
    }
}

function Test-ChromeMainWindow([System.Windows.Automation.AutomationElement]$Root) {
    if (-not $Root) { throw 'window.root_missing' }
    $rootId = @($Root.GetRuntimeId()) -join '.'
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $nodes = [System.Collections.Generic.List[object]]::new()
    $pending = [System.Collections.Generic.Queue[object]]::new()
    $pending.Enqueue($Root)
    while ($pending.Count) {
        foreach ($node in Get-RawChatNodes -Element $pending.Dequeue() -ChildrenOnly) {
            # Main-window chrome only; page widgets cannot identify a browser window.
            if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document -or
                [string]$node.Current.ClassName -ceq 'Chrome_RenderWidgetHostHWND') { continue }
            $nodes.Add($node)
            $pending.Enqueue($node)
        }
    }
    $tabBars = @($nodes | Where-Object {
        [string]$_.Current.ClassName -ceq 'TabContainerImpl' -and
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Tab -and
        (Get-ChromeBrowserOwner -Element $_ -RootId $rootId)
    })
    $omniboxes = @($nodes | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
        [string]$_.Current.ClassName -match 'Omnibox' -and
        (Get-ChromeBrowserOwner -Element $_ -RootId $rootId)
    })
    if ($tabBars.Count -gt 1 -or $omniboxes.Count -gt 1) { throw 'window.main_structure_ambiguous' }
    if ($tabBars.Count -eq 1 -and $omniboxes.Count -eq 1) {
        $tabOwner = Get-ChromeBrowserOwner -Element $tabBars[0] -RootId $rootId
        $addressOwner = Get-ChromeBrowserOwner -Element $omniboxes[0] -RootId $rootId
        if ((@($tabOwner.GetRuntimeId()) -join '.') -ne (@($addressOwner.GetRuntimeId()) -join '.')) { throw 'window.main_structure_ambiguous' }
    }
    if ($omniboxes.Count -eq 1) { return $true }
    if ($tabBars.Count -eq 1 -and @(Get-RawChatNodes -Element $tabBars[0] -ChildrenOnly | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem
    }).Count -gt 0) { return $true }
    if (@($nodes | Where-Object { [string]$_.Current.ClassName -in @('BrowserView','TabContainerImpl') -or [string]$_.Current.ClassName -match 'Omnibox' }).Count) {
        throw 'window.main_structure_incomplete'
    }
    $frames = @($nodes | Where-Object { [string]$_.Current.ClassName -ceq 'BubbleFrameView' })
    if ($frames.Count -eq 1) {
        $nonClient = $walker.GetParent($frames[0])
        $rootView = $walker.GetParent($nonClient)
        if ([string]$nonClient.Current.ClassName -ceq 'NonClientView' -and [string]$rootView.Current.ClassName -ceq 'RootView' -and
            (@($walker.GetParent($rootView).GetRuntimeId()) -join '.') -eq $rootId) { return $false }
    }
    throw 'window.structure_unrecognized'
}

function Get-BossWindow {
    $candidates = [System.Collections.Generic.List[object]]::new()
    $windows = @(Get-DedicatedChromeWindows -ProfileDirectory $ChromeProfileDirectory)
    foreach ($window in $windows) {
        try {
            $root = Get-Root -Window $window
            $window.MainWindowTitle = [string]$root.Current.Name
            $address = Get-CurrentAddress -Root $root
            if ($address -match "(^|\.)zhipin\.com/|^https://www\.zhipin\.com/") {
                $candidates.Add([pscustomobject]@{ Window = $window; Root = $root; Address = $address })
            }
        } catch {}
    }
    if ($candidates.Count -eq 0) { throw '没有找到本实例的 BOSS 窗口，请打开本实例专用 Chrome 并登录。' }
    if ($candidates.Count -gt 1) { throw '本实例专用 Chrome 中有多个 BOSS 窗口，请只保留其中一个 BOSS 窗口。' }
    return $candidates[0]
}

function Set-VerifiedForegroundWindow([IntPtr]$WindowHandle, [switch]$SkipWait) {
    if ($WindowHandle -eq [IntPtr]::Zero) { return $false }
    if ([BossWindowApi]::GetForegroundWindow() -eq $WindowHandle) { return $true }
    if ([BossWindowApi]::IsIconic($WindowHandle)) {
        [void][BossWindowApi]::ShowWindowAsync($WindowHandle, 9)
    }
    $foregroundHandle = [BossWindowApi]::GetForegroundWindow()
    $foregroundProcessId = [uint32]0
    $targetProcessId = [uint32]0
    $foregroundThreadId = if ($foregroundHandle -ne [IntPtr]::Zero) {
        [BossWindowApi]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundProcessId)
    } else { [uint32]0 }
    $targetThreadId = [BossWindowApi]::GetWindowThreadProcessId($WindowHandle, [ref]$targetProcessId)
    $currentThreadId = [BossWindowApi]::GetCurrentThreadId()
    $attachedForeground = $false
    $attachedTarget = $false
    try {
        if ($foregroundThreadId -ne 0 -and $foregroundThreadId -ne $currentThreadId) {
            $attachedForeground = [BossWindowApi]::AttachThreadInput($currentThreadId, $foregroundThreadId, $true)
        }
        if ($targetThreadId -ne 0 -and $targetThreadId -ne $currentThreadId) {
            $attachedTarget = [BossWindowApi]::AttachThreadInput($currentThreadId, $targetThreadId, $true)
        }
        [void][BossWindowApi]::BringWindowToTop($WindowHandle)
        [void][BossWindowApi]::SetForegroundWindow($WindowHandle)
        if (-not $SkipWait) { Start-Sleep -Milliseconds 120 }
        return [BossWindowApi]::GetForegroundWindow() -eq $WindowHandle
    } finally {
        if ($attachedTarget) { [void][BossWindowApi]::AttachThreadInput($currentThreadId, $targetThreadId, $false) }
        if ($attachedForeground) { [void][BossWindowApi]::AttachThreadInput($currentThreadId, $foregroundThreadId, $false) }
    }
}

function Focus-DedicatedChromeWindow([string]$ProfileDirectory, [string]$TargetUrl = '', [int]$WaitMilliseconds = 0) {
    if (-not $ProfileDirectory) { return $false }
    $deadline = (Get-Date).AddMilliseconds($WaitMilliseconds)
    do {
        $windows = @(Get-DedicatedChromeWindows -ProfileDirectory $ProfileDirectory)
        foreach ($window in $windows) {
            # The URL launch may still be loading or redirected to login. A sole
            # profile-owned window is unambiguous; UIA address readiness is not
            # a prerequisite for bringing it forward. Multiple windows still
            # require the requested URL before any foreground change.
            if ($TargetUrl -and $windows.Count -gt 1) {
                try {
                    $address = Get-CurrentAddress -Root (Get-Root -Window $window)
                    if (($address -replace '^https?://', '').TrimEnd('/') -ne ($TargetUrl -replace '^https?://', '').TrimEnd('/')) { continue }
                } catch { continue }
            }
            return Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$window.MainWindowHandle)
        }
        if ((Get-Date) -ge $deadline) { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Get-Tabs([System.Windows.Automation.AutomationElement]$Root) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::TabItem
    )
    $all = $Root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $condition
    )
    return @($all | Where-Object {
        try {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and -not $_.Current.IsOffscreen
        } catch { $false }
    } | Sort-Object { $_.Current.BoundingRectangle.Left })
}

function Get-TabRuntimeId([System.Windows.Automation.AutomationElement]$Tab) {
    if (-not $Tab) { return "" }
    try { return (@($Tab.GetRuntimeId()) -join ".") } catch { return "" }
}

function Get-SelectedTab([System.Windows.Automation.AutomationElement]$Root) {
    foreach ($tab in @(Get-Tabs -Root $Root)) {
        if (Test-TabSelected -Tab $tab) { return $tab }
    }
    return $null
}

function Find-TabByRuntimeId([System.Windows.Automation.AutomationElement]$Root, [string]$RuntimeId) {
    if (-not $RuntimeId) { return $null }
    foreach ($tab in @(Get-Tabs -Root $Root)) {
        if ((Get-TabRuntimeId -Tab $tab) -eq $RuntimeId) { return $tab }
    }
    return $null
}

function Test-TabSelected([System.Windows.Automation.AutomationElement]$Tab) {
    try {
        $pattern = $null
        if ($Tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
            return [bool]$pattern.Current.IsSelected
        }
    } catch {}
    return $false
}

function Select-Tab([System.Windows.Automation.AutomationElement]$Tab, [switch]$SkipWait) {
    $pattern = $null
    if (-not $Tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        throw "A Chrome tab did not expose SelectionItemPattern."
    }
    $pattern.Select()
    if (-not $SkipWait) { Wait-AfterAction }
}

function Activate-JobsPage([switch]$SkipWait) {
    $state = Get-BossWindow
    if (-not (Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$state.Window.MainWindowHandle) -SkipWait:$SkipWait)) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
    if (-not $SkipWait) { Start-Sleep -Milliseconds 250 }
    $document = Get-ActiveDocument -Root $state.Root
    $loginState = Get-LoginState -Document $document -Address $state.Address
    if ($loginState -in @('login_required', 'verification_required')) { return $state }
    if ($state.Address -match "/web/geek/jobs") { return Get-BossWindow }

    $omnibox = Get-Omnibox -Root $state.Root
    if (-not $omnibox) { throw "Chrome address bar was not found." }
    $valuePattern = $null
    if (-not $omnibox.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        throw "Chrome address bar does not expose ValuePattern."
    }
    $omnibox.SetFocus()
    $valuePattern.SetValue("https://www.zhipin.com/web/geek/jobs")
    [System.Windows.Forms.SendKeys]::SendWait('%{ENTER}')
    if (-not $SkipWait) { Wait-AfterAction }
    $opened = Get-BossWindow
    if ($opened.Address -notmatch "/web/geek/jobs") { throw "The BOSS jobs tab did not open as expected." }
    return $opened
}

function Activate-ChatPage {
    Add-ChatDiagnostic 'prepare.enter'
    $state = Get-BossWindow
    Add-ChatDiagnostic 'prepare.before' { @{is_chat=($state.Address -match '/web/geek/chat');process_id=$state.Window.Id;target_window=$state.Window.MainWindowHandle.ToInt64()} }
    Add-ChatDiagnostic 'prepare.before.document' { $script:chatBeforeDocumentId=@((Get-ActiveDocument -Root $state.Root).GetRuntimeId()); @{document_runtime_id=$script:chatBeforeDocumentId} }
    if (-not (Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$state.Window.MainWindowHandle))) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
    Start-Sleep -Milliseconds 250
    $omnibox = Get-Omnibox -Root $state.Root
    if (-not $omnibox) { throw "Chrome address bar was not found." }
    $valuePattern = $null
    if (-not $omnibox.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        throw "Chrome address bar does not expose ValuePattern."
    }
    $omnibox.SetFocus()
    $valuePattern.SetValue("https://www.zhipin.com/web/geek/chat")
    [System.Windows.Forms.SendKeys]::SendWait('%{ENTER}')
    [void](Wait-JobDetail)
    $opened = Get-BossWindow
    Add-ChatDiagnostic 'prepare.after' { @{is_chat=($opened.Address -match '/web/geek/chat');process_id=$opened.Window.Id;target_window=$opened.Window.MainWindowHandle.ToInt64();same_window=($opened.Window.MainWindowHandle -eq $state.Window.MainWindowHandle)} }
    if ($opened.Address -notmatch "/web/geek/chat") { throw "The BOSS chat tab did not open as expected." }
    return $opened
}

function Navigate-SelectedTab([string]$Url) {
    if ($Url -notmatch '^https://www\.zhipin\.com/job_detail/[^/?#]+\.html$') {
        throw "Only BOSS job detail URLs are allowed."
    }
    $state = Get-BossWindow
    if (-not (Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$state.Window.MainWindowHandle))) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
    Start-Sleep -Milliseconds 250
    $omnibox = Get-Omnibox -Root $state.Root
    if (-not $omnibox) { throw "Chrome address bar was not found." }
    $valuePattern = $null
    if (-not $omnibox.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        throw "Chrome address bar does not expose ValuePattern."
    }
    $omnibox.SetFocus()
    $valuePattern.SetValue($Url)
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    [void](Wait-JobDetail)
    return Get-BossWindow
}

function Activate-DetailPage([string]$Url, [string]$TabRuntimeId = "") {
    if ($Url -notmatch '^https://www\.zhipin\.com/job_detail/([^/?#]+)\.html$') {
        throw "Only BOSS job detail URLs are allowed."
    }
    $navigationClock = [Diagnostics.Stopwatch]::StartNew()
    $script:detailReadinessDiagnostic = [ordered]@{
        navigation = [ordered]@{ branch = 'pending'; elapsed_ms = $null; started_at = $null }
    }
    $targetJobId = $Matches[1]
    $state = Get-BossWindow
    if (-not (Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$state.Window.MainWindowHandle))) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
    Start-Sleep -Milliseconds 250
    $startedAt = Get-Date
    $script:detailReadinessDiagnostic.navigation.started_at = $startedAt.ToUniversalTime().ToString('o')
    if ($state.Address -match "/job_detail/$([regex]::Escape($targetJobId))\.html(?:[?#]|$)") {
        $script:detailReadinessDiagnostic.navigation.branch = 'current_detail'
        $script:detailReadinessDiagnostic.navigation.elapsed_ms = $navigationClock.Elapsed.TotalMilliseconds
        return [pscustomobject]@{ Root = $state.Root; PreviousTabId = ''; PreviousDocumentId = ''; StartedAt = $startedAt }
    }

    $tab = Find-TabByRuntimeId -Root $state.Root -RuntimeId $TabRuntimeId
    if ($tab) {
        if (-not (Test-TabSelected -Tab $tab)) { Select-Tab -Tab $tab -SkipWait }
        $candidate = Get-BossWindow
        if ($candidate.Address -match "/job_detail/$([regex]::Escape($targetJobId))\.html(?:[?#]|$)") {
            $script:detailReadinessDiagnostic.navigation.branch = 'existing_tab'
            $script:detailReadinessDiagnostic.navigation.elapsed_ms = $navigationClock.Elapsed.TotalMilliseconds
            return [pscustomobject]@{ Root = $candidate.Root; PreviousTabId = ''; PreviousDocumentId = ''; StartedAt = $startedAt }
        }
    }

    $script:detailReadinessDiagnostic.navigation.branch = 'open_detail'
    $navigation = Open-DetailPage -Url $Url
    $script:detailReadinessDiagnostic.navigation.started_at = $navigation.StartedAt.ToUniversalTime().ToString('o')
    $script:detailReadinessDiagnostic.navigation.elapsed_ms = $navigationClock.Elapsed.TotalMilliseconds
    return $navigation
}

function Open-DetailPage([string]$Url, [object]$Interval = $null) {
    if ($Url -notmatch '^https://www\.zhipin\.com/job_detail/[^/?#]+\.html$') {
        throw "Only BOSS job detail URLs are allowed."
    }
    $state = Get-BossWindow
    if (-not (Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$state.Window.MainWindowHandle))) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
    Start-Sleep -Milliseconds 250
    $previousTabId = Get-TabRuntimeId -Tab (Get-SelectedTab -Root $state.Root)
    $previousDocumentId = ''
    try {
        $previousDocument = Get-ActiveDocument -Root $state.Root
        $previousDocumentId = @($previousDocument.GetRuntimeId()) -join '.'
    } catch {
        if ($_.Exception.Message -ne 'The active web document was not found.' -and $_.Exception.Message -notlike 'The active web document was not found: *') { throw }
    }
    if (-not $previousTabId) { throw "Current tab identity is unavailable." }
    $omnibox = Get-Omnibox -Root $state.Root
    if (-not $omnibox) { throw "Chrome address bar was not found." }
    $valuePattern = $null
    if (-not $omnibox.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        throw "Chrome address bar does not expose ValuePattern."
    }
    $omnibox.SetFocus()
    $valuePattern.SetValue($Url)
    $remainingWaitMs = 0
    if ($null -ne $Interval) {
        # All return/save/ensure/PS startup and navigation preparation already consume this budget.
        $remainingWaitMs = [Math]::Max(0, [long]$Interval.ready_at_ms + [int]$Interval.target_ms - ([DateTimeOffset](Get-Date)).ToUnixTimeMilliseconds())
        if ($remainingWaitMs -gt 0) { Start-Sleep -Milliseconds ([int]$remainingWaitMs) }
        # Never send the navigation key to another window after the interval wait.
        if ([BossWindowApi]::GetForegroundWindow() -ne [IntPtr]$state.Window.MainWindowHandle) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
    }
    $startedAt = Get-Date
    [System.Windows.Forms.SendKeys]::SendWait('%{ENTER}')
    $navigation = [pscustomobject]@{ Root = $state.Root; PreviousTabId = $previousTabId; PreviousDocumentId = $previousDocumentId; StartedAt = $startedAt }
    if ($null -ne $Interval) {
        $navigation | Add-Member -NotePropertyName IntervalDiagnostic -NotePropertyValue ([pscustomobject]@{
            previous_ready_at_ms = [long]$Interval.ready_at_ms; previous_target_ms = [int]$Interval.target_ms
            navigation_started_at_ms = ([DateTimeOffset]$startedAt).ToUnixTimeMilliseconds(); remaining_wait_ms = [int]$remainingWaitMs
        })
    }
    return $navigation
}

function Close-SelectedTabsToCount([int]$RemainingCount) {
    $remaining = [Math]::Max(1, [Math]::Min(2, $RemainingCount))
    $closed = 0
    while (@(Get-Tabs -Root (Get-BossWindow).Root).Count -gt $remaining) {
        $state = Get-BossWindow
        if (-not (Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$state.Window.MainWindowHandle))) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
        [System.Windows.Forms.SendKeys]::SendWait('^w')
        Start-Sleep -Milliseconds 250
        $closed += 1
    }
    return $closed
}

function Decode-Payload {
    if (-not $PayloadBase64) { throw "A payload is required." }
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
    return $json | ConvertFrom-Json
}

function Get-PayloadText([object]$Payload, [string]$Name) {
    $property = $Payload.PSObject.Properties[$Name]
    if (-not $property) { return "" }
    return Clean-Text $property.Value
}

$script:detailReadinessDiagnostic = $null
$script:chatDiagnostics = $null
$script:chatDiagnosticWindow = $null
$script:chatBeforeDocumentId = $null
function Add-ChatDiagnostic([string]$Stage, [scriptblock]$Read = $null) {
    if ($null -eq $script:chatDiagnostics) { return }
    try {
        $fields = if ($Read) { & $Read } else { @{} }
        $entry = [ordered]@{ stage = $Stage }
        foreach ($key in $fields.Keys) { $entry[$key] = $fields[$key] }
        $script:chatDiagnostics.Add([pscustomobject]$entry)
    } catch {
        $diagnosticError = $_.Exception.GetType().Name
        try { $script:chatDiagnostics.Add([pscustomobject]@{stage=$Stage;diagnostic_error_type=$diagnosticError}) } catch {}
    }
}
function Add-ChatForegroundDiagnostic([string]$Stage) {
    Add-ChatDiagnostic $Stage {
        $foreground = [BossWindowApi]::GetForegroundWindow().ToInt64()
        @{ foreground_window=$foreground; target_window=$script:chatDiagnosticWindow; foreground_matches_target=$(if($null -ne $script:chatDiagnosticWindow){$foreground -eq $script:chatDiagnosticWindow}else{$null}) }
    }
}

function Invoke-Element([System.Windows.Automation.AutomationElement]$Element, [object]$ActionAudit = $null) {
    try {
    $invoke = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        if ($ActionAudit) { $ActionAudit.method = 'invoke' }
        if ($ActionAudit) { Add-ChatForegroundDiagnostic 'invoke.enter' }
        $invoke.Invoke()
        if ($ActionAudit) { Add-ChatDiagnostic 'invoke.return' { @{call_completed=$true} }; Add-ChatForegroundDiagnostic 'invoke.after' }
        if ($ActionAudit) { $ActionAudit.action_returned = $true }
        return
    }
    $selection = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
        if ($ActionAudit) { $ActionAudit.method = 'selection' }
        if ($ActionAudit) { Add-ChatForegroundDiagnostic 'selection.enter' }
        $selection.Select()
        if ($ActionAudit) { Add-ChatDiagnostic 'selection.return' { @{call_completed=$true} }; Add-ChatForegroundDiagnostic 'selection.after' }
        if ($ActionAudit) { $ActionAudit.action_returned = $true }
        return
    }
    throw "The requested element is not invokable or selectable."
    } catch {
        $originalError = $_
        if ($ActionAudit) { Add-ChatDiagnostic 'pattern.exception' { @{error_type=$originalError.Exception.GetType().Name} } }
        throw $originalError
    }
}

function Click-Element([System.Windows.Automation.AutomationElement]$Element, [object]$ActionAudit = $null) {
    try {
    $state = Get-BossWindow
    if ($ActionAudit) { Add-ChatDiagnostic 'pointer.target' { $script:chatDiagnosticWindow=$state.Window.MainWindowHandle.ToInt64(); @{process_id=$state.Window.Id;target_window=$script:chatDiagnosticWindow} }; Add-ChatForegroundDiagnostic 'pointer.focus.before' }
    if (-not (Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$state.Window.MainWindowHandle))) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
    if ($ActionAudit) { Add-ChatForegroundDiagnostic 'pointer.focus.verified' }
    if ($ActionAudit) { $ActionAudit.method = 'pointer'; $ActionAudit.process_id = $state.Window.Id; $ActionAudit.window_handle = $state.Window.MainWindowHandle.ToInt64() }
    $bounds = $Element.Current.BoundingRectangle
    $point = $null
    try {
        $point = $Element.GetClickablePoint()
    } catch { if ($ActionAudit) { $ActionAudit.point_error_type = $_.Exception.GetType().Name } }
    $xValue = if ($point) { [double]$point.X } else { [double]($bounds.Left + ($bounds.Width / 2)) }
    $yValue = if ($point) { [double]$point.Y } else { [double]($bounds.Top + ($bounds.Height / 2)) }
    if ([double]::IsNaN($xValue) -or [double]::IsInfinity($xValue) -or
        [double]::IsNaN($yValue) -or [double]::IsInfinity($yValue) -or
        $xValue -lt [int]::MinValue -or $xValue -gt [int]::MaxValue -or
        $yValue -lt [int]::MinValue -or $yValue -gt [int]::MaxValue) {
        throw "The requested element does not have a finite clickable point."
    }
    $x = [int]$xValue
    $y = [int]$yValue
    if ($ActionAudit) {
        $ActionAudit.point_source = if ($point) { 'clickable_point' } else { 'bounds_center' }
        $ActionAudit.point = [pscustomobject]@{ x = $x; y = $y }
        $ActionAudit.bounds = [pscustomobject]@{ left = $bounds.Left; top = $bounds.Top; width = $bounds.Width; height = $bounds.Height }
    }
    if ($ActionAudit) { Add-ChatDiagnostic 'pointer.request' { @{point_x=$x;point_y=$y;bounds_left=$bounds.Left;bounds_top=$bounds.Top;bounds_width=$bounds.Width;bounds_height=$bounds.Height;point_source=$ActionAudit.point_source} } }
    $previous = [BossWindowApi+Point]::new()
    $readCursor = [BossWindowApi]::GetPhysicalCursorPos([ref]$previous)
    if ($ActionAudit) { Add-ChatDiagnostic 'pointer.previous' { @{api_result=$readCursor} } }
    if (-not $readCursor) { throw "Unable to read the physical cursor position; no click attempted." }
    $movedCursor = [BossWindowApi]::SetPhysicalCursorPos($x, $y)
    if ($ActionAudit) { Add-ChatDiagnostic 'pointer.move' { @{api_result=$movedCursor} } }
    if (-not $movedCursor) { throw "Unable to set the physical cursor position; no click attempted." }
    if ($ActionAudit) {
        Add-ChatDiagnostic 'pointer.moved' {
            $actual = [BossWindowApi+Point]::new()
            $readActual = [BossWindowApi]::GetPhysicalCursorPos([ref]$actual)
            $fields = @{api_result=$readActual}
            if ($readActual) { $fields.actual_x=$actual.X; $fields.actual_y=$actual.Y; $fields.point_matches_request=($actual.X -eq $x -and $actual.Y -eq $y) }
            $fields
        }
        Add-ChatForegroundDiagnostic 'pointer.down.enter'
    }
    [BossWindowApi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    if ($ActionAudit) { Add-ChatDiagnostic 'pointer.down.return' { @{call_completed=$true} }; Add-ChatDiagnostic 'pointer.up.enter' }
    [BossWindowApi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    if ($ActionAudit) { Add-ChatDiagnostic 'pointer.up.return' { @{call_completed=$true} }; Add-ChatForegroundDiagnostic 'pointer.after'; $ActionAudit.action_returned = $true }
    Start-Sleep -Milliseconds 250
    $restoredCursor = [BossWindowApi]::SetPhysicalCursorPos($previous.X, $previous.Y)
    if ($ActionAudit) { Add-ChatDiagnostic 'pointer.restore' { @{api_result=$restoredCursor} } }
    } catch {
        $originalError = $_
        if ($ActionAudit) { Add-ChatDiagnostic 'pointer.exception' { @{error_type=$originalError.Exception.GetType().Name} } }
        throw $originalError
    }
}

function Get-InlineDetailRoot([System.Windows.Automation.AutomationElement]$Document) {
    try {
        if ([string]$Document.Current.ClassName -ceq 'job-detail-container') { return $Document }
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        $panels = @(Get-RawChatNodes -Element $Document | Where-Object {
            -not $_.Current.IsOffscreen -and [string]$_.Current.ClassName -ceq 'job-detail-container' -and
            [string]$walker.GetParent($_).Current.ClassName -cmatch '(^|\s)page-jobs-main(\s|$)'
        })
        if ($panels.Count -eq 1) { return $panels[0] }
    } catch {}
    return $null
}

function Find-VisibleButton([System.Windows.Automation.AutomationElement]$Document, [string[]]$Names, [switch]$RightSide) {
    $nodes = @()
    $isCommunication = $RightSide -or @($Names | Where-Object { $_ -in @($startChatName, $continueChatName) }).Count -gt 0
    if ($isCommunication) {
        $inline = Get-InlineDetailRoot -Document $Document
        if ($inline) {
            $nodes = @(Get-RawChatNodes -Element $inline -ChildrenOnly | Where-Object { [string]$_.Current.ClassName -cmatch '(^|\s)op-btn-chat(\s|$)' })
        } else {
            $regions = Get-DetailRegions -Document $Document
            if (-not $regions) { return $null }
            $containers = @(Get-RawChatNodes -Element $regions.Info -ChildrenOnly | Where-Object { [string]$_.Current.ClassName -ceq 'btn-container' })
            if ($containers.Count -ne 1) { return $null }
            $nodes = @(Get-RawChatNodes -Element $containers[0])
        }
    } else { $nodes = @(Get-DocumentNodes -Document $Document) }
    $matches = @($nodes | Where-Object {
        try {
            -not $_.Current.IsOffscreen -and $_.Current.ControlType -in @([System.Windows.Automation.ControlType]::Button,[System.Windows.Automation.ControlType]::Hyperlink) -and
            (Clean-Text $_.Current.Name) -in $Names
        } catch { $false }
    })
    if ($isCommunication) { if ($matches.Count -eq 1) { return $matches[0] }; return $null }
    return ($matches | Select-Object -First 1)
}

function Get-RawChatNodes([System.Windows.Automation.AutomationElement]$Element, [switch]$ChildrenOnly) {
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $nodes = [System.Collections.Generic.List[object]]::new()
    $pending = [System.Collections.Generic.Queue[object]]::new()
    $pending.Enqueue($Element)
    while ($pending.Count) {
        $parent = $pending.Dequeue()
        $child = $walker.GetFirstChild($parent)
        while ($null -ne $child) {
            $nodes.Add($child)
            if (-not $ChildrenOnly) { $pending.Enqueue($child) }
            $child = $walker.GetNextSibling($child)
        }
    }
    return @($nodes.ToArray())
}

function Get-CurrentChatRegion([System.Windows.Automation.AutomationElement]$Document, [string]$ClassName) {
    $conversations = @(Get-RawChatNodes -Element $Document | Where-Object {
        -not $_.Current.IsOffscreen -and [string]$_.Current.ClassName -cmatch '(^|\s)chat-conversation(\s|$)'
    })
    if ($conversations.Count -ne 1) { return $null }
    $regions = @(Get-RawChatNodes -Element $conversations[0] -ChildrenOnly | Where-Object {
        [string]$_.Current.ClassName -cmatch ('(^|\s)' + [regex]::Escape($ClassName) + '(\s|$)')
    })
    if ($regions.Count -ne 1 -or $regions[0].Current.IsOffscreen) { return $null }
    return $regions[0]
}

function Get-ChatSendButtonCandidates([System.Windows.Automation.AutomationElement]$Document) {
    try {
        $editor = Get-CurrentChatRegion -Document $Document -ClassName 'chat-editor'
        if (-not $editor) { return @() }
        $operations = @(Get-RawChatNodes -Element $editor -ChildrenOnly | Where-Object {
            [string]$_.Current.ClassName -cmatch '(^|\s)chat-op(\s|$)'
        })
        if ($operations.Count -ne 1) { return @() }
        return @(Get-RawChatNodes -Element $operations[0] -ChildrenOnly | Where-Object {
            [string]$_.Current.ClassName -cmatch '(^|\s)btn-send(\s|$)' -and
            $_.Current.ControlType -in @([System.Windows.Automation.ControlType]::Button, [System.Windows.Automation.ControlType]::Hyperlink) -and
            (Clean-Text $_.Current.Name) -eq $sendName
        })
    } catch { return @() }
}

function Get-ChatSendTarget([object]$State, [System.Windows.Automation.AutomationElement]$Document, [object]$ChatInput, [object]$Expected, [string]$Message) {
    $buttons = @(Get-ChatSendButtonCandidates -Document $Document)
    if ($buttons.Count -ne 1) { return $null }
    if (-not $buttons[0].Current.IsOffscreen) { return [pscustomobject]@{ Button = $buttons[0]; Input = $ChatInput } }

    # Only reveal an unambiguous, named chat send control. Never invoke a hidden
    # control, scroll arbitrary containers, or fall back to Enter/coordinates.
    $buttonId = @($buttons[0].GetRuntimeId()) -join '.'
    $documentId = @($Document.GetRuntimeId()) -join '.'
    $inputId = @($ChatInput.Element.GetRuntimeId()) -join '.'
    if (-not $buttonId -or -not $documentId -or -not $inputId) { return $null }
    $scrollItem = $null
    if (-not $buttons[0].TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scrollItem)) { return $null }
    $scrollItem.ScrollIntoView()
    Start-Sleep -Milliseconds 250

    # Layout can change while scrolling. Re-read the same window/document and
    # recipient/body before returning any control to the existing single send.
    $current = Get-BossWindow
    if ($current.Window.Id -ne $State.Window.Id -or
        $current.Window.MainWindowHandle -ne $State.Window.MainWindowHandle -or
        $current.Address -ne $State.Address) { throw 'chat_send_context_changed_after_scroll' }
    $currentDocument = Get-ActiveDocument -Root $current.Root
    if ((@($currentDocument.GetRuntimeId()) -join '.') -ne $documentId) { throw 'chat_send_document_changed_after_scroll' }
    $header = Read-ChatHeader -Document $currentDocument
    $headerMatch = Test-ChatHeader -Header $header -Expected $Expected
    Add-ChatDiagnostic 'header.after_scroll' { $header.structure + @{matched=[bool]$headerMatch.matched;missing_fields=@($headerMatch.missing_fields)} }
    if (-not $headerMatch.matched) { throw 'chat_send_recipient_changed_after_scroll' }
    $inputs = @(Find-ChatInput -Document $currentDocument)
    if (-not $inputs.Count -or (@($inputs[0].Element.GetRuntimeId()) -join '.') -ne $inputId) { throw 'chat_send_input_changed_after_scroll' }
    $value = Get-Value -Element $inputs[0].Element
    if (-not $value) { $value = Clean-Text $inputs[0].Element.Current.Name }
    if (-not $value) { $value = Clean-Text (Get-TextPatternValue -Element $inputs[0].Element) }
    if ((Clean-Text $value) -ne (Clean-Text $Message)) { throw 'chat_send_body_changed_after_scroll' }
    $buttons = @(Get-ChatSendButtonCandidates -Document $currentDocument)
    if ($buttons.Count -ne 1 -or $buttons[0].Current.IsOffscreen -or
        (@($buttons[0].GetRuntimeId()) -join '.') -ne $buttonId) { return $null }
    return [pscustomobject]@{ Button = $buttons[0]; Input = $inputs[0] }
}

function Find-DetailChatSendButton([System.Windows.Automation.AutomationElement]$Document) {
    foreach ($node in Get-DocumentNodes -Document $Document) {
        try {
            if ($node.Current.IsOffscreen -or
                $node.Current.ControlType -ne [System.Windows.Automation.ControlType]::Group -or
                $node.Current.ClassName -ne "send-message") { continue }
            $invoke = $null
            if ($node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
                return $node
            }
        } catch {}
    }
    return Find-VisibleButton -Document $Document -Names @($sendName)
}

function Test-SummaryMatches([object]$Summary, [object]$Expected) {
    $mismatches = [System.Collections.Generic.List[string]]::new()
    foreach ($field in @("title", "company", "salary", "city")) {
        $expectedValue = Get-PayloadText -Payload $Expected -Name $field
        if (-not $expectedValue) { continue }
        $actualValue = Clean-Text $Summary.$field
        if (-not $actualValue -or
            ($actualValue -notlike "*$expectedValue*" -and $expectedValue -notlike "*$actualValue*")) {
            $mismatches.Add("${field}: expected '$expectedValue', actual '$actualValue'")
        }
    }
    return [pscustomobject]@{ matched = $mismatches.Count -eq 0; mismatches = @($mismatches) }
}

function Get-DetailRegions([System.Windows.Automation.AutomationElement]$Document) {
    try {
        $wrappers = @(Get-RawChatNodes -Element $Document | Where-Object {
            [string]$_.Current.ClassName -cmatch '(^|\s)job-body-wrapper(\s|$)'
        })
        if ($wrappers.Count -ne 1) { return $null }
        $primary = @(Get-RawChatNodes -Element $wrappers[0] | Where-Object {
            [string]$_.Current.ClassName -cmatch '(^|\s)job-primary(\s|$)' -and
            [string]$_.Current.ClassName -cmatch '(^|\s)detail-box(\s|$)'
        })
        if ($primary.Count -ne 1) { return $null }
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        $main = $walker.GetParent($primary[0])
        $details = @(Get-RawChatNodes -Element $main -ChildrenOnly | Where-Object {
            [string]$_.Current.ClassName -cmatch '(^|\s)job-detail(\s|$)'
        })
        $info = @(Get-RawChatNodes -Element $primary[0] -ChildrenOnly | Where-Object {
            [string]$_.Current.ClassName -cmatch '(^|\s)info-primary(\s|$)'
        })
        if ($details.Count -ne 1 -or $info.Count -ne 1) { return $null }
        return [pscustomobject]@{ Main = $main; Primary = $primary[0]; Info = $info[0]; Detail = $details[0] }
    } catch { return $null }
}

function Read-DetailHeader([System.Windows.Automation.AutomationElement]$Document) {
    $values = @()
    $statusValues = @()
    $ok = $false
    try {
        $regions = Get-DetailRegions -Document $Document
        if ($regions) {
            $statusValues = @(Get-RawChatNodes -Element $regions.Info | Where-Object {
                -not $_.Current.IsOffscreen -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and
                (Clean-Text $_.Current.Name) -match [regex]::Escape($jobClosedName)
            } | ForEach-Object { Clean-Text $_.Current.Name } | Select-Object -Unique)
            $nameGroups = @(Get-RawChatNodes -Element $regions.Info -ChildrenOnly | Where-Object {
                [string]$_.Current.ClassName -ceq 'name' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group
            })
            if ($nameGroups.Count -eq 1) {
                $title = @(Get-RawChatNodes -Element $nameGroups[0] -ChildrenOnly | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text })
                $salary = @(Get-RawChatNodes -Element $nameGroups[0] -ChildrenOnly | Where-Object { [string]$_.Current.ClassName -ceq 'salary' })
                $city = @(Get-RawChatNodes -Element $regions.Info | Where-Object { [string]$_.Current.ClassName -cmatch '(^|\s)text-city(\s|$)' })
                $mainChildren = @(Get-RawChatNodes -Element $regions.Main -ChildrenOnly)
                $heading = Text-FromCodes @(0x516C,0x53F8,0x57FA,0x672C,0x4FE1,0x606F)
                $headings = @($mainChildren | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and (Clean-Text $_.Current.Name) -eq $heading })
                $ends = @($mainChildren | Where-Object { [string]$_.Current.ClassName -ceq 'look-all' })
                if ($title.Count -eq 1 -and $salary.Count -eq 1 -and $city.Count -eq 1 -and $headings.Count -eq 1 -and $ends.Count -eq 1) {
                    $salaryTexts = @(Get-RawChatNodes -Element $salary[0] -ChildrenOnly | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text })
                    $companyValues = [System.Collections.Generic.List[string]]::new()
                    $companies = [System.Collections.Generic.List[string]]::new()
                    $inside = $false
                    $ended = $false
                    foreach ($child in $mainChildren) {
                        if ((@($child.GetRuntimeId()) -join '.') -eq (@($headings[0].GetRuntimeId()) -join '.')) { $inside = $true; continue }
                        if (-not $inside) { continue }
                        if ((@($child.GetRuntimeId()) -join '.') -eq (@($ends[0].GetRuntimeId()) -join '.')) { $ended = $true; break }
                        if ($child.Current.ControlType -notin @([System.Windows.Automation.ControlType]::Text,[System.Windows.Automation.ControlType]::Hyperlink)) { throw 'Unknown company header child.' }
                        $text = Clean-Text $child.Current.Name
                        if (-not $text) { throw 'Empty company header field.' }
                        if ($child.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink) {
                            $link = $null
                            if ($child.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$link) -and
                                [string]$link.Current.Value -match '^https://(?:www\.)?zhipin\.com/gongsi/[^/?#]+\.html(?:[?#].*)?$') { $companies.Add($text) }
                        }
                        $companyValues.Add($text)
                    }
                    $companyNames = @($companies | Select-Object -Unique)
                    if ($salaryTexts.Count -eq 1 -and $ended -and $companyNames.Count -eq 1 -and $companyValues.Count -gt 0 -and $companyValues[0] -eq $companyNames[0]) {
                        $values = @((Clean-Text $title[0].Current.Name), (Clean-Text $salaryTexts[0].Current.Name), (Clean-Text $city[0].Current.Name), $heading) + @($companyValues | Select-Object -Unique)
                        $ok = @($values | Where-Object { -not $_ }).Count -eq 0
                    }
                }
            }
        }
    } catch { $ok = $false }
    if (-not $ok) { $values = @() }
    return [pscustomobject]@{ text = ((@($values) + @($statusValues)) -join ' | '); values = $values; structure = [pscustomobject]@{ structure_ok = $ok } }
}

function Get-DetailSummaryFromHeader([object]$Header, [object]$Fallback) {
    $values = @($Header.values)
    $salaryIndex = -1
    for ($index = 0; $index -lt $values.Count; $index += 1) {
        if ((Clean-Text $values[$index]) -match '^(?:[0-9]+(?:\.[0-9]+)?-[0-9]+(?:\.[0-9]+)?K(?:[\u00B7\.]?[0-9]+\u85AA)?|\u9762\u8BAE)$') {
            $salaryIndex = $index
            break
        }
    }
    $companyHeading = Text-FromCodes @(0x516C, 0x53F8, 0x57FA, 0x672C, 0x4FE1, 0x606F)
    $allJobsText = Text-FromCodes @(0x67E5, 0x770B, 0x5168, 0x90E8, 0x804C, 0x4F4D)
    $companyIndex = [Array]::IndexOf($values, $companyHeading)
    $company = Get-PayloadText -Payload $Fallback -Name 'company'
    $industry = Get-PayloadText -Payload $Fallback -Name 'industry'
    $companySize = Get-PayloadText -Payload $Fallback -Name 'company_size'
    if ($companyIndex -ge 0 -and ($companyIndex + 1) -lt $values.Count) {
        $company = Clean-Text $values[$companyIndex + 1]
        $companyEnd = [Array]::IndexOf($values, $allJobsText, $companyIndex + 1)
        if ($companyEnd -lt 0) { $companyEnd = [Math]::Min($values.Count, $companyIndex + 8) }
        for ($index = $companyIndex + 2; $index -lt $companyEnd; $index += 1) {
            $candidate = Clean-Text $values[$index]
            if (-not $companySize -and $candidate -match '^(?:\u5C11\u4E8E)?[0-9]+(?:\s*-\s*[0-9]+)?\s*\u4EBA(?:\u4EE5\u4E0A|\u4EE5\u4E0B)?$') {
                $companySize = $candidate -replace '\s+', ''
                continue
            }
            if (-not $industry -and $candidate -and
                $candidate -notmatch '^(?:\u672A\u878D\u8D44|\u4E0D\u9700\u8981\u878D\u8D44|\u5929\u4F7F\u8F6E|[A-Z]\u8F6E|[A-Z]\u8F6E\u53CA\u4EE5\u4E0A|\u5DF2\u4E0A\u5E02|\u6218\u7565\u878D\u8D44)$' -and
                $candidate -notmatch '\u4EBA(?:\u4EE5\u4E0A|\u4EE5\u4E0B)?$') {
                $industry = $candidate
            }
        }
    }
    return [pscustomobject]@{
        title = if ($salaryIndex -gt 0) { Clean-Text $values[$salaryIndex - 1] } else { Get-PayloadText -Payload $Fallback -Name 'title' }
        company = $company
        salary = if ($salaryIndex -ge 0) { Clean-Text $values[$salaryIndex] } else { Get-PayloadText -Payload $Fallback -Name 'salary' }
        city = if ($salaryIndex -ge 0 -and ($salaryIndex + 1) -lt $values.Count) { Clean-Text $values[$salaryIndex + 1] } else { Get-PayloadText -Payload $Fallback -Name 'city' }
        industry = $industry
        company_size = $companySize
    }
}

function Test-DetailHeader([object]$Header, [object]$Expected) {
    if (-not $Header.structure -or -not $Header.structure.structure_ok) {
        return [pscustomobject]@{ matched = $false; missing_fields = @('detail_structure') }
    }
    $missing = [System.Collections.Generic.List[string]]::new()
    $headerText = (Clean-Text $Header.text) -replace '\s+', '' -replace [regex]::Escape([string]$middleDot), ''
    foreach ($field in @('title', 'company', 'salary', 'city')) {
        $expectedValue = Get-PayloadText -Payload $Expected -Name $field
        if (-not $expectedValue) { continue }
        $normalized = (Clean-Text $expectedValue) -replace '\s+', '' -replace [regex]::Escape([string]$middleDot), ''
        if (-not $headerText.Contains($normalized)) { $missing.Add($field) }
    }
    return [pscustomobject]@{ matched = $missing.Count -eq 0; missing_fields = @($missing) }
}

function Get-FixedGreeting([System.Windows.Automation.AutomationElement]$Document) {
    foreach ($node in Get-DocumentNodes -Document $Document) {
        try {
            if ($node.Current.IsOffscreen) { continue }
            $name = Clean-Text $node.Current.Name
            if ($name.Length -ge 10 -and $name.Length -le 120 -and
                $name -match [regex]::Escape($interestName) -and
                ($name -match [regex]::Escape($communicateName) -or $name -match [regex]::Escape($deepChatName))) {
                if ($name.StartsWith($sentName)) { return $name.Substring($sentName.Length).Trim() }
                return $name
            }
        } catch {}
    }
    return ""
}

function Test-GreetingConfirmation([System.Windows.Automation.AutomationElement]$Document, [string]$FixedGreeting) {
    $sentVisible = $false
    $greetingVisible = $false
    foreach ($node in Get-DocumentNodes -Document $Document) {
        try {
            if ($node.Current.IsOffscreen) { continue }
            $name = Clean-Text $node.Current.Name
            if ($name -match [regex]::Escape($sentToBossName)) { return $true }
            if ($name -eq $sentName) { $sentVisible = $true }
            if ($FixedGreeting -and $name -eq $FixedGreeting) { $greetingVisible = $true }
            if ($FixedGreeting -and $name.StartsWith($sentName) -and
                $name.Substring($sentName.Length).Trim() -eq $FixedGreeting) {
                $sentVisible = $true
                $greetingVisible = $true
            }
        } catch {}
    }
    return $sentVisible -and $greetingVisible
}

function Read-ChatHeader([System.Windows.Automation.AutomationElement]$Document) {
    $structure = @{structure_ok=$false;structure_status='conversation_missing';conversation_count=0;user_info_count=0;position_count=0}
    $values = [System.Collections.Generic.List[string]]::new()
    try {
        # Chromium omits these containers from FindAll's view. Walk the raw
        # parent/child tree; positions and expected text never select a header.
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        $pending = [System.Collections.Generic.Stack[object]]::new()
        $conversations = [System.Collections.Generic.List[object]]::new()
        $pending.Push($Document)
        while ($pending.Count) {
            $node = $pending.Pop()
            if ([string]$node.Current.ClassName -cmatch '(^|\s)chat-conversation(\s|$)' -and -not $node.Current.IsOffscreen) {
                $conversations.Add($node)
            }
            $child = $walker.GetFirstChild($node)
            while ($null -ne $child) {
                $pending.Push($child)
                $child = $walker.GetNextSibling($child)
            }
        }
        $structure.conversation_count = $conversations.Count
        if ($conversations.Count -eq 1) {
            $users = [System.Collections.Generic.List[object]]::new()
            $positions = [System.Collections.Generic.List[object]]::new()
            $child = $walker.GetFirstChild($conversations[0])
            while ($null -ne $child) {
                if ([string]$child.Current.ClassName -cmatch '(^|\s)user-info(\s|$)') { $users.Add($child) }
                if ([string]$child.Current.ClassName -cmatch '(^|\s)chat-position-content(\s|$)') { $positions.Add($child) }
                $child = $walker.GetNextSibling($child)
            }
            $structure.user_info_count = $users.Count
            $structure.position_count = $positions.Count
            $structure.structure_status = 'header_branch_missing'
            if ($users.Count -gt 1 -or $positions.Count -gt 1) {
                $structure.structure_status = 'header_branch_ambiguous'
            } elseif ($users.Count -eq 1 -and $positions.Count -eq 1) {
                $structure.structure_status = 'header_branch_hidden'
                if (-not $users[0].Current.IsOffscreen -and -not $positions[0].Current.IsOffscreen) {
                    $pending.Push($users[0]); $pending.Push($positions[0])
                    while ($pending.Count) {
                        $node = $pending.Pop()
                        if ($node.Current.IsOffscreen) { continue }
                        $name = Clean-Text $node.Current.Name
                        if ($name) { $values.Add($name) }
                        $child = $walker.GetFirstChild($node)
                        while ($null -ne $child) {
                            $pending.Push($child)
                            $child = $walker.GetNextSibling($child)
                        }
                    }
                    $structure.structure_ok = $true
                    $structure.structure_status = 'ok'
                }
            }
        } elseif ($conversations.Count -gt 1) {
            $structure.structure_status = 'conversation_ambiguous'
        }
    } catch {
        $structure.structure_ok = $false
        $structure.structure_status = 'read_error'
        $values.Clear()
    }
    return [pscustomobject]@{
        text = (@($values | Select-Object -Unique) -join " | ")
        values = @($values | Select-Object -Unique)
        structure = $structure
    }
}

function Test-ChatHeader([object]$Header, [object]$Expected) {
    $mismatches = [System.Collections.Generic.List[string]]::new()
    foreach ($field in @("title", "company", "salary", "city")) {
        $expectedValue = Get-PayloadText -Payload $Expected -Name $field
        if (-not $expectedValue) { continue }
        if ($Header.text -notlike "*$expectedValue*") { $mismatches.Add($field) }
    }
    return [pscustomobject]@{ matched = $Header.structure.structure_ok -eq $true -and $mismatches.Count -eq 0; missing_fields = @($mismatches) }
}

function Get-ChatContactVisibleFields(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$FallbackText,
    [bool]$IncludeOffscreen = $false
) {
    $texts = [System.Collections.Generic.List[string]]::new()
    $recruiterTexts = [System.Collections.Generic.List[string]]::new()
    $companyTexts = [System.Collections.Generic.List[string]]::new()
    $titleTexts = [System.Collections.Generic.List[string]]::new()
    $fallback = Clean-Text $FallbackText
    if ($fallback) { $texts.Add($fallback) }
    foreach ($node in Get-DocumentNodes -Document $Element) {
        try {
            if (-not $IncludeOffscreen -and $node.Current.IsOffscreen) { continue }
            $text = Clean-Text $node.Current.Name
            if (-not $text) { continue }
            if (-not $texts.Contains($text)) { $texts.Add($text) }
            $marker = "$(Clean-Text $node.Current.AutomationId) $(Clean-Text $node.Current.ClassName)"
            if ($marker -match '(?i)(boss-name|recruiter|contact-name|user-name)') {
                if (-not $recruiterTexts.Contains($text)) { $recruiterTexts.Add($text) }
            } elseif ($marker -match '(?i)(company|brand)') {
                if (-not $companyTexts.Contains($text)) { $companyTexts.Add($text) }
            } elseif ($marker -match '(?i)(job-title|position|job-name)') {
                if (-not $titleTexts.Contains($text)) { $titleTexts.Add($text) }
            }
        } catch {}
    }
    $displayText = Clean-Text ($texts -join '｜')
    return [pscustomobject]@{
        Text = $displayText
        NormalizedText = (($displayText -replace '[\s·•|｜_\-—（）()【】\[\]]+', '') -replace '(在线|活跃|刚刚活跃|今日活跃|分钟前活跃|小时前活跃)', '').ToLowerInvariant()
        RecruiterText = Clean-Text ($recruiterTexts -join '｜')
        CompanyText = Clean-Text ($companyTexts -join '｜')
        TitleText = Clean-Text ($titleTexts -join '｜')
    }
}

function Get-SearchChatContactCandidates(
    [System.Windows.Automation.AutomationElement]$Root,
    [bool]$IncludeOffscreen = $false
) {
    $candidates = [System.Collections.Generic.List[object]]::new()
    try {
        $lists = @(Get-RawChatNodes -Element $Root -ChildrenOnly | Where-Object {
            -not $_.Current.IsOffscreen -and [string]$_.Current.ClassName -ceq 'search-ul' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::List
        })
        if ($lists.Count -ne 1) { return @() }
        foreach ($item in Get-RawChatNodes -Element $lists[0] -ChildrenOnly) {
            if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem -or
                [string]$item.Current.ClassName -cne 'search-list' -or (-not $IncludeOffscreen -and $item.Current.IsOffscreen)) { continue }
            $children = @(Get-RawChatNodes -Element $item -ChildrenOnly)
            $names = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text })
            $companyLines = @($children | Where-Object { [string]$_.Current.ClassName -ceq 'gray' })
            if ($names.Count -eq 0 -or $companyLines.Count -ne 1 -or
                (-not $IncludeOffscreen -and (@($names | Where-Object { $_.Current.IsOffscreen }).Count -gt 0 -or $companyLines[0].Current.IsOffscreen))) { continue }
            $parts = @(Get-RawChatNodes -Element $companyLines[0] -ChildrenOnly)
            $dividers = @($parts | Where-Object { [string]$_.Current.ClassName -ceq 'vline' })
            if ($dividers.Count -ne 1) { continue }
            $companyParts = [System.Collections.Generic.List[string]]::new()
            $valid = $true
            foreach ($part in $parts) {
                if ([string]$part.Current.ClassName -ceq 'vline') { break }
                if ($part.Current.ControlType -ne [System.Windows.Automation.ControlType]::Text -or
                    (-not $IncludeOffscreen -and $part.Current.IsOffscreen)) { $valid = $false; break }
                $companyParts.Add([string]$part.Current.Name)
            }
            $name = Clean-Text (($names | ForEach-Object { [string]$_.Current.Name }) -join '')
            $company = Clean-Text ($companyParts -join '')
            if (-not $valid -or -not $name -or -not $company) { continue }
            # Search highlighting splits direct sibling name/company text into fragments.
            # The text after vline is the recruiter's role, not the job title.
            # Unproved second-line text/preview cannot supply a matching field.
            $text = $name + '｜' + $company
            $candidates.Add([pscustomobject]@{
                Element = $item; ContentElement = $item; Name = $name
                RuntimeId = @($item.GetRuntimeId()); Text = $text
                NormalizedText = (($text -replace '[\s·•|｜_\-—（）()【】\[\]]+', '') -replace '(在线|活跃|刚刚活跃|今日活跃|分钟前活跃|小时前活跃)', '').ToLowerInvariant()
                RecruiterText = $name; CompanyText = $company; TitleText = ''
            })
        }
    } catch { return @() }
    return @($candidates.ToArray())
}

function Get-ChatContactCandidates(
    [System.Windows.Automation.AutomationElement]$Document,
    [bool]$IncludeOffscreen = $false
) {
    $candidates = [System.Collections.Generic.List[object]]::new()
    try {
    $wraps = @(Get-RawChatNodes -Element $Document | Where-Object {
        -not $_.Current.IsOffscreen -and [string]$_.Current.ClassName -cmatch '(^|\s)chat-wrap(\s|$)'
    })
    if ($wraps.Count -ne 1) { return @() }
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $searchRoots = @(Get-RawChatNodes -Element $wraps[0] | Where-Object {
        -not $_.Current.IsOffscreen -and [string]$_.Current.ClassName -cmatch '(^|\s)boss-search-result(\s|$)'
    })
    if ($searchRoots.Count -gt 0) {
        if ($searchRoots.Count -ne 1 -or [string]$walker.GetParent($searchRoots[0]).Current.ClassName -cnotmatch '(^|\s)list-warp(\s|$)') { return @() }
        return @(Get-SearchChatContactCandidates -Root $searchRoots[0] -IncludeOffscreen $IncludeOffscreen)
    } else {
        $lists = @(Get-RawChatNodes -Element $wraps[0] | Where-Object {
            -not $_.Current.IsOffscreen -and [string]$_.Current.ClassName -cmatch '(^|\s)user-list-content(\s|$)' -and
            [string]$walker.GetParent($_).Current.ClassName -cmatch '(^|\s)user-list(\s|$)'
        })
    }
    if ($lists.Count -ne 1) { return @() }
    foreach ($node in Get-RawChatNodes -Element $lists[0]) {
        try {
            if ($node.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem -or
                (-not $IncludeOffscreen -and $node.Current.IsOffscreen)) { continue }
            $contents = @(Get-RawChatNodes -Element $node | Where-Object {
                [string]$_.Current.ClassName -cmatch '(^|\s)friend-content(\s|$)' -and
                ($IncludeOffscreen -or -not $_.Current.IsOffscreen)
            })
            if ($contents.Count -ne 1) { continue }
            # Only this ListItem, directly or through its confirmed wrapper,
            # owns the content. A nested item or editor cannot lend it upward.
            $owner = $walker.GetParent($contents[0])
            if ([string]$owner.Current.ClassName -cmatch '(^|\s)friend-content-warp(\s|$)') { $owner = $walker.GetParent($owner) }
            $ownerId = @($owner.GetRuntimeId()) -join '.'
            if (-not $ownerId -or $ownerId -ne (@($node.GetRuntimeId()) -join '.')) { continue }
            $name = Clean-Text $node.Current.Name
            if ($name) {
                $runtimeId = @()
                try { $runtimeId = @($node.GetRuntimeId()) } catch {}
                $visible = Get-ChatContactVisibleFields -Element $contents[0] -FallbackText $name -IncludeOffscreen $IncludeOffscreen
                $candidates.Add([pscustomobject]@{
                    Element = $node
                    ContentElement = $contents[0]
                    Name = $name
                    RuntimeId = $runtimeId
                    Text = $visible.Text
                    NormalizedText = $visible.NormalizedText
                    RecruiterText = $visible.RecruiterText
                    CompanyText = $visible.CompanyText
                    TitleText = $visible.TitleText
                })
            }
        } catch {}
    }
    } catch { return @() }
    return @($candidates.ToArray())
}

function Get-ChatContactIdentityKey([object]$Candidate) {
    $runtimeId = @($Candidate.RuntimeId | ForEach-Object {
        $parsed = 0
        if ([int]::TryParse([string]$_, [ref]$parsed)) { $parsed }
    })
    if ($runtimeId.Count -gt 0) {
        return "runtime:$($runtimeId -join '.')"
    }
    # Without a UIA runtime identity, treating equal display text as the same
    # contact could hide a genuine same-name card. Keep such candidates separate;
    # a repeated virtualized card may then become ambiguous, which is the safe result.
    return ""
}

function Read-LoadedChatContactStructure([System.Windows.Automation.AutomationElement]$Document, [int]$Maximum = 200) {
    $seen = @{}
    $contacts = [System.Collections.Generic.List[object]]::new()
    foreach ($candidate in Get-ChatContactCandidates -Document $Document -IncludeOffscreen $true) {
        $key = Get-ChatContactIdentityKey -Candidate $candidate
        if ($key -and $seen.ContainsKey($key)) { continue }
        if ($key) { $seen[$key] = $true }
        $contacts.Add($candidate)
        if ($contacts.Count -ge $Maximum) { break }
    }
    return [pscustomobject]@{
        candidates = @($contacts)
        contact_count = $contacts.Count
        scrolled = $false
        reached_bottom = $false
    }
}

function Get-ChatContactScrollTarget([System.Windows.Automation.AutomationElement]$Document) {
    $candidate = @(Get-ChatContactCandidates -Document $Document | Select-Object -First 1)
    if (-not $candidate.Count) { return $null }
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $element = $candidate[0].Element
    while ($element) {
        try {
            $pattern = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern) -and
                $pattern.Current.VerticallyScrollable) {
                return [pscustomobject]@{ Element = $element; Pattern = $pattern }
            }
            if ($element -eq $Document) { break }
            $element = $walker.GetParent($element)
        } catch { break }
    }
    return $null
}

function Read-ChatContactStructure([System.Windows.Automation.AutomationElement]$Document, [int]$Maximum = 30) {
    $seen = @{}
    $contacts = [System.Collections.Generic.List[object]]::new()
    $scrolled = $false
    $reachedBottom = $false
    $target = Get-ChatContactScrollTarget -Document $Document
    if ($target -and [double]$target.Pattern.Current.VerticalScrollPercent -gt 0.0) {
        $target.Pattern.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, 0.0)
        Wait-AfterAction
        $scrolled = $true
    }
    for ($pass = 0; $pass -lt 40 -and $contacts.Count -lt $Maximum; $pass += 1) {
        $state = Get-BossWindow
        $currentDocument = Get-ActiveDocument -Root $state.Root
        $snapshotTarget = Get-ChatContactScrollTarget -Document $currentDocument
        $snapshotScrollPercent = if ($snapshotTarget) { [double]$snapshotTarget.Pattern.Current.VerticalScrollPercent } else { 0.0 }
        foreach ($candidate in Get-ChatContactCandidates -Document $currentDocument) {
            $key = Get-ChatContactIdentityKey -Candidate $candidate
            if ($key -and $seen.ContainsKey($key)) { continue }
            if ($key) { $seen[$key] = $true }
            $candidate | Add-Member -NotePropertyName SnapshotScrollPercent -NotePropertyValue $snapshotScrollPercent -Force
            $contacts.Add($candidate)
            if ($contacts.Count -ge $Maximum) { break }
        }
        if ($contacts.Count -ge $Maximum) {
            $currentTarget = Get-ChatContactScrollTarget -Document $currentDocument
            $reachedBottom = [bool]($currentTarget -and [double]$currentTarget.Pattern.Current.VerticalScrollPercent -ge 99.9)
            break
        }
        $currentTarget = Get-ChatContactScrollTarget -Document $currentDocument
        if (-not $currentTarget) { $reachedBottom = $true; break }
        $before = [double]$currentTarget.Pattern.Current.VerticalScrollPercent
        if ($before -ge 99.9) { $reachedBottom = $true; break }
        $step = [Math]::Max(15.0, [double]$currentTarget.Pattern.Current.VerticalViewSize * 0.8)
        $next = [Math]::Min(100.0, $before + $step)
        try {
            $currentTarget.Pattern.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, $next)
        } catch { $reachedBottom = $true; break }
        Wait-AfterAction
        $scrolled = $true
        $afterState = Get-BossWindow
        $afterDocument = Get-ActiveDocument -Root $afterState.Root
        $afterTarget = Get-ChatContactScrollTarget -Document $afterDocument
        $after = if ($afterTarget) { [double]$afterTarget.Pattern.Current.VerticalScrollPercent } else { $before }
        if ($after -le ($before + 0.01)) { $reachedBottom = $true; break }
        if ($after -ge 99.9) { $reachedBottom = $true }
    }
    return [pscustomobject]@{
        candidates = @($contacts | Select-Object -First $Maximum)
        contact_count = [Math]::Min($contacts.Count, $Maximum)
        scrolled = $scrolled
        reached_bottom = $reachedBottom
    }
}

function Add-ChatLocationAudit([object]$Result, [object]$Audit, [object]$Header, [object]$Expected, [System.Diagnostics.Stopwatch]$Timer) {
    Add-ChatDiagnostic 'locate.exit' { @{status=[string]$Result.status} }
    $headerCheck = if ($Header) { Test-ChatHeader -Header $Header -Expected $Expected } else { $null }
    $location = [pscustomobject]@{
        source = $Audit.location_source
        contact_count = [int]$Audit.contact_count
        scrolled = [bool]$Audit.scrolled
        reached_bottom = [bool]$Audit.reached_bottom
        clicked_contact_summary = $Audit.clicked_contact_summary
        contact_activation = if ($Audit.PSObject.Properties['contact_activation']) { $Audit.contact_activation } else { $null }
        search_term = Clean-Text $Audit.search_term
        search_reason = Clean-Text $Audit.search_reason
        search_result_count = [int]$Audit.search_result_count
        duration_ms = [int64]$Timer.ElapsedMilliseconds
        header_verification = if ($headerCheck) { [pscustomobject]@{
            matched = [bool]$headerCheck.matched
            missing_fields = @($headerCheck.missing_fields)
            expected = [pscustomobject]@{
                title = Get-PayloadText -Payload $Expected -Name 'title'
                company = Get-PayloadText -Payload $Expected -Name 'company'
                salary = Get-PayloadText -Payload $Expected -Name 'salary'
                city = Get-PayloadText -Payload $Expected -Name 'city'
            }
        } } else { $null }
    }
    $Result | Add-Member -NotePropertyName location -NotePropertyValue $location -Force
    $Result | Add-Member -NotePropertyName location_source -NotePropertyValue $location.source -Force
    $Result | Add-Member -NotePropertyName contact_count -NotePropertyValue $location.contact_count -Force
    $Result | Add-Member -NotePropertyName contact_list_scrolled -NotePropertyValue $location.scrolled -Force
    $Result | Add-Member -NotePropertyName contact_list_reached_bottom -NotePropertyValue $location.reached_bottom -Force
    $Result | Add-Member -NotePropertyName location_duration_ms -NotePropertyValue $location.duration_ms -Force
    $Result | Add-Member -NotePropertyName header_verification -NotePropertyValue $location.header_verification -Force
    return $Result
}

function Add-ChatSendAudit([object]$Result, [object]$Located, [string]$SendStatus, [bool]$MessageSent, [string]$SendError = '') {
    $sendResult = [pscustomobject]@{
        status = $SendStatus
        message_sent = $MessageSent
        error = Clean-Text $SendError
    }
    if ($Located.location) {
        $Located.location | Add-Member -NotePropertyName send_result -NotePropertyValue $sendResult -Force
        $Result | Add-Member -NotePropertyName location -NotePropertyValue $Located.location -Force
    }
    foreach ($name in @('location_source', 'contact_count', 'contact_list_scrolled', 'contact_list_reached_bottom', 'location_duration_ms', 'header_verification')) {
        $property = $Located.PSObject.Properties[$name]
        if ($property) { $Result | Add-Member -NotePropertyName $name -NotePropertyValue $property.Value -Force }
    }
    $Result | Add-Member -NotePropertyName send_result -NotePropertyValue $sendResult -Force
    return $Result
}

function Select-ChatAllFilter([System.Windows.Automation.AutomationElement]$Document) {
    $allFilter = $null
    foreach ($node in Get-DocumentNodes -Document $Document) {
        try {
            if ($node.Current.IsOffscreen -or
                $node.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem -or
                (Clean-Text $node.Current.Name) -ne $allContactsName) { continue }
            if ((Clean-Text $node.Current.ClassName) -eq 'selected') { return $false }
            $allFilter = $node
            break
        } catch {}
    }
    if (-not $allFilter) { throw 'The chat All filter was not found.' }
    try {
        Invoke-Element -Element $allFilter
    } catch {
        Click-Element -Element $allFilter
    }
    Wait-AfterAction
    return $true
}

function Test-ChatAllFilterSelected([System.Windows.Automation.AutomationElement]$Document) {
    foreach ($node in Get-DocumentNodes -Document $Document) {
        try {
            if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem -and
                (Clean-Text $node.Current.Name) -eq $allContactsName) {
                return (Clean-Text $node.Current.ClassName) -eq 'selected'
            }
        } catch {}
    }
    return $false
}

function Get-ChatSearchInput([System.Windows.Automation.AutomationElement]$Document) {
    foreach ($node in Get-DocumentNodes -Document $Document) {
        try {
            if ($node.Current.IsOffscreen -or
                $node.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { continue }
            if ((Clean-Text $node.Current.Name) -eq $contactSearchName) { return $node }
        } catch {}
    }
    return $null
}

function Set-ChatSearch([System.Windows.Automation.AutomationElement]$InputElement, [string]$Query) {
    $valuePattern = $null
    if (-not $InputElement.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        throw 'The chat contact search box does not expose ValuePattern.'
    }
    $InputElement.SetFocus()
    $valuePattern.SetValue($Query)
    Wait-AfterAction
}

function Clear-ChatSearch([System.Windows.Automation.AutomationElement]$Document) {
    $searchInput = Get-ChatSearchInput -Document $Document
    if (-not $searchInput) { return $false }
    $valuePattern = $null
    if (-not $searchInput.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        throw 'The chat contact search box does not expose ValuePattern.'
    }
    if (-not (Clean-Text $valuePattern.Current.Value)) { return $false }
    $searchInput.SetFocus()
    $valuePattern.SetValue('')
    Wait-AfterAction
    return $true
}

function Get-RecruiterSearchTerm([object]$Expected) {
    $recruiter = Get-PayloadText -Payload $Expected -Name 'recruiter'
    if (-not $recruiter) { return '' }
    return @($recruiter -split '\s+')[0]
}

function Normalize-ChatCompany([string]$Value) {
    return ((Clean-Text $Value) -replace '[\s·•|｜_\-—（）()【】\[\]]+', '' -replace '(股份有限|有限责任|有限|股份)?公司$', '').ToLowerInvariant()
}

function Test-ChatCompanyRelated([string]$Left, [string]$Right) {
    $leftKey = Normalize-ChatCompany -Value $Left
    $rightKey = Normalize-ChatCompany -Value $Right
    return [bool]($leftKey -and $rightKey -and ($leftKey -eq $rightKey -or
        ([Math]::Min($leftKey.Length, $rightKey.Length) -ge 2 -and ($leftKey.Contains($rightKey) -or $rightKey.Contains($leftKey)))))
}

function Find-ExpectedChatCandidates([object[]]$Candidates, [object]$Expected, [string[]]$KnownTargetCompanies = @()) {
    $recruiterName = Get-RecruiterSearchTerm -Expected $Expected
    $company = Get-PayloadText -Payload $Expected -Name 'company'
    $title = Get-PayloadText -Payload $Expected -Name 'title'
    if (-not $recruiterName) { return @() }
    $matches = [System.Collections.Generic.List[object]]::new()
    foreach ($candidate in $Candidates) {
        $name = Clean-Text $candidate.Name
        $text = Get-PayloadText -Payload $candidate -Name 'Text'
        if (-not $text) { $text = $name }
        $recruiterText = Get-PayloadText -Payload $candidate -Name 'RecruiterText'
        if (-not $recruiterText) { $recruiterText = $text }
        $companyText = Get-PayloadText -Payload $candidate -Name 'CompanyText'
        $titleText = Get-PayloadText -Payload $candidate -Name 'TitleText'
        $normalizedName = ($recruiterText -replace '[\s·•|｜_\-—（）()【】\[\]]+', '' -replace '(在线|活跃|刚刚活跃|今日活跃|分钟前活跃|小时前活跃)', '').ToLowerInvariant()
        $normalizedRecruiter = ($recruiterName -replace '[\s·•|｜_\-—（）()【】\[\]]+', '').ToLowerInvariant()
        $hasRecruiter = $normalizedName.IndexOf($normalizedRecruiter, [StringComparison]::OrdinalIgnoreCase) -ge 0
        if ($hasRecruiter -and $companyText -and $company -and
            -not (Test-ChatCompanyRelated -Left $companyText -Right $company)) { continue }
        $explicitOtherCompany = $false
        foreach ($knownCompany in $KnownTargetCompanies) {
            if (-not $knownCompany -or (Test-ChatCompanyRelated -Left $knownCompany -Right $company)) { continue }
            $showsKnownCompany = if ($companyText) {
                Test-ChatCompanyRelated -Left $companyText -Right $knownCompany
            } else {
                $text.IndexOf($knownCompany, [StringComparison]::OrdinalIgnoreCase) -ge 0
            }
            $showsExpectedCompany = if ($companyText) {
                Test-ChatCompanyRelated -Left $companyText -Right $company
            } else {
                (-not $company) -or (Test-ChatCompanyRelated -Left $text -Right $company)
            }
            if ($showsKnownCompany -and -not $showsExpectedCompany) {
                $explicitOtherCompany = $true
                break
            }
        }
        if ($hasRecruiter -and -not $explicitOtherCompany) { $matches.Add($candidate) }
    }
    if ($matches.Count -gt 1 -and $company) {
        $companyMatches = @($matches | Where-Object {
            $candidateCompany = Get-PayloadText -Payload $_ -Name 'CompanyText'
            $candidateText = Get-PayloadText -Payload $_ -Name 'Text'
            if (-not $candidateText) { $candidateText = Clean-Text $_.Name }
            if ($candidateCompany) { Test-ChatCompanyRelated -Left $candidateCompany -Right $company }
            else { Test-ChatCompanyRelated -Left $candidateText -Right $company }
        })
        if ($companyMatches.Count) { $matches = @($companyMatches) }
    }
    if ($matches.Count -gt 1 -and $title) {
        $titleMatches = @($matches | Where-Object {
            $candidateTitle = Get-PayloadText -Payload $_ -Name 'TitleText'
            $candidateText = Get-PayloadText -Payload $_ -Name 'Text'
            if (-not $candidateText) { $candidateText = Clean-Text $_.Name }
            ($candidateTitle -and $candidateTitle.IndexOf($title, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
                (-not $candidateTitle -and $candidateText.IndexOf($title, [StringComparison]::OrdinalIgnoreCase) -ge 0)
        })
        if ($titleMatches.Count) { return @($titleMatches) }
    }
    return @($matches)
}

function Open-ExpectedChatCandidate(
    [object]$Candidate,
    [object]$Expected,
    [string]$LoginState,
    [string]$SearchTerm,
    [string]$LocationSource,
    [object]$Audit,
    [System.Diagnostics.Stopwatch]$Timer,
    [string[]]$KnownTargetCompanies = @()
) {
    Add-ChatDiagnostic 'activation.enter' { @{branch=$LocationSource} }
    $targetCandidate = $Candidate
    $scrolledIntoView = $false
    try {
        $scrollItem = $null
        if ($Candidate.Element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scrollItem)) {
            $scrollItem.ScrollIntoView()
            Start-Sleep -Milliseconds 250
            $scrolledIntoView = $true
        }
    } catch {}
    Add-ChatDiagnostic 'activation.scroll' { @{scrolled=$scrolledIntoView} }
    if ($scrolledIntoView) {
        $refreshedState = Get-BossWindow
        Add-ChatDiagnostic 'activation.requery.target' { $script:chatDiagnosticWindow=$refreshedState.Window.MainWindowHandle.ToInt64(); @{process_id=$refreshedState.Window.Id;target_window=$script:chatDiagnosticWindow} }
        $refreshedDocument = Get-ActiveDocument -Root $refreshedState.Root
        $refreshedCandidates = @(Get-ChatContactCandidates -Document $refreshedDocument -IncludeOffscreen $true | Select-Object -First 200)
        $refreshedMatches = @(Find-ExpectedChatCandidates -Candidates $refreshedCandidates -Expected $Expected -KnownTargetCompanies $KnownTargetCompanies)
        Add-ChatDiagnostic 'activation.requery' { @{requeried=$true;candidate_count=$refreshedMatches.Count} }
        if ($refreshedMatches.Count -ne 1) {
            $Audit.location_source = $LocationSource
            $Audit.search_term = $SearchTerm
            $errorCode = if ($refreshedMatches.Count -gt 1) { 'chat_contact_ambiguous' } else { 'chat_contact_not_found' }
            return Add-ChatLocationAudit -Result ([pscustomobject]@{
                status = 'failed'
                error = $errorCode
                reason = 'contact_changed_after_scroll'
                candidate_count = $refreshedMatches.Count
                search_term = $SearchTerm
            }) -Audit $Audit -Header $null -Expected $Expected -Timer $Timer
        }
        $targetCandidate = $refreshedMatches[0]
    }
    Add-ChatDiagnostic 'activation.target' { @{target_runtime_id=@($targetCandidate.RuntimeId);scrolled=$scrolledIntoView} }
    $activation = [pscustomobject]@{
        method = 'none'; action_returned = $false; pattern_error_type = ''
        point_source = ''; point_error_type = ''; point = $null; bounds = $null
        process_id = $null; window_handle = $null
        target_runtime_id = @($targetCandidate.RuntimeId); scrolled_before_activation = $scrolledIntoView
        header_verified = $false
    }
    $Audit | Add-Member -NotePropertyName contact_activation -NotePropertyValue $activation -Force
    try {
        $invokeElement = $targetCandidate.ContentElement
        Invoke-Element -Element $invokeElement -ActionAudit $activation
    } catch {
        $activation.pattern_error_type = $_.Exception.GetType().Name
        Click-Element -Element $targetCandidate.Element -ActionAudit $activation
    }
    Wait-AfterAction
    $selected = Get-BossWindow
    Add-ChatDiagnostic 'activation.selected' { @{process_id=$selected.Window.Id;target_window=$selected.Window.MainWindowHandle.ToInt64();same_window=($selected.Window.MainWindowHandle.ToInt64() -eq $script:chatDiagnosticWindow)} }
    $selectedDocument = Get-ActiveDocument -Root $selected.Root
    $header = Read-ChatHeader -Document $selectedDocument
    $match = Test-ChatHeader -Header $header -Expected $Expected
    Add-ChatDiagnostic 'header.after' { $header.structure + @{matched=[bool]$match.matched;missing_fields=@($match.missing_fields)} }
    $activation.header_verified = [bool]$match.matched
    $Audit.location_source = $LocationSource
    $Audit.search_term = $SearchTerm
    $Audit.clicked_contact_summary = [pscustomobject]@{
        source = $LocationSource
        recruiter = Get-RecruiterSearchTerm -Expected $Expected
        company = Get-PayloadText -Payload $Expected -Name 'company'
        title = Get-PayloadText -Payload $Expected -Name 'title'
    }
    if (-not $match.matched) {
        return Add-ChatLocationAudit -Result ([pscustomobject]@{
            status = 'failed'
            error = 'matching_chat_header_mismatch'
            search_term = $SearchTerm
            missing_fields = $match.missing_fields
            header = $header
        }) -Audit $Audit -Header $header -Expected $Expected -Timer $Timer
    }
    return Add-ChatLocationAudit -Result ([pscustomobject]@{
        status = 'ok'
        login_state = $LoginState
        current_url = $selected.Address
        contact_name = Get-RecruiterSearchTerm -Expected $Expected
        search_term = $SearchTerm
        header = $header
        selected_existing = $false
    }) -Audit $Audit -Header $header -Expected $Expected -Timer $Timer
}

function Locate-ExpectedChat([object]$Expected, [bool]$OpenChatPage = $true) {
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $audit = [pscustomobject]@{
        location_source = 'contact_list'
        contact_count = 0
        scrolled = $false
        reached_bottom = $false
        clicked_contact_summary = $null
        search_term = ''
        search_result_count = 0
    }
    if ($OpenChatPage) {
        $state = Activate-ChatPage
    } else {
        $state = Get-BossWindow
        if (-not (Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$state.Window.MainWindowHandle))) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
        Start-Sleep -Milliseconds 250
        if ($state.Address -notmatch '/web/geek/chat') {
            throw 'The current BOSS page is not the active Chat page.'
        }
    }
    $document = Get-ActiveDocument -Root $state.Root
    $loginState = Get-LoginState -Document $document -Address $state.Address
    if ($loginState -ne "logged_in") {
        return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = "user_action_required"; login_state = $loginState; current_url = $state.Address }) -Audit $audit -Header $null -Expected $Expected -Timer $timer
    }

    if (Select-ChatAllFilter -Document $document) {
        $state = Get-BossWindow
        $document = Get-ActiveDocument -Root $state.Root
        if (-not (Test-ChatAllFilterSelected -Document $document)) {
            throw 'The chat contact filter did not switch to All.'
        }
    }

    $header = Read-ChatHeader -Document $document
    $match = Test-ChatHeader -Header $header -Expected $Expected
    Add-ChatDiagnostic 'header.initial' { $header.structure + @{matched=[bool]$match.matched;missing_fields=@($match.missing_fields)} }
    if ($match.matched) {
        $audit.location_source = 'current_chat'
        return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = "ok"; login_state = $loginState; current_url = $state.Address; header = $header; selected_existing = $true }) -Audit $audit -Header $header -Expected $Expected -Timer $timer
    }

    if (Clear-ChatSearch -Document $document) {
        $state = Get-BossWindow
        $document = Get-ActiveDocument -Root $state.Root
    }

    $structure = Read-ChatContactStructure -Document $document -Maximum 30
    $audit.contact_count = $structure.contact_count
    $audit.scrolled = $structure.scrolled
    $audit.reached_bottom = $structure.reached_bottom
    $searchTerm = Get-RecruiterSearchTerm -Expected $Expected
    if (-not $searchTerm) {
        return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = 'failed'; error = 'recruiter_missing'; header = $header }) -Audit $audit -Header $header -Expected $Expected -Timer $timer
    }
    $listMatches = @(Find-ExpectedChatCandidates -Candidates $structure.candidates -Expected $Expected)
    if ($listMatches.Count -eq 1) {
        return Open-ExpectedChatCandidate -Candidate $listMatches[0] -Expected $Expected -LoginState $loginState -SearchTerm '' -LocationSource 'contact_list' -Audit $audit -Timer $timer
    }
    $audit.location_source = 'search'
    $audit.search_term = $searchTerm
    $searchInput = Get-ChatSearchInput -Document $document
    if (-not $searchInput) {
        $errorCode = if ($listMatches.Count -gt 1) { 'chat_contact_ambiguous' } else { 'chat_contact_not_found' }
        return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = 'failed'; error = $errorCode; search_term = $searchTerm; reason = 'search_input_not_found'; candidate_count = $listMatches.Count; header = $header }) -Audit $audit -Header $header -Expected $Expected -Timer $timer
    }
    try {
        Set-ChatSearch -InputElement $searchInput -Query $searchTerm
    } catch {
        return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = 'failed'; error = 'chat_contact_not_found'; search_term = $searchTerm; reason = 'search_failed'; detail = $_.Exception.Message; header = $header }) -Audit $audit -Header $header -Expected $Expected -Timer $timer
    }
    $current = Get-BossWindow
    $currentDocument = Get-ActiveDocument -Root $current.Root
    $searchCandidates = @(Get-ChatContactCandidates -Document $currentDocument | Select-Object -First 30)
    $audit.search_result_count = $searchCandidates.Count
    $searchMatches = @(Find-ExpectedChatCandidates -Candidates $searchCandidates -Expected $Expected)
    if ($searchMatches.Count -eq 1) {
        return Open-ExpectedChatCandidate -Candidate $searchMatches[0] -Expected $Expected -LoginState $loginState -SearchTerm $searchTerm -LocationSource 'search' -Audit $audit -Timer $timer
    }
    if ($searchMatches.Count -gt 1) {
        return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = 'failed'; error = 'chat_contact_ambiguous'; search_term = $searchTerm; candidate_count = $searchMatches.Count; header = $header }) -Audit $audit -Header $header -Expected $Expected -Timer $timer
    }
    return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = 'failed'; error = 'chat_contact_not_found'; search_term = $searchTerm; header = $header }) -Audit $audit -Header $header -Expected $Expected -Timer $timer
}

function Prepare-ChatBatch([object[]]$Items) {
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $state = Activate-ChatPage
    $document = Get-ActiveDocument -Root $state.Root
    Add-ChatDiagnostic 'prepare.document' { $documentId=@($document.GetRuntimeId()); @{document_runtime_id=$documentId;same_document=$(if($null -ne $script:chatBeforeDocumentId){[string]::Join(',', $script:chatBeforeDocumentId) -eq [string]::Join(',', $documentId)}else{$null})} }
    $loginState = Get-LoginState -Document $document -Address $state.Address
    if ($loginState -ne 'logged_in') {
        return [pscustomobject]@{ status = 'user_action_required'; login_state = $loginState; current_url = $state.Address }
    }
    if (Select-ChatAllFilter -Document $document) {
        $state = Get-BossWindow
        $document = Get-ActiveDocument -Root $state.Root
        if (-not (Test-ChatAllFilterSelected -Document $document)) { throw 'The chat contact filter did not switch to All.' }
    }
    [void](Clear-ChatSearch -Document $document)
    $plans = [System.Collections.Generic.List[object]]::new()
    $knownTargetCompanies = @($Items | ForEach-Object { Get-PayloadText -Payload $_.expected -Name 'company' } | Where-Object { $_ } | Select-Object -Unique)
    foreach ($item in $Items) {
        $itemNo = [int]$item.item_no
        $expected = $item.expected
        $searchTerm = Get-RecruiterSearchTerm -Expected $expected
        if (-not $searchTerm) {
            $plans.Add([pscustomobject]@{ item_no = $itemNo; source = 'none'; status = 'failed'; error = 'recruiter_missing'; search_term = '' })
            continue
        }
        $plans.Add([pscustomobject]@{
            item_no = $itemNo
            source = 'current_structure'
            status = 'ready'
            search_term = $searchTerm
            known_target_companies = $knownTargetCompanies
        })
    }
    return [pscustomobject]@{
        status = 'ok'
        snapshot_id = [guid]::NewGuid().ToString()
        snapshot = [pscustomobject]@{
            contact_count = 0
            scrolled = $false
            reached_bottom = $false
            maximum = 200
            duration_ms = [int64]$timer.ElapsedMilliseconds
        }
        items = @($plans)
    }
}

function Locate-ExpectedChatFromBatch([object]$Payload) {
    try {
    Add-ChatDiagnostic 'locate.enter'
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $expected = $Payload.expected
    $plan = $Payload.plan
    $snapshot = $Payload.snapshot
    $audit = [pscustomobject]@{
        location_source = 'current_structure'
        contact_count = 0
        scrolled = $false
        reached_bottom = $false
        clicked_contact_summary = $null
        search_term = ''
        search_result_count = 0
        search_reason = ''
    }
    $state = Get-BossWindow
    Add-ChatDiagnostic 'locate.target' { $script:chatDiagnosticWindow=$state.Window.MainWindowHandle.ToInt64(); @{process_id=$state.Window.Id;target_window=$script:chatDiagnosticWindow;is_chat=($state.Address -match '/web/geek/chat')} }
    Add-ChatForegroundDiagnostic 'locate.focus.before'
    if (-not (Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$state.Window.MainWindowHandle))) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
    Add-ChatForegroundDiagnostic 'locate.focus.verified'
    if ($state.Address -notmatch '/web/geek/chat') { throw 'The current BOSS page is not the active Chat page.' }
    $document = Get-ActiveDocument -Root $state.Root
    Add-ChatDiagnostic 'locate.document' { @{document_runtime_id=@($document.GetRuntimeId())} }
    $loginState = Get-LoginState -Document $document -Address $state.Address
    if ($loginState -ne 'logged_in') {
        return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = 'user_action_required'; login_state = $loginState }) -Audit $audit -Header $null -Expected $expected -Timer $timer
    }
    $source = Get-PayloadText -Payload $plan -Name 'source'
    if ($source -eq 'none') {
        return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = 'failed'; error = (Get-PayloadText -Payload $plan -Name 'error') }) -Audit $audit -Header $null -Expected $expected -Timer $timer
    }
    $header = Read-ChatHeader -Document $document
    $headerMatch = Test-ChatHeader -Header $header -Expected $expected
    Add-ChatDiagnostic 'header.initial' { $header.structure + @{matched=[bool]$headerMatch.matched;missing_fields=@($headerMatch.missing_fields)} }
    if ($headerMatch.matched) {
        Add-ChatDiagnostic 'branch' { @{branch='current_chat'} }
        $audit.location_source = 'current_chat'
        return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = 'ok'; header = $header; selected_existing = $true }) -Audit $audit -Header $header -Expected $expected -Timer $timer
    }
    Add-ChatDiagnostic 'branch' { @{branch='current_structure'} }
    [void](Clear-ChatSearch -Document $document)
    $state = Get-BossWindow
    $document = Get-ActiveDocument -Root $state.Root
    $structure = Read-LoadedChatContactStructure -Document $document -Maximum 200
    $audit.contact_count = [int]$structure.contact_count
    $matches = @(Find-ExpectedChatCandidates -Candidates $structure.candidates -Expected $expected -KnownTargetCompanies @($plan.known_target_companies))
    Add-ChatDiagnostic 'structure.matches' { @{candidate_count=$matches.Count;contact_count=$audit.contact_count} }
    if ($matches.Count -eq 1) {
        return Open-ExpectedChatCandidate -Candidate $matches[0] -Expected $expected -LoginState $loginState -SearchTerm '' -LocationSource 'current_structure' -Audit $audit -Timer $timer -KnownTargetCompanies @($plan.known_target_companies)
    }
    Add-ChatDiagnostic 'branch' { @{branch='search'} }
    $searchTerm = Get-PayloadText -Payload $plan -Name 'search_term'
    $audit.search_reason = if ($matches.Count -gt 1) { 'ambiguous' } else { 'not_found' }
    $audit.search_term = $searchTerm
    $searchInput = Get-ChatSearchInput -Document $document
    if (-not $searchInput) {
        return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = 'failed'; error = 'chat_contact_not_found'; reason = 'search_input_not_found' }) -Audit $audit -Header $null -Expected $expected -Timer $timer
    }
    Set-ChatSearch -InputElement $searchInput -Query $searchTerm
    $searched = Get-BossWindow
    $searchedDocument = Get-ActiveDocument -Root $searched.Root
    $searchCandidates = @(Get-ChatContactCandidates -Document $searchedDocument -IncludeOffscreen $true | Select-Object -First 200)
    $audit.search_result_count = $searchCandidates.Count
    $matches = @(Find-ExpectedChatCandidates -Candidates $searchCandidates -Expected $expected -KnownTargetCompanies @($plan.known_target_companies))
    Add-ChatDiagnostic 'search.matches' { @{candidate_count=$matches.Count;contact_count=$searchCandidates.Count} }
    if ($matches.Count -ne 1) {
        [void](Clear-ChatSearch -Document $searchedDocument)
        $errorCode = if ($matches.Count -gt 1) { 'chat_contact_ambiguous' } else { 'chat_contact_not_found' }
        return Add-ChatLocationAudit -Result ([pscustomobject]@{ status = 'failed'; error = $errorCode; candidate_count = $matches.Count }) -Audit $audit -Header $null -Expected $expected -Timer $timer
    }
    $located = Open-ExpectedChatCandidate -Candidate $matches[0] -Expected $expected -LoginState $loginState -SearchTerm $searchTerm -LocationSource 'search' -Audit $audit -Timer $timer -KnownTargetCompanies @($plan.known_target_companies)
    $after = Get-BossWindow
    [void](Clear-ChatSearch -Document (Get-ActiveDocument -Root $after.Root))
    return $located
    } catch {
        $originalError = $_
        Add-ChatDiagnostic 'locate.exception' { @{error_type=$originalError.Exception.GetType().Name} }
        throw $originalError
    }
}

function Find-ChatInput([System.Windows.Automation.AutomationElement]$Document) {
    try {
        $editor = Get-CurrentChatRegion -Document $Document -ClassName 'chat-editor'
        if (-not $editor) { return @() }
        $inputs = @(Get-RawChatNodes -Element $editor -ChildrenOnly | Where-Object {
            [string]$_.Current.ClassName -cmatch '(^|\s)chat-input(\s|$)' -and
            $_.Current.ControlType -in @([System.Windows.Automation.ControlType]::Group, [System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::Document)
        })
        if ($inputs.Count -ne 1 -or $inputs[0].Current.IsOffscreen) { return @() }
        $bounds = $inputs[0].Current.BoundingRectangle
        return @([pscustomobject]@{Element=$inputs[0];Top=$bounds.Top;Bounds=$bounds})
    } catch { return @() }
}

function Find-DetailChatInput([System.Windows.Automation.AutomationElement]$Document) {
    $documentBounds = $Document.Current.BoundingRectangle
    $candidates = [System.Collections.Generic.List[object]]::new()
    foreach ($node in Get-DocumentNodes -Document $Document) {
        try {
            if ($node.Current.IsOffscreen) { continue }
            $isChatGroup = $node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group -and
                ($node.Current.AutomationId -eq 'chat-input' -or $node.Current.ClassName -eq 'chat-input')
            if (-not $isChatGroup -and
                $node.Current.ControlType -notin @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::Document)) { continue }
            $bounds = $node.Current.BoundingRectangle
            if ($bounds.Width -lt 180 -or $bounds.Width -gt ($documentBounds.Width * 0.75) -or
                $bounds.Height -lt 30 -or $bounds.Top -lt ($documentBounds.Top + ($documentBounds.Height * 0.48))) { continue }
            $priority = if ($isChatGroup) { 0 } else { 1 }
            $candidates.Add([pscustomobject]@{ Element = $node; Priority = $priority; Top = $bounds.Top; Bounds = $bounds })
        } catch {}
    }
    return @($candidates | Sort-Object Priority, @{ Expression = 'Top'; Descending = $true } | Select-Object -First 1)
}

function Set-ChatInput([System.Windows.Automation.AutomationElement]$InputElement, [string]$Message) {
    $state = Get-BossWindow
    if (-not (Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$state.Window.MainWindowHandle))) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
    $InputElement.SetFocus()
    Start-Sleep -Milliseconds 200
    $valuePattern = $null
    if ($InputElement.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern) -and
        -not $valuePattern.Current.IsReadOnly) {
        $valuePattern.SetValue($Message)
    } else {
        $hadText = [System.Windows.Forms.Clipboard]::ContainsText()
        $oldText = if ($hadText) { [System.Windows.Forms.Clipboard]::GetText() } else { "" }
        try {
            [System.Windows.Forms.Clipboard]::SetText($Message)
            [System.Windows.Forms.SendKeys]::SendWait("^a")
            [System.Windows.Forms.SendKeys]::SendWait("^v")
            Start-Sleep -Milliseconds 200
        } finally {
            if ($hadText) { [System.Windows.Forms.Clipboard]::SetText($oldText) } else { [System.Windows.Forms.Clipboard]::Clear() }
        }
    }
    Start-Sleep -Milliseconds 300
    $value = Get-Value -Element $InputElement
    if (-not $value) { $value = Clean-Text $InputElement.Current.Name }
    if (-not $value) { $value = Clean-Text (Get-TextPatternValue -Element $InputElement) }
    return $value
}

function Test-MessageVisible([System.Windows.Automation.AutomationElement]$Document, [string]$Message, [double]$InputTop) {
    try {
        $history = Get-CurrentChatRegion -Document $Document -ClassName 'message-content'
        if (-not $history) { return $false }
        $records = @(Get-RawChatNodes -Element $history -ChildrenOnly | Where-Object {
            [string]$_.Current.ClassName -cmatch '(^|\s)chat-record(\s|$)'
        })
        if ($records.Count -ne 1 -or $records[0].Current.IsOffscreen) { return $false }
        $messages = @(Get-RawChatNodes -Element $records[0] -ChildrenOnly | Where-Object {
            [string]$_.Current.ClassName -cmatch '(^|\s)chat-message(\s|$)'
        })
        if ($messages.Count -ne 1 -or $messages[0].Current.IsOffscreen) { return $false }
        $lists = @(Get-RawChatNodes -Element $messages[0] -ChildrenOnly | Where-Object {
            [string]$_.Current.ClassName -cmatch '(^|\s)im-list(\s|$)'
        })
        if ($lists.Count -ne 1 -or $lists[0].Current.IsOffscreen) { return $false }
        foreach ($item in Get-RawChatNodes -Element $lists[0] -ChildrenOnly) {
            if ($item.Current.IsOffscreen -or
                [string]$item.Current.ClassName -cnotmatch '(^|\s)message-item(\s|$)' -or
                [string]$item.Current.ClassName -cnotmatch '(^|\s)item-myself(\s|$)') { continue }
            $bodies = @(Get-RawChatNodes -Element $item -ChildrenOnly | Where-Object {
                [string]$_.Current.ClassName -cmatch '(^|\s)message-content(\s|$)'
            })
            if ($bodies.Count -ne 1 -or $bodies[0].Current.IsOffscreen) { continue }
            $texts = @(Get-RawChatNodes -Element $bodies[0] -ChildrenOnly | Where-Object {
                [string]$_.Current.ClassName -cmatch '(^|\s)text(\s|$)'
            })
            if ($texts.Count -ne 1 -or $texts[0].Current.IsOffscreen) { continue }
            $parts = [System.Collections.Generic.List[object]]::new()
            foreach ($content in Get-RawChatNodes -Element $texts[0]) {
                if ([string]$content.Current.ClassName -cnotmatch '(^|\s)text-content(\s|$)') { continue }
                foreach ($node in Get-RawChatNodes -Element $content) {
                    if ($node.Current.ControlType -ne [System.Windows.Automation.ControlType]::Text) { continue }
                    $value = Clean-Text $node.Current.Name
                    if ($value) { $parts.Add([pscustomobject]@{Text=$value;Visible=(-not $content.Current.IsOffscreen -and -not $node.Current.IsOffscreen)}) }
                }
            }
            # One exposed non-empty body is complete; multiple fragments cannot
            # prove that this message equals the approved text. Keep it unknown.
            if ($parts.Count -eq 1 -and $parts[0].Visible -and $parts[0].Text -eq (Clean-Text $Message)) { return $true }
        }
    } catch { return $false }
    return $false
}

function Test-DetailMessageVisible([System.Windows.Automation.AutomationElement]$Document, [string]$Message, [double]$InputTop) {
    foreach ($node in Get-DocumentNodes -Document $Document) {
        try {
            if ($node.Current.IsOffscreen) { continue }
            $bounds = $node.Current.BoundingRectangle
            if ($bounds.Top -ge $InputTop) { continue }
            if ((Clean-Text $node.Current.Name) -eq (Clean-Text $Message)) { return $true }
        } catch {}
    }
    return $false
}

function Get-ChromeBrowserOwner([System.Windows.Automation.AutomationElement]$Element, [string]$RootId) {
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $browser = $null
    $parent = $walker.GetParent($Element)
    while ($parent) {
        if ((@($parent.GetRuntimeId()) -join '.') -eq $RootId) { return $browser }
        if ($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { return $null }
        if ([string]$parent.Current.ClassName -ceq 'BrowserView') {
            if ($browser) { return $null }
            $browser = $parent
        }
        $parent = $walker.GetParent($parent)
    }
    return $null
}

function Get-ActiveDocument([System.Windows.Automation.AutomationElement]$Root) {
    try {
        if ([string]$Root.Current.ClassName -cne 'Chrome_WidgetWin_1') { throw 'Unexpected browser root.' }
        $rootId = @($Root.GetRuntimeId()) -join '.'
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        $nodes = @(Get-RawChatNodes -Element $Root)
        $tabs = @($nodes | Where-Object {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and
            -not $_.Current.IsOffscreen -and
            [string]$walker.GetParent($_).Current.ClassName -ceq 'TabContainerImpl' -and
            (Test-TabSelected -Tab $_) -and (Get-ChromeBrowserOwner -Element $_ -RootId $rootId)
        })
        if ($tabs.Count -ne 1) { throw 'The selected browser tab is ambiguous.' }
        $tabId = @($tabs[0].GetRuntimeId()) -join '.'
        $browserId = @((Get-ChromeBrowserOwner -Element $tabs[0] -RootId $rootId).GetRuntimeId()) -join '.'
        $documents = @($nodes | Where-Object {
            if ($_.Current.ControlType -ne [System.Windows.Automation.ControlType]::Document -or
                $_.Current.IsOffscreen -or [string]$_.Current.AutomationId -cne 'RootWebArea') { return $false }
            $hostNode = $walker.GetParent($_)
            if ([string]$hostNode.Current.ClassName -cne 'Chrome_RenderWidgetHostHWND' -or $hostNode.Current.IsOffscreen) { return $false }
            $owner = Get-ChromeBrowserOwner -Element $_ -RootId $rootId
            return $owner -and ((@($owner.GetRuntimeId()) -join '.') -eq $browserId)
        })
        if ($documents.Count -ne 1) { throw 'The browser document is ambiguous.' }
        $documentId = @($documents[0].GetRuntimeId()) -join '.'
        $documentHostId = @($walker.GetParent($documents[0]).GetRuntimeId()) -join '.'
        $selectedNow = @($nodes | Where-Object {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and
            -not $_.Current.IsOffscreen -and [string]$walker.GetParent($_).Current.ClassName -ceq 'TabContainerImpl' -and
            (Test-TabSelected -Tab $_) -and (Get-ChromeBrowserOwner -Element $_ -RootId $rootId)
        })
        if ($selectedNow.Count -ne 1 -or (@($selectedNow[0].GetRuntimeId()) -join '.') -ne $tabId) { throw 'The selected browser tab changed.' }
        $selectedOwner = Get-ChromeBrowserOwner -Element $selectedNow[0] -RootId $rootId
        $documentOwner = Get-ChromeBrowserOwner -Element $documents[0] -RootId $rootId
        $documentHost = $walker.GetParent($documents[0])
        if ((@($Root.GetRuntimeId()) -join '.') -ne $rootId -or
            (@($documents[0].GetRuntimeId()) -join '.') -ne $documentId -or $documents[0].Current.IsOffscreen -or
            [string]$documents[0].Current.AutomationId -cne 'RootWebArea' -or
            -not $selectedOwner -or -not $documentOwner -or
            (@($selectedOwner.GetRuntimeId()) -join '.') -ne $browserId -or (@($documentOwner.GetRuntimeId()) -join '.') -ne $browserId -or
            -not $documentHost -or $documentHost.Current.IsOffscreen -or [string]$documentHost.Current.ClassName -cne 'Chrome_RenderWidgetHostHWND' -or
            (@($documentHost.GetRuntimeId()) -join '.') -ne $documentHostId) { throw 'The active document ownership changed.' }
        return $documents[0]
    } catch { throw ('The active web document was not found: ' + $_.Exception.Message) }
}

function Get-DocumentNodes([System.Windows.Automation.AutomationElement]$Document) {
    return $Document.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
}

function Get-LoginState([System.Windows.Automation.AutomationElement]$Document, [string]$Address) {
    if ($Address -match "/web/user|login") { return "login_required" }
    $hasAccount = $false
    $hasLogin = $false
    $hasVerification = $Address -match "safe|verify|security-check"
    $nodes = Get-DocumentNodes -Document $Document
    foreach ($node in $nodes) {
        try {
            $name = Clean-Text $node.Current.Name
            if (-not $name) { continue }
            if ($name.StartsWith($messageName) -or $name -eq $resumeName) { $hasAccount = $true }
            if ($name -eq $loginName -or $name -eq "$loginName/$registerName") { $hasLogin = $true }
            if ($name -match [regex]::Escape($verificationName) -or $name -match [regex]::Escape($captchaName)) {
                $hasVerification = $true
            }
        } catch {}
    }
    if ($hasVerification) { return "verification_required" }
    if ($hasLogin) { return "login_required" }
    if ($hasAccount) { return "logged_in" }
    return "unknown"
}

function Convert-ExpectationLabel([string]$Name) {
    $label = (Clean-Text $Name).Normalize([System.Text.NormalizationForm]::FormKC)
    if ($label -eq $recommendName) { return [pscustomobject]@{ Id = 'recommended'; Name = $Name; City = ''; Keyword = '' } }
    $parts = [regex]::Match($label, '^(?<keyword>.+?)\s*\((?<city>[^()]+)\)$')
    if (-not $parts.Success) { return $null }
    $keyword = $parts.Groups['keyword'].Value.Trim()
    $city = $parts.Groups['city'].Value.Trim()
    if (-not $keyword -or -not $city -or $city.Length -gt 20 -or $keyword.Length -gt 80) { return $null }
    $normalizedLabel = "$keyword($city)"
    $id = 'boss:' + [Uri]::EscapeDataString($normalizedLabel)
    return [pscustomobject]@{ Id = $id; Name = $normalizedLabel; City = $city; Keyword = $keyword }
}

function Get-ExpectationId([string]$Name) {
    $expectation = Convert-ExpectationLabel -Name $Name
    if ($expectation) { return $expectation.Id }
    return ''
}

function Get-ExpectationItems([System.Windows.Automation.AutomationElement]$Document) {
    $nodes = Get-DocumentNodes -Document $Document
    $items = [System.Collections.Generic.List[object]]::new()
    $foundExpectationBar = $false
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    foreach ($element in $nodes) {
        try {
            $name = Clean-Text $element.Current.Name
            if ($element.Current.IsOffscreen) { continue }
            $className = [string]$element.Current.ClassName
            if ($className -notmatch '(^|\s)(expect-item|synthesis|add-expect-btn)(\s|$)') { continue }
            $parent = $walker.GetParent($element)
            if (-not $parent -or $parent.Current.IsOffscreen -or [string]$parent.Current.ClassName -notmatch '(^|\s)expect-and-search(\s|$)') { continue }
            $foundExpectationBar = $true
            if ($className -match '(^|\s)add-expect-btn(\s|$)') { continue }
            $expectation = Convert-ExpectationLabel -Name $name
            if (-not $expectation) { continue }
            if ($className -match '(^|\s)synthesis(\s|$)' -and $expectation.Id -ne 'recommended') { continue }
            $selected = $className -match "(^|\s)(active|selected)(\s|$)"
            $selection = $null
            $selectable = $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)
            if ($selectable) {
                $selected = $selected -or [bool]$selection.Current.IsSelected
            }
            $invoke = $null
            if (-not $selectable -and -not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { continue }
            $items.Add([pscustomobject]@{
                Id = $expectation.Id
                Name = $expectation.Name
                City = $expectation.City
                Keyword = $expectation.Keyword
                Selected = $selected
                ClassName = $className
                Element = $element
            })
        } catch {}
    }
    if (-not $foundExpectationBar) { throw '无法定位本实例页面的求职期望栏，请在 BOSS 岗位页核对后重试。' }
    # Keep the actual UI order: Group-Object sorts IDs and changes the first expectation.
    $seen = @{}
    return @($items | Where-Object {
        if ($seen.ContainsKey($_.Id)) { $false } else { $seen[$_.Id] = $true; $true }
    })
}

function Decode-ObfuscatedText([string]$Value) {
    $builder = [System.Text.StringBuilder]::new()
    foreach ($character in $Value.ToCharArray()) {
        $code = [int][char]$character
        if ($code -ge 0xE031 -and $code -le 0xE03A) {
            [void]$builder.Append($code - 0xE031)
        } else {
            [void]$builder.Append($character)
        }
    }
    return $builder.ToString()
}

function Get-JobCardElements([System.Windows.Automation.AutomationElement]$Document) {
    $nodes = Get-DocumentNodes -Document $Document
    return @($nodes | Where-Object {
        try {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem -and
            $_.Current.ClassName -match "(^|\s)job-card-box(\s|$)"
        } catch { $false }
    })
}

function Convert-JobCard([System.Windows.Automation.AutomationElement]$Card, [int]$Rank) {
    $nodes = $Card.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $title = ""
    $detailUrl = ""
    $company = ""
    $alreadyContacted = $false
    $isHeadhunter = $false
    $rawTags = [System.Collections.Generic.List[string]]::new()
    foreach ($node in $nodes) {
        try {
            $className = [string]$node.Current.ClassName
            $nodeName = Clean-Text $node.Current.Name
            if ($nodeName -eq $headhunterName -or
                ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Image -and
                 $className -match '(^|\s)job-tag-icon(\s|$)' -and
                 $nodeName.StartsWith($headhunterName + '. '))) { $isHeadhunter = $true }
            if ($className -eq "job-name") {
                $title = Clean-Text $node.Current.Name
                $detailUrl = Get-Value -Element $node
            } elseif ($className -match "(^|\s)boss-info(\s|$)" -or $className -match "(^|\s)company-name(\s|$)") {
                $candidate = Clean-Text $node.Current.Name
                if ($candidate) { $company = $candidate }
            } elseif ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem) {
                $candidate = Decode-ObfuscatedText (Clean-Text $node.Current.Name)
                if ($candidate) { $rawTags.Add($candidate) }
            }
            if ((Clean-Text $node.Current.Name) -eq $continueChatName) { $alreadyContacted = $true }
        } catch {}
    }

    $rawName = [string]$Card.Current.Name
    if ((Clean-Text $rawName).StartsWith($headhunterName)) { $isHeadhunter = $true }
    $salaryMatch = [regex]::Match($rawName, '[\uE031-\uE03A0-9]+-[\uE031-\uE03A0-9]+K')
    $salaryRaw = if ($salaryMatch.Success) { $salaryMatch.Value } else { "" }
    $salaryLength = if ($salaryMatch.Success) { $salaryMatch.Length } else { 0 }
    if ($salaryMatch.Success) {
        $tail = $rawName.Substring($salaryMatch.Index + $salaryMatch.Length)
        $suffix = [regex]::Match($tail, '^.[\uE031-\uE03A0-9]+\u85AA')
        if ($suffix.Success -and $suffix.Length -le 6) {
            $salaryRaw += $suffix.Value
            $salaryLength += $suffix.Length
        }
    }
    $salary = Decode-ObfuscatedText $salaryRaw

    $experience = ""
    $education = ""
    $companySize = ""
    $tags = [System.Collections.Generic.List[string]]::new()
    foreach ($tag in @($rawTags | Select-Object -Unique)) {
        if (-not $companySize -and $tag -match '^(?:\u5C11\u4E8E)?[0-9]+(?:\s*-\s*[0-9]+)?\s*\u4EBA(?:\u4EE5\u4E0A|\u4EE5\u4E0B)?$') {
            $companySize = $tag -replace '\s+', ''
        } elseif (-not $experience -and $tag -match '^([0-9]+-[0-9]+\u5E74|[0-9]+\u5E74\u4EE5\u4E0A|\u7ECF\u9A8C\u4E0D\u9650|\u5728\u6821|\u5E94\u5C4A)') {
            $experience = $tag
        } elseif (-not $education -and $tag -match '^(\u5B66\u5386\u4E0D\u9650|\u9AD8\u4E2D|\u4E2D\u4E13|\u5927\u4E13|\u672C\u79D1|\u7855\u58EB|\u535A\u58EB)') {
            $education = $tag
        } else {
            $tags.Add($tag)
        }
    }

    $location = ""
    if ($salaryMatch.Success) {
        $location = $rawName.Substring($salaryMatch.Index + $salaryLength)
    } else {
        $location = $rawName
    }
    foreach ($tag in $rawTags) {
        if ($location.StartsWith($tag)) { $location = $location.Substring($tag.Length) }
    }
    if ($company -and $location.StartsWith($company)) { $location = $location.Substring($company.Length) }
    $location = Clean-Text $location

    $jobId = ""
    if ($detailUrl -match '/job_detail/([^/?#]+)\.html') { $jobId = $Matches[1] }
    $locationParts = @($location -split [regex]::Escape([string]$middleDot))
    return [pscustomobject]@{
        rank = $Rank
        job_id = $jobId
        title = $title
        salary = $salary
        experience = $experience
        education = $education
        tags = @($tags)
        company = $company
        company_size = $companySize
        location = $location
        city = if ($locationParts.Count -gt 0) { $locationParts[0] } else { "" }
        district = if ($locationParts.Count -gt 1) { $locationParts[1] } else { "" }
        business_district = if ($locationParts.Count -gt 2) { $locationParts[2] } else { "" }
        detail_url = $detailUrl
        already_contacted = $alreadyContacted
        is_headhunter = $isHeadhunter
    }
}

function Get-JobCards([System.Windows.Automation.AutomationElement]$Document, [int]$Maximum) {
    $results = [System.Collections.Generic.List[object]]::new()
    $seen = @{}
    foreach ($card in Get-JobCardElements -Document $Document) {
        if ($results.Count -ge $Maximum) { break }
        try {
            $job = Convert-JobCard -Card $card -Rank ($results.Count + 1)
            if (-not $job.job_id -or $seen.ContainsKey($job.job_id)) { continue }
            $seen[$job.job_id] = $true
            $results.Add($job)
        } catch {}
    }
    return @($results)
}

function Get-JobListScrollTarget([System.Windows.Automation.AutomationElement]$Document) {
    try {
        $cards = @(Get-JobCardElements -Document $Document | Where-Object { -not $_.Current.IsOffscreen })
        if (-not $cards.Count) { return $null }
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        $documentId = @($Document.GetRuntimeId()) -join '.'
        $target = $null
        $targetId = ''
        foreach ($card in $cards) {
            $element = $walker.GetParent($card)
            $nearest = $null
            $inDocument = $false
            while ($element) {
                $id = @($element.GetRuntimeId()) -join '.'
                if ($id -ne $documentId -and $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { return $null }
                if (-not $nearest) {
                    $pattern = $null
                    if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern) -and
                        $pattern.Current.VerticallyScrollable) {
                        $nearest = [pscustomobject]@{ Element = $element; Pattern = $pattern }
                    }
                }
                if ($id -eq $documentId) { $inDocument = $true; break }
                $element = $walker.GetParent($element)
            }
            if (-not $inDocument -or -not $nearest) { return $null }
            $nearestId = @($nearest.Element.GetRuntimeId()) -join '.'
            if ($target -and $targetId -ne $nearestId) { return $null }
            $target = $nearest
            $targetId = $nearestId
        }
        return $target
    } catch { return $null }
}

function Move-JobListDown([System.Windows.Automation.AutomationElement]$Document) {
    $target = Get-JobListScrollTarget -Document $Document
    if (-not $target) {
        return [pscustomobject]@{ moved = $false; at_bottom = $true; before_percent = $null; after_percent = $null }
    }
    $before = [double]$target.Pattern.Current.VerticalScrollPercent
    $state = Get-BossWindow
    if (-not (Set-VerifiedForegroundWindow -WindowHandle ([IntPtr]$state.Window.MainWindowHandle))) { throw '本实例专用 Chrome 无法置前，请打开该窗口后重试。' }
    try {
        $Document.SetFocus()
        [System.Windows.Forms.SendKeys]::SendWait("^{END}")
    } catch {
        return [pscustomobject]@{ moved = $false; at_bottom = $before -ge 99.9; before_percent = $before; after_percent = $before }
    }
    Wait-AfterAction
    $after = $before
    try {
        $current = Get-BossWindow
        $currentDocument = Get-ActiveDocument -Root $current.Root
        $currentTarget = Get-JobListScrollTarget -Document $currentDocument
        if ($currentTarget) { $after = [double]$currentTarget.Pattern.Current.VerticalScrollPercent }
    } catch {}
    return [pscustomobject]@{
        moved = $true
        at_bottom = $after -ge 99.9
        before_percent = $before
        after_percent = $after
    }
}

function Move-JobListTop([System.Windows.Automation.AutomationElement]$Document) {
    $target = Get-JobListScrollTarget -Document $Document
    if (-not $target -or [double]$target.Pattern.Current.VerticalScrollPercent -le 0.0) { return $false }
    $target.Pattern.SetScrollPercent(
        [System.Windows.Automation.ScrollPattern]::NoScroll,
        0.0
    )
    Wait-AfterAction
    return $true
}

function Find-JobCard([System.Windows.Automation.AutomationElement]$Document, [string]$JobId) {
    foreach ($card in Get-JobCardElements -Document $Document) {
        $nodes = $card.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        foreach ($node in $nodes) {
            try {
                if ($node.Current.ClassName -eq "job-name" -and (Get-Value -Element $node) -like "*$JobId*") {
                    return [pscustomobject]@{ Card = $card; Summary = Convert-JobCard -Card $card -Rank 0 }
                }
            } catch {}
        }
    }
    return $null
}

function Test-HeadhunterDetail([System.Windows.Automation.AutomationElement]$Document) {
    $regions = Get-DetailRegions -Document $Document
    if (-not $regions) { throw 'The recruiter region could not be confirmed.' }
    $sections = @(Get-RawChatNodes -Element $regions.Detail -ChildrenOnly | Where-Object { [string]$_.Current.ClassName -ceq 'job-detail-section' })
    if ($sections.Count -ne 1) { throw 'The recruiter section is ambiguous.' }
    $names = @(Get-RawChatNodes -Element $sections[0] -ChildrenOnly | Where-Object {
        [string]$_.Current.ClassName -ceq 'name' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text
    })
    if ($names.Count -ne 1 -or -not (Clean-Text $names[0].Current.Name)) { throw 'The recruiter identity could not be confirmed.' }
    $identityNodes = @($names[0]) + @(Get-RawChatNodes -Element $names[0])
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $company = $walker.GetNextSibling($names[0])
    if ($company -and $company.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text) {
        $separator = $walker.GetNextSibling($company)
        if ($separator -and [string]$separator.Current.ClassName -ceq 'vdot') {
            $role = $walker.GetNextSibling($separator)
            if ($role -and $role.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text) {
                $identityNodes += @($company, $role)
            }
        }
    }
    foreach ($node in $identityNodes) {
        $name = Clean-Text $node.Current.Name
        if ($name -eq $headhunterConsultantName -or $name -eq $headhunterName -or
            $name.StartsWith($agencyCompanyName + $asciiColon) -or $name.StartsWith($agencyCompanyName + $fullwidthColon)) { return $true }
    }
    return $false
}

function Read-DetailAddress([System.Windows.Automation.AutomationElement]$Document) {
    try {
        $inline = Get-InlineDetailRoot -Document $Document
        if ($inline) {
            $heading = Text-FromCodes @(0x5DE5,0x4F5C,0x5730,0x5740)
            $headings = @(Get-RawChatNodes -Element $inline -ChildrenOnly | Where-Object {
                $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and (Clean-Text $_.Current.Name) -eq $heading
            })
            if ($headings.Count -ne 1) { return '' }
            $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
            $text = $walker.GetNextSibling($headings[0])
            $map = $walker.GetNextSibling($text)
            if ($text.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and
                [string]$map.Current.ClassName -ceq 'map-box-wrapper') { return (Clean-Text $text.Current.Name) }
            return ''
        }
        $regions = Get-DetailRegions -Document $Document
        if (-not $regions) { return '' }
        $sections = @(Get-RawChatNodes -Element $regions.Detail -ChildrenOnly | Where-Object { [string]$_.Current.ClassName -cmatch '(^|\s)job-detail-company(\s|$)' })
        if ($sections.Count -ne 1) { return '' }
        $locations = @(Get-RawChatNodes -Element $sections[0] -ChildrenOnly | Where-Object { [string]$_.Current.ClassName -ceq 'job-location' })
        if ($locations.Count -ne 1) { return '' }
        $addresses = @(Get-RawChatNodes -Element $locations[0] -ChildrenOnly | Where-Object { [string]$_.Current.ClassName -ceq 'location-address' })
        if ($addresses.Count -ne 1) { return '' }
        $texts = @(Get-RawChatNodes -Element $addresses[0] -ChildrenOnly | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and (Clean-Text $_.Current.Name) })
        if ($texts.Count -eq 1) { return (Clean-Text $texts[0].Current.Name) }
    } catch {}
    return ''
}

function Read-SelectedDetail([System.Windows.Automation.AutomationElement]$Document, [object]$Summary, [switch]$SampleOnly) {
    $nodes = Get-DocumentNodes -Document $Document
    $header = Read-DetailHeader -Document $Document
    if (-not $SampleOnly -and (-not $header.structure -or -not $header.structure.structure_ok)) {
        return [pscustomobject]@{
            job_id = $Summary.job_id
            status = 'incomplete'
            error = 'detail_incomplete'
            missing_fields = @('detail_structure')
            summary = $Summary
        }
    }
    $currentSummary = Get-DetailSummaryFromHeader -Header $header -Fallback $Summary
    if (-not $SampleOnly -and (Test-HeadhunterDetail -Document $Document)) {
        return [pscustomobject]@{
            job_id = $Summary.job_id
            title = $currentSummary.title
            company = $currentSummary.company
            salary = $currentSummary.salary
            city = $currentSummary.city
            detail_url = $Summary.detail_url
            status = "headhunter_skipped"
            error = ""
            is_headhunter = $true
            skip_reason = "headhunter"
            summary = $Summary
        }
    }
    $isClosed = @($nodes | Where-Object {
        try { (Clean-Text ([string]$_.Current.Name)) -match [regex]::Escape($jobClosedName) } catch { $false }
    }).Count -gt 0
    if ($isClosed -and -not $SampleOnly) {
        return [pscustomobject]@{
            job_id = $Summary.job_id
            title = $currentSummary.title
            company = $currentSummary.company
            salary = $currentSummary.salary
            city = $currentSummary.city
            status = "closed"
            error = "job_closed"
            summary = $Summary
        }
    }
    $communicationButton = Find-VisibleButton -Document $Document -Names @($startChatName, $continueChatName)
    if (-not $SampleOnly -and $communicationButton -and (Clean-Text $communicationButton.Current.Name) -eq $continueChatName) {
        return [pscustomobject]@{
            job_id = $Summary.job_id
            title = $currentSummary.title
            company = $currentSummary.company
            salary = $currentSummary.salary
            city = $currentSummary.city
            detail_url = $Summary.detail_url
            status = "already_contacted"
            already_contacted = $true
            summary = $Summary
        }
    }
    $descriptionBuilder = [System.Text.StringBuilder]::new()
    $detailTags = [System.Collections.Generic.List[string]]::new()
    $descriptionStarted = $false
    $descriptionFinished = $false
    $address = Read-DetailAddress -Document $Document
    $recruiterName = ""
    $recruiterTitle = ""
    $industry = $currentSummary.industry
    $companySize = $currentSummary.company_size
    $companyName = $currentSummary.company

    for ($index = 0; $index -lt $nodes.Count; $index += 1) {
        $node = $nodes[$index]
        try {
            $rawName = [string]$node.Current.Name
            $name = Clean-Text $rawName
            $className = [string]$node.Current.ClassName

            if ($name -eq $descriptionHeading) {
                $descriptionStarted = $true
                continue
            }
            if ($descriptionStarted -and -not $descriptionFinished) {
                if ($className -eq "name") {
                    $descriptionFinished = $true
                    $recruiterName = $name
                } elseif ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $rawName) {
                    [void]$descriptionBuilder.Append($rawName)
                }
            }

            if ($descriptionFinished -and $recruiterName -and -not $recruiterTitle -and
                $node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and
                $className -ne "name" -and $name) {
                $recruiterTitle = $name
            }


        } catch {}
    }

    foreach ($list in $nodes) {
        try {
            if ($list.Current.ControlType -ne [System.Windows.Automation.ControlType]::List -or
                $list.Current.ClassName -ne "job-label-list") { continue }
            $items = $list.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            foreach ($item in $items) {
                if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem) {
                    $name = Clean-Text $item.Current.Name
                    if ($name) { $detailTags.Add($name) }
                }
            }
        } catch {}
    }

    $companyTexts = [System.Collections.Generic.List[string]]::new()
    $companyLinks = [System.Collections.Generic.List[string]]::new()
    foreach ($container in $nodes) {
        try {
            $containerClass = [string]$container.Current.ClassName
            if ($containerClass -notmatch '(?i)(company-info|company-sider|sider-company)') { continue }
            $items = $container.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            foreach ($item in $items) {
                $name = Clean-Text $item.Current.Name
                if (-not $name -or $name.Length -gt 100) { continue }
                if (-not $companyTexts.Contains($name)) { $companyTexts.Add($name) }
                if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -and
                    -not $companyLinks.Contains($name)) {
                    $companyLinks.Add($name)
                }
                if (-not $companySize -and $name -match '^(?:\u4EBA\u5458\u89C4\u6A21|\u516C\u53F8\u89C4\u6A21)?[:\uFF1A]?\s*((?:\u5C11\u4E8E)?[0-9]+(?:\s*-\s*[0-9]+)?\s*\u4EBA(?:\u4EE5\u4E0A|\u4EE5\u4E0B)?)$') {
                    $companySize = $Matches[1] -replace '\s+', ''
                }
                if (-not $industry -and $name -match '^(?:\u6240\u5C5E)?\u884C\u4E1A[:\uFF1A]\s*(.+)$') {
                    $industry = Clean-Text $Matches[1]
                }
                $itemClass = [string]$item.Current.ClassName
                if (-not $industry -and $itemClass -match '(?i)industry' -and -not ($industryNames -contains $name)) {
                    $industry = $name
                }
            }
        } catch {}
    }

    if (-not $industry) {
        foreach ($label in $industryNames) {
            $labelIndex = $companyTexts.IndexOf($label)
            if ($labelIndex -ge 0 -and ($labelIndex + 1) -lt $companyTexts.Count) {
                $candidate = $companyTexts[$labelIndex + 1]
                if ($candidate -and -not ($industryNames -contains $candidate) -and
                    -not ($companySizeNames -contains $candidate)) {
                    $industry = $candidate
                    break
                }
            }
        }
    }
    if (-not $industry) {
        foreach ($candidate in $companyLinks) {
            if ($candidate -eq $companyName -or $candidate -match '^(?:\u67E5\u770B|\u516C\u53F8\u4E3B\u9875)' -or
                $candidate -match '^(?:\u672A\u878D\u8D44|\u4E0D\u9700\u8981\u878D\u8D44|\u5929\u4F7F\u8F6E|[A-Z]\u8F6E|\u5DF2\u4E0A\u5E02|\u6218\u7565\u878D\u8D44)$' -or
                $candidate -match '\u4EBA(?:\u4EE5\u4E0A|\u4EE5\u4E0B)?$') { continue }
            $industry = $candidate
            break
        }
    }

    $description = $descriptionBuilder.ToString().Trim()
    $missingFields = [System.Collections.Generic.List[string]]::new()
    if (-not $description) { $missingFields.Add("description") }
    if (-not $address) { $missingFields.Add("detail_address") }
    return [pscustomobject]@{
        job_id = $Summary.job_id
        title = $currentSummary.title
        company = $currentSummary.company
        salary = $currentSummary.salary
        city = $currentSummary.city
        status = if ($missingFields.Count -eq 0) { "ok" } else { "incomplete" }
        error = if ($missingFields.Count -eq 0) { "" } else { "detail_incomplete" }
        missing_fields = @($missingFields)
        summary = $Summary
        detail_tags = @($detailTags | Select-Object -Unique)
        description = $description
        address = $address
        industry = $industry
        company_size = $companySize
        recruiter = [pscustomobject]@{
            name = $recruiterName
            title = $recruiterTitle
        }
    }
}

function Read-DetailWithRetry([object]$Summary, [object]$Navigation, [switch]$Screening) {
    $deadline = $Navigation.StartedAt.AddSeconds(15)
    $checks = 0
    $result = $null
    $address = ""
    while ((Get-Date) -lt $deadline) {
        $checkStarted = Get-Date
        $checks += 1
        $address = Get-CurrentAddress -Root $Navigation.Root
        $result = $null
        $document = $null
        try { $document = Get-ActiveDocument -Root $Navigation.Root } catch {
            if ($_.Exception.Message -ne 'The active web document was not found.' -and $_.Exception.Message -notlike 'The active web document was not found: *') { throw }
        }
        $login = if ($address -match 'safe|verify|security-check') { 'verification_required' } elseif ($address -match '/web/user|login') { 'login_required' } elseif ($document) { Get-LoginState -Document $document -Address $address } else { 'unknown' }
        if ($login -in @('login_required', 'verification_required')) {
            return [pscustomobject]@{ status = 'user_action_required'; login_state = $login; current_url = $address; retry_count = $checks - 1 }
        }
        $tabId = Get-TabRuntimeId -Tab (Get-SelectedTab -Root $Navigation.Root)
        $documentId = if ($document) { @($document.GetRuntimeId()) -join '.' } else { '' }
        if ($address -notmatch "/job_detail/$([regex]::Escape($Summary.job_id))\.html(?:[?#]|$)") {
            $result = [pscustomobject]@{ job_id = $Summary.job_id; status = 'failed'; error = 'detail_navigation_mismatch'; current_url = $address }
        } elseif ($tabId -and $tabId -ne $Navigation.PreviousTabId -and $documentId -and $documentId -ne $Navigation.PreviousDocumentId -and $login -eq 'logged_in') {
            if ((Get-Date) -ge $deadline) { break }
            $result = Read-SelectedDetail -Document $document -Summary $Summary
            if ($result.status -ne 'incomplete') {
                if ($result.status -eq 'ok') {
                    if ($Screening) {
                        $readyAtMs = ([DateTimeOffset](Get-Date)).ToUnixTimeMilliseconds()
                        $minimum = [Math]::Min($JobDetailSettleMinMs, $JobDetailSettleMaxMs)
                        $maximum = [Math]::Max($JobDetailSettleMinMs, $JobDetailSettleMaxMs)
                        $result | Add-Member -NotePropertyName screening_detail_interval -NotePropertyValue ([pscustomobject]@{
                            ready_at_ms = $readyAtMs; target_ms = Get-Random -Minimum $minimum -Maximum ($maximum + 1)
                        })
                    } else { [void](Wait-JobDetail -Ready) }
                }
                $result | Add-Member -NotePropertyName retry_count -NotePropertyValue ($checks - 1)
                $result | Add-Member -NotePropertyName detail_tab_runtime_id -NotePropertyValue $tabId
                return $result
            }
        }
        $now = Get-Date
        $remaining = ($deadline - $now).TotalMilliseconds
        if ($remaining -le 0) { break }
        $delay = [Math]::Min($remaining, [Math]::Max(0, 500 - ($now - $checkStarted).TotalMilliseconds))
        if ($delay -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Ceiling($delay)) }
    }
    if (-not $result) { $result = [pscustomobject]@{ job_id = $Summary.job_id; status = 'failed'; error = 'detail_load_timeout'; current_url = $address } }
    $result | Add-Member -NotePropertyName retry_count -NotePropertyValue ([Math]::Max(0, $checks - 1))
    $result | Add-Member -NotePropertyName error_message -NotePropertyValue 'Detail page is still not ready within the 15-second loading window.'
    return $result
}

function Wait-ApplicationDetail([object]$Expected, [object]$Navigation) {
    $waitClock = [Diagnostics.Stopwatch]::StartNew()
    if ($null -eq $script:detailReadinessDiagnostic) { $script:detailReadinessDiagnostic = [ordered]@{ navigation = $null } }
    $diagnostic = $script:detailReadinessDiagnostic
    $diagnostic.started_at = $Navigation.StartedAt.ToUniversalTime().ToString('o')
    $diagnostic.checks = [System.Collections.Generic.List[object]]::new()
    $diagnostic.return_reason = 'exception'
    $diagnostic.stop_point = 'before_loop'
    try {
    $deadline = $Navigation.StartedAt.AddSeconds(15)
    $jobId = $Expected.job_id
    $result = $null
    $address = ''
    while ((Get-Date) -lt $deadline) {
        $checkStarted = Get-Date
        $roundClock = [Diagnostics.Stopwatch]::StartNew()
        $observation = [ordered]@{
            index = $diagnostic.checks.Count + 1; started_elapsed_ms = $waitClock.Elapsed.TotalMilliseconds
            remaining_start_ms = ($deadline - $checkStarted).TotalMilliseconds
            address_matches = $null; document_present = $null; login_state = $null
            tab_id = $null; document_id = $null; previous_tab_id = [string]$Navigation.PreviousTabId
            previous_document_id = [string]$Navigation.PreviousDocumentId
            same_previous_tab = $null; same_previous_document = $null; page_ready = $null
            remaining_before_header_ms = $null; remaining_after_button_ms = $null
            header_structure_ok = $null; header_matched = $null; missing_fields = $null
            is_headhunter = $null; job_closed = $null; button_present = $null
            address_elapsed_ms = $null; document_elapsed_ms = $null; login_elapsed_ms = $null
            identity_elapsed_ms = $null; header_elapsed_ms = $null; hunter_elapsed_ms = $null
            header_check_elapsed_ms = $null; button_elapsed_ms = $null; settle_elapsed_ms = $null
            sleep_elapsed_ms = $null; stop_point = 'address'
        }
        try {
        $stageStarted = $roundClock.Elapsed.TotalMilliseconds
        $address = Get-CurrentAddress -Root $Navigation.Root
        $observation.address_elapsed_ms = $roundClock.Elapsed.TotalMilliseconds - $stageStarted
        $stageStarted = $roundClock.Elapsed.TotalMilliseconds
        $observation.stop_point = 'document'
        $result = $null
        $document = $null
        try { $document = Get-ActiveDocument -Root $Navigation.Root } catch {
            if ($_.Exception.Message -ne 'The active web document was not found.' -and $_.Exception.Message -notlike 'The active web document was not found: *') { throw }
        }
        $observation.document_present = [bool]$document
        $observation.document_elapsed_ms = $roundClock.Elapsed.TotalMilliseconds - $stageStarted
        $stageStarted = $roundClock.Elapsed.TotalMilliseconds
        $observation.stop_point = 'login'
        $login = if ($address -match 'safe|verify|security-check') { 'verification_required' } elseif ($address -match '/web/user|login') { 'login_required' } elseif ($document) { Get-LoginState -Document $document -Address $address } else { 'unknown' }
        $observation.login_state = $login
        $observation.login_elapsed_ms = $roundClock.Elapsed.TotalMilliseconds - $stageStarted
        if ($login -in @('login_required', 'verification_required')) {
            $diagnostic.return_reason = $login
            return [pscustomobject]@{ status = 'user_action_required'; login_state = $login; current_url = $address }
        }
        $stageStarted = $roundClock.Elapsed.TotalMilliseconds
        $observation.stop_point = 'identity'
        $tabId = Get-TabRuntimeId -Tab (Get-SelectedTab -Root $Navigation.Root)
        $documentId = if ($document) { @($document.GetRuntimeId()) -join '.' } else { '' }
        $pageReady = $tabId -and $documentId -and (-not $Navigation.PreviousTabId -or
            ($tabId -ne $Navigation.PreviousTabId -and $documentId -ne $Navigation.PreviousDocumentId))
        $observation.tab_id = [string]$tabId
        $observation.document_id = [string]$documentId
        $observation.same_previous_tab = if ($Navigation.PreviousTabId) { $tabId -eq $Navigation.PreviousTabId } else { $null }
        $observation.same_previous_document = if ($Navigation.PreviousDocumentId) { $documentId -eq $Navigation.PreviousDocumentId } else { $null }
        $observation.page_ready = [bool]$pageReady
        $observation.identity_elapsed_ms = $roundClock.Elapsed.TotalMilliseconds - $stageStarted
        if ($address -notmatch "/job_detail/$([regex]::Escape($jobId))\.html(?:[?#]|$)") {
            $observation.address_matches = $false
            $observation.stop_point = 'address_mismatch'
            $result = [pscustomobject]@{ status = 'failed'; job_id = $jobId; error = 'detail_navigation_mismatch'; current_url = $address }
        } elseif ($pageReady -and $login -eq 'logged_in') {
            $observation.address_matches = $true
            $beforeHeader = Get-Date
            $observation.remaining_before_header_ms = ($deadline - $beforeHeader).TotalMilliseconds
            if ($beforeHeader -ge $deadline) { $observation.stop_point = 'deadline_before_header'; break }
            $observation.stop_point = 'header'
            $stageStarted = $roundClock.Elapsed.TotalMilliseconds
            $header = Read-DetailHeader -Document $document
            $observation.header_elapsed_ms = $roundClock.Elapsed.TotalMilliseconds - $stageStarted
            $structure = $header.PSObject.Properties['structure']
            if ($structure) { $observation.header_structure_ok = [bool]$structure.Value.structure_ok }
            $stageStarted = $roundClock.Elapsed.TotalMilliseconds
            $observation.stop_point = 'hunter'
            $isHeadhunter = Test-HeadhunterDetail -Document $document
            $observation.is_headhunter = [bool]$isHeadhunter
            $observation.hunter_elapsed_ms = $roundClock.Elapsed.TotalMilliseconds - $stageStarted
            if ($isHeadhunter) {
                $observation.stop_point = 'headhunter'
                $diagnostic.return_reason = 'headhunter_skipped' 
                return [pscustomobject]@{ status = 'headhunter_skipped'; job_id = $jobId; error = ''; is_headhunter = $true; skip_reason = 'headhunter'; header = $header }
            }
            $stageStarted = $roundClock.Elapsed.TotalMilliseconds
            $observation.stop_point = 'header_check'
            $headerCheck = Test-DetailHeader -Header $header -Expected $Expected
            $observation.header_matched = [bool]$headerCheck.matched
            $observation.missing_fields = @($headerCheck.missing_fields)
            $observation.header_check_elapsed_ms = $roundClock.Elapsed.TotalMilliseconds - $stageStarted
            if (-not $headerCheck.matched) {
                $observation.stop_point = 'header_mismatch'
                $result = [pscustomobject]@{ status = 'failed'; job_id = $jobId; error = 'detail_summary_mismatch'; missing_fields = $headerCheck.missing_fields; header = $header }
            } elseif ($header.text -match [regex]::Escape($jobClosedName)) {
                $observation.job_closed = $true
                $observation.stop_point = 'job_closed'
                $diagnostic.return_reason = 'job_closed'
                return [pscustomobject]@{ status = 'failed'; job_id = $jobId; error = 'job_closed'; header = $header }
            } else {
                $observation.job_closed = $false
                $observation.stop_point = 'button'
                $stageStarted = $roundClock.Elapsed.TotalMilliseconds
                $button = Find-VisibleButton -Document $document -Names @($startChatName, $continueChatName)
                $observation.button_present = [bool]$button
                $observation.button_elapsed_ms = $roundClock.Elapsed.TotalMilliseconds - $stageStarted
                $buttonWithinDeadline = $false
                if ($button) {
                    $afterButton = Get-Date
                    $observation.remaining_after_button_ms = ($deadline - $afterButton).TotalMilliseconds
                    $buttonWithinDeadline = $afterButton -lt $deadline
                }
                if ($button -and $buttonWithinDeadline) {
                    $stageStarted = $roundClock.Elapsed.TotalMilliseconds
                    $observation.stop_point = 'settle'
                    [void](Wait-JobDetail -Ready)
                    $observation.settle_elapsed_ms = $roundClock.Elapsed.TotalMilliseconds - $stageStarted
                    $observation.stop_point = 'ready'
                    $diagnostic.return_reason = 'ok'
                    return [pscustomobject]@{ status = 'ok'; document = $document; button = $button; header = $header; current_url = $address }
                }
                $observation.stop_point = if ($button) { 'deadline_after_button' } else { 'button_missing' }
                $result = [pscustomobject]@{ status = 'failed'; job_id = $jobId; error = 'communication_button_not_found'; header = $header }
            }
        } else {
            $observation.address_matches = $true
            $observation.stop_point = if (-not $pageReady) { 'page_not_ready' } else { 'login_not_ready' }
        }
        $now = Get-Date
        $remaining = ($deadline - $now).TotalMilliseconds
        if ($remaining -le 0) { break }
        $delay = [Math]::Min($remaining, [Math]::Max(0, 500 - ($now - $checkStarted).TotalMilliseconds))
        if ($delay -gt 0) {
            $stageStarted = $roundClock.Elapsed.TotalMilliseconds
            Start-Sleep -Milliseconds ([int][Math]::Ceiling($delay))
            $observation.sleep_elapsed_ms = $roundClock.Elapsed.TotalMilliseconds - $stageStarted
        }
        } finally {
            $observation.elapsed_ms = $roundClock.Elapsed.TotalMilliseconds
            $observation.remaining_end_ms = ($deadline - [datetime]::Now).TotalMilliseconds
            $diagnostic.checks.Add([pscustomobject]$observation)
            $diagnostic.stop_point = $observation.stop_point
        }
    }
    if (-not $result) { $result = [pscustomobject]@{ status = 'failed'; job_id = $jobId; error = 'detail_load_timeout'; current_url = $address } }
    $result | Add-Member -NotePropertyName error_message -NotePropertyValue 'Detail page is still not ready within the 15-second loading window.'
    $diagnostic.return_reason = $result.error
    return $result
    } finally {
        $diagnostic.elapsed_ms = $waitClock.Elapsed.TotalMilliseconds
        $diagnostic.remaining_end_ms = ($Navigation.StartedAt.AddSeconds(15) - [datetime]::Now).TotalMilliseconds
        $diagnostic.checks = @($diagnostic.checks.ToArray())
    }
}

function Write-Result([object]$Value) {
    if ($null -ne $script:detailReadinessDiagnostic) {
        try { $Value | Add-Member -NotePropertyName detail_readiness_diagnostic -NotePropertyValue ([pscustomobject]$script:detailReadinessDiagnostic) -Force } catch {}
    }
    if ($null -ne $script:chatDiagnostics) {
        try { $Value | Add-Member -NotePropertyName contact_diagnostic -NotePropertyValue ([pscustomobject]@{events=@($script:chatDiagnostics.ToArray())}) -Force } catch {}
    }
    $Value | ConvertTo-Json -Depth 10 -Compress
}

function Test-SampleCardSelected([System.Windows.Automation.AutomationElement]$Card) {
    if ([string]$Card.Current.ClassName -match '(^|\s)(active|selected)(\s|$)') { return $true }
    $pattern = $null
    if ($Card.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { return [bool]$pattern.Current.IsSelected }
    # HTML list cards may expose no selected class or SelectionItemPattern.
    return $null
}

function Get-SampleDetailRoot([System.Windows.Automation.AutomationElement]$Document, [object]$Summary, [switch]$RequireUniqueCard) {
    if ($RequireUniqueCard) {
        # With no selection indicator, a title/company pair shared by different cards cannot identify the JD.
        $cards = @(Get-JobCardElements -Document $Document)
        foreach ($card in $cards) {
            if ((Test-SampleCardSelected -Card $card) -eq $true -and (Convert-JobCard -Card $card -Rank 1).job_id -ne $Summary.job_id) { return $null }
        }
        $matchingCards = @($cards | ForEach-Object { Convert-JobCard -Card $_ -Rank 1 } | Where-Object { $_.title -eq $Summary.title -and $_.company -eq $Summary.company })
        if ($matchingCards.Count -ne 1 -or $matchingCards[0].job_id -ne $Summary.job_id) { return $null }
    }
    # Match a detail-only subtree: list cards cannot prove which JD is selected.
    foreach ($heading in Get-DocumentNodes -Document $Document) {
        if ($heading.Current.IsOffscreen -or (Clean-Text $heading.Current.Name) -ne $descriptionHeading) { continue }
        $parent = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($heading)
        while ($null -ne $parent -and -not [System.Windows.Automation.Automation]::Compare($parent,$Document)) {
            if (@(Get-JobCardElements -Document $parent).Count) { break }
            # The inline JD may omit the card's company and combine title/salary.
            # Its own details link identifies the job without using list-card text.
            $detailIds = @(foreach ($node in Get-DocumentNodes -Document $parent) {
                if ($node.Current.ControlType -ne [System.Windows.Automation.ControlType]::Hyperlink -or
                    (Clean-Text $node.Current.Name) -ne '查看更多信息') { continue }
                $url = Get-Value -Element $node
                if ($url -match '^(?:https://)?www\.zhipin\.com/job_detail/([^/?#]+)\.html(?:[?#]|$)') { $Matches[1] }
            })
            if ($detailIds.Count) {
                if (@($detailIds | Select-Object -Unique).Count -eq 1 -and $detailIds[0] -ceq $Summary.job_id) { return $parent }
                return $null
            }
            $parent = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($parent)
        }
    }
    return $null
}

function Close-BossChromeWindow([IntPtr]$WindowHandle, [string]$MessagePrefix = '') {
    if (-not [BossWindowApi]::PostMessage($WindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)) { throw ($MessagePrefix+'窗口关闭请求未能发送。') }
    $deadline = (Get-Date).AddSeconds(5)
    while ([BossWindowApi]::IsWindow($WindowHandle) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ([BossWindowApi]::IsWindow($WindowHandle)) { throw ($MessagePrefix+'专用BOSS窗口尚未关闭，请手动处理。') }
}

if ($Action -eq 'CloseTaskWindows') {
    $allWindows = @(Get-DedicatedChromeWindows -ProfileDirectory $ChromeProfileDirectory)
    # Classify before closing: an attached bubble can disappear with its main window.
    $windows = @(
        $classificationIndex = 0
        foreach ($window in $allWindows) {
            $classificationIndex++
            try { $root = Get-Root -Window $window }
            catch { throw ('未能读取当前专用窗口地址，未自动关闭。 window=' + $classificationIndex + '/' + $allWindows.Count + ' pid=' + $window.Id + ' hwnd=' + $window.MainWindowHandle.ToInt64() + ' stage=address.root_query_failed/' + $_.Exception.GetType().Name) }
            try { $isMainWindow = Test-ChromeMainWindow -Root $root }
            catch { throw ('未能识别当前专用Chrome主窗口，未自动关闭。 window=' + $classificationIndex + '/' + $allWindows.Count + ' pid=' + $window.Id + ' hwnd=' + $window.MainWindowHandle.ToInt64() + ' stage=' + $_.Exception.Message) }
            if ($isMainWindow) { $window }
        }
    )
    $closed = 0
    $skipped = 0
    $windowIndex = 0
    foreach ($window in $windows) {
        $windowIndex++
        # Fresh profile/PID/handle membership before closing a window from this installation.
        $owned = @(Get-DedicatedChromeWindows -ProfileDirectory $ChromeProfileDirectory | Where-Object {
            $_.Id -eq $window.Id -and $_.MainWindowHandle -eq $window.MainWindowHandle
        })
        if ($owned.Count -ne 1) { throw '专用窗口已变化，未关闭其他窗口。' }
        try { $root = Get-Root -Window $window }
        catch { throw ('未能读取当前专用窗口地址，未自动关闭。 window=' + $windowIndex + '/' + $windows.Count + ' pid=' + $window.Id + ' hwnd=' + $window.MainWindowHandle.ToInt64() + ' stage=address.root_query_failed/' + $_.Exception.GetType().Name) }
        try { $address = ([string](Get-CurrentAddress -Root $root -ExplainFailure)).Trim() }
        catch { throw ('未能读取当前专用窗口地址，未自动关闭。 window=' + $windowIndex + '/' + $windows.Count + ' pid=' + $window.Id + ' hwnd=' + $window.MainWindowHandle.ToInt64() + ' stage=' + $_.Exception.Message) }
        if (-not $address) { throw '未能读取当前专用窗口地址，未自动关闭。 stage=address.value_empty' }
        if ($address -notmatch '^(?:https://)?(?:www\.)?zhipin\.com(?:/|$)') { $skipped++; continue }
        Close-BossChromeWindow -WindowHandle $window.MainWindowHandle
        $closed++
    }
    Write-Result ([pscustomobject]@{ status = 'ok'; closed = ($closed -gt 0 -and $skipped -eq 0); closed_count = $closed; skipped_count = $skipped })
    exit 0
}

if ($Action -eq 'CloseSampleWindow') {
    $target = Decode-Payload
    $windows = @(Get-DedicatedChromeWindows -ProfileDirectory $ChromeProfileDirectory | Where-Object {
        $_.Id -eq $target.process_id -and $_.MainWindowHandle.ToInt64() -eq $target.window_handle
    })
    if ($windows.Count -ne 1) { throw '样本已保存，但本次专用BOSS窗口已变化，未关闭其他窗口。' }
    $window = $windows[0]
    $root = Get-Root -Window $window
    try { $isMainWindow = Test-ChromeMainWindow -Root $root }
    catch { throw ('样本已保存，未能识别当前专用Chrome主窗口，未自动关闭。 pid=' + $window.Id + ' hwnd=' + $window.MainWindowHandle.ToInt64() + ' stage=' + $_.Exception.Message) }
    if (-not $isMainWindow) { throw '样本已保存，当前对象不是浏览器主窗口，未自动关闭。' }
    $address = ([string](Get-CurrentAddress -Root $root)).Trim()
    if (-not $address) { throw '样本已保存，未能读取当前专用窗口地址，未自动关闭。' }
    if ($address -notmatch '^(?:https://)?(?:www\.)?zhipin\.com(?:/|$)') { throw '样本已保存，当前地址未识别为BOSS，未自动关闭。' }
    Close-BossChromeWindow -WindowHandle $window.MainWindowHandle -MessagePrefix '样本已保存，'
    Write-Result ([pscustomobject]@{ status = 'ok'; closed = $true })
    exit 0
}

if ($Action -eq "FocusDedicatedWindow") {
    $focusUrl = ''
    $focusWait = 0
    if ($PayloadBase64) {
        $focusRequest = Decode-Payload
        $focusUrl = Get-PayloadText -Payload $focusRequest -Name 'target_url'
        if ($focusRequest.PSObject.Properties['wait_for_window'] -and $focusRequest.wait_for_window -eq $true) { $focusWait = 10000 }
    }
    Write-Result ([pscustomobject]@{
        focused = Focus-DedicatedChromeWindow -ProfileDirectory $ChromeProfileDirectory -TargetUrl $focusUrl -WaitMilliseconds $focusWait
    })
    exit 0
}

if ($Action -eq "Status") {
    $state = Get-BossWindow
    $document = Get-ActiveDocument -Root $state.Root
    Write-Result ([pscustomobject]@{
        browser_state = "ready"
        process_id = $state.Window.Id
        window_title = $state.Window.MainWindowTitle
        current_url = $state.Address
        tab_count = @(Get-Tabs -Root $state.Root).Count
        login_state = Get-LoginState -Document $document -Address $state.Address
    })
    exit 0
}

if ($Action -eq "LocateChat") {
    $payload = Decode-Payload
    Write-Result (Locate-ExpectedChat -Expected $payload)
    exit 0
}

if ($Action -eq "VerifyDelivery") {
    $script:chatDiagnostics = [System.Collections.Generic.List[object]]::new()
    $payload = Decode-Payload
    $message = Get-PayloadText -Payload $payload -Name 'message'
    if (-not $message) { throw 'A non-empty reviewed message is required.' }
    $located = Locate-ExpectedChat -Expected $payload
    if ($located.status -ne 'ok') { Write-Result $located; exit 0 }
    $state = Get-BossWindow
    $document = Get-ActiveDocument -Root $state.Root
    $inputs = @(Find-ChatInput -Document $document)
    if (-not $inputs.Count) { Write-Result ([pscustomobject]@{ status = 'uncertain'; message_sent = $false; error = 'chat_input_not_found' }); exit 0 }
    $visible = Test-MessageVisible -Document $document -Message $message -InputTop $inputs[0].Bounds.Top
    Write-Result ([pscustomobject]@{ status = if ($visible) { 'sent' } else { 'uncertain' }; message_sent = $visible; header = $located.header; error = if ($visible) { '' } else { 'reviewed_message_not_visible' } })
    exit 0
}
if ($Action -eq "PrepareChatBatch") {
    $script:chatDiagnostics = [System.Collections.Generic.List[object]]::new()
    $payload = Decode-Payload
    $itemsProperty = $payload.PSObject.Properties['items']
    if (-not $itemsProperty -or -not @($itemsProperty.Value).Count) { throw 'items are required.' }
    try { Write-Result (Prepare-ChatBatch -Items @($itemsProperty.Value)) } catch {
        $originalError = $_
        Add-ChatDiagnostic 'action.exception' { @{error_type=$originalError.Exception.GetType().Name} }
        try { Write-Result ([pscustomobject]@{}) } catch {}
        throw $originalError
    }
    exit 0
}

if ($Action -eq "LocateChatFromBatch") {
    $script:chatDiagnostics = [System.Collections.Generic.List[object]]::new()
    $payload = Decode-Payload
    $locationPayload = [pscustomobject]@{
        expected = $payload.expected
        plan = $payload.plan
        snapshot = $payload.snapshot
    }
    try { Write-Result (Locate-ExpectedChatFromBatch -Payload $locationPayload) } catch {
        $originalError = $_
        Add-ChatDiagnostic 'action.exception' { @{error_type=$originalError.Exception.GetType().Name} }
        try { Write-Result ([pscustomobject]@{}) } catch {}
        throw $originalError
    }
    exit 0
}

if ($Action -eq "SendChatMessageFromBatch") {
    $script:chatDiagnostics = [System.Collections.Generic.List[object]]::new()
    $payload = Decode-Payload
    $message = Get-PayloadText -Payload $payload -Name 'message'
    $sendMode = Get-PayloadText -Payload $payload -Name 'send_mode'
    if (-not $message) { throw 'A non-empty chat message is required.' }
    if ($sendMode -notin @('fill_only', 'send')) { throw 'send_mode must be fill_only or send.' }
    $located = $null
    $sendActionStarted = $false
    try {
        $located = Locate-ExpectedChatFromBatch -Payload $payload
        if ($located.status -ne 'ok') {
            Write-Result (Add-ChatSendAudit -Result $located -Located $located -SendStatus 'not_attempted' -MessageSent $false -SendError (Get-PayloadText -Payload $located -Name 'error'))
            exit 0
        }
        $state = Get-BossWindow
        $document = Get-ActiveDocument -Root $state.Root
        $inputCandidates = @(Find-ChatInput -Document $document)
        if (-not $inputCandidates.Count) {
            Write-Result (Add-ChatSendAudit -Result ([pscustomobject]@{ status = 'failed'; error = 'chat_input_not_found'; header = $located.header }) -Located $located -SendStatus 'not_attempted' -MessageSent $false -SendError 'chat_input_not_found')
            exit 0
        }
        $input = $inputCandidates[0]
        $inputValue = Set-ChatInput -InputElement $input.Element -Message $message
        if ((Clean-Text $inputValue) -ne (Clean-Text $message)) {
            Write-Result (Add-ChatSendAudit -Result ([pscustomobject]@{ status = 'failed'; error = 'chat_input_verification_failed'; input_value = $inputValue }) -Located $located -SendStatus 'not_attempted' -MessageSent $false -SendError 'chat_input_verification_failed')
            exit 0
        }
        if ($sendMode -eq 'fill_only') {
            Write-Result (Add-ChatSendAudit -Result ([pscustomobject]@{ status = 'ok'; send_mode = 'fill_only'; input_verified = $true; message_sent = $false; header = $located.header }) -Located $located -SendStatus 'fill_only' -MessageSent $false)
            exit 0
        }
        $sendTarget = Get-ChatSendTarget -State $state -Document $document -ChatInput $input -Expected $payload.expected -Message $message
        $sendButton = if ($sendTarget) { $sendTarget.Button } else { $null }
        if ($sendTarget) { $input = $sendTarget.Input }
        if (-not $sendButton) {
            Write-Result (Add-ChatSendAudit -Result ([pscustomobject]@{ status = 'failed'; error = 'send_button_not_found'; input_verified = $true }) -Located $located -SendStatus 'not_attempted' -MessageSent $false -SendError 'send_button_not_found')
            exit 0
        }
        Start-Sleep -Milliseconds (Get-Random -Minimum 500 -Maximum 1001)
        $sendActionStarted = $true
        Invoke-Element -Element $sendButton
        Wait-AfterAction -SendConfirmation
        $after = Get-BossWindow
        $afterDocument = Get-ActiveDocument -Root $after.Root
        $messageVisible = Test-MessageVisible -Document $afterDocument -Message $message -InputTop $input.Bounds.Top
        Write-Result (Add-ChatSendAudit -Result ([pscustomobject]@{
            status = if ($messageVisible) { 'ok' } else { 'failed' }
            error = if ($messageVisible) { '' } else { 'sent_message_not_visible' }
            send_mode = 'send'
            input_verified = $true
            message_sent = $messageVisible
            header = $located.header
        }) -Located $located -SendStatus $(if ($messageVisible) { 'sent' } else { 'unverified' }) -MessageSent $messageVisible -SendError $(if ($messageVisible) { '' } else { 'sent_message_not_visible' }))
        exit 0
    } catch {
        $originalError = $_
        Add-ChatDiagnostic 'action.exception' { @{error_type=$originalError.Exception.GetType().Name} }
        if ($sendActionStarted) { try { Write-Result ([pscustomobject]@{}) } catch {}; throw $originalError }
        $errorDetail = $originalError.Exception.Message
        $failure = [pscustomobject]@{
            status = 'failed'
            error = 'unexpected_chat_message_error'
            detail = $errorDetail
            send_mode = $sendMode
            message_sent = $false
        }
        if ($located -and $located.PSObject.Properties['location']) {
            $failure = Add-ChatSendAudit -Result $failure -Located $located -SendStatus 'not_attempted' -MessageSent $false -SendError $errorDetail
        } else {
            $failure | Add-Member -NotePropertyName send_result -NotePropertyValue ([pscustomobject]@{ status = 'not_attempted'; message_sent = $false; error = $errorDetail }) -Force
        }
        Write-Result $failure
        exit 0
    }
}

if ($Action -eq "SendChatMessage") {
    $payload = Decode-Payload
    $message = Get-PayloadText -Payload $payload -Name "message"
    $sendMode = Get-PayloadText -Payload $payload -Name "send_mode"
    $openChatPageProperty = $payload.PSObject.Properties['open_chat_page']
    $openChatPage = if ($openChatPageProperty) { [bool]$openChatPageProperty.Value } else { $true }
    if (-not $message) { throw "A non-empty chat message is required." }
    if ($sendMode -notin @("fill_only", "send")) { throw "send_mode must be fill_only or send." }

    $located = Locate-ExpectedChat -Expected $payload -OpenChatPage $openChatPage
    if ($located.status -ne "ok") {
        Write-Result (Add-ChatSendAudit -Result $located -Located $located -SendStatus 'not_attempted' -MessageSent $false -SendError (Get-PayloadText -Payload $located -Name 'error'))
        exit 0
    }
    $state = Get-BossWindow
    $document = Get-ActiveDocument -Root $state.Root
    $inputCandidates = @(Find-ChatInput -Document $document)
    if (-not $inputCandidates.Count) {
        Write-Result (Add-ChatSendAudit -Result ([pscustomobject]@{ status = "failed"; error = "chat_input_not_found"; header = $located.header }) -Located $located -SendStatus 'not_attempted' -MessageSent $false -SendError 'chat_input_not_found')
        exit 0
    }
    $input = $inputCandidates[0]
    $inputValue = Set-ChatInput -InputElement $input.Element -Message $message
    $verified = (Clean-Text $inputValue) -eq (Clean-Text $message)
    if (-not $verified) {
        Write-Result (Add-ChatSendAudit -Result ([pscustomobject]@{ status = "failed"; error = "chat_input_verification_failed"; input_value = $inputValue }) -Located $located -SendStatus 'not_attempted' -MessageSent $false -SendError 'chat_input_verification_failed')
        exit 0
    }
    if ($sendMode -eq "fill_only") {
        Write-Result (Add-ChatSendAudit -Result ([pscustomobject]@{ status = "ok"; send_mode = "fill_only"; input_verified = $true; message_sent = $false; header = $located.header }) -Located $located -SendStatus 'fill_only' -MessageSent $false)
        exit 0
    }

    $sendTarget = Get-ChatSendTarget -State $state -Document $document -ChatInput $input -Expected $payload -Message $message
    $sendButton = if ($sendTarget) { $sendTarget.Button } else { $null }
    if ($sendTarget) { $input = $sendTarget.Input }
    if (-not $sendButton) {
        Write-Result (Add-ChatSendAudit -Result ([pscustomobject]@{ status = "failed"; error = "send_button_not_found"; input_verified = $true }) -Located $located -SendStatus 'not_attempted' -MessageSent $false -SendError 'send_button_not_found')
        exit 0
    }
    Start-Sleep -Milliseconds (Get-Random -Minimum 500 -Maximum 1001)
    Invoke-Element -Element $sendButton
    Wait-AfterAction -SendConfirmation
    $after = Get-BossWindow
    $afterDocument = Get-ActiveDocument -Root $after.Root
    $messageVisible = Test-MessageVisible -Document $afterDocument -Message $message -InputTop $input.Bounds.Top
    Write-Result (Add-ChatSendAudit -Result ([pscustomobject]@{
        status = if ($messageVisible) { "ok" } else { "failed" }
        error = if ($messageVisible) { "" } else { "sent_message_not_visible" }
        send_mode = "send"
        input_verified = $true
        message_sent = $messageVisible
        header = $located.header
    }) -Located $located -SendStatus $(if ($messageVisible) { 'sent' } else { 'unverified' }) -MessageSent $messageVisible -SendError $(if ($messageVisible) { '' } else { 'sent_message_not_visible' }))
    exit 0
}

if ($Action -eq "ApplyFromDetail") {
    $payload = Decode-Payload
    $jobId = Get-PayloadText -Payload $payload -Name "job_id"
    $detailUrl = Get-PayloadText -Payload $payload -Name "detail_url"
    $detailTabRuntimeId = Get-PayloadText -Payload $payload -Name "detail_tab_runtime_id"
    if (-not $jobId -or -not $detailUrl) { throw "job_id and detail_url are required." }
    if ($detailUrl -notmatch '^https://www\.zhipin\.com/job_detail/([^/?#]+)\.html$' -or $Matches[1] -ne $jobId) {
        throw "detail_url must be the BOSS detail URL for the supplied job_id."
    }

    try {
        $navigation = Activate-DetailPage -Url $detailUrl -TabRuntimeId $detailTabRuntimeId
        $ready = Wait-ApplicationDetail -Expected $payload -Navigation $navigation
    } catch {
        # Emit only existing metadata; the original exception still terminates this action.
        try {
            if ($null -ne $script:detailReadinessDiagnostic) {
                $script:detailReadinessDiagnostic.return_reason = 'exception'
                Write-Result ([pscustomobject]@{})
            }
        } catch {}
        throw
    }
    if ($ready.status -ne 'ok') {
        Write-Result $ready
        exit 0
    }
    $header = $ready.header
    $button = $ready.button
    $buttonName = Clean-Text $button.Current.Name
    if ($buttonName -eq $continueChatName) {
        Write-Result ([pscustomobject]@{ status = "already_contacted"; job_id = $jobId; error = ""; already_contacted = $true; greeting_sent = $false; current_url = $ready.current_url; header = $header })
        exit 0
    }
    Invoke-Element -Element $button
    Wait-AfterAction -SendConfirmation
    $afterClick = Get-BossWindow
    $afterDocument = Get-ActiveDocument -Root $afterClick.Root
    $fixedGreeting = Get-FixedGreeting -Document $afterDocument
    $confirmationVisible = Test-GreetingConfirmation -Document $afterDocument -FixedGreeting $fixedGreeting
    Write-Result ([pscustomobject]@{
        status = if ($confirmationVisible) { "ok" } else { "failed" }
        job_id = $jobId
        error = if ($confirmationVisible) { "" } else { "greeting_confirmation_not_found" }
        already_contacted = $false
        greeting_sent = $true
        confirmation_visible = $confirmationVisible
        fixed_greeting = $fixedGreeting
        current_url = $afterClick.Address
        header = $header
    })
    exit 0
}

if ($Action -eq "TrimTabs") {
    $state = Get-BossWindow
    $threshold = Get-Random -Minimum 6 -Maximum 11
    $remaining = Get-Random -Minimum 1 -Maximum 3
    $beforeCount = @(Get-Tabs -Root $state.Root).Count
    $closedCount = if ($beforeCount -ge $threshold) {
        Close-SelectedTabsToCount -RemainingCount $remaining
    } else {
        0
    }
    Write-Result ([pscustomobject]@{
        status = "ok"
        threshold = $threshold
        remaining_target = $remaining
        before_count = $beforeCount
        closed_count = $closedCount
        after_count = @(Get-Tabs -Root (Get-BossWindow).Root).Count
    })
    exit 0
}

$state = if ($Action -eq "ReadJobDetails") { Get-BossWindow } else { Activate-JobsPage -SkipWait:($Action -eq 'ReadFirstJobSample') }
$document = Get-ActiveDocument -Root $state.Root
$loginState = Get-LoginState -Document $document -Address $state.Address
if ($loginState -ne "logged_in") {
    Write-Result ([pscustomobject]@{
        status = "user_action_required"
        login_state = $loginState
        current_url = $state.Address
    })
    exit 0
}

if ($Action -eq "ListExpectations") {
    $expectations = @(Get-ExpectationItems -Document $document)
    $selectedItems = @($expectations | Where-Object Selected | Select-Object -First 1)
    Write-Result ([pscustomobject]@{
        status = "ok"
        login_state = $loginState
        current_url = $state.Address
        selected = if ($selectedItems.Count) { $selectedItems[0].Id } else { '' }
        expectations = @($expectations | Where-Object { $_.Id -ne "recommended" } | ForEach-Object {
            [pscustomobject]@{ id = $_.Id; name = $_.Name; boss_label = $_.Name; city = $_.City; keyword = $_.Keyword; selected = $_.Selected }
        })
    })
    exit 0
}

if ($Action -in @("SelectExpectation", "CollectJobsIncrement", "ReadFirstJobSample")) {
    if (-not $ExpectationId -or $ExpectationId -eq 'recommended') { throw '请选择实际保存的 BOSS 求职期望。' }
    $expectations = @(Get-ExpectationItems -Document $document)
    if ($Action -eq 'ReadFirstJobSample') {
        $sampleWaited = $false
        $firstExpectation = @($expectations | Where-Object { $_.Id -ne 'recommended' } | Select-Object -First 1)
        if (-not $firstExpectation.Count -or $firstExpectation[0].Id -ne $ExpectationId) { throw '首个求职期望已变化，请重新读取，未更新样本。' }
    }
    $targetCandidates = @($expectations | Where-Object Id -eq $ExpectationId | Select-Object -First 1)
    $target = if ($targetCandidates.Count) { $targetCandidates[0] } else { $null }
    if (-not $target) { throw "The requested job expectation is not visible." }
    if (-not $target.Selected) {
        Invoke-Element -Element $target.Element
        if ($Action -eq 'ReadFirstJobSample') {
            Start-Sleep -Milliseconds (Get-Random -Minimum 1000 -Maximum 2001)
            $sampleWaited = $true
        } else {
            Wait-AfterAction
        }
    }
    $afterState = Get-BossWindow
    $afterDocument = Get-ActiveDocument -Root $afterState.Root
    $afterExpectations = @(Get-ExpectationItems -Document $afterDocument)
    $selectedItems = @($afterExpectations | Where-Object Selected | Select-Object -First 1)
    $selectedExpectation = if ($selectedItems.Count) { $selectedItems[0].Id } else { '' }
    if ($selectedExpectation -ne $ExpectationId) { throw '无法确认已切换到指定求职期望，请在本实例 BOSS 页面核对后重试。' }
    if ($Action -eq "SelectExpectation") {
        Write-Result ([pscustomobject]@{
            status = "ok"
            login_state = $loginState
            expectation_id = $ExpectationId
            selected = $selectedExpectation
        })
        exit 0
    }
    if ($selectedExpectation -ne $ExpectationId) {
        throw "Could not select the requested expectation."
    }
    $state = $afterState
    $document = $afterDocument
}

if ($Action -eq 'ReadFirstJobSample') {
    $cards = @(Get-JobCardElements -Document $document)
    if (-not $cards.Count) { throw '首个求职期望的岗位列表为空，未更新样本。' }
    $first = Convert-JobCard -Card $cards[0] -Rank 1
    if (-not $first.job_id -or -not $first.title -or -not $first.company) { throw '首卡标识、标题或公司未能读取，未更新样本。' }
    $firstSelection = Test-SampleCardSelected -Card $cards[0]
    $currentDetail = Get-SampleDetailRoot -Document $document -Summary $first -RequireUniqueCard:($null -eq $firstSelection)
    if ($firstSelection -eq $false -or -not $currentDetail) {
        Invoke-Element -Element $cards[0]
    }
    # One total active wait for first-job sampling, including any expectation switch.
    if (-not $sampleWaited) {
        Start-Sleep -Milliseconds (Get-Random -Minimum 1000 -Maximum 2001)
        $sampleWaited = $true
    }
    $state = Get-BossWindow
    $document = Get-ActiveDocument -Root $state.Root
    $cards = @(Get-JobCardElements -Document $document)
    $selected = @(Get-ExpectationItems -Document $document | Where-Object Selected)
    if (-not $cards.Count -or -not $selected.Count -or $selected[0].Id -ne $ExpectationId) { throw '无法核对首个期望及首卡，未更新样本。' }
    $now = Convert-JobCard -Card $cards[0] -Rank 1
    if ($now.job_id -ne $first.job_id) { throw '首卡标识已变化，未更新样本。' }
    $selection = Test-SampleCardSelected -Card $cards[0]
    if ($selection -eq $false) { throw '首卡仍未选中，未更新样本。' }
    $detailRoot = Get-SampleDetailRoot -Document $document -Summary $now -RequireUniqueCard:($null -eq $selection)
    if (-not $detailRoot) { throw '当前JD与首卡的对应关系未能核对，未更新样本。' }
    # Reacquire before sampling; never sample stale nodes or add another wait.
    $state = Get-BossWindow
    $document = Get-ActiveDocument -Root $state.Root
    $cards = @(Get-JobCardElements -Document $document)
    $selected = @(Get-ExpectationItems -Document $document | Where-Object Selected)
    if (-not $cards.Count -or -not $selected.Count -or $selected[0].Id -ne $ExpectationId) { throw '采样期间期望已变化，未更新样本。' }
    $now = Convert-JobCard -Card $cards[0] -Rank 1
    if ($now.job_id -ne $first.job_id) { throw '采样期间首卡已变化，未更新样本。' }
    $selection = Test-SampleCardSelected -Card $cards[0]
    if ($selection -eq $false) { throw '采样期间首卡选中状态已变化，未更新样本。' }
    $detailRoot = Get-SampleDetailRoot -Document $document -Summary $now -RequireUniqueCard:($null -eq $selection)
    if (-not $detailRoot) { throw '当前JD与首卡不对应，未更新样本。' }
    $detail = Read-SelectedDetail -Document $detailRoot -Summary $now -SampleOnly
    if (-not $detail.description) { throw '首个岗位没有可用JD，未更新样本。' }
    Write-Result ([pscustomobject]@{
        status = 'ok'
        sample = [pscustomobject]@{
            job_id = $now.job_id; detail_url = $now.detail_url; title = $now.title; company = $now.company
            salary = $now.salary; city = $now.city; location = $now.location; address = $detail.address
            tags = @($now.tags + $detail.detail_tags | Select-Object -Unique)
            jd = $detail.description; summary = $now; detail = $detail; captured_at = [DateTime]::UtcNow.ToString('o')
        }
        window = [pscustomobject]@{ process_id = $state.Window.Id; window_handle = $state.Window.MainWindowHandle.ToInt64() }
    })
    exit 0
}

function Normalize-JobTitleFilterText {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { return "" }
    return (($Value.Normalize([System.Text.NormalizationForm]::FormKC).Trim() -replace '\s+', ' ').ToLowerInvariant())
}

function Get-JobTitleFilterMatches {
    param(
        [AllowEmptyString()][string]$Title,
        [Parameter(Mandatory = $true)]$Filter
    )
    $normalizedTitle = Normalize-JobTitleFilterText -Value $Title
    $matches = [System.Collections.Generic.List[string]]::new()
    $seenMatches = @{}
    foreach ($phrase in @($Filter.exclude_contains_any)) {
        $normalizedPhrase = Normalize-JobTitleFilterText -Value ([string]$phrase)
        if ($normalizedPhrase -and $normalizedTitle.Contains($normalizedPhrase) -and -not $seenMatches.ContainsKey($normalizedPhrase)) {
            $matches.Add([string]$phrase)
            $seenMatches[$normalizedPhrase] = $true
        }
    }
    foreach ($rule in @($Filter.conditional_exclusions)) {
        $normalizedKeyword = Normalize-JobTitleFilterText -Value ([string]$rule.keyword)
        if (-not $normalizedKeyword -or -not $normalizedTitle.Contains($normalizedKeyword)) { continue }
        $protected = $false
        foreach ($unlessPhrase in @($rule.unless_contains_any)) {
            $normalizedUnless = Normalize-JobTitleFilterText -Value ([string]$unlessPhrase)
            if ($normalizedUnless -and $normalizedTitle.Contains($normalizedUnless)) {
                $protected = $true
                break
            }
        }
        if (-not $protected -and -not $seenMatches.ContainsKey($normalizedKeyword)) {
            $matches.Add([string]$rule.keyword)
            $seenMatches[$normalizedKeyword] = $true
        }
    }
    return @($matches)
}

if ($Action -in @("ListJobs", "ListJobsIncrement", "CollectJobsIncrement")) {
    $isIncrement = $Action -in @("ListJobsIncrement", "CollectJobsIncrement")
    $expectations = @(Get-ExpectationItems -Document $document)
    if (Move-JobListTop -Document $document) {
        $current = Get-BossWindow
        $document = Get-ActiveDocument -Root $current.Root
    }
    $jobs = [System.Collections.Generic.List[object]]::new()
    $seen = @{}
    $excluded = @{}
    $excludedCompanies = @{}
    $salaryTarget = $null
    if ($SalaryTargetBase64) { $salaryTarget = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SalaryTargetBase64)) | ConvertFrom-Json }
    $titleFilter = $null
    $titleFilterVersion = ""
    if ($isIncrement -and $ExcludedJobIdsFile) {
        $excludedJson = [System.IO.File]::ReadAllText($ExcludedJobIdsFile, [System.Text.Encoding]::UTF8)
        $decodedExcluded = $excludedJson | ConvertFrom-Json
        foreach ($excludedId in @($decodedExcluded)) { $excluded[[string]$excludedId] = $true }
    }
    if ($isIncrement -and $ExcludedCompaniesBase64) {
        $companyJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ExcludedCompaniesBase64))
        foreach ($company in @($companyJson | ConvertFrom-Json)) {
            $companyKey = ([string]$company -replace '\s+', '').ToLowerInvariant()
            if ($companyKey) { $excludedCompanies[$companyKey] = $true }
        }
    }
    if ($isIncrement) {
        if (-not $TitleFilterBase64) { throw "Title filter configuration is required for incremental collection." }
        $titleFilterJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($TitleFilterBase64))
        $titleFilter = $titleFilterJson | ConvertFrom-Json
        if (-not $titleFilter.PSObject.Properties["version"] -or -not ([string]$titleFilter.version).Trim()) {
            throw "Title filter version is required."
        }
        if (-not $titleFilter.PSObject.Properties["exclude_contains_any"] -or -not $titleFilter.PSObject.Properties["conditional_exclusions"]) {
            throw "Title filter rules are incomplete."
        }
        $titleFilterVersion = [string]$titleFilter.version
    }
    $selectedItems = @($expectations | Where-Object Selected | Select-Object -First 1)
    $selectedCity = if ($selectedItems.Count) { [string]$selectedItems[0].City } else { '' }
    $expectedCityPattern = if ($selectedCity) { '^' + [regex]::Escape(($selectedCity -replace '市$', '')) + '(?:市)?(?:$|[\s·・-])' } else { '(?!)' }
    $newCount = 0
    $pageAlreadyContactedCount = 0
    $headhunterExcludedCount = 0
    $titleKeywordExcludedCount = 0
    $titleKeywordCounts = [ordered]@{}
    $scrollCount = 0
    $noGrowthCount = 0
    while ($seen.Count -lt $Limit -and (-not $isIncrement -or $newCount -lt $TargetNewCount)) {
        $beforeSeenCount = $seen.Count
        foreach ($job in @(Get-JobCards -Document $document -Maximum $Limit)) {
            if ($seen.Count -ge $Limit) { break }
            if (-not $job.job_id -or $seen.ContainsKey($job.job_id)) { continue }
            $seen[$job.job_id] = $true
            if ($job.is_headhunter) {
                $headhunterExcludedCount += 1
                continue
            }
            $jobCompanyKey = ([string]$job.company -replace '\s+', '').ToLowerInvariant()
            if ($jobCompanyKey -and $excludedCompanies.ContainsKey($jobCompanyKey)) { continue }
            $job.rank = $jobs.Count + 1
            $titleMatches = @()
            if ($isIncrement -and -not $job.already_contacted -and -not $excluded.ContainsKey([string]$job.job_id)) {
                $titleMatches = @(Get-JobTitleFilterMatches -Title ([string]$job.title) -Filter $titleFilter)
            }
            $job | Add-Member -NotePropertyName title_filter_excluded -NotePropertyValue ($titleMatches.Count -gt 0) -Force
            $job | Add-Member -NotePropertyName matched_title_keywords -NotePropertyValue @($titleMatches) -Force
            $jobs.Add($job)
            if ($job.already_contacted) { $pageAlreadyContactedCount += 1 }
            elseif ($excluded.ContainsKey([string]$job.job_id)) { }
            elseif ($isIncrement -and ([string]$job.city).Trim() -notmatch $expectedCityPattern) { }
            elseif ($isIncrement -and (Test-SalaryOutsideTarget -Salary ([string]$job.salary) -Target $salaryTarget)) { }
            elseif ($titleMatches.Count -gt 0) {
                $titleKeywordExcludedCount += 1
                foreach ($keyword in $titleMatches) {
                    if (-not $titleKeywordCounts.Contains([string]$keyword)) { $titleKeywordCounts[[string]$keyword] = 0 }
                    $titleKeywordCounts[[string]$keyword] = [int]$titleKeywordCounts[[string]$keyword] + 1
                }
            }
            else { $newCount += 1 }
            if ($isIncrement -and $newCount -ge $TargetNewCount) { break }
        }
        if ($seen.Count -ge $Limit -or ($isIncrement -and $newCount -ge $TargetNewCount)) { break }
        $grew = $seen.Count -gt $beforeSeenCount
        if ($grew) { $noGrowthCount = 0 } else { $noGrowthCount += 1 }
        if ($noGrowthCount -ge 4) { break }
        if ($scrollCount -ge 100) { break }
        $move = Move-JobListDown -Document $document
        if ($move -and $move.moved) {
            $scrollCount += 1
            $current = Get-BossWindow
            $document = Get-ActiveDocument -Root $current.Root
            continue
        }
        break
    }
    Write-Result ([pscustomobject]@{
        status = "ok"
        login_state = $loginState
        expectation_id = if ($selectedItems.Count) { $selectedItems[0].Id } else { '' }
        scope = "progressively_loaded_job_list"
        detail_fields_collected = $false
        count = $jobs.Count
        observed_card_count = $seen.Count
        new_candidate_count = $newCount
        page_already_contacted_count = $pageAlreadyContactedCount
        headhunter_excluded_count = $headhunterExcludedCount
        title_keyword_excluded_count = $titleKeywordExcludedCount
        title_keyword_excluded_by_keyword = [pscustomobject]$titleKeywordCounts
        title_filter_version = if ($isIncrement) { $titleFilterVersion } else { $null }
        target_new_count = if ($isIncrement) { $TargetNewCount } else { $null }
        scroll_count = $scrollCount
        limit_reached = $seen.Count -ge $Limit
        jobs = @($jobs)
    })
    exit 0
}

if ($Action -eq "ReadJobDetails") {
    $payload = Decode-Payload
    $jobProperty = $payload.PSObject.Properties["jobs"]
    if (-not $jobProperty) { throw "jobs are required." }
    $jobsToRead = @($jobProperty.Value)
    $results = [System.Collections.Generic.List[object]]::new()
    foreach ($job in $jobsToRead) {
        $jobId = Get-PayloadText -Payload $job -Name "job_id"
        $detailUrl = Get-PayloadText -Payload $job -Name "detail_url"
        if (-not $jobId -or -not $detailUrl) {
            $results.Add([pscustomobject]@{ job_id = $jobId; status = "failed"; error = "detail_url_missing" })
            continue
        }
        if ($detailUrl -notmatch '^https://www\.zhipin\.com/job_detail/([^/?#]+)\.html$' -or $Matches[1] -ne $jobId) {
            $results.Add([pscustomobject]@{ job_id = $jobId; status = "failed"; error = "detail_url_mismatch" })
            continue
        }
        $screeningProperty = $payload.PSObject.Properties['screening_detail_interval']
        $screening = $null -ne $screeningProperty
        $interval = if ($screening) { $screeningProperty.Value } else { $null }
        $state = Open-DetailPage -Url $detailUrl -Interval $interval
        $detail = Read-DetailWithRetry -Summary $job -Navigation $state -Screening:$screening
        if ($screening -and $null -ne $interval) {
            $detail | Add-Member -NotePropertyName screening_detail_navigation -NotePropertyValue $state.IntervalDiagnostic
        }
        if ($detail.status -eq 'user_action_required') {
            Write-Result ([pscustomobject]@{
                status = "user_action_required"
                login_state = $detail.login_state
                current_url = $detail.current_url
                requested_count = $jobsToRead.Count
                returned_count = $results.Count
                results = @($results)
            })
            exit 0
        }
        $results.Add($detail)
    }
    Write-Result ([pscustomobject]@{
        status = "ok"
        login_state = $loginState
        requested_count = $jobsToRead.Count
        returned_count = $results.Count
        job_detail_load_timeout_ms = 15000
        job_detail_poll_interval_ms = 500
        detail_source = "job_detail_url"
        results = @($results)
    })
    exit 0
}

if ($Action -eq "StartCommunication") {
    $payload = Decode-Payload
    $jobId = Get-PayloadText -Payload $payload -Name "job_id"
    if (-not $jobId) { throw "job_id is required." }
    $found = Find-JobCard -Document $document -JobId $jobId
    if (-not $found) {
        Write-Result ([pscustomobject]@{ status = "failed"; job_id = $jobId; error = "job_card_not_found" })
        exit 0
    }
    if ($found.Summary.is_headhunter) {
        Write-Result ([pscustomobject]@{ status = "headhunter_skipped"; job_id = $jobId; error = ""; is_headhunter = $true; skip_reason = "headhunter"; summary = $found.Summary })
        exit 0
    }
    $summaryCheck = Test-SummaryMatches -Summary $found.Summary -Expected $payload
    if (-not $summaryCheck.matched) {
        Write-Result ([pscustomobject]@{ status = "failed"; job_id = $jobId; error = "job_summary_mismatch"; mismatches = $summaryCheck.mismatches; summary = $found.Summary })
        exit 0
    }
    Invoke-Element -Element $found.Card
    [void](Wait-JobDetail)
    $selectedState = Get-BossWindow
    $selectedDocument = Get-ActiveDocument -Root $selectedState.Root
    $button = Find-VisibleButton -Document $selectedDocument -Names @($startChatName, $continueChatName) -RightSide
    if (-not $button) {
        Write-Result ([pscustomobject]@{ status = "failed"; job_id = $jobId; error = "communication_button_not_found"; summary = $found.Summary })
        exit 0
    }
    $buttonName = Clean-Text $button.Current.Name
    if ($buttonName -eq $continueChatName) {
        Write-Result ([pscustomobject]@{ status = "already_contacted"; job_id = $jobId; error = ""; already_contacted = $true; greeting_sent = $false; current_url = $selectedState.Address; summary = $found.Summary })
        exit 0
    }
    Invoke-Element -Element $button
    Wait-AfterAction -SendConfirmation
    $afterClick = Get-BossWindow
    $afterDocument = Get-ActiveDocument -Root $afterClick.Root
    $fixedGreeting = Get-FixedGreeting -Document $afterDocument
    $continued = $false
    if ($afterClick.Address -notmatch "/web/geek/chat") {
        $continueButton = Find-VisibleButton -Document $afterDocument -Names @($continueChatName)
        if ($continueButton) {
            Invoke-Element -Element $continueButton
            Wait-AfterAction
            $continued = $true
            $afterClick = Get-BossWindow
        }
    }
    Write-Result ([pscustomobject]@{
        status = "ok"
        job_id = $jobId
        summary = $found.Summary
        already_contacted = $buttonName -eq $continueChatName
        greeting_sent = $buttonName -eq $startChatName
        fixed_greeting = $fixedGreeting
        continued_to_chat = $continued -or $afterClick.Address -match "/web/geek/chat"
        current_url = $afterClick.Address
    })
    exit 0
}

throw "Unsupported action."
