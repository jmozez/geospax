# Upgrade test for the Windows installer (CI job windows-native, on a Windows runner): install an older
# published release, run the new installer over it and check that exactly one GeoSpaX remains: the new
# version, in the same folder, with one Apps & features entry and publisher in4metrix.
# Two ways of upgrading:
#   GUI      the setup clicked through as a user does (UI Automation presses Next / Uninstall / Finish).
#            Only this mode uninstalls the older copy first ("Uninstall before installing", the default),
#            which is the step that failed with "unable to uninstall".
#   passive  /P, the unattended mode; for an upgrade Tauri installs over the old files without uninstalling.
# Old installs: 3.0.2 (publisher "GeoSpaX contributors"), 3.0.6 (publisher in4metrix), and 3.0.2 with its
# uninstaller deleted (an install folder half-removed by hand). A control run first clicks the published 3.0.6
# setup through over 3.0.2 and reports what happened (the reported bug); it is not required to fail.
param([Parameter(Mandatory)][string]$Setup)
$ErrorActionPreference = 'Stop'
$Setup = (Resolve-Path $Setup).Path
$NewVersion = [regex]::Match((Split-Path $Setup -Leaf), 'GeoSpaX_([0-9.]+)_x64-setup\.exe').Groups[1].Value
if (-not $NewVersion) { throw "cannot read the version from $Setup" }
$Inst = Join-Path $env:LOCALAPPDATA 'GeoSpaX'
$UninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GeoSpaX'
$NewKey = 'HKCU:\Software\in4metrix\GeoSpaX'
$OldKey = 'HKCU:\Software\GeoSpaX contributors'
$Cache = Join-Path $env:RUNNER_TEMP 'geospax-old'
New-Item -ItemType Directory -Force $Cache | Out-Null
$summary = @("### Windows upgrade test (new installer $NewVersion)", '')
function Note([string]$line) { Write-Host $line; $script:summary += $line }

function Old-Setup([string]$v) {
  $f = Join-Path $Cache "GeoSpaX_${v}_x64-setup.exe"
  if (-not (Test-Path $f)) {
    Invoke-WebRequest -UseBasicParsing -OutFile $f "https://github.com/jmozez/geospax/releases/download/v$v/GeoSpaX_${v}_x64-setup.exe"
  }
  $f
}
function Uninstall-Entries {
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' |
    Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ } | Get-ItemProperty |
    Where-Object { $_.DisplayName -like 'GeoSpaX*' }
}
function Run([string]$exe, [string[]]$arguments, [int]$seconds) {
  $p = Start-Process $exe -ArgumentList $arguments -PassThru
  $null = $p.Handle   # keeps ExitCode readable after the process ends
  if (-not $p.WaitForExit($seconds * 1000)) {
    Get-Process | Where-Object { $_.Path -like "$env:TEMP*" -or $_.Path -like "$Cache*" -or $_.Path -eq $exe -or $_.Path -like "$Inst*" } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    return 'hung'
  }
  $p.ExitCode
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$UIA = [System.Windows.Automation.AutomationElement]
$Btn = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Button)
$Txt = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Text)
# Runs a setup without switches and clicks it through like a user: Next (the reinstall page keeps its default,
# "Uninstall before installing"), the old uninstaller's Uninstall / Close, Install, Finish. A message box
# is answered with OK and its text recorded. Returns @{ Exit = exit code, 'timeout' or 'no window'; Boxes = texts }.
function Run-Gui([string]$exe, [int]$seconds) {
  $p = Start-Process $exe -PassThru
  $null = $p.Handle
  $boxes = @(); $seen = $false
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
    $ids = @($p.Id) + @(Get-Process uninstall, Un_*, Au_* -ErrorAction SilentlyContinue | ForEach-Object Id)
    foreach ($w in $UIA::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        if ($ids -notcontains $w.Current.ProcessId) { continue }
        $seen = $true
        $buttons = @($w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $Btn))
        $names = $buttons | ForEach-Object { $_.Current.Name -replace '&', '' }
        $target = $null
        if (($names -contains 'OK') -and ($names -notcontains 'Cancel')) {
          # a message box
          $boxes += (@($w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $Txt)) | ForEach-Object { $_.Current.Name }) -join ' '
          $target = $buttons | Where-Object { ($_.Current.Name -replace '&', '') -eq 'OK' } | Select-Object -First 1
        } else {
          foreach ($want in 'Next >', 'Install', 'Uninstall', 'Finish', 'Close') {
            $target = $buttons | Where-Object { ($_.Current.Name -replace '&', '') -eq $want -and $_.Current.IsEnabled } | Select-Object -First 1
            if ($target) { break }
          }
        }
        if ($target) { $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
      } catch { }   # the window went away while being read
    }
    if ($boxes.Count -ge 2) { break }   # the installer returns to its page after a message box; twice is enough
    Start-Sleep -Milliseconds 800
  }
  Get-Process geospax -ErrorAction SilentlyContinue | Stop-Process -Force   # "Run GeoSpaX" on the finish page
  if (-not $p.HasExited) {
    Get-Process uninstall, Un_*, Au_* -ErrorAction SilentlyContinue | Stop-Process -Force
    $p | Stop-Process -Force
    return @{ Exit = $(if ($seen) { 'timeout' } else { 'no window' }); Boxes = $boxes }
  }
  @{ Exit = $p.ExitCode; Boxes = $boxes }
}

# The manual removal of a stuck install (docs/FAQ.md, "the installer finds my old GeoSpaX"), also the clean slate between scenarios.
function Remove-GeoSpaX {
  Get-Process geospax, geospax-server, uninstall -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
  Remove-Item -Recurse -Force $Inst, $UninstKey, $OldKey, 'HKCU:\Software\in4metrix' -ErrorAction SilentlyContinue
  Remove-Item -Force "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\GeoSpaX*.lnk", "$env:USERPROFILE\Desktop\GeoSpaX.lnk" -ErrorAction SilentlyContinue
}
function Install-Old([string]$v) {
  Remove-GeoSpaX
  $rc = Run (Old-Setup $v) @('/S') 300
  if ($rc -ne 0) { throw "GeoSpaX $v did not install silently ($rc)" }
  $dv = (Get-ItemProperty $UninstKey).DisplayVersion
  if ($dv -ne $v) { throw "after installing $v, Apps & features shows '$dv'" }
}
function Assert-Upgraded([string]$from) {
  $e = @(Uninstall-Entries)
  if ($e.Count -ne 1) { throw "from ${from}: $($e.Count) GeoSpaX entries in Apps & features: $($e.DisplayVersion -join ', ')" }
  if ($e[0].DisplayVersion -ne $NewVersion) { throw "from ${from}: Apps & features shows $($e[0].DisplayVersion), not $NewVersion" }
  if ($e[0].Publisher -ne 'in4metrix') { throw "from ${from}: Apps & features publisher is '$($e[0].Publisher)'" }
  if ((Get-ItemProperty $NewKey).'(default)' -ne $Inst) { throw "from ${from}: the install folder is not recorded under in4metrix" }
  if (Test-Path $OldKey) { throw "from ${from}: the old 'GeoSpaX contributors' registry key is still there" }
  foreach ($exe in 'geospax.exe', 'geospax-server.exe') {
    $vi = (Get-Item "$Inst\$exe").VersionInfo
    if ($vi.ProductVersion -notlike "$NewVersion*") { throw "from ${from}: $exe is version '$($vi.ProductVersion)'" }
    if ($vi.CompanyName -ne 'in4metrix') { throw "from ${from}: $exe company is '$($vi.CompanyName)'" }
  }
  $others = @("$env:ProgramFiles\GeoSpaX", "${env:ProgramFiles(x86)}\GeoSpaX") | Where-Object { Test-Path "$_\geospax.exe" }
  if ($others) { throw "from ${from}: a second copy in $others" }
  $out = & "$Inst\geospax-server.exe" recipes
  if ($LASTEXITCODE -ne 0 -or -not $out) { throw "from ${from}: geospax-server.exe does not run after the upgrade" }
}

# control: the published 3.0.6 setup clicked through over 3.0.2
Install-Old '3.0.2'
$r = Run-Gui (Old-Setup '3.0.6') 180
$v = (Get-Item "$Inst\geospax.exe" -ErrorAction SilentlyContinue).VersionInfo.ProductVersion
Note "- control, published 3.0.6 setup (GUI) over 3.0.2: exit '$($r.Exit)', geospax.exe now '$v', message boxes: '$($r.Boxes -join ' | ')'"
if ($r.Exit -eq 'no window') { throw 'no installer window seen: UI Automation cannot drive the setup on this runner' }

foreach ($from in '3.0.2', '3.0.6') {
  Install-Old $from
  $r = Run-Gui $Setup 600
  if ($r.Exit -ne 0 -or $r.Boxes) { throw "new setup (GUI) over ${from}: exit '$($r.Exit)', message boxes: '$($r.Boxes -join ' | ')'" }
  Assert-Upgraded "$from (GUI)"
  Note "- upgrade from ${from}, setup clicked through: ok (old copy uninstalled first; one entry, $NewVersion, publisher in4metrix, same folder)"

  Install-Old $from
  $rc = Run $Setup @('/P') 600
  if ($rc -ne 0) { throw "new installer /P over ${from}: exit '$rc' (hung = stuck on a message box)" }
  Assert-Upgraded "$from (passive)"
  Note "- upgrade from ${from}, passive /P: ok"
}

Install-Old '3.0.2'
Remove-Item -Force "$Inst\uninstall.exe"
$r = Run-Gui $Setup 600
if ($r.Exit -ne 0 -or $r.Boxes) { throw "new setup (GUI) over 3.0.2 without its uninstaller: exit '$($r.Exit)', message boxes: '$($r.Boxes -join ' | ')'" }
Assert-Upgraded '3.0.2 without uninstall.exe (GUI)'
Note '- 3.0.2 with its uninstaller deleted, setup clicked through: ok'

# the new uninstaller leaves nothing behind
$rc = Run "$Inst\uninstall.exe" @('/S') 120
for ($i = 0; $i -lt 60 -and (Test-Path "$Inst\geospax.exe"); $i++) { Start-Sleep 1 }
if (Test-Path "$Inst\geospax.exe") { throw 'the uninstaller left geospax.exe' }
for ($i = 0; $i -lt 30 -and @(Uninstall-Entries).Count; $i++) { Start-Sleep 1 }
if (@(Uninstall-Entries).Count) { throw 'the uninstaller left an Apps & features entry' }
if (Test-Path $OldKey) { throw "the uninstaller left the old 'GeoSpaX contributors' registry key" }
# Tauri keeps Software\in4metrix\GeoSpaX (the install folder, for a later reinstall) unless "delete app data" is ticked
if ((Test-Path $NewKey) -and (Get-ItemProperty $NewKey).'(default)' -ne $Inst) { throw 'the in4metrix key points elsewhere' }
Note '- uninstall: no files, Apps & features entry or old registry key left'

if ($env:GITHUB_STEP_SUMMARY) { $summary | Out-File -Append -Encoding utf8 $env:GITHUB_STEP_SUMMARY }
