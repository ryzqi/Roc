param(
    [string]$Level,
    [string]$Service,
    [string]$TraceId,
    [string]$RunId,
    [string]$Grep,
    [string]$LogPath,
    [int]$Last = 100
)

if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $ProfileRoot = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($ProfileRoot)) {
        $ProfileRoot = [Environment]::GetFolderPath('UserProfile')
    }
    if ([string]::IsNullOrWhiteSpace($ProfileRoot)) {
        throw "Unable to resolve the Roc user profile directory."
    }
    $LogPath = Join-Path $ProfileRoot ".roc\logs\app.jsonl"
}

if (-not (Test-Path -LiteralPath $LogPath)) {
    Write-Error "Roc log file not found: $LogPath"
    exit 1
}

Get-Content -LiteralPath $LogPath -Tail $Last |
    ConvertFrom-Json |
    Where-Object {
        ([string]::IsNullOrWhiteSpace($Level) -or $_.level -eq $Level) -and
        ([string]::IsNullOrWhiteSpace($Service) -or $_.service -eq $Service) -and
        ([string]::IsNullOrWhiteSpace($TraceId) -or $_.traceId -eq $TraceId) -and
        ([string]::IsNullOrWhiteSpace($RunId) -or $_.runId -eq $RunId) -and
        ([string]::IsNullOrWhiteSpace($Grep) -or $_.message -like "*$Grep*")
    } |
    Format-Table timestamp, level, message, service -AutoSize
