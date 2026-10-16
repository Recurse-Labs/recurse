# Recurse installer for Windows.
#
#   powershell -c "irm https://raw.githubusercontent.com/Recurse-Labs/recurse/master/scripts/install.ps1 | iex"
#
# Downloads the latest GitHub Release installer (.msi, falling back to the
# NSIS .exe) for your architecture and runs it. Once installed, Recurse
# checks for and installs updates itself — see docs/updating.md. This
# script is only needed for the very first install.

$ErrorActionPreference = "Stop"

$Repo = "Recurse-Labs/recurse"
$Api = "https://api.github.com/repos/$Repo/releases/latest"

function Write-Step($msg) { Write-Host "==> $msg" }

Write-Step "Fetching latest release metadata for $Repo..."
$headers = @{ "User-Agent" = "recurse-install-script" }
$release = Invoke-RestMethod -Uri $Api -Headers $headers

$arch = if ([Environment]::Is64BitOperatingSystem) {
	if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
} else {
	"x86"
}

$assets = $release.assets
$msi = $assets | Where-Object { $_.name -like "*.msi" -and $_.name -like "*$arch*" } | Select-Object -First 1
if (-not $msi) { $msi = $assets | Where-Object { $_.name -like "*.msi" } | Select-Object -First 1 }

$exe = $assets | Where-Object { $_.name -like "*setup.exe" -and $_.name -like "*$arch*" } | Select-Object -First 1
if (-not $exe) { $exe = $assets | Where-Object { $_.name -like "*setup.exe" } | Select-Object -First 1 }

$asset = if ($msi) { $msi } elseif ($exe) { $exe } else { $null }
if (-not $asset) {
	Write-Error "No Windows installer found in the latest release. Grab one manually from https://github.com/$Repo/releases"
	exit 1
}

$dest = Join-Path $env:TEMP $asset.name
Write-Step "Downloading $($asset.name)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -Headers $headers

Write-Step "Launching installer..."
if ($dest -like "*.msi") {
	Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", "`"$dest`"" -Wait
} else {
	Start-Process -FilePath $dest -Wait
}

Write-Step "Done. Launch Recurse from the Start menu."
