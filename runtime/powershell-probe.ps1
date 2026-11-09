$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
 if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){throw [Security.SecurityException]::new('PowerShell language mode is restricted by policy.')}
 if(-not [Environment]::Is64BitProcess){throw 'Windows x64 PowerShell is required.'}
 if([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA'){throw 'STA desktop support is required.'}
 foreach($name in @('PresentationFramework','PresentationCore','WindowsBase','System.Windows.Forms','UIAutomationClient','UIAutomationTypes','System.Net.Http')){Add-Type -AssemblyName $name}
 Add-Type 'public static class JobmatePowerShellProbe { public static int Ready() { return 1; } }'
 Import-Module CimCmdlets -ErrorAction Stop
 @{ok=$true;version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;x64=$true;sta=$true}|ConvertTo-Json -Compress
} catch {
 $policy=$_.Exception -is [Security.SecurityException] -or $_.Exception -is [UnauthorizedAccessException] -or $_.FullyQualifiedErrorId -match 'UnauthorizedAccess|PSSecurityException'
 @{ok=$false;kind=$(if($policy){'policy'}else{'capability'});reason=$_.Exception.Message}|ConvertTo-Json -Compress
 exit 1
}
