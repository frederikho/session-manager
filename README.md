# Session Manager

One GUI for every Claude Code and Codex session you have — Windows, WSL and the shared
OneDrive folder — showing which ones are backed up and letting you sync, restore or delete them.

```
sessions
```

That starts a local server on `http://127.0.0.1:62841` and opens it in your browser.

## What it scans

| Location | Path |
| --- | --- |
| Windows · Claude | `%USERPROFILE%\.claude\projects` |
| Windows · Codex | `%USERPROFILE%\.codex\sessions` |
| WSL · Claude | `\\wsl.localhost\<distro>\home\<user>\.claude\projects` |
| WSL · Codex | `\\wsl.localhost\<distro>\home\<user>\.codex\sessions` |
| Shared · Claude | `OneDrive*/claude-sessions` |
| Shared · Codex | `OneDrive*/codex/sessions` |

WSL distros are enumerated with `wsl -l -q` and read over UNC, so nothing needs to be
installed inside the distro.

### Machines you reach over SSH

`bin/pull-remote.sh <ssh-host>` rsyncs another machine's transcripts into
`remote/<host>/{claude,codex}`, and every such directory is picked up as a read-only
location — listed, counted and searched alongside the local ones:

```
bin/pull-remote.sh solar-panels-h
```

Run it on a timer to keep the mirror fresh; transcripts are append-only, so repeat
syncs transfer only what was added. The mirror is never a restore target — the tool
refuses, because the next sync would overwrite anything written there. Set
`SESSION_MIRROR_ROOT` to keep the mirrors outside the project folder. Override the shared folders with `CLAUDE_SESSION_SYNC_ROOT`
and `CODEX_SESSION_SYNC_ROOT` on machines with unusual OneDrive paths.

## Sync states

A local session is matched to its shared copy by session id, then compared by byte size —
transcripts are append-only, so size is a reliable ordering.

- **Synced** — the shared copy matches byte for byte.
- **Not synced** — only exists on this machine.
- **Local ahead** — the conversation continued after it was last saved.
- **OneDrive ahead** — the shared copy has more content than the local one.
- **OneDrive only** — saved from another machine, or the local copy is gone.

## Reading a conversation

Click the ▶ on any row to expand it and read the chat inline: user and assistant turns,
reasoning, tool calls and trimmed tool output. Transcripts are streamed, so even a 200 MB
one opens in under a second — very long conversations show the first 60 and last 300
messages with a marker for the gap between them.

## Actions

- **Rename…** — renames the folder in the shared OneDrive folder (and its manifest). Local
  transcripts are named by session id, so the friendly name only exists on the shared side.
- **Sync to OneDrive** — copies the transcript (plus Claude subagent transcripts) into the
  shared folder and writes a `manifest.json`. Already-saved conversations update in place.
- **Restore here** — copies a shared conversation into a local root, back at its original
  project/date path. Existing files are skipped unless you tick overwrite.
- **Delete from OneDrive** — removes the saved conversation from the shared folder, which
  removes it from every machine once OneDrive syncs.

Deletes are refused for any path outside the roots listed above.

The written layout matches the existing `codex-session-sync` skill, so the two can coexist:
Codex conversations land in `<shared>/<name>/session.jsonl`, Claude bundles in
`<shared>/<name>/session-bundle/claude-session/<uuid>.jsonl`.

## Terminal use

```
sessions --list        # summary of locations and sync counts
sessions --json        # full scan as JSON
sessions --port 5000   # use a different port
sessions --no-open     # don't launch a browser
```

## Running it always (Linux, systemd)

A user service starts the server at login and restarts it if it ever dies, so
`http://127.0.0.1:62841/` is simply always there:

```
systemctl --user status session-manager     # is it up?
systemctl --user restart session-manager    # after changing the code
journalctl --user -u session-manager -n 50  # what did it say?
systemctl --user disable --now session-manager   # stop doing this
```

The unit is `~/.config/systemd/user/session-manager.service`. Two things about it
are deliberate:

- It runs as a **user** service, not a system one, so it starts at login and stops
  at logout. The server binds `127.0.0.1` only, so it is useless when nobody is
  logged in anyway.
- The code lives on the VeraCrypt volume `/mnt/data1`, which is unlocked after
  login. Instead of ordering after the mount, the unit just retries every 10 s
  (`Restart=always`, no start limit) until the volume appears.

`ExecStart` names the nvm Node binary by absolute path, because systemd does not
source your shell profile. After an `nvm install` of a new major version, update
that path in the unit.

## Running it always (Windows, Scheduled Tasks)

The equivalent for a plain Windows machine (no WSL) is a Scheduled Task that starts
at logon and restarts on failure:

```
powershell -ExecutionPolicy Bypass -File bin\install-windows-autostart.ps1
```

That registers a task named `SessionManager` (`Get-ScheduledTask -TaskName
SessionManager` to inspect it, `Start-ScheduledTask` / `Stop-ScheduledTask` by the
same name to control it) and starts it immediately. On a machine where Node is only
installed inside WSL (not natively on Windows), the task runs the server through
`wsl.exe -d <distro> -- node .../bin/sessions.mjs --no-open`, hidden behind
`wscript.exe` so no console window appears — the server still binds `127.0.0.1` and
is reachable from Windows browsers exactly as if it ran natively. It retries every
minute, indefinitely, if the process ever exits. Re-run the install script after
moving the repo, switching WSL distro, or installing a new Node version, since it
records those in the generated launcher at install time. To stop doing this:

```
powershell -ExecutionPolicy Bypass -File bin\uninstall-windows-autostart.ps1
```

## Install on a new machine

The tool lives in OneDrive, so it is already there. Register the command once per machine:

```
cd "%USERPROFILE%\OneDrive - Hausable\session-manager"
npm link
```

Requires Node 18+ and no dependencies. Session metadata is cached in
`~/.session-manager-cache.json` (keyed by size and mtime), so rescans are fast.
