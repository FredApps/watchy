$ErrorActionPreference = "Stop"

function Open-SettingsUri {
  param([Parameter(Mandatory = $true)][string]$Uri)

  Start-Process $Uri
}

try {
  Open-SettingsUri "ms-settings:camera"
  Write-Host "Opened Windows camera settings."
} catch {
  Write-Warning "Could not open camera settings directly. Opening webcam privacy settings instead."
  Open-SettingsUri "ms-settings:privacy-webcam"
}
