$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$processes = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine.Contains($projectRoot) -and $_.CommandLine -match 'server\.ts'
}

if (-not $processes) {
  Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev' -WorkingDirectory $projectRoot -WindowStyle Hidden
}
