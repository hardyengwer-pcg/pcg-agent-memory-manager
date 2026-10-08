$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$processes = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine.Contains($projectRoot) -and $_.CommandLine -match 'cli\.ts.*chat-watch'
}

if (-not $processes) {
  Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'agent', '--', 'chat-watch' -WorkingDirectory $projectRoot -WindowStyle Hidden
}
