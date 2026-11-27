# Setup PowerShell Editor Services bundle for OMP DAP adapter
# Usage: ./setup-pses-bundle.ps1 [-BundlePath <path>] [-SkipDownload]
#
# Downloads the latest PSES release and extracts it to the bundle path.
# Default bundle path: $env:USERPROFILE\.pses
# Set PSES_BUNDLE_PATH env var to override.

param(
    [string]$BundlePath = (Join-Path $env:USERPROFILE ".pses"),
    [switch]$SkipDownload,
    [string]$LocalBuildPath
)

$ErrorActionPreference = 'Stop'

# If a local build is specified, use that instead of downloading
if ($LocalBuildPath) {
    Write-Host "Using local PSES build: $LocalBuildPath"
    if (-not (Test-Path "$LocalBuildPath\PowerShellEditorServices\Start-EditorServices.ps1")) {
        throw "Local build path does not contain PowerShellEditorServices\Start-EditorServices.ps1"
    }
    # Set env var for this session
    [Environment]::SetEnvironmentVariable("PSES_BUNDLE_PATH", $LocalBuildPath, "User")
    Write-Host "PSES_BUNDLE_PATH set to $LocalBuildPath"
    Write-Host "Restart your terminal for the change to take effect."
    return
}

if ($SkipDownload) {
    Write-Host "Skipping download. Set PSES_BUNDLE_PATH to point to your existing PSES installation."
    return
}

# Download latest PSES release
$releaseUrl = "https://api.github.com/repos/PowerShell/PowerShellEditorServices/releases/latest"
Write-Host "Fetching latest PSES release..."
$release = Invoke-RestMethod -Uri $releaseUrl
$zipAsset = $release.assets | Where-Object { $_.name -like "*.zip" } | Select-Object -First 1
if (-not $zipAsset) { throw "No zip asset found in latest release" }

$zipUrl = $zipAsset.browser_download_url
$zipPath = Join-Path $env:TEMP "PowerShellEditorServices.zip"
Write-Host "Downloading $($zipAsset.name)..."
Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath

# Extract
Write-Host "Extracting to $BundlePath..."
if (Test-Path $BundlePath) { Remove-Item -Recurse -Force $BundlePath }
Expand-Archive -Path $zipPath -DestinationPath $BundlePath
Remove-Item $zipPath

# Set env var
[Environment]::SetEnvironmentVariable("PSES_BUNDLE_PATH", $BundlePath, "User")
Write-Host "PSES installed to $BundlePath"
Write-Host "PSES_BUNDLE_PATH set. Restart your terminal for the change to take effect."
