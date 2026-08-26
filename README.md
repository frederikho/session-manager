# Session Manager

One GUI for every Claude Code and Codex session you have — Windows, WSL and the shared
OneDrive folder — showing which ones are backed up and letting you sync, restore or delete them.

```
sessions
```

That starts a local server on `http://127.0.0.1:4321` and opens it in your browser.

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
installed inside the distro. Override the shared folders with `CLAUDE_SESSION_SYNC_ROOT`
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

## Install on a new machine

The tool lives in OneDrive, so it is already there. Register the command once per machine:

```
cd "%USERPROFILE%\OneDrive - Hausable\session-manager"
npm link
```

Requires Node 18+ and no dependencies. Session metadata is cached in
`~/.session-manager-cache.json` (keyed by size and mtime), so rescans are fast.
