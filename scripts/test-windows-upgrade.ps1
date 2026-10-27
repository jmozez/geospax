# Upgrade test for the Windows installer (CI job windows-native, on a Windows runner): install an older
# published release, run the new installer over it the way a user does (passive mode runs the same
# "uninstall the older version first" path as clicking Next), and check that exactly one GeoSpaX remains:
# the new version, in the same folder, with one Apps & features entry and publisher in4metrix.
#   3.0.2  publisher "GeoSpaX contributors" (the upgrade that failed with "unable to uninstall")
#   3.0.6  publisher "in4metrix"
#   3.0.2 with its uninstaller deleted (an install folder half-removed by hand)
# A control run first shows the old failure with the published 3.0.6 installer (reported, not required).
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

# control: the published 3.0.6 installer over 3.0.2
Install-Old '3.0.2'
$rc = Run (Old-Setup '3.0.6') @('/P') 120
$v = (Get-Item "$Inst\geospax.exe" -ErrorAction SilentlyContinue).VersionInfo.ProductVersion
$summary += "- control, published 3.0.6 over 3.0.2: installer exit '$rc', geospax.exe now '$v'" + $(if ($rc -eq 'hung') { ' (stuck on "unable to uninstall", the reported bug)' } else { '' })

foreach ($from in '3.0.2', '3.0.6') {
  Install-Old $from
  $rc = Run $Setup @('/P') 600
  if ($rc -ne 0) { throw "new installer over ${from}: exit '$rc' (hung = stuck on a message box such as 'unable to uninstall')" }
  Assert-Upgraded $from
  $summary += "- upgrade from ${from}: ok (one entry, $NewVersion, publisher in4metrix, same folder)"
}

Install-Old '3.0.2'
Remove-Item -Force "$Inst\uninstall.exe"
$rc = Run $Setup @('/P') 600
if ($rc -ne 0) { throw "new installer over 3.0.2 without its uninstaller: exit '$rc'" }
Assert-Upgraded '3.0.2 without uninstall.exe'
$summary += '- 3.0.2 with its uninstaller deleted: ok'

# the new uninstaller leaves nothing behind
$rc = Run "$Inst\uninstall.exe" @('/S') 120
for ($i = 0; $i -lt 60 -and (Test-Path "$Inst\geospax.exe"); $i++) { Start-Sleep 1 }
if (Test-Path "$Inst\geospax.exe") { throw 'the uninstaller left geospax.exe' }
for ($i = 0; $i -lt 30 -and @(Uninstall-Entries).Count; $i++) { Start-Sleep 1 }
if (@(Uninstall-Entries).Count) { throw 'the uninstaller left an Apps & features entry' }
if ((Test-Path $NewKey) -or (Test-Path $OldKey)) { throw 'the uninstaller left a GeoSpaX registry key' }
$summary += '- uninstall: no files, entries or registry keys left'

$summary | ForEach-Object { Write-Host $_ }
if ($env:GITHUB_STEP_SUMMARY) { $summary | Out-File -Append -Encoding utf8 $env:GITHUB_STEP_SUMMARY }
