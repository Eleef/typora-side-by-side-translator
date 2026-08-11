$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ("typora-side-by-side-installer-" + [Guid]::NewGuid().ToString("N"))
$typoraHome = Join-Path $sandbox "Typora"
$communityRoot = Join-Path $sandbox "community-plugins"
$windowHtml = Join-Path $typoraHome "resources\window.html"
$pluginStatesPath = Join-Path $communityRoot "settings\plugins.json"
$releaseZip = Join-Path $workspace "release\plugin.zip"
$utf8WithoutBom = [Text.UTF8Encoding]::new($false)
$utf8WithBom = [Text.UTF8Encoding]::new($true)
$windowsPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$projectVersion = (Get-Content -LiteralPath (Join-Path $workspace "manifest.json") -Raw | ConvertFrom-Json).version

function Invoke-Doctor {
  param ([string] $Mode)
  & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $workspace "scripts\doctor.ps1") -Mode $Mode -TyporaHome $typoraHome -CommunityRoot $communityRoot | Out-Host
  $doctorExitCode = $LASTEXITCODE
  return $doctorExitCode
}

function Get-Sha256 {
  param ([string] $Path)
  $stream = [IO.File]::OpenRead([IO.Path]::GetFullPath($Path))
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  }
  finally {
    $hasher.Dispose()
    $stream.Dispose()
  }
}

try {
  New-Item -ItemType Directory -Force (Split-Path $windowHtml -Parent) | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $communityRoot "2.9.14") | Out-Null
  New-Item -ItemType Directory -Force (Split-Path $pluginStatesPath -Parent) | Out-Null
  Copy-Item (Join-Path $env:WINDIR "System32\notepad.exe") (Join-Path $typoraHome "Typora.exe")

  [IO.File]::WriteAllText($windowHtml, '<script src="typora://app/userData/plugins/loader.js" type="module"></script></body></html>', $utf8WithoutBom)
  [IO.File]::WriteAllText((Join-Path $communityRoot "loader.js"), "// test loader", $utf8WithoutBom)
  [IO.File]::WriteAllText((Join-Path $communityRoot "loader.json"), '{"coreVersion":"2.9.14","debug":false}', $utf8WithoutBom)
  [IO.File]::WriteAllText((Join-Path $communityRoot "2.9.14\core.js"), "// test core", $utf8WithoutBom)
  [IO.File]::WriteAllText((Join-Path $communityRoot "2.9.14\core.css"), "/* test core */", $utf8WithoutBom)
  [IO.File]::WriteAllText($pluginStatesPath, '{"jiang.typora-bilingual":true}', $utf8WithBom)

  $buildInstallOutput = @(& (Join-Path $workspace "scripts\install-plugin.ps1") -TyporaHome $typoraHome -CommunityRoot $communityRoot)
  $buildInstallOutput | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Installer failed in the healthy community-market fixture."
  }
  if (($buildInstallOutput -join "`n") -notmatch [Regex]::Escape("installed_version=$projectVersion") -or ($buildInstallOutput -join "`n") -notmatch "install_source=build") {
    throw "Installer did not complete its post-install verification for the build source."
  }

  $stateBytes = [IO.File]::ReadAllBytes($pluginStatesPath)
  if ($stateBytes.Length -ge 3 -and $stateBytes[0] -eq 0xEF -and $stateBytes[1] -eq 0xBB -and $stateBytes[2] -eq 0xBF) {
    throw "Installer left a UTF-8 BOM in plugins.json."
  }
  $pluginStates = [IO.File]::ReadAllText($pluginStatesPath) | ConvertFrom-Json
  if (-not [bool]$pluginStates.PSObject.Properties["eleef.typora-side-by-side-translator"].Value) {
    throw "Installer did not enable the current plugin ID."
  }
  if ($pluginStates.PSObject.Properties["jiang.typora-bilingual"]) {
    throw "Installer did not remove the legacy plugin ID."
  }
  if ((Invoke-Doctor "Installed") -ne 0) {
    throw "Installed-mode doctor failed after a healthy installation."
  }
  $redactedDoctorOutput = @(& $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $workspace "scripts\doctor.ps1") -Mode Installed -TyporaHome $typoraHome -CommunityRoot $communityRoot -RedactPaths)
  if ($LASTEXITCODE -ne 0 -or ($redactedDoctorOutput -join "`n").Contains($sandbox)) {
    throw "Redacted doctor output failed or exposed the sandbox path."
  }

  if (-not (Test-Path -LiteralPath $releaseZip -PathType Leaf)) {
    throw "Release package is required for ZIP installer smoke: $releaseZip"
  }
  $releaseHash = Get-Sha256 $releaseZip
  try {
    & (Join-Path $workspace "scripts\install-plugin.ps1") -TyporaHome $typoraHome -CommunityRoot $communityRoot -PackagePath $releaseZip -ExpectedSha256 ("0" * 64)
    throw "Installer unexpectedly accepted an incorrect package checksum."
  }
  catch {
    if ($_.Exception.Message -notmatch "checksum mismatch") {
      throw
    }
  }

  $zipInstallOutput = @(& (Join-Path $workspace "scripts\install-plugin.ps1") -TyporaHome $typoraHome -CommunityRoot $communityRoot -PackagePath $releaseZip -ExpectedSha256 $releaseHash)
  $zipInstallOutput | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Installer failed to install the packaged ZIP."
  }
  if (($zipInstallOutput -join "`n") -notmatch [Regex]::Escape("installed_version=$projectVersion") -or ($zipInstallOutput -join "`n") -notmatch "install_source=zip") {
    throw "Installer did not complete its post-install verification for the ZIP source."
  }
  $installedManifest = Get-Content -LiteralPath (Join-Path $communityRoot "plugins\eleef.typora-side-by-side-translator\manifest.json") -Raw | ConvertFrom-Json
  if ($installedManifest.version -ne $projectVersion) {
    throw "ZIP installer installed the wrong plugin version: $($installedManifest.version)"
  }

  [IO.File]::WriteAllText($windowHtml, "</body></html>", $utf8WithoutBom)
  if ((Invoke-Doctor "Community") -eq 0) {
    throw "Community-mode doctor accepted a missing loader injection."
  }

  [IO.File]::WriteAllText($windowHtml, '<script src="typora://app/userData/plugins/loader.js" type="module"></script></body></html>', $utf8WithoutBom)
  $validStates = [IO.File]::ReadAllText($pluginStatesPath)
  [IO.File]::WriteAllText($pluginStatesPath, $validStates, $utf8WithBom)
  if ((Invoke-Doctor "Installed") -eq 0) {
    throw "Installed-mode doctor accepted a BOM-prefixed plugins.json."
  }

  Write-Output "windows_installer_smoke=passed"
  Write-Output "windows_zip_installer_smoke=passed"
}
finally {
  if (Test-Path $sandbox) {
    $resolvedSandbox = [IO.Path]::GetFullPath($sandbox)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedSandbox.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean unexpected test path: $resolvedSandbox"
    }
    Remove-Item -LiteralPath $resolvedSandbox -Recurse -Force
  }
}
