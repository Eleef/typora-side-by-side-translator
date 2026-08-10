param (
  [Alias("p")]
  [string] $TyporaHome = "",
  [string] $CommunityRoot = "",
  [string] $PackagePath = "",
  [string] $ExpectedSha256 = ""
)

$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$source = Join-Path $workspace "build\typora-side-by-side-translator"
$sourceKind = "build"
$temporarySourceRoot = $null
$communityRootPath = if ($CommunityRoot) { $CommunityRoot } else { Join-Path $env:USERPROFILE ".typora\community-plugins" }
$communityRootPath = [IO.Path]::GetFullPath($communityRootPath)
$pluginsRoot = [IO.Path]::GetFullPath((Join-Path $communityRootPath "plugins"))
$pluginId = "eleef.typora-side-by-side-translator"
$legacyPluginIds = @("eleef.typora-side-by-side-translation", "typora-bilingual", "jiang.typora-bilingual")
$target = [IO.Path]::GetFullPath((Join-Path $pluginsRoot $pluginId))
$staging = [IO.Path]::GetFullPath((Join-Path $pluginsRoot "$pluginId.installing"))
$doctor = Join-Path $PSScriptRoot "doctor.ps1"
$packageFiles = @("manifest.json", "main.js", "style.css")

try {
if ($PackagePath) {
  $resolvedPackagePath = [IO.Path]::GetFullPath($PackagePath)
  if (-not (Test-Path -LiteralPath $resolvedPackagePath -PathType Leaf)) {
    throw "Plugin package not found: $resolvedPackagePath"
  }
  if ([IO.Path]::GetExtension($resolvedPackagePath) -ne ".zip") {
    throw "Plugin package must be a ZIP file: $resolvedPackagePath"
  }
  $actualSha256 = (Get-FileHash -LiteralPath $resolvedPackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ExpectedSha256) {
    $normalizedExpectedSha256 = $ExpectedSha256.Trim().ToLowerInvariant()
    if ($normalizedExpectedSha256 -notmatch '^[0-9a-f]{64}$') {
      throw "ExpectedSha256 must contain exactly 64 hexadecimal characters."
    }
    if ($actualSha256 -ne $normalizedExpectedSha256) {
      throw "Plugin package checksum mismatch: $actualSha256"
    }
  }
  $temporarySourceRoot = Join-Path ([IO.Path]::GetTempPath()) ("typora-side-by-side-package-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force $temporarySourceRoot | Out-Null
  Expand-Archive -LiteralPath $resolvedPackagePath -DestinationPath $temporarySourceRoot -Force
  $source = $temporarySourceRoot
  $sourceKind = "zip"
  Write-Output "verified_package_sha256=$actualSha256"
}

$runningWindow = Get-Process Typora -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
if ($runningWindow) {
  throw "Typora is open. Close Typora before installing the plugin."
}

$doctorParameters = @{ Mode = "Community" }
if ($TyporaHome) { $doctorParameters.TyporaHome = $TyporaHome }
if ($CommunityRoot) { $doctorParameters.CommunityRoot = $CommunityRoot }
& $doctor @doctorParameters
if ($LASTEXITCODE -ne 0) {
  throw "Community plugin market check failed. Repair typora-community-plugin before installing this plugin."
}

if (-not (Test-Path $source)) {
  throw "Build output not found: $source"
}

$sourceEntries = @(Get-ChildItem -LiteralPath $source -Force)
$unexpectedEntries = @($sourceEntries | Where-Object { $_.PSIsContainer -or $_.Name -notin $packageFiles })
if ($sourceEntries.Count -ne $packageFiles.Count -or $unexpectedEntries.Count -ne 0) {
  throw "Plugin package root must contain only manifest.json, main.js, and style.css."
}
$sourceManifest = Get-Content -LiteralPath (Join-Path $source "manifest.json") -Raw | ConvertFrom-Json
if ($sourceManifest.id -ne $pluginId -or -not $sourceManifest.version) {
  throw "Plugin package manifest id or version is invalid."
}

$pluginsPrefix = $pluginsRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
foreach ($safePath in @($target, $staging)) {
  if (-not $safePath.StartsWith($pluginsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe plugin target: $safePath"
  }
}

$pluginStatesPath = Join-Path (Split-Path $pluginsRoot -Parent) "settings\plugins.json"
if (-not (Test-Path $pluginStatesPath)) {
  New-Item -ItemType Directory -Force (Split-Path $pluginStatesPath -Parent) | Out-Null
  $pluginStates = [PSCustomObject]@{}
}
else {
  try {
    $pluginStates = Get-Content $pluginStatesPath -Raw | ConvertFrom-Json
  }
  catch {
    throw "Community plugin state is invalid JSON; no plugin files were changed: $pluginStatesPath"
  }
  Copy-Item -LiteralPath $pluginStatesPath -Destination "$pluginStatesPath.typora-side-by-side-translator.bak" -Force
}

if (Test-Path $staging) {
  Remove-Item -LiteralPath $staging -Recurse -Force
}
New-Item -ItemType Directory -Force $staging | Out-Null
Copy-Item -Path (Join-Path $source "*") -Destination $staging -Recurse -Force

foreach ($packageFile in $packageFiles) {
  $sourceHash = (Get-FileHash (Join-Path $source $packageFile) -Algorithm SHA256).Hash
  $stagedHash = (Get-FileHash (Join-Path $staging $packageFile) -Algorithm SHA256).Hash
  if ($sourceHash -ne $stagedHash) {
    throw "Staged plugin file hash mismatch: $packageFile"
  }
}

if (Test-Path $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}
Move-Item -LiteralPath $staging -Destination $target
Write-Output "verified_installed_file_hashes=manifest.json,main.js,style.css"

foreach ($legacyName in $legacyPluginIds) {
  $legacyPath = [IO.Path]::GetFullPath((Join-Path $pluginsRoot $legacyName))
  if (-not $legacyPath.StartsWith($pluginsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe legacy plugin target: $legacyPath"
  }
  if ((Test-Path $legacyPath) -and ($legacyPath -ne $target)) {
    Remove-Item -LiteralPath $legacyPath -Recurse -Force
  }
}

$legacyStateFound = $false
foreach ($legacyId in $legacyPluginIds) {
  $legacyProperty = $pluginStates.PSObject.Properties[$legacyId]
  if ($null -ne $legacyProperty) {
    $legacyStateFound = $true
    $pluginStates.PSObject.Properties.Remove($legacyId)
  }
}

$currentProperty = $pluginStates.PSObject.Properties[$pluginId]
if ($null -eq $currentProperty) {
  $pluginStates | Add-Member -NotePropertyName $pluginId -NotePropertyValue $true
}
else {
  $currentProperty.Value = $true
}

if ($legacyStateFound) {
  Write-Output "migrated_enabled_plugin_id=$pluginId"
}

# The community core reads this file with JSON.parse, which rejects a UTF-8 BOM.
$pluginStatesJson = ($pluginStates | ConvertTo-Json -Depth 10) + [Environment]::NewLine
$utf8WithoutBom = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($pluginStatesPath, $pluginStatesJson, $utf8WithoutBom)
Write-Output "enabled_plugin_id=$pluginId"
Write-Output "normalized_plugin_state_encoding=$pluginStatesPath"

$installedDoctorParameters = @{ Mode = "Installed" }
if ($TyporaHome) { $installedDoctorParameters.TyporaHome = $TyporaHome }
if ($CommunityRoot) { $installedDoctorParameters.CommunityRoot = $CommunityRoot }
& $doctor @installedDoctorParameters
if ($LASTEXITCODE -ne 0) {
  throw "Installed plugin verification failed. Review the FAIL lines above."
}

Write-Output "installed_to=$target"
Write-Output "installed_version=$($sourceManifest.version)"
Write-Output "install_source=$sourceKind"
}
finally {
  if ($temporarySourceRoot -and (Test-Path -LiteralPath $temporarySourceRoot)) {
    $resolvedTemporarySourceRoot = [IO.Path]::GetFullPath($temporarySourceRoot)
    $resolvedSystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedTemporarySourceRoot.StartsWith($resolvedSystemTemp, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean unexpected package path: $resolvedTemporarySourceRoot"
    }
    Remove-Item -LiteralPath $resolvedTemporarySourceRoot -Recurse -Force
  }
}
