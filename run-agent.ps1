$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $scriptDir

$commandArg = if ($args.Count -gt 0) { $args[0] } else { "daily" }
$logFile = Join-Path $scriptDir "agent-cron.log"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

Add-Content -Path $logFile -Value "[$timestamp] [Runner Start] Argument: $commandArg"

# If executing 'daily', verify whether a daily run was already successfully recorded for today
if ($commandArg -eq "daily") {
    $cronStatusFile = Join-Path $scriptDir ".last_cron_status.json"
    $todayStr = Get-Date -Format "yyyy-MM-dd"
    if (Test-Path $cronStatusFile) {
        try {
            $statusJson = Get-Content $cronStatusFile -Raw | ConvertFrom-Json
            if ($statusJson.success -eq $true -and $statusJson.dateStr -eq $todayStr) {
                Add-Content -Path $logFile -Value "[$timestamp] [Runner Skip] Daily run for $todayStr already completed successfully at $($statusJson.lastRunAt)."
                exit 0
            }
        } catch {
            # Continue on json read error
        }
    }
}

try {
    & npm.cmd run agent -- $commandArg *>> $logFile
    $endTimestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$endTimestamp] [Runner End] Completed with exit code $LASTEXITCODE"
} catch {
    $errTimestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$errTimestamp] [Runner Error] $($_.Exception.Message)"
}
