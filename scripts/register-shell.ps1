# Registers a per-user "Make GIF with GIFM" right-click verb for common video/GIF files.
# Run this from inside the portable GIFM folder (next to GIFM.exe). No administrator rights required.
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'GIFM.exe'
if (-not (Test-Path $exe)) {
  Write-Error "GIFM.exe was not found next to this script. Run it from the portable GIFM folder."
  exit 1
}

$extensions = '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.gif'
foreach ($ext in $extensions) {
  $base = "HKCU:\Software\Classes\SystemFileAssociations\$ext\shell\GIFM"
  New-Item -Path $base -Force | Out-Null
  Set-ItemProperty -Path $base -Name '(default)' -Value 'Make GIF with GIFM'
  Set-ItemProperty -Path $base -Name 'Icon' -Value $exe
  New-Item -Path "$base\command" -Force | Out-Null
  Set-ItemProperty -Path "$base\command" -Name '(default)' -Value "`"$exe`" `"%1`""
}

Write-Host "Registered 'Make GIF with GIFM' for: $($extensions -join ', ')"
Write-Host "Right-click a video and choose 'Make GIF with GIFM'. Run unregister-shell.ps1 to remove."
