$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $scriptDir

$commandArg = if ($args.Count -gt 0) { $args[0] } else { "daily" }
$logFile = Join-Path $scriptDir "agent-cron.log"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

Add-Content -Path $logFile -Value "[$timestamp] [Runner Start] Argument: $commandArg" -Encoding utf8

# If executing 'daily', verify whether a daily run was already successfully recorded for today
if ($commandArg -eq "daily") {
    $cronStatusFile = Join-Path $scriptDir ".last_cron_status.json"
    $todayStr = Get-Date -Format "yyyy-MM-dd"
    if (Test-Path $cronStatusFile) {
        try {
            $statusJson = Get-Content $cronStatusFile -Raw | ConvertFrom-Json
            if ($statusJson.success -eq $true -and $statusJson.dateStr -eq $todayStr) {
                Add-Content -Path $logFile -Value "[$timestamp] [Runner Skip] Daily run for $todayStr already completed successfully at $($statusJson.lastRunAt)." -Encoding utf8
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
    Add-Content -Path $logFile -Value "[$endTimestamp] [Runner End] Completed with exit code $LASTEXITCODE" -Encoding utf8

    if ($LASTEXITCODE -eq 0 -and $commandArg -eq "daily") {
        try {
            [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
            $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
            $textNodes = $template.GetElementsByTagName("text")
            $textNodes.Item(0).AppendChild($template.CreateTextNode("PCG Agent Memory Manager")) | Out-Null
            $textNodes.Item(1).AppendChild($template.CreateTextNode("Tägliches Briefing erfolgreich erstellt & versendet.")) | Out-Null
            $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
            $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("PCG Agent")
            $notifier.Show($toast)
        } catch {
            # Silent notification fallback
        }
    }
} catch {
    $errTimestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$errTimestamp] [Runner Error] $($_.Exception.Message)" -Encoding utf8
}
