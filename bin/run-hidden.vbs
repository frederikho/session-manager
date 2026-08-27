Set shell = CreateObject("WScript.Shell")
shell.Run "C:\WINDOWS\System32\wsl.exe -d Ubuntu -- bash -lc ""node /mnt/d/Code/session-manager/bin/sessions.mjs --no-open""", 0, False
