# Registers a Scheduled Task that starts the session manager at logon and
# restarts it if it ever dies, so http://127.0.0.1:62841/ is simply always
# there — the Windows equivalent of the systemd user service (see README).
#
# Node itself isn't installed for native Windows on this machine, only
# inside WSL, so the task runs the server through `wsl.exe` — the server
# still binds 127.0.0.1 and Windows browsers reach it exactly the same way.
#
# Run once per machine, from a normal (non-admin) PowerShell:
#   powershell -ExecutionPolicy Bypass -File bin\install-windows-autostart.ps1
#
# Re-run after switching WSL distro, moving the repo, or installing a new
# Node major version in WSL, to refresh the recorded paths.

$ErrorActionPreference = 'Stop'

$taskName = 'SessionManager'
$distro = 'Ubuntu'

$wsl = Join-Path $env:WINDIR 'System32\wsl.exe'
if (-not (Test-Path $wsl)) { throw "wsl.exe not found at $wsl" }

# Translate the repo's Windows path (D:\Code\session-manager) to the WSL
# mount path (/mnt/d/Code/session-manager) ourselves — cheaper than shelling
# out to wsl.exe just to ask it, and avoids quoting `wslpath` through two
# more layers of escaping (VBScript, then bash).
$repoRoot = Split-Path -Parent $PSScriptRoot
$driveLetter = $repoRoot.Substring(0, 1).ToLower()
$restOfPath = $repoRoot.Substring(2) -replace '\\', '/'
$wslRepoRoot = "/mnt/$driveLetter$restOfPath"

# wscript /nologo runs the command with no visible console window — the
# cheap substitute for systemd's default of no controlling terminal.
# Built line by line with the quote character (") as its own variable,
# rather than as a nested-quoting here-string, so there is exactly one
# layer of escaping to reason about: VBScript's own ("" inside a "..."
# string means a literal ").
$q = [char]34
$vbsPath = Join-Path $repoRoot 'bin\run-hidden.vbs'
$bashCmd = "node $wslRepoRoot/bin/sessions.mjs --no-open"
$runLine = "$wsl -d $distro -- bash -lc $q$bashCmd$q"
$runLineEscaped = $runLine.Replace([string]$q, "$q$q")
$vbsLines = @(
  "Set shell = CreateObject(${q}WScript.Shell${q})"
  "shell.Run ${q}${runLineEscaped}${q}, 0, False"
)
Set-Content -Path $vbsPath -Value $vbsLines -Encoding ASCII

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbsPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
# Restart=always, no start limit: retry every minute, indefinitely. Mirrors
# the systemd unit's tolerance for the code living on a volume that may not
# be ready the instant the session starts (here: WSL itself spinning up).
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null

Write-Host "Registered scheduled task '$taskName'."
Write-Host "Starting it now..."
Start-ScheduledTask -TaskName $taskName
Write-Host "Done. http://127.0.0.1:62841/ will come up at every logon."
