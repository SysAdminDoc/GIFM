# Removes the per-user "Make GIF with GIFM" right-click verb. No administrator rights required.
$ErrorActionPreference = 'Stop'
$extensions = '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.gif'
foreach ($ext in $extensions) {
  $base = "HKCU:\Software\Classes\SystemFileAssociations\$ext\shell\GIFM"
  if (Test-Path $base) {
    Remove-Item -Path $base -Recurse -Force
  }
}
Write-Host "Removed 'Make GIF with GIFM' context-menu entries."
