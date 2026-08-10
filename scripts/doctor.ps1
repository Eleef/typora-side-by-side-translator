param (
  [ValidateSet("Community", "Installed")]
  [string] $Mode = "Installed",
  [Alias("p")]
  [string] $TyporaHome = "",
  [string] $CommunityRoot = ""
)

$ErrorActionPreference = "Stop"

$pluginId = "eleef.typora-side-by-side-translator"
$legacyPluginIds = @("eleef.typora-side-by-side-translation", "typora-bilingual", "jiang.typora-bilingual")
$failures = [Collections.Generic.List[string]]::new()
$warnings = [Collections.Generic.List[string]]::new()

function Write-CheckResult {
  param ([string] $Level, [string] $Code, [string] $Message)
  Write-Host "[$Level] $Code - $Message"
}

function Add-Pass {
  param ([string] $Code, [string] $Message)
  Write-CheckResult "PASS" $Code $Message
}

function Add-Warning {
  param ([string] $Code, [string] $Message)
  $warnings.Add($Code)
  Write-CheckResult "WARN" $Code $Message
}

function Add-Failure {
  param ([string] $Code, [string] $Message)
  $failures.Add($Code)
  Write-CheckResult "FAIL" $Code $Message
}

function Find-TyporaHome {
  param ([string] $RequestedPath)

  if ($RequestedPath -and (Test-Path (Join-Path $RequestedPath "Typora.exe"))) {
    return [IO.Path]::GetFullPath($RequestedPath)
  }

  $uninstallPaths = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  foreach ($uninstallPath in $uninstallPaths) {
    if (-not (Test-Path $uninstallPath)) {
      continue
    }
    foreach ($entry in Get-ChildItem $uninstallPath) {
      $properties = Get-ItemProperty $entry.PSPath -ErrorAction SilentlyContinue
      if ($properties.DisplayName -like "*Typora*" -and $properties.InstallLocation -and (Test-Path (Join-Path $properties.InstallLocation "Typora.exe"))) {
        return [IO.Path]::GetFullPath($properties.InstallLocation)
      }
    }
  }

  $candidates = @(
    (Join-Path $env:SystemDrive "Program Files\Typora"),
    (Join-Path $env:SystemDrive "Program Files (x86)\Typora"),
    (Join-Path $env:LOCALAPPDATA "Programs\Typora"),
    (Join-Path $env:USERPROFILE "scoop\apps\typora\current")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate "Typora.exe")) {
      return [IO.Path]::GetFullPath($candidate)
    }
  }
  return $null
}

function Find-WindowHtml {
  param ([string] $ResolvedTyporaHome)

  $candidates = @(
    (Join-Path $ResolvedTyporaHome "resources\app\window.html"),
    (Join-Path $ResolvedTyporaHome "resources\appsrc\window.html"),
    (Join-Path $ResolvedTyporaHome "resources\window.html")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }
  return $null
}

function Test-Utf8Bom {
  param ([string] $Path)

  $bytes = [IO.File]::ReadAllBytes($Path)
  return $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
}

function Read-JsonFile {
  param ([string] $Path, [string] $Code)

  if (-not (Test-Path $Path)) {
    Add-Failure $Code "Missing JSON file: $Path"
    return $null
  }
  if (Test-Utf8Bom $Path) {
    Add-Failure "$Code.bom" "JSON has a UTF-8 BOM that the community core cannot parse: $Path"
    return $null
  }
  try {
    $document = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
    Add-Pass $Code "JSON is readable without a BOM: $Path"
    return $document
  }
  catch {
    Add-Failure "$Code.invalid" "Invalid JSON: $Path"
    return $null
  }
}

function Convert-ToVersion {
  param ([string] $Value)
  if (-not $Value) {
    return $null
  }
  $numeric = (($Value -replace '^[vV]', '') -split '-', 2)[0]
  try {
    return [Version]::Parse($numeric)
  }
  catch {
    return $null
  }
}

$resolvedTyporaHome = Find-TyporaHome $TyporaHome
if (-not $resolvedTyporaHome) {
  Add-Failure "typora.installation" "Typora.exe was not found. Pass -TyporaHome with the Typora installation directory."
}
else {
  $typoraExe = Join-Path $resolvedTyporaHome "Typora.exe"
  $typoraVersionText = [Diagnostics.FileVersionInfo]::GetVersionInfo($typoraExe).ProductVersion
  Add-Pass "typora.installation" "Typora $typoraVersionText found at $resolvedTyporaHome"

  $windowHtml = Find-WindowHtml $resolvedTyporaHome
  if (-not $windowHtml) {
    Add-Failure "community-market.window-html" "Typora window.html was not found."
  }
  else {
    $windowHtmlText = [IO.File]::ReadAllText($windowHtml)
    if ($windowHtmlText -match 'typora://(?:app/)?userData/plugins/loader\.js') {
      Add-Pass "community-market.injection" "Community loader injection is present in $windowHtml"
    }
    else {
      Add-Failure "community-market.injection" "Community loader injection is missing. Re-run the official typora-community-plugin installer after closing Typora."
    }
  }
}

if ($CommunityRoot) {
  $resolvedCommunityRoot = [IO.Path]::GetFullPath($CommunityRoot)
}
else {
  $runtimeRoot = Join-Path $env:APPDATA "Typora\plugins"
  $sourceRoot = Join-Path $env:USERPROFILE ".typora\community-plugins"
  if (Test-Path $runtimeRoot) {
    $resolvedCommunityRoot = [IO.Path]::GetFullPath($runtimeRoot)
    Add-Pass "community-market.runtime-path" "Typora runtime plugin path exists: $runtimeRoot"
  }
  elseif (Test-Path $sourceRoot) {
    $resolvedCommunityRoot = [IO.Path]::GetFullPath($sourceRoot)
    Add-Failure "community-market.runtime-path" "Community files exist, but Typora's runtime plugin path is missing: $runtimeRoot"
  }
  else {
    $resolvedCommunityRoot = [IO.Path]::GetFullPath($runtimeRoot)
    Add-Failure "community-market.runtime-path" "typora-community-plugin is not installed. Install it from the official release first."
  }
}

$loaderPath = Join-Path $resolvedCommunityRoot "loader.js"
if (Test-Path $loaderPath) {
  Add-Pass "community-market.loader" "Community loader exists: $loaderPath"
}
else {
  Add-Failure "community-market.loader" "Community loader is missing: $loaderPath"
}

$loaderConfigPath = Join-Path $resolvedCommunityRoot "loader.json"
$loaderConfig = Read-JsonFile $loaderConfigPath "community-market.loader-config"
$coreVersionText = $null
if ($loaderConfig) {
  $coreVersionText = [string]$loaderConfig.coreVersion
  $coreVersion = Convert-ToVersion $coreVersionText
  if (-not $coreVersion) {
    Add-Failure "community-market.core-version" "loader.json does not contain a valid coreVersion."
  }
  else {
    $coreScriptPath = Join-Path $resolvedCommunityRoot "$coreVersionText\core.js"
    $coreStylePath = Join-Path $resolvedCommunityRoot "$coreVersionText\core.css"
    if ((Test-Path $coreScriptPath) -and (Test-Path $coreStylePath)) {
      Add-Pass "community-market.core" "Community core $coreVersionText is installed."
    }
    else {
      Add-Failure "community-market.core" "Community core files are incomplete for version $coreVersionText."
    }
  }
}

if ($Mode -eq "Installed") {
  $pluginRoot = Join-Path $resolvedCommunityRoot "plugins\$pluginId"
  $requiredPluginFiles = @("manifest.json", "main.js", "style.css")
  foreach ($requiredFile in $requiredPluginFiles) {
    $installedFile = Join-Path $pluginRoot $requiredFile
    if ((Test-Path $installedFile) -and (Get-Item $installedFile).Length -gt 0) {
      Add-Pass "plugin.file.$requiredFile" "Installed plugin file is present: $installedFile"
    }
    else {
      Add-Failure "plugin.file.$requiredFile" "Installed plugin file is missing or empty: $installedFile"
    }
  }

  $manifestPath = Join-Path $pluginRoot "manifest.json"
  $manifest = Read-JsonFile $manifestPath "plugin.manifest"
  if ($manifest) {
    if ($manifest.id -eq $pluginId) {
      Add-Pass "plugin.manifest-id" "Installed manifest ID matches $pluginId"
    }
    else {
      Add-Failure "plugin.manifest-id" "Installed manifest ID does not match its plugin directory."
    }

    $requiredCoreVersion = Convert-ToVersion ([string]$manifest.minCoreVersion)
    $installedCoreVersion = Convert-ToVersion $coreVersionText
    if ($requiredCoreVersion -and $installedCoreVersion -and $installedCoreVersion -ge $requiredCoreVersion) {
      Add-Pass "plugin.core-compatibility" "Core $coreVersionText satisfies plugin minimum $($manifest.minCoreVersion)."
    }
    else {
      Add-Failure "plugin.core-compatibility" "Installed community core is older than the plugin minimum."
    }

    if ($resolvedTyporaHome) {
      $installedAppVersionText = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $resolvedTyporaHome "Typora.exe")).ProductVersion
      $installedAppVersion = Convert-ToVersion $installedAppVersionText
      $requiredAppVersion = Convert-ToVersion ([string]$manifest.minAppVersion)
      if ($requiredAppVersion -and $installedAppVersion -and $installedAppVersion -ge $requiredAppVersion) {
        Add-Pass "plugin.typora-compatibility" "Installed Typora satisfies plugin minimum $($manifest.minAppVersion)."
      }
      else {
        Add-Failure "plugin.typora-compatibility" "Installed Typora is older than the plugin minimum."
      }

      $verifiedPairs = @("1.14.9|2.9.14")
      $installedPair = "$installedAppVersion|$installedCoreVersion"
      if ($verifiedPairs -contains $installedPair) {
        Add-Pass "plugin.verified-matrix" "Typora $installedAppVersion and Core $installedCoreVersion are a verified host pair."
      }
      else {
        Add-Warning "plugin.verified-matrix" "This host pair meets minimum versions but has not completed this plugin's smoke matrix: Typora $installedAppVersion, Core $installedCoreVersion."
      }
    }
  }

  $pluginStatesPath = Join-Path $resolvedCommunityRoot "settings\plugins.json"
  $pluginStates = Read-JsonFile $pluginStatesPath "plugin.enabled-config"
  if ($pluginStates) {
    $currentState = $pluginStates.PSObject.Properties[$pluginId]
    if ($currentState -and [bool]$currentState.Value) {
      Add-Pass "plugin.enabled" "The plugin is enabled in the global community configuration."
    }
    else {
      Add-Failure "plugin.enabled" "The plugin is installed but not enabled."
    }
    foreach ($legacyId in $legacyPluginIds) {
      if ($pluginStates.PSObject.Properties[$legacyId]) {
        Add-Warning "plugin.legacy-state" "Legacy enabled state remains for $legacyId"
      }
    }
  }

  $runtimeLogPath = Join-Path $resolvedCommunityRoot "settings\data\logs\typora-side-by-side-translator.log"
  if ((Test-Path $runtimeLogPath) -and ([IO.File]::ReadAllText($runtimeLogPath) -match [Regex]::Escape('"manifestId":"' + $pluginId + '"'))) {
    Add-Pass "plugin.runtime-marker" "A successful plugin startup marker exists in the diagnostic log."
  }
  else {
    Add-Warning "plugin.runtime-marker" "No startup marker yet. Restart Typora once, then run doctor.ps1 again."
  }
}

$runningWindow = Get-Process Typora -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
if ($runningWindow) {
  Add-Warning "typora.running" "Typora is open. Close it before installing or replacing plugin files."
}
else {
  Add-Pass "typora.running" "No interactive Typora window is open."
}

Write-Output "doctor_mode=$Mode"
Write-Output "doctor_failures=$($failures.Count)"
Write-Output "doctor_warnings=$($warnings.Count)"
if ($failures.Count -gt 0) {
  exit 1
}
exit 0
