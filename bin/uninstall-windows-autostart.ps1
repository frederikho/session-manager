# Removes the Scheduled Task installed by install-windows-autostart.ps1.
#
#   powershell -ExecutionPolicy Bypass -File bin\uninstall-windows-autostart.ps1

$ErrorActionPreference = 'Stop'

$taskName = 'SessionManager'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Removed scheduled task '$taskName'."
