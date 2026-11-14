param([switch]$Launch)

$ErrorActionPreference = 'Stop'
if ($Launch) {
    $arguments = '-NoProfile -NonInteractive -File "{0}"' -f $PSCommandPath
    Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardError $env:WORKBENCH_OBSERVER_ERRORS
    return
}

$log = $env:WORKBENCH_OBSERVER_LOG
$appId = [int]$env:WORKBENCH_OBSERVED_PID
$utf8 = [Text.UTF8Encoding]::new($false)

function Write-Record([string]$eventName, [hashtable]$fields) {
    $record = [ordered]@{
        timestamp = [DateTime]::UtcNow.ToString('o')
        event = $eventName
        pid = $appId
    }
    foreach ($key in $fields.Keys) { $record[$key] = $fields[$key] }
    $line = ConvertTo-Json -InputObject $record -Compress
    [IO.File]::AppendAllText($log, $line + [Environment]::NewLine, $utf8)
}

$app = $null
$launcher = $null
try {
    $app = [Diagnostics.Process]::GetProcessById($appId)
    # Keep the OS handle open so exit metadata remains readable after termination.
    $null = $app.Handle
    if ($app.Path -ne $env:WORKBENCH_OBSERVED_EXECUTABLE) {
        throw 'The process ID does not match the expected executable.'
    }

    $launcherId = [int]$env:WORKBENCH_DEV_LAUNCHER_PID
    if ($launcherId) {
        try {
            $launcher = [Diagnostics.Process]::GetProcessById($launcherId)
            $null = $launcher.Handle
        } catch {
            if ($launcher) { $launcher.Dispose() }
            $launcher = $null
        }
    }

    Write-Record 'attached' @{
        observerPid = $PID
        launcherPid = $launcherId
        executable = $env:WORKBENCH_OBSERVED_EXECUTABLE
        build = $env:WORKBENCH_OBSERVED_BUILD
        startedAt = $app.StartTime.ToUniversalTime().ToString('o')
    }

    $app.WaitForExit()
    $details = @{
        exitedAt = $app.ExitTime.ToUniversalTime().ToString('o')
        exitCode = $app.ExitCode
        exitCodeHex = '0x{0:x8}' -f $app.ExitCode
    }
    if ($launcher) {
        $details.launcherExited = $launcher.HasExited
        if ($details.launcherExited) {
            $details.launcherExitedAt = $launcher.ExitTime.ToUniversalTime().ToString('o')
            $details.launcherExitCode = $launcher.ExitCode
        }
    }
    Write-Record 'exited' $details
} catch {
    Write-Record 'observer_error' @{ message = $_.Exception.Message }
    exit 1
} finally {
    if ($app) { $app.Dispose() }
    if ($launcher) { $launcher.Dispose() }
}
